import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { DATA, redactSecrets } from "./config.js";
import type { AuditRun, ContextSnapshot, Finding, RunEvent } from "./types.js";

export class RunStore extends EventEmitter {
  private sequences = new Map<string, number>();
  constructor(readonly root = resolve(DATA, "runs")) {
    super();
    mkdirSync(root, { recursive: true });
  }
  dir(id: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("无效的运行 ID");
    return resolve(this.root, id);
  }
  private writeText(path: string, text: string) {
    writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  private writeJson(path: string, data: unknown) {
    this.writeText(path, JSON.stringify(data, null, 2));
  }
  create(
    input: Omit<
      AuditRun,
      | "id"
      | "createdAt"
      | "updatedAt"
      | "toolCalls"
      | "inputTokens"
      | "outputTokens"
    >,
  ): AuditRun {
    const now = new Date().toISOString();
    const run: AuditRun = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    mkdirSync(this.dir(run.id), { recursive: true });
    this.writeJson(resolve(this.dir(run.id), "run.json"), run);
    this.writeJson(resolve(this.dir(run.id), "findings.json"), []);
    return run;
  }
  get(id: string): AuditRun {
    const file = resolve(this.dir(id), "run.json");
    if (!existsSync(file)) throw new Error("审计任务不存在");
    return JSON.parse(readFileSync(file, "utf8"));
  }
  update(id: string, patch: Partial<AuditRun>) {
    const run = redactSecrets({
      ...this.get(id),
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    this.writeJson(resolve(this.dir(id), "run.json"), run);
    return run;
  }
  assignWorkspace(id: string, workspaceId: string) {
    const run = { ...this.get(id), workspaceId };
    this.writeJson(resolve(this.dir(id), "run.json"), run);
    return run;
  }
  list() {
    return readdirSync(this.root)
      .flatMap((id) => {
        try {
          return [this.get(id)];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  events(id: string, after = 0): RunEvent[] {
    this.get(id);
    const file = resolve(this.dir(id), "events.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const e = JSON.parse(line);
          return e.seq > after ? [e] : [];
        } catch {
          return [];
        }
      });
  }
  emitEvent(id: string, type: string, data: Record<string, unknown>) {
    const file = resolve(this.dir(id), "events.jsonl");
    let previous = this.sequences.get(id);
    if (previous === undefined) {
      // Preserve an interrupted write as its own line before appending a new event.
      // Otherwise the next valid JSON event would be swallowed by the torn tail.
      if (existsSync(file)) {
        const raw = readFileSync(file, "utf8");
        if (raw.length && !raw.endsWith("\n")) appendFileSync(file, "\n");
      }
      previous = this.events(id).at(-1)?.seq || 0;
    }
    const event: RunEvent = {
      seq: previous + 1,
      at: new Date().toISOString(),
      type,
      data: redactSecrets(data),
    };
    this.sequences.set(id, event.seq);
    appendFileSync(file, JSON.stringify(event) + "\n", { mode: 0o600 });
    this.emit(id, event);
    return event;
  }
  findings(id: string): Finding[] {
    return JSON.parse(
      readFileSync(resolve(this.dir(id), "findings.json"), "utf8"),
    );
  }
  saveFinding(
    id: string,
    input: Omit<Finding, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ) {
    const all = this.findings(id);
    const index = input.id ? all.findIndex((f) => f.id === input.id) : -1;
    const now = new Date().toISOString();
    const finding: Finding = redactSecrets({
      ...input,
      id: input.id || `F-${String(all.length + 1).padStart(3, "0")}`,
      createdAt: index >= 0 ? all[index].createdAt : now,
      updatedAt: now,
    });
    if (index >= 0) all[index] = finding;
    else all.push(finding);
    this.writeJson(resolve(this.dir(id), "findings.json"), all);
    this.emitEvent(id, "finding", { finding });
    return finding;
  }
  notes(id: string) {
    const file = resolve(this.dir(id), "notes.md");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }
  saveNotes(id: string, text: string) {
    const clean = redactSecrets(text);
    this.writeText(resolve(this.dir(id), "notes.md"), clean);
    this.emitEvent(id, "notes", { text: clean });
  }
  report(id: string) {
    const file = resolve(this.dir(id), "report.md");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }
  saveReport(id: string, text: string) {
    this.writeText(resolve(this.dir(id), "report.md"), redactSecrets(text));
  }
  context(id: string): ContextSnapshot | undefined {
    const file = resolve(this.dir(id), "context.json");
    return existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : undefined;
  }
  saveContext(id: string, snapshot: ContextSnapshot) {
    this.writeJson(resolve(this.dir(id), "context.json"), snapshot);
    return snapshot;
  }
  recoverInterrupted() {
    for (const run of this.list())
      if (
        ["starting", "running", "stopping", "compacting"].includes(run.status)
      ) {
        this.update(run.id, {
          status: "interrupted",
          endedAt: new Date().toISOString(),
        });
        this.emitEvent(run.id, "status", {
          status: "interrupted",
          message:
            "服务重启中断了本次执行；历史记录和 Pi 会话已保留，可继续审计。",
        });
      }
  }
}
