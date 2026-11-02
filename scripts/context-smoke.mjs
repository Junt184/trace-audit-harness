// A real model, actual project files, native Pi compaction, then resume the same session.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
const base = process.env.HARNESS_URL || "http://127.0.0.1:4317";
const repository = resolve(".");
const active = (status) =>
  ["starting", "running", "stopping", "compacting"].includes(status);
async function response(path, body) {
  const r = await fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  return { status: r.status, data: await r.json() };
}
async function request(path, body) {
  const r = await response(path, body);
  assert.ok(r.status < 400, r.data.error || `HTTP ${r.status}`);
  return r.data;
}
async function until(label, predicate, timeout = 300000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${label}：等待超时，历史记录保留；不会自动终止其他审计。`);
}
function sessionEntries(file) {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
assert.equal(
  (await request("/api/runs")).filter((r) => active(r.status)).length,
  0,
  "请等待现有任务空闲后运行真实上下文验收",
);
const marker = `context-proof-${randomUUID()}`;
const run = await request("/api/runs", {
  repository,
  title: "上下文压缩 · 真实会话与继续验收",
  goal: `这是上下文管理的真实只读验收。请记住最初验收标记 ${marker}，之后继续对话需要用到。依次用 read 完整阅读 src/agent.ts、src/code.ts、src/semantic.ts、src/fix-sources.ts、src/server.ts、src/tools.ts、public/app.js、public/style.css，用于核对当前项目的组成；每个文件只读一次，如果被截断请补读。最后只简短说明已阅读的文件和边界，不要在最终回答重复验收标记。不要修改源码、不要创建笔记、不要执行扫描或额外命令。`,
});
console.log(`验收任务：${base}/?run=${run.id}&view=trace`);
const path = `/api/runs/${run.id}`;
const seed = await until("真实读取源码", async () => {
  const data = await request(path);
  return !active(data.run.status) && data;
});
assert.equal(seed.run.status, "completed", seed.run.error);
assert.ok(seed.run.toolCalls >= 8, "需要实际读取源码，不能伪造上下文");
const before = await request(path + "/context");
assert.ok(
  before.tokens > 20000,
  `上下文过小，无法有效验收压缩：${before.tokens}`,
);
assert.equal(before.autoCompactionEnabled, true);
assert.equal(
  before.remainingTokens,
  Math.max(0, before.contextWindow - before.tokens),
);
assert.equal(seed.notes, "", "不把验收标记存入会被重新注入的笔记");
const sessionBefore = readFileSync(seed.run.sessionFile, "utf8");
console.log("压缩前：", before.tokens, "/", before.contextWindow);

// Cancellation is a native SDK abort; the saved audit must remain available.
await request(path + "/compact", {});
assert.equal((await response(path + "/compact", {})).status, 409);
assert.equal(
  (await response(path + "/continue", { message: "并发请求应被拒绝" })).status,
  409,
);
await until(
  "压缩开始",
  async () => (await request(path + "/context")).isCompacting,
  20000,
);
await request(path + "/stop", {});
const cancelled = await until("取消压缩", async () => {
  const data = await request(path);
  return !active(data.run.status) && data;
});
assert.equal(cancelled.run.status, "completed");
assert.equal(cancelled.report, seed.report);
assert.equal(
  sessionEntries(seed.run.sessionFile).filter((e) => e.type === "compaction")
    .length,
  0,
  "取消操作不应提交压缩摘要",
);
assert.match((await request(path + "/context")).compactionError || "", /取消/);
console.log("原生取消通过；再次压缩可由 Web 按钮发起。");

assert.equal(
  (await request("/api/runs")).filter((r) => active(r.status)).length,
  0,
  "检测到新审计，保留验收会话并等待其结束后再压缩",
);
if (process.env.MANUAL_COMPACT === "1") {
  console.log("等待在工作台点击「压缩上下文」…");
} else {
  await request(path + "/compact", {
    instructions: "摘要中保留最初验收标记、已阅读范围和实际限制。",
  });
}
const compacted = await until("真实原生压缩", async () => {
  const context = await request(path + "/context");
  const data = await request(path);
  if (!active(data.run.status) && context.lastCompaction)
    return { ...data, context };
  if (
    !active(data.run.status) &&
    context.compactionError &&
    !context.compactionError.includes("取消")
  )
    throw new Error(context.compactionError);
});
assert.equal(compacted.run.status, "completed");
assert.equal(compacted.report, seed.report);
assert.equal(compacted.notes, seed.notes);
assert.deepEqual(compacted.findings, seed.findings);
assert.equal(compacted.context.tokens, null);
assert.equal(compacted.context.percent, null);
assert.equal(compacted.context.remainingTokens, null);
assert.ok(compacted.context.lastCompaction.estimatedTokensAfter > 0);
assert.ok(
  readFileSync(seed.run.sessionFile, "utf8").startsWith(sessionBefore),
  "原始会话是追加保存的",
);
const compaction = sessionEntries(seed.run.sessionFile).find(
  (e) => e.type === "compaction",
);
assert.ok(compaction?.summary?.includes(marker), "真实摘要需保留最初标记");
console.log(
  "压缩后：未知（等待响应校准）；摘要估算",
  compacted.context.lastCompaction.estimatedTokensAfter,
);
console.log("READY_TO_RESUME", run.id);
if (process.env.MANUAL_RESUME === "1") {
  console.log("等待页面继续审计：请原样回答最初的验收标记，不调用任何工具。");
} else {
  await request(path + "/continue", {
    message: "请原样回答我最初给你的验收标记，不调用任何工具。",
  });
}
const resumed = await until("压缩后继续", async () => {
  const data = await request(path);
  return !active(data.run.status) && data.report !== seed.report && data;
});
assert.equal(resumed.run.status, "completed", resumed.run.error);
assert.ok(resumed.report.includes(marker), "压缩后模型应从摘要恢复最初标记");
const after = await request(path + "/context");
assert.ok(after.tokens > 0);
assert.ok(after.tokens < before.tokens, "新的模型 usage 应反映压缩后的上下文");
console.log(
  JSON.stringify(
    {
      id: run.id,
      before: before.tokens,
      estimatedAfter: compacted.context.lastCompaction.estimatedTokensAfter,
      after: after.tokens,
      autoCompactionEnabled: after.autoCompactionEnabled,
      recoveredOriginalMarker: true,
      lifetimeInput: resumed.run.inputTokens,
      lifetimeOutput: resumed.run.outputTokens,
    },
    null,
    2,
  ),
);
