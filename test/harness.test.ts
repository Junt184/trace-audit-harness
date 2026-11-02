import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { RunStore } from "../src/store.js";
import { createAuditTools, repositoryInfo } from "../src/tools.js";
import { validateConfig } from "../src/config.js";

function setup() {
  const dir = mkdtempSync(resolve(tmpdir(), "audit-harness-test-"));
  const store = new RunStore(resolve(dir, "runs"));
  const run = store.create({
    title: "Regression",
    repository: dir,
    goal: "Exercise real tools",
    status: "running",
    model: "not-used",
    provider: "not-used",
    modelConfig: {
      provider: "not-used",
      baseUrl: "http://127.0.0.1",
      model: "not-used",
      api: "openai-completions",
      contextWindow: 4096,
      maxTokens: 1024,
    },
  });
  const tools = createAuditTools(dir, store, run.id);
  return {
    dir,
    store,
    run,
    tools,
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("persistent run replay retains evidence, notes, report and sequence after interruption", () => {
  const x = setup();
  try {
    x.store.emitEvent(x.run.id, "tool_start", {
      name: "read",
      args: { path: "example.ts" },
    });
    x.store.saveFinding(x.run.id, {
      title: "Candidate",
      description: "Evidence",
      severity: "low",
      status: "candidate",
    });
    x.store.saveNotes(
      x.run.id,
      "Ruled out one hypothesis; inspect its caller next.",
    );
    x.store.saveReport(x.run.id, "# Actual report");
    const restored = new RunStore(x.store.root);
    restored.recoverInterrupted();
    assert.equal(restored.get(x.run.id).status, "interrupted");
    assert.equal(restored.findings(x.run.id).length, 1);
    assert.match(restored.notes(x.run.id), /caller/);
    assert.equal(restored.report(x.run.id), "# Actual report");
    const previous = restored.events(x.run.id).at(-1)!;
    const next = restored.emitEvent(x.run.id, "user_message", {
      text: "Continue",
    });
    assert.equal(next.seq, previous.seq + 1);
    assert.deepEqual(restored.events(x.run.id, previous.seq), [next]);
    assert.throws(() => restored.get("../outside"), /ID/);
  } finally {
    x.clean();
  }
});

test("structured commands preserve literal payload arguments and persist their output", async () => {
  const x = setup();
  try {
    const command = x.tools.find((t) => t.name === "run_command")!;
    const values = [
      '<!ENTITY x "a&b">',
      "literal $(echo no) `echo no` !",
      "中文 空格\n下一行",
    ];
    const result = await command.execute(
      "exact-argv",
      {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
          ...values,
        ],
      },
      undefined,
      undefined,
      {} as never,
    );
    const details = result.details as {
      output: string;
      exitCode: number;
      fullOutputPath: string;
    };
    assert.equal(details.exitCode, 0);
    assert.deepEqual(JSON.parse(details.output), values);
    assert.equal(readFileSync(details.fullOutputPath, "utf8"), details.output);
  } finally {
    x.clean();
  }
});

test("a torn log tail cannot swallow the first event after restart", () => {
  const x = setup();
  try {
    const first = x.store.emitEvent(x.run.id, "user_message", {
      text: "Before interruption",
    });
    const file = resolve(x.store.dir(x.run.id), "events.jsonl");
    appendFileSync(file, '{"seq":2,"data":{"text":"torn');
    const restored = new RunStore(x.store.root);
    const next = restored.emitEvent(x.run.id, "user_message", {
      text: "After restart",
    });
    assert.equal(next.seq, first.seq + 1);
    assert.deepEqual(
      restored.events(x.run.id).map((e) => e.data.text),
      ["Before interruption", "After restart"],
    );
    assert.match(readFileSync(file, "utf8"), /torn\n/);
    restored.saveNotes(x.run.id, "Durable note");
    restored.saveReport(x.run.id, "Durable report");
    assert.equal(
      statSync(resolve(restored.dir(x.run.id), "notes.md")).mode & 0o777,
      0o600,
    );
    assert.equal(
      statSync(resolve(restored.dir(x.run.id), "report.md")).mode & 0o777,
      0o600,
    );
  } finally {
    x.clean();
  }
});

test("cancellation kills a running process and retains partial output", async () => {
  const x = setup();
  try {
    const command = x.tools.find((t) => t.name === "run_command")!;
    const controller = new AbortController();
    let pid = 0;
    const result = await command.execute(
      "cancel",
      {
        command: process.execPath,
        args: ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
      },
      controller.signal,
      (partial) => {
        pid = Number((partial.content[0] as { text: string }).text.trim());
        controller.abort();
      },
      {} as never,
    );
    const details = result.details as {
      aborted: boolean;
      output: string;
      fullOutputPath: string;
    };
    assert.equal(details.aborted, true);
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0));
    assert.match(readFileSync(details.fullOutputPath, "utf8"), /\d+/);
  } finally {
    x.clean();
  }
});

test("nonzero exit, timeout and missing executable remain distinguishable", async () => {
  const x = setup();
  try {
    const command = x.tools.find((t) => t.name === "run_command")!;
    const failed = await command.execute(
      "exit",
      { command: process.execPath, args: ["-e", "process.exit(7)"] },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal((failed.details as { exitCode: number }).exitCode, 7);
    assert.equal(
      readFileSync(
        (failed.details as { fullOutputPath: string }).fullOutputPath,
        "utf8",
      ),
      "",
    );
    const timeout = await command.execute(
      "timeout",
      {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutSeconds: 0.1,
      },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal((timeout.details as { timedOut: boolean }).timedOut, true);
    await assert.rejects(
      command.execute(
        "missing",
        { command: "audit-harness-binary-that-does-not-exist" },
        undefined,
        undefined,
        {} as never,
      ),
      /ENOENT/,
    );
  } finally {
    x.clean();
  }
});

test("findings can be revised and ordinary source directories work without git", async () => {
  const x = setup();
  try {
    const finding = x.store.saveFinding(x.run.id, {
      title: "Check",
      description: "Initial",
      severity: "medium",
      status: "candidate",
    });
    x.store.saveFinding(x.run.id, {
      id: finding.id,
      title: "Check",
      description: "Ruled out by control",
      severity: "info",
      status: "dismissed",
    });
    assert.equal(x.store.findings(x.run.id).length, 1);
    assert.equal(x.store.findings(x.run.id)[0].status, "dismissed");
    const repo = await repositoryInfo(x.dir);
    assert.equal(repo.path, x.dir);
    assert.equal(repo.isGit, false);
    assert.throws(
      () => validateConfig({ baseUrl: "file:///etc/passwd" }),
      /HTTP/,
    );
  } finally {
    x.clean();
  }
});
