// End-to-end acceptance: actual model + language server + live upstream sources.
import assert from "node:assert/strict";
import { resolve } from "node:path";
const base = process.env.HARNESS_URL || "http://127.0.0.1:4317";
async function request(path, body) {
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
  const v = await r.json();
  if (!r.ok) throw new Error(v.error);
  return v;
}
const run = await request("/api/runs", {
  repository: resolve("."),
  title: "语义引用与在线修复 · 真实验收",
  goal: '这是新增工具的真实验收。请只读执行：先 read_symbol(path="src/store.ts",symbol="RunStore.saveNotes") 确定光标，再实际调用 semantic_references 查询这个方法的定义和语义引用（列应指向方法名，可先 read 阅读定位）。实际调用 search_fix_sources(query="CVE-2021-23337",repository="lodash/lodash",package="lodash",ecosystem="npm",version="4.17.20",limit=3) 查询 GitHub 与 OSV。再用通告返回的显式 commit 链接调用 read_fix_source，获取真实元数据与 diff 产物。最后保存 audit_notes 并用中文简短说明结果和边界。不要修改源码、不要强行找漏洞、不要安装依赖。在线例子仅验收工具，不代表本项目有 lodash 漏洞。',
});
console.log("真实模型验收：" + base + "/?run=" + run.id);
const seen = new Map();
const c = new AbortController();
const timer = setTimeout(() => c.abort(), 240000);
let ended = false;
try {
  const response = await fetch(`${base}/api/runs/${run.id}/events`, {
    signal: c.signal,
  });
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = "";
  while (!ended) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const block = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const line = block.split("\n").find((x) => x.startsWith("data: "));
      if (!line) continue;
      const e = JSON.parse(line.slice(6));
      if (e.type === "tool_end") {
        console.log(e.data.name, e.data.isError ? "ERROR" : "OK");
        if (!e.data.isError) seen.set(e.data.name, e.data.result.details);
      }
      if (
        e.type === "status" &&
        ["completed", "failed", "stopped", "interrupted"].includes(
          e.data.status,
        )
      ) {
        ended = true;
        break;
      }
    }
  }
  const result = await request("/api/runs/" + run.id);
  assert.equal(result.run.status, "completed", result.run.error);
  const semantic = seen.get("semantic_references");
  assert.ok(semantic?.definitions.length > 0);
  assert.ok(semantic.references.length > 1, "应包含真实跨文件调用");
  const sources = seen.get("search_fix_sources");
  assert.ok(sources?.sources.some((s) => s.cveId === "CVE-2021-23337"));
  assert.ok(sources.sources.some((s) => s.kind === "osv"));
  assert.equal(sources.errors.length, 0, JSON.stringify(sources.errors));
  assert.ok(sources.relatedFixes.some((s) => s.kind === "commit"));
  const source = seen.get("read_fix_source");
  assert.equal(source?.kind, "commit");
  assert.equal(source.patchCaptureComplete, true);
  assert.ok(source.sha);
  for (const name of [
    sources.artifact,
    source.artifact,
    source.patchArtifact,
  ]) {
    const r = await fetch(
      `${base}/api/runs/${run.id}/artifacts/${encodeURIComponent(name)}`,
    );
    assert.equal(r.status, 200);
    assert.ok((await r.text()).length > 0);
  }
  console.log(
    JSON.stringify(
      {
        id: run.id,
        status: result.run.status,
        calls: result.run.toolCalls,
        semanticReferences: semantic.total,
        sources: sources.sources.length,
        explicitFixes: sources.relatedFixes.length,
        commit: source.sha,
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(timer);
  c.abort();
  if (!ended) await request(`/api/runs/${run.id}/stop`, {}).catch(() => {});
}
