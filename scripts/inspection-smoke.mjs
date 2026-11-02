// Uses a real configured model, real repository and actual SDK tool events.
import assert from "node:assert/strict";
import { resolve } from "node:path";

const base = process.env.HARNESS_URL || "http://127.0.0.1:4317";
const [repositoryArg, file, symbol] = process.argv.slice(2);
if (!repositoryArg || !file || !symbol)
  throw new Error(
    '用法：npm run smoke:inspection -- "/path/to/repo" "source/file" "Class.method"',
  );
const repository = resolve(repositoryArg);
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
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
const repo = await request(
  "/api/repository?path=" + encodeURIComponent(repository),
);
assert.equal(repo.isGit, true, "此联调需要实际 Git 仓库");
const goal = `这是新增代码定位与版本工具的真实只读联调。仓库 ${repository}，目标文件 ${file}，符号 ${symbol}。请实际调用 git_refs(limit=3)、code_outline(path=目标文件)、read_symbol(path=目标文件,symbol=该符号)、find_references(symbol=该符号,limit=5)、git_history(path=目标文件,limit=1)，再用返回的真实 hash 调用 git_patch(revision=该 hash,path=目标文件,limit=60)。将工具结果用于解释符号范围、候选调用方及这个文件的实际变更。保存简短 audit_notes，最后用中文汇报。无需强行找漏洞，不修改仓库，不拉取、不全仓扫描、不运行额外实验；解释候选引用和本地历史的边界。`;
const run = await request("/api/runs", {
  title: "符号与修复工具 · 真实联调",
  repository,
  goal,
});
console.log(`真实联调：${base}/?run=${run.id}`);
const expected = [
  "code_outline",
  "read_symbol",
  "find_references",
  "git_refs",
  "git_history",
  "git_patch",
];
const success = new Map();
const controller = new AbortController();
let finished = false;
const timeout = setTimeout(() => controller.abort(), 180000);
try {
  const response = await fetch(`${base}/api/runs/${run.id}/events`, {
    signal: controller.signal,
  });
  assert.equal(response.ok, true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const block = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const line = block
        .split("\n")
        .find((value) => value.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      if (
        event.type === "tool_end" &&
        !event.data.isError &&
        expected.includes(event.data.name)
      ) {
        success.set(event.data.name, event.data.result.details);
        console.log(`已验证真实调用：${event.data.name}`);
      }
      if (
        event.type === "status" &&
        ["completed", "failed", "stopped", "interrupted"].includes(
          event.data.status,
        )
      ) {
        finished = true;
        break;
      }
    }
  }
  for (const name of expected)
    assert.ok(success.has(name), `未完成工具：${name}`);
  assert.equal(success.get("read_symbol").found, true);
  assert.equal(success.get("code_outline").engine, "tree-sitter");
  assert.ok(success.get("git_history").commits.length > 0);
  const patch = success.get("git_patch");
  assert.equal(patch.complete, true);
  const artifact = await fetch(
    `${base}/api/runs/${run.id}/artifacts/${encodeURIComponent(patch.artifact)}`,
  );
  assert.equal(artifact.ok, true, `补丁产物无法打开：HTTP ${artifact.status}`);
  assert.ok((await artifact.text()).length > 0);
  const result = await request(`/api/runs/${run.id}`);
  assert.equal(result.run.status, "completed", result.run.error);
  console.log(
    JSON.stringify(
      {
        id: run.id,
        status: result.run.status,
        validatedTools: [...success.keys()],
        calls: result.run.toolCalls,
        reportCharacters: result.report.length,
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(timeout);
  controller.abort();
  if (!finished) await request(`/api/runs/${run.id}/stop`, {}).catch(() => {});
}
