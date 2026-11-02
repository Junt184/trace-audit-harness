import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  buildCallGraph,
  queryCallGraph,
  type CallGraph,
} from "../src/call-graph.js";
import { semanticReferences } from "../src/semantic.js";
import { RunStore } from "../src/store.js";
import { setTimeout as delay } from "node:timers/promises";

function fixture(language: string) {
  const dir = realpathSync(mkdtempSync(resolve(tmpdir(), "trace-graph-")));
  cpSync(resolve("test/fixtures/call-graph", language), dir, {
    recursive: true,
  });
  const store = new RunStore(resolve(dir, ".audit-harness/runs"));
  const run = store.create({
    title: "graph regression",
    repository: dir,
    goal: "test",
    status: "completed",
    model: "fixture",
    provider: "fixture",
    modelConfig: {
      provider: "fixture",
      model: "fixture",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9",
      contextWindow: 10000,
      maxTokens: 1000,
    },
  });
  return {
    dir,
    store,
    run,
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}
async function build(x: ReturnType<typeof fixture>, scope?: string) {
  const result = await buildCallGraph(
    x.dir,
    { scope, timeoutSeconds: 150 },
    x.store,
    x.run.id,
    scope ? "test-scoped" : "test",
  );
  const graph: CallGraph = JSON.parse(
    readFileSync(
      resolve(x.store.dir(x.run.id), "artifacts", result.artifact),
      "utf8",
    ),
  );
  assert.deepEqual(graph.errors, [], JSON.stringify(graph.errors));
  assert.equal(
    graph.coverage.callSites,
    graph.coverage.resolvedCallSites + graph.unresolved.length,
  );
  return { result, graph };
}

test("Python graph follows cross-file aliases and cyclic chains; keeps unknown callbacks unresolved", async () => {
  const x = fixture("python");
  try {
    const { result, graph } = await build(x);
    const node = (name: string) =>
      graph.nodes.find((n) => n.qualifiedName === name)!;
    for (const [from, to] of [
      ["entry", "save"],
      ["save", "finish"],
      ["finish", "save"],
    ])
      assert.ok(
        graph.edges.some(
          (e) => e.from === node(from).id && e.to === node(to).id,
        ),
        `${from} → ${to}`,
      );
    assert.ok(!graph.edges.some((e) => e.to === node("Other.save").id));
    assert.ok(graph.unresolved.some((c) => c.text === "callback"));
    const query = await queryCallGraph(
      x.dir,
      {
        artifact: result.artifact,
        symbol: "entry",
        direction: "outgoing",
        transitive: true,
        limit: 2,
      },
      x.store,
      x.run.id,
    );
    assert.equal(query.totalEdges, 3);
    assert.equal(query.edges.length, 2);
    assert.equal(query.nextOffset, 2);
    assert.equal(
      (
        await queryCallGraph(
          x.dir,
          {
            artifact: result.artifact,
            symbol: "finish",
            direction: "incoming",
            transitive: true,
          },
          x.store,
          x.run.id,
        )
      ).totalEdges,
      3,
    );
    assert.equal(query.freshness, "unchanged");
    writeFileSync(resolve(x.dir, "added.py"), "def added(): pass\n");
    const stale = await queryCallGraph(
      x.dir,
      { artifact: result.artifact },
      x.store,
      x.run.id,
    );
    assert.equal(stale.freshness, "stale");
    assert.deepEqual(stale.addedFiles, [resolve(x.dir, "added.py")]);
  } finally {
    x.clean();
  }
});

test("Go graph binds imported receiver methods and transitive queries, including an outside-scope boundary", async () => {
  const x = fixture("go");
  try {
    const { result, graph } = await build(x);
    const store = graph.nodes.find((n) => n.qualifiedName === "Store.Save")!;
    const other = graph.nodes.find((n) => n.qualifiedName === "Other.Save")!;
    const entry = graph.nodes.find((n) => n.qualifiedName === "entry")!;
    assert.ok(store && other && entry);
    assert.ok(
      graph.edges.some((e) => e.from === entry.id && e.to === store.id),
    );
    assert.ok(!graph.edges.some((e) => e.to === other.id));
    assert.equal(
      (
        await queryCallGraph(
          x.dir,
          {
            artifact: result.artifact,
            symbol: "main",
            direction: "outgoing",
            transitive: true,
          },
          x.store,
          x.run.id,
        )
      ).totalEdges,
      3,
    );
    const scoped = await build(x, "main.go");
    assert.ok(
      scoped.graph.nodes.some(
        (n) => n.external && n.path.endsWith("api/store.go"),
      ),
    );
    assert.equal(scoped.graph.coverage.runtimeComplete, false);
    mkdirSync(resolve(x.dir, "api/vendor"));
    writeFileSync(
      resolve(x.dir, "api/vendor/generated.go"),
      "package ignored\nfunc unexpected() {}\n",
    );
    const freshness = await queryCallGraph(
      x.dir,
      { artifact: result.artifact },
      x.store,
      x.run.id,
    );
    assert.equal(freshness.freshness, "unchanged");
  } finally {
    x.clean();
  }
});

test("Java graph waits for Maven import, resolves constructors and overloads across files; semantic refs exclude wrong overload", async () => {
  const x = fixture("java");
  try {
    const { result, graph } = await build(x);
    const entry = graph.nodes.find((n) => n.qualifiedName === "Main.entry")!;
    const overloads = graph.nodes.filter(
      (n) => n.qualifiedName === "Store.save",
    );
    assert.equal(overloads.length, 2);
    const stringOverload = overloads.find((n) =>
      n.signature?.includes("String"),
    )!;
    const intOverload = overloads.find((n) =>
      n.signature?.includes("int value"),
    )!;
    assert.ok(
      graph.edges.some(
        (e) => e.from === entry.id && e.to === stringOverload.id,
      ),
    );
    assert.ok(!graph.edges.some((e) => e.to === intOverload.id));
    const constructor = graph.nodes.find(
      (n) => n.kind === "constructor_declaration",
    )!;
    assert.ok(
      graph.edges.some((e) => e.from === entry.id && e.to === constructor.id),
    );
    assert.equal(
      (
        await queryCallGraph(
          x.dir,
          {
            artifact: result.artifact,
            symbol: "Main.entry",
            direction: "outgoing",
            transitive: true,
          },
          x.store,
          x.run.id,
        )
      ).totalEdges,
      3,
    );
    const refs = await semanticReferences(x.dir, {
      path: "src/main/java/sample/Store.java",
      line: stringOverload.nameLine!,
      column: stringOverload.nameColumn!,
      timeoutSeconds: 150,
    });
    assert.ok(
      refs.references.some(
        (r) => r.path?.endsWith("Main.java") && r.line === 6,
      ),
    );
    assert.ok(!refs.references.some((r) => r.path?.endsWith("Other.java")));
    assert.ok(
      refs.serverMessages.some((m) => m.includes("Java Started: Ready")),
    );
    for (const name of [".project", ".classpath", ".settings"])
      assert.equal(
        existsSync(resolve(x.dir, name)),
        false,
        `Java import wrote ${name} to target`,
      );
  } finally {
    x.clean();
  }
});

test("graph server failures retain every syntactic call and user cancellation rejects promptly", async () => {
  const x = fixture("python");
  const previous = process.env.AUDIT_LSP_SERVERS;
  try {
    process.env.AUDIT_LSP_SERVERS = JSON.stringify({
      python: [resolve(x.dir, "missing-server")],
    });
    const result = await buildCallGraph(
      x.dir,
      {},
      x.store,
      x.run.id,
      "missing",
    );
    assert.equal(result.coverage.callSites, 4);
    assert.equal(result.unresolved, 4);
    assert.equal(result.coverage.indexedFiles, 0);
    assert.equal(result.coverage.staticAnalysisComplete, false);
    assert.ok(result.errors.length > 0);
    const cancel = new AbortController();
    cancel.abort();
    await assert.rejects(
      buildCallGraph(x.dir, {}, x.store, x.run.id, "cancel", cancel.signal),
    );
  } finally {
    if (previous === undefined) delete process.env.AUDIT_LSP_SERVERS;
    else process.env.AUDIT_LSP_SERVERS = previous;
    x.clean();
  }
});

test("an unresponsive server produces an explicit partial graph at deadline and active cancellation kills its process", async () => {
  const x = fixture("python");
  const previous = process.env.AUDIT_LSP_SERVERS;
  const pidFile = resolve(x.dir, "server-pid");
  try {
    process.env.AUDIT_LSP_SERVERS = JSON.stringify({
      python: [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{}, 60000)`,
      ],
    });
    const partial = await buildCallGraph(
      x.dir,
      { timeoutSeconds: 1 },
      x.store,
      x.run.id,
      "deadline",
    );
    assert.equal(partial.coverage.callSites, 4);
    assert.equal(partial.unresolved, 4);
    assert.equal(partial.coverage.staticAnalysisComplete, false);
    assert.ok(partial.errors.some((e) => e.error === "analysis-timeout"));
    const saved: CallGraph = JSON.parse(
      readFileSync(
        resolve(x.store.dir(x.run.id), "artifacts", partial.artifact),
        "utf8",
      ),
    );
    assert.ok(saved.unresolved.every((c) => c.reason === "analysis-timeout"));
    rmSync(pidFile, { force: true });
    const cancel = new AbortController();
    const active = buildCallGraph(
      x.dir,
      {},
      x.store,
      x.run.id,
      "active-cancel",
      cancel.signal,
    );
    const assertion = assert.rejects(active, /abort|取消/i);
    for (let attempt = 0; !existsSync(pidFile) && attempt < 100; attempt++)
      await delay(20);
    assert.ok(existsSync(pidFile), "server did not start");
    const pid = Number(readFileSync(pidFile, "utf8"));
    cancel.abort();
    await assertion;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await delay(20);
    }
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.equal(
      existsSync(
        resolve(
          x.store.dir(x.run.id),
          "artifacts/call-graph-active-cancel.json",
        ),
      ),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.AUDIT_LSP_SERVERS;
    else process.env.AUDIT_LSP_SERVERS = previous;
    x.clean();
  }
});
