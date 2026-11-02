import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { semanticReferences } from "../src/semantic.js";
import { codeOutline } from "../src/code.js";
import { buildCallGraph, queryCallGraph } from "../src/call-graph.js";
import { RunStore } from "../src/store.js";
import { comparePatch } from "../src/fix-verification.js";
import { parseFixUrl } from "../src/fix-sources.js";
function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(resolve(tmpdir(), "harness-analysis-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(resolve(dir, name, ".."), { recursive: true });
    writeFileSync(resolve(dir, name), text);
  }
  const store = new RunStore(resolve(dir, ".audit-harness/runs"));
  const run = store.create({
    title: "regression",
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
test("real PHP server indexes cross-file aliases and distinguishes methods; PHP symbols retain ranges", async () => {
  const x = fixture({
    "composer.json": "{}",
    "api.php":
      "<?php\nnamespace App;\nclass A { public function save() {} }\nclass B { public function save() {} }\n",
    "use.php":
      "<?php\nnamespace Client;\nuse App\\A as Store;\n$a = new Store(); $a->save();\n$b = new \\App\\B(); $b->save();\n",
  });
  try {
    const symbols = await codeOutline(x.dir, { path: "api.php" });
    assert.equal(symbols.supported, true);
    assert.ok(
      symbols.declarations?.some((s) => s.qualifiedName === "App.A.save"),
    );
    const refs = await semanticReferences(x.dir, {
      path: "api.php",
      line: 3,
      column: 28,
    });
    assert.equal(refs.language, "php");
    assert.ok(
      refs.references.some(
        (r) => basename(r.path || "") === "use.php" && r.line === 4,
      ),
    );
    assert.ok(
      !refs.references.some(
        (r) => basename(r.path || "") === "use.php" && r.line === 5,
      ),
    );
    const graphResult = await buildCallGraph(
      x.dir,
      {},
      x.store,
      x.run.id,
      "php-graph",
    );
    const graph = JSON.parse(
      readFileSync(
        resolve(x.store.dir(x.run.id), "artifacts", graphResult.artifact),
        "utf8",
      ),
    );
    const target = graph.nodes.find(
      (n: any) => n.qualifiedName === "App.A.save",
    );
    assert.ok(
      graph.edges.some(
        (e: any) =>
          e.to === target.id && e.path.endsWith("use.php") && e.line === 4,
      ),
    );
    assert.ok(
      !graph.edges.some((e: any) => e.to === target.id && e.line === 5),
    );
  } finally {
    x.clean();
  }
});
test("whole-scope graph uses actual bindings across aliases, preserves cycles and unresolved dynamic callbacks, detects changed sources", async () => {
  const x = fixture({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include: ["*.ts"],
    }),
    "a.ts":
      "import { beta } from './b.js';\nexport function alpha(){ beta(); }\nexport class Other { beta() {} }\nexport function dynamic(f:()=>void){ f(); }\n",
    "b.ts":
      "import {alpha as entry} from './a.js';\nexport function beta(){ entry(); }\n",
  });
  try {
    const summary = await buildCallGraph(x.dir, {}, x.store, x.run.id, "graph");
    const graph = JSON.parse(
      readFileSync(
        resolve(x.store.dir(x.run.id), "artifacts", summary.artifact),
        "utf8",
      ),
    );
    const a = graph.nodes.find((n: any) => n.qualifiedName === "alpha"),
      b = graph.nodes.find((n: any) => n.qualifiedName === "beta"),
      other = graph.nodes.find((n: any) => n.qualifiedName === "Other.beta");
    assert.ok(graph.edges.some((e: any) => e.from === a.id && e.to === b.id));
    assert.ok(graph.edges.some((e: any) => e.from === b.id && e.to === a.id));
    assert.ok(!graph.edges.some((e: any) => e.to === other.id));
    assert.ok(graph.unresolved.some((c: any) => c.text === "f"));
    const query = queryCallGraph(
      x.dir,
      {
        artifact: summary.artifact,
        symbol: "alpha",
        direction: "outgoing",
        transitive: true,
      },
      x.store,
      x.run.id,
    );
    assert.equal(query.totalEdges, 2);
    assert.equal(query.coverage.runtimeComplete, false);
    writeFileSync(resolve(x.dir, "a.ts"), "export function changed(){}");
    assert.ok(
      queryCallGraph(
        x.dir,
        { artifact: summary.artifact },
        x.store,
        x.run.id,
      ).staleFiles.some((p) => p.endsWith("a.ts")),
    );
  } finally {
    x.clean();
  }
});
test("patch regression executes the same real script on Git snapshots, preserves dirty worktree and distinguishes infrastructure failures", async () => {
  const x = fixture({ "value.txt": "before" });
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        x.dir,
        "-c",
        "user.name=Harness",
        "-c",
        "user.email=test@localhost",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  try {
    git("init", "-q");
    git("add", "value.txt");
    git("commit", "-qm", "before");
    writeFileSync(resolve(x.dir, "value.txt"), "after");
    git("commit", "-qam", "fix");
    const head = git("rev-parse", "HEAD");
    writeFileSync(resolve(x.dir, "value.txt"), "user-dirty");
    const before = git("status", "--porcelain");
    const options = {
      revision: head,
      command: process.execPath,
      args: ["probe.cjs"],
      files: [
        {
          path: "probe.cjs",
          content:
            "const fs=require('fs');const v=fs.readFileSync('value.txt','utf8');console.log(v);process.exit(v==='after'?0:1);",
        },
      ],
      expectedBeforeExitCode: 1,
      expectedAfterExitCode: 0,
    };
    const result = await comparePatch(
      x.dir,
      options,
      x.store,
      x.run.id,
      "compare",
    );
    assert.equal(result.expectationsMet, true);
    assert.equal(result.runs.before.result.exitCode, 1);
    assert.equal(result.runs.after.result.exitCode, 0);
    assert.equal(
      readFileSync(resolve(x.dir, "value.txt"), "utf8"),
      "user-dirty",
    );
    assert.equal(git("status", "--porcelain"), before);
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.ok(
      existsSync(resolve(x.store.dir(x.run.id), "artifacts", result.artifact)),
    );
    const base = git("rev-parse", "HEAD^");
    const patch = execFileSync("git", ["-C", x.dir, "diff", base, head], {
      encoding: "utf8",
    });
    writeFileSync(
      resolve(x.store.dir(x.run.id), "artifacts", "actual-fix.patch"),
      patch,
    );
    const patched = await comparePatch(
      x.dir,
      {
        ...options,
        revision: undefined,
        base,
        patchArtifact: "actual-fix.patch",
      },
      x.store,
      x.run.id,
      "apply-patch",
    );
    assert.equal(patched.expectationsMet, true);
    assert.equal(patched.patchApplication.exitCode, 0);
    assert.equal(
      readFileSync(resolve(x.dir, "value.txt"), "utf8"),
      "user-dirty",
    );
    const missing = await comparePatch(
      x.dir,
      { ...options, command: "nonexistent-harness-executable" },
      x.store,
      x.run.id,
      "missing",
    );
    assert.equal(missing.expectationsMet, false);
    assert.equal(missing.runs.before.status, "spawn-error");
    const c = new AbortController();
    const pending = comparePatch(
      x.dir,
      { ...options, args: ["-e", "setInterval(()=>{},1000)"] },
      x.store,
      x.run.id,
      "cancelled",
      c.signal,
    );
    setTimeout(() => c.abort(), 150);
    await assert.rejects(pending);
    const cancelled = JSON.parse(
      readFileSync(
        resolve(
          x.store.dir(x.run.id),
          "artifacts",
          "patch-comparison-cancelled.json",
        ),
        "utf8",
      ),
    );
    assert.ok(cancelled.error);
    assert.ok(!cancelled.runs.after?.result);
    assert.equal(
      readFileSync(resolve(x.dir, "value.txt"), "utf8"),
      "user-dirty",
    );
  } finally {
    x.clean();
  }
});
test("issue and gist URL identities map to canonical APIs and keep existing host checks", () => {
  assert.equal(
    parseFixUrl("https://github.com/a/b/issues/123#issuecomment-5").api,
    "https://api.github.com/repos/a/b/issues/123",
  );
  assert.equal(
    parseFixUrl("https://gist.github.com/user/abcdef1234567890").api,
    "https://api.github.com/gists/abcdef1234567890",
  );
  assert.throws(() =>
    parseFixUrl("https://gist.github.com.evil.invalid/user/abcdef1234567890"),
  );
});
