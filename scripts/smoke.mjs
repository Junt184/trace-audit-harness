// End-to-end smoke test against a RUNNING local server and a REAL configured model.
import assert from "node:assert/strict";
import { resolve } from "node:path";
const base = process.env.HARNESS_URL || "http://127.0.0.1:4317";
const repository = resolve(process.argv[2] || ".");
async function request(path, body) {
  const response = await fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
assert.equal((await request("/api/health")).ok, true);
const connection = await request("/api/config/test", {});
console.log(`真实连接成功：${connection.model} (${connection.latencyMs}ms)`);
const goal =
  process.env.SMOKE_GOAL ||
  "这是一次真实功能联调。请先调用 project_overview，然后只阅读 src/store.ts，简短检查执行过程记录是否可持久保存。用 audit_notes 保存范围和结论。若有实际证据支持的问题可用 record_finding 记录，没有就如实说明。不要修改目标仓库、不要运行额外扫描，最后用中文汇报。";
const run = await request("/api/runs", {
  title: "真实模型烟雾测试",
  repository,
  goal,
});
console.log(`任务：${base}/?run=${run.id}`);
const start = Date.now();
while (Date.now() - start < 180000) {
  const data = await request("/api/runs/" + run.id);
  if (
    ["completed", "failed", "stopped", "interrupted"].includes(data.run.status)
  ) {
    assert.equal(
      data.run.status,
      "completed",
      data.run.error || data.run.status,
    );
    assert.ok(data.run.sessionFile, "Pi session file was not persisted");
    assert.ok(data.run.toolCalls > 0, "No real tool calls recorded");
    assert.ok(data.report.length > 20, "No model report returned");
    console.log(
      JSON.stringify(
        {
          status: data.run.status,
          tools: data.run.toolCalls,
          findings: data.findings.length,
          inputTokens: data.run.inputTokens,
          outputTokens: data.run.outputTokens,
          reportCharacters: data.report.length,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  await new Promise((accept) => setTimeout(accept, 500));
}
await request(`/api/runs/${run.id}/stop`, {});
throw new Error("180s 内未结束；已发送停止请求，历史留在工作台。");
