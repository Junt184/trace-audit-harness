import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AuditAgent } from "../src/agent.js";
import { RunStore } from "../src/store.js";
import { contextSnapshot } from "../src/context.js";
function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), "harness-context-")),
    store = new RunStore(resolve(dir, "runs"));
  const manager = SessionManager.create(dir, resolve(dir, "pi"));
  manager.appendModelChange("audit-model", "fixture");
  manager.appendThinkingLevelChange("off");
  manager.appendMessage({
    role: "user",
    content: "Saved discussion",
    timestamp: Date.now(),
  });
  const assistant = (tokens: number) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Recorded response" }],
    api: "openai-completions" as const,
    provider: "audit-model",
    model: "fixture",
    stopReason: "stop" as const,
    timestamp: Date.now(),
    usage: {
      input: tokens - 200,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  manager.appendMessage(assistant(5000));
  manager.appendMessage({
    role: "user",
    content: "More discussion",
    timestamp: Date.now(),
  });
  manager.appendMessage(assistant(10200));
  const run = store.create({
    title: "Context regression",
    repository: dir,
    goal: "Inspect native SDK context",
    status: "completed",
    model: "fixture",
    provider: "fixture",
    modelConfig: {
      provider: "fixture",
      baseUrl: "http://127.0.0.1:9",
      model: "fixture",
      api: "openai-completions",
      contextWindow: 131072,
      maxTokens: 1024,
    },
    sessionFile: manager.getSessionFile(),
  });
  return {
    dir,
    store,
    run,
    manager,
    assistant,
    agent: new AuditAgent(store),
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test("context statistics restore through the real SDK without modifying the saved session or audit metadata", async () => {
  const x = fixture();
  try {
    const file = x.manager.getSessionFile()!,
      before = readFileSync(file, "utf8"),
      metadata = readFileSync(
        resolve(x.store.dir(x.run.id), "run.json"),
        "utf8",
      );
    const snapshot = await x.agent.contextInfo(x.run.id);
    assert.equal(snapshot.source, "sdk");
    assert.equal(snapshot.tokens, 10200);
    assert.equal(snapshot.contextWindow, 131072);
    assert.equal(snapshot.remainingTokens, 131072 - 10200);
    assert.equal(snapshot.autoCompactionEnabled, true);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(
      readFileSync(resolve(x.store.dir(x.run.id), "run.json"), "utf8"),
      metadata,
    );
    assert.deepEqual(
      await x.agent.contextInfo(x.run.id),
      JSON.parse(JSON.stringify(snapshot)),
    );
  } finally {
    x.clean();
  }
});
test("native post-compaction usage stays unknown until a new response and refreshes when the session changes", async () => {
  const x = fixture();
  try {
    await x.agent.contextInfo(x.run.id);
    x.manager.appendCompaction(
      "Summary for the SDK projection test",
      x.manager.getLeafId()!,
      10200,
    );
    const unknown = await x.agent.contextInfo(x.run.id);
    assert.equal(unknown.tokens, null);
    assert.equal(unknown.percent, null);
    assert.equal(unknown.remainingTokens, null);
    x.manager.appendMessage({
      role: "user",
      content: "Continue after the compaction boundary",
      timestamp: Date.now(),
    });
    x.manager.appendMessage(x.assistant(2200));
    const known = await x.agent.contextInfo(x.run.id);
    assert.equal(known.tokens, 2200);
    assert.notEqual(known.sessionVersion, unknown.sessionVersion);
  } finally {
    x.clean();
  }
});
test("manual compaction refuses active audits before loading or mutating their sessions", () => {
  const x = fixture();
  try {
    x.store.update(x.run.id, { status: "running" });
    const raw = readFileSync(x.manager.getSessionFile()!, "utf8");
    assert.throws(() => x.agent.compact(x.run.id), /审计执行中/);
    assert.equal(readFileSync(x.manager.getSessionFile()!, "utf8"), raw);
    assert.equal(x.agent.isActive(x.run.id), false);
  } finally {
    x.clean();
  }
});
test("unknown context never becomes a fabricated zero after compaction", () => {
  const snapshot = contextSnapshot(
    { tokens: null, contextWindow: 100000, percent: null },
    100000,
    true,
    false,
  );
  assert.equal(snapshot.tokens, null);
  assert.equal(snapshot.remainingTokens, null);
  assert.equal(snapshot.percent, null);
});
