import express from "express";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { AuditAgent, testConnection } from "./agent.js";
import {
  getConfig,
  DATA,
  PORT,
  publicConfig,
  redactSecrets,
  resolveCredential,
  ROOT,
  saveConfig,
  validateConfig,
} from "./config.js";
import { RunStore } from "./store.js";
import { repositoryInfo } from "./tools.js";
import type { RunEvent } from "./types.js";
import { WorkspaceStore } from "./workspaces.js";
import { callGraphStatus } from "./call-graph.js";

export const store = new RunStore();
store.recoverInterrupted();
const workspaces = new WorkspaceStore(resolve(DATA, "workspaces.json"));
workspaces.importRuns(store);
const agent = new AuditAgent(store);
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(req.hostname)) {
    res
      .status(403)
      .json({ error: "请使用 localhost 或 127.0.0.1 访问本地工作台" });
    return;
  }
  if (
    req.method !== "GET" &&
    req.headers.origin &&
    new URL(req.headers.origin).host !== req.headers.host
  ) {
    res.status(403).json({ error: "请从本机工作台发起请求" });
    return;
  }
  next();
});
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, sdk: "Pi SDK 1.4.0" }),
);
app.get("/api/config", (_req, res) => res.json(publicConfig()));
app.post("/api/config", (req, res) => res.json(saveConfig(req.body)));
app.post("/api/config/test", async (req, res) =>
  res.json(await testConnection(validateConfig(req.body || {}))),
);
app.get("/api/models", async (_req, res) => {
  const config = getConfig();
  const credential = resolveCredential(config);
  if (!credential.key) throw new Error("请先配置 API Key");
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${credential.key}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`供应商模型列表请求失败 (${response.status})`);
  const data = (await response.json()) as { data?: { id: string }[] };
  res.json({ models: data.data || [] });
});
app.get("/api/repository", async (req, res) =>
  res.json(await repositoryInfo(String(req.query.path || ROOT))),
);
app.get("/api/directories", (req, res) => {
  const path = realpathSync(
    String(req.query.path || ROOT).replace(/^~(?=\/|$)/, homedir()),
  );
  const directories = readdirSync(path, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules",
    )
    .map((e) => ({
      name: e.name,
      path: resolve(path, e.name),
      isGit: existsSync(resolve(path, e.name, ".git")),
    }));
  res.json({
    path,
    parent: dirname(path),
    directories: directories.sort((a, b) => a.name.localeCompare(b.name)),
  });
});
app.get("/api/workspaces", (_req, res) => {
  const runs = store.list();
  res.json(
    workspaces.list().map((w) => ({
      ...w,
      runCount: runs.filter((r) => r.workspaceId === w.id).length,
      activeCount: runs.filter(
        (r) =>
          r.workspaceId === w.id &&
          ["starting", "running", "stopping", "compacting"].includes(r.status),
      ).length,
    })),
  );
});
app.post("/api/workspaces", async (req, res) => {
  const repository = realpathSync(
    String(req.body.repository || "")
      .trim()
      .replace(/^~(?=\/|$)/, homedir()),
  );
  if (!statSync(repository).isDirectory())
    throw new Error("请选择代码项目目录");
  res
    .status(201)
    .json(
      workspaces.ensure(
        repository,
        typeof req.body.name === "string" ? req.body.name : undefined,
      ),
    );
});
app.get("/api/runs", (req, res) => {
  const workspace = req.query.workspaceId
    ? workspaces.get(String(req.query.workspaceId))
    : undefined;
  res.json(
    store
      .list()
      .filter((run) => !workspace || run.workspaceId === workspace.id),
  );
});
app.post("/api/runs", async (req, res) => {
  const goal = typeof req.body.goal === "string" ? req.body.goal.trim() : "";
  if (!goal) throw new Error("请填写审计目标");
  const selectedWorkspace = req.body.workspaceId
    ? workspaces.get(String(req.body.workspaceId))
    : undefined;
  const repository = await repositoryInfo(
    selectedWorkspace?.repository || String(req.body.repository || ROOT),
  );
  const workspace = selectedWorkspace || workspaces.ensure(repository.path);
  const config = getConfig();
  if (!resolveCredential(config).key) throw new Error("请先配置模型 API Key");
  const { apiKey: _, ...safeModel } = config;
  const run = store.create({
    title:
      typeof req.body.title === "string" && req.body.title.trim()
        ? req.body.title.trim().slice(0, 100)
        : `${repository.name} · ${goal.slice(0, 35)}`,
    repository: repository.path,
    workspaceId: workspace.id,
    goal,
    status: "starting",
    model: config.model,
    provider: config.provider,
    modelConfig: safeModel,
  });
  store.emitEvent(run.id, "repository", repository);
  agent.launch(run.id, goal);
  res.status(201).json(store.get(run.id));
});
app.get("/api/runs/:id", (req, res) =>
  res.json({
    run: store.get(req.params.id),
    findings: store.findings(req.params.id),
    notes: store.notes(req.params.id),
    report: store.report(req.params.id),
  }),
);
app.get("/api/runs/:id/events", (req, res) => {
  const id = req.params.id;
  store.get(id);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const after = Number(req.headers["last-event-id"] || req.query.after || 0);
  const send = (event: RunEvent) =>
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  // Node dispatch is synchronous: subscribe and replay cannot interleave with model events.
  store.on(id, send);
  for (const event of store.events(id, after)) send(event);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    store.off(id, send);
  });
});
app.post("/api/runs/:id/continue", (req, res) => {
  const id = req.params.id;
  store.get(id);
  if (agent.isActive(id)) {
    res.status(409).json({ error: "该任务仍在运行" });
    return;
  }
  const message =
    typeof req.body.message === "string" ? req.body.message.trim() : "";
  if (!message) throw new Error("请填写继续审计的指令");
  agent.launch(id, message);
  res.status(202).json(store.get(id));
});
app.post("/api/runs/:id/stop", async (req, res) => {
  await agent.stop(req.params.id);
  res.json(store.get(req.params.id));
});
app.get("/api/runs/:id/context", async (req, res) =>
  res.json(await agent.contextInfo(req.params.id)),
);
app.post("/api/runs/:id/compact", (req, res) => {
  const id = req.params.id;
  const run = store.get(id);
  if (
    agent.isActive(id) ||
    ["starting", "running", "stopping", "compacting"].includes(run.status)
  ) {
    res
      .status(409)
      .json({ error: "审计执行中，请先停止或等待完成后压缩上下文" });
    return;
  }
  agent.compact(
    id,
    typeof req.body.instructions === "string"
      ? req.body.instructions.trim() || undefined
      : undefined,
  );
  res.status(202).json(store.get(id));
});
app.get("/api/runs/:id/report", (req, res) => {
  store.get(req.params.id);
  const report = store.report(req.params.id);
  if (!report) {
    res.status(404).json({ error: "尚无可导出的报告" });
    return;
  }
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="audit-${req.params.id.slice(0, 8)}.md"`,
  );
  res.type("text/markdown").send(report);
});
app.get("/api/runs/:id/call-graph-status/:name", async (req, res) => {
  const run = store.get(req.params.id);
  const status = await callGraphStatus(
    run.repository,
    req.params.name,
    store,
    run.id,
    AbortSignal.timeout(15000),
  );
  res.set("Cache-Control", "no-store").json(status);
});
app.get("/api/runs/:id/artifacts/:name", (req, res) => {
  store.get(req.params.id);
  if (basename(req.params.name) !== req.params.name)
    throw new Error("无效的产物名称");
  const path = resolve(store.dir(req.params.id), "artifacts", req.params.name);
  if (!existsSync(path) || !statSync(path).isFile()) {
    res.status(404).json({ error: "产物不存在" });
    return;
  }
  res.type("text/plain").sendFile(path, { dotfiles: "allow" });
});
app.get("/vendor/marked.js", (_req, res) =>
  res.sendFile(resolve(ROOT, "node_modules/marked/lib/marked.esm.js")),
);
app.get("/vendor/purify.js", (_req, res) =>
  res.sendFile(resolve(ROOT, "node_modules/dompurify/dist/purify.es.mjs")),
);
app.use(express.static(resolve(ROOT, "public")));
app.use(
  (
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(400).json(redactSecrets({ error: error.message || "请求失败" }));
  },
);
const server = app.listen(PORT, "127.0.0.1", () =>
  console.log(
    `\n  Audit Harness · Pi SDK\n  Local: http://127.0.0.1:${PORT}\n  Model: ${getConfig().model}\n`,
  ),
);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await agent.stopAll();
  server.close();
  server.closeAllConnections();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
