import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditWorkspace } from "./types.js";
import type { RunStore } from "./store.js";

export function canonicalRepository(path: string) {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

// A workspace groups audit sessions for one repository. Agent sessions and all
// existing artifacts stay in their original run directories.
export class WorkspaceStore {
  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }
  list(): AuditWorkspace[] {
    return existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8"))
      : [];
  }
  private save(all: AuditWorkspace[]) {
    writeFileSync(this.file + ".tmp", JSON.stringify(all, null, 2), {
      mode: 0o600,
    });
    renameSync(this.file + ".tmp", this.file);
  }
  get(id: string) {
    const workspace = this.list().find((w) => w.id === id);
    if (!workspace) throw new Error("工作空间不存在");
    return workspace;
  }
  ensure(repository: string, name?: string) {
    const path = canonicalRepository(repository),
      all = this.list();
    const existing = all.find((w) => w.repository === path);
    if (existing) return existing;
    const workspace: AuditWorkspace = {
      id: randomUUID(),
      name: name?.trim().slice(0, 100) || basename(path) || path,
      repository: path,
      createdAt: new Date().toISOString(),
    };
    this.save([...all, workspace]);
    return workspace;
  }
  importRuns(store: RunStore) {
    for (const run of store.list()) {
      const workspace = this.ensure(run.repository);
      if (run.workspaceId !== workspace.id)
        store.assignWorkspace(run.id, workspace.id);
    }
  }
}
