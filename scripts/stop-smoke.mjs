// Real DeepSeek tool call + real parent/child processes; MANUAL_STOP=1 tests Web controls.
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
const code = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('STOP_PROBE:'+JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>console.log('tick'),1000);`;
const run = await request("/api/runs", {
  repository: resolve("."),
  title: "停止按钮 · 真实父子进程验收",
  goal: `这是停止按钮的真实验收。只调用一次 run_command(command="${process.execPath}",args=["-e",${JSON.stringify(code)}],timeoutSeconds=240)。它会输出探针 PID 并持续等待我点击停止。不要自行结束、不要修改任何源码、不要调用其他工具；等待工具返回即可。`,
});
console.log("停止验收：" + base + "/?run=" + run.id);
const c = new AbortController();
const timer = setTimeout(() => c.abort(), 180000);
let ended = false,
  ready = false;
const events = [];
try {
  const response = await fetch(`${base}/api/runs/${run.id}/events`, {
    signal: c.signal,
  });
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = "";
  while (!ended) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const block = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const line = block.split("\n").find((x) => x.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      events.push(event);
      if (
        event.type === "tool_update" &&
        !ready &&
        JSON.stringify(event.data).includes("STOP_PROBE:")
      ) {
        ready = true;
        console.log("真实进程已启动，可以点击停止");
        if (process.env.MANUAL_STOP !== "1")
          void request(`/api/runs/${run.id}/stop`, {});
      }
      if (event.type === "status") {
        console.log("status:", event.data.status);
        if (["stopped", "completed", "failed"].includes(event.data.status)) {
          ended = true;
          break;
        }
      }
    }
  }
  assert.equal((await request("/api/runs/" + run.id)).run.status, "stopped");
  assert.ok(ready);
  const end = events.find(
    (e) => e.type === "tool_end" && e.data.name === "run_command",
  );
  assert.equal(end?.data.result.details.aborted, true);
  assert.equal(end.data.result.details.timedOut, false);
  const details = end.data.result.details;
  const pids = JSON.parse(/STOP_PROBE:(\{[^}]+\})/.exec(details.output)[1]);
  await new Promise((r) => setTimeout(r, 200));
  for (const pid of Object.values(pids))
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  const stop = events.find(
    (e) => e.type === "status" && e.data.status === "stopping",
  );
  assert.ok(stop);
  assert.ok(!events.some((e) => e.seq > stop.seq && e.type === "tool_start"));
  const logUrl = `${base}/api/runs/${run.id}/artifacts/${encodeURIComponent(details.artifact)}`;
  const before = await (await fetch(logUrl)).text();
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await (await fetch(logUrl)).text(), before);
  console.log(
    JSON.stringify(
      {
        id: run.id,
        status: "stopped",
        pids,
        aborted: details.aborted,
        timedOut: details.timedOut,
        signal: details.signal,
        stableOutput: true,
        manual: process.env.MANUAL_STOP === "1",
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
