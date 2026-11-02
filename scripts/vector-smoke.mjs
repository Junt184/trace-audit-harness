import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, basename } from "node:path";
import { vectorSearch } from "../src/vectors.ts";
const dir = mkdtempSync(resolve(tmpdir(), "harness-real-vectors-"));
try {
  writeFileSync(
    resolve(dir, "cancel.ts"),
    '// Stop a running audit by terminating the operating system child process.\nexport function halt(child: {kill:(signal:string)=>void}) { child.kill("SIGKILL"); }\n',
  );
  writeFileSync(
    resolve(dir, "temperature.ts"),
    "// Convert a temperature from Celsius to Fahrenheit.\nexport function fahrenheit(celsius: number) { return celsius * 9 / 5 + 32; }\n",
  );
  const first = await vectorSearch(dir, {
    query: "用户取消任务后终止子进程，停止正在运行的审计",
    limit: 2,
  });
  assert.equal(first.mode, "local-neural-vector-search");
  assert.equal(first.dimension, 384);
  assert.equal(basename(first.results[0].path), "cancel.ts");
  assert.ok(first.results[0].score > first.results[1].score);
  assert.equal(first.embeddedChunks, 2);
  const cached = await vectorSearch(dir, { query: "杀掉子进程" });
  assert.equal(cached.embeddedChunks, 0);
  assert.equal(cached.reusedChunks, 2);
  writeFileSync(
    resolve(dir, "temperature.ts"),
    "// Measures current CPU load.\nexport function load(){ return 0; }",
  );
  const changed = await vectorSearch(dir, { query: "处理器负载" });
  assert.equal(changed.embeddedChunks, 1);
  assert.equal(changed.reusedChunks, 1);
  unlinkSync(resolve(dir, "cancel.ts"));
  const removed = await vectorSearch(dir, { query: "取消子进程" });
  assert.equal(removed.files, 1);
  assert.ok(!removed.results.some((r) => basename(r.path) === "cancel.ts"));
  const c = new AbortController();
  const start = Date.now();
  const pending = vectorSearch(dir, { query: "中途取消" }, c.signal);
  setTimeout(() => c.abort(), 80);
  await assert.rejects(pending, /取消|abort/i);
  assert.ok(Date.now() - start < 3000);
  console.log(
    JSON.stringify(
      {
        model: first.model,
        revision: first.revision,
        dimension: first.dimension,
        crossLanguageTopResult: basename(first.results[0].path),
        scores: first.results.map((r) => r.score),
        incremental: true,
        deletion: true,
        cancellation: true,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
