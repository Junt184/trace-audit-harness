// Real-model acceptance on committed controlled sources, using real language servers.
import assert from "node:assert/strict";
import { resolve } from "node:path";
const base = process.env.HARNESS_URL || "http://127.0.0.1:4317";
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
  if (!response.ok) throw Error(value.error || `HTTP ${response.status}`);
  return value;
}
const run = await request("/api/runs", {
  repository: resolve("test/fixtures/call-graph"),
  title: "四语言静态调用图 · 真实模型验收",
  goal: '这是受控样例上的工具链验收，不是漏洞审计。只读执行以下操作：调用 build_call_graph(scope=".", timeoutSeconds=240)，保留返回的 artifact。然后对同一个 artifact 实际调用四次 query_call_graph，参数分别为 symbol="entry",path="php/Use.php"；symbol="entry",path="python/main.py"；symbol="entry",path="go/main.go"；symbol="Main.entry",path="java/src/main/java/sample/Main.java"。四次均 direction="outgoing",transitive=true,limit=20。检查未解析回调、重载和外部边界，不把静态图称为完整运行时图。最后 audit_notes 保存工具返回的统计与限制，用中文简短汇报并给出 viewerUrl。不运行 shell、不写目标源码、不安装依赖；失败明确报告。',
});
console.log(`真实模型验收：${base}/?run=${run.id}`);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 420000);
const results = [];
try {
  const response = await fetch(`${base}/api/runs/${run.id}/events`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    ended = false;
  while (!ended) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const block = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const line = block.split("\n").find((v) => v.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === "tool_end") {
        console.log(event.data.name, event.data.isError ? "ERROR" : "OK");
        results.push(event.data);
      }
      if (
        event.type === "status" &&
        ["completed", "failed", "stopped", "interrupted"].includes(
          event.data.status,
        )
      )
        ended = true;
    }
  }
  await reader.cancel();
  const result = await request(`/api/runs/${run.id}`);
  assert.equal(result.run.status, "completed", result.run.error);
  const success = (name) =>
    results
      .filter((v) => v.name === name && !v.isError)
      .map((v) => v.result.details);
  const built = success("build_call_graph").at(-1);
  assert.ok(built, "真实模型没有成功构图");
  assert.deepEqual(built.errors, []);
  assert.equal(built.servers.length, 4);
  assert.equal(built.coverage.indexedFiles, 9);
  assert.equal(built.coverage.callSites, 13);
  assert.equal(built.edges, 12);
  assert.equal(built.unresolved, 1);
  const queries = success("query_call_graph");
  assert.equal(queries.length, 4);
  for (const [suffix, expected] of [
    ["php/Use.php", 3],
    ["python/main.py", 3],
    ["go/main.go", 2],
    ["java/src/main/java/sample/Main.java", 3],
  ]) {
    const query = queries.find((q) =>
      q.selected.some((n) => n.path.endsWith(suffix)),
    );
    assert.equal(query?.totalEdges, expected, suffix);
    assert.equal(query.freshness, "unchanged");
  }
  const artifact = await fetch(
    `${base}/api/runs/${run.id}/artifacts/${encodeURIComponent(built.artifact)}`,
  );
  assert.equal(artifact.status, 200);
  const graph = await artifact.json();
  assert.equal(graph.schema, 1);
  assert.equal(graph.edges.length, 12);
  assert.equal((await fetch(base + built.viewerUrl)).status, 200);
  const freshness = await request(
    `/api/runs/${run.id}/call-graph-status/${encodeURIComponent(built.artifact)}`,
  );
  assert.equal(freshness.freshness, "unchanged");
  console.log(
    JSON.stringify(
      {
        id: run.id,
        calls: result.run.toolCalls,
        files: built.coverage.indexedFiles,
        callSites: built.coverage.callSites,
        edges: built.edges,
        unresolved: built.unresolved,
        viewer: base + built.viewerUrl,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await request(`/api/runs/${run.id}/stop`, {}).catch(() => {});
  throw error;
} finally {
  clearTimeout(timer);
}
