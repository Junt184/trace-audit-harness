import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceStore } from "../src/workspaces.js";
import { RunStore } from "../src/store.js";
function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), "harness-workspaces-"));
  return {
    dir,
    store: new RunStore(resolve(dir, "runs")),
    workspaces: new WorkspaceStore(resolve(dir, "workspaces.json")),
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}
function run(store: RunStore, repository: string) {
  return store.create({
    repository,
    title: "Legacy audit",
    goal: "Existing audit",
    status: "completed",
    model: "fixture-not-called",
    provider: "fixture-not-called",
    modelConfig: {
      provider: "fixture-not-called",
      baseUrl: "http://127.0.0.1",
      model: "fixture-not-called",
      api: "openai-completions",
      contextWindow: 4096,
      maxTokens: 1024,
    },
    sessionFile: resolve(repository, "saved-session.jsonl"),
  });
}
test("legacy audits migrate by repository without changing evidence, session paths or timestamps", () => {
  const x = fixture();
  try {
    const one = resolve(x.dir, "one"),
      two = resolve(x.dir, "two");
    mkdirSync(one);
    mkdirSync(two);
    const a = run(x.store, one),
      b = run(x.store, one),
      c = run(x.store, two);
    x.store.saveNotes(a.id, "Existing notes");
    x.store.saveReport(a.id, "Existing report");
    x.store.emitEvent(a.id, "user_message", { text: "Existing instruction" });
    const before = ["notes.md", "report.md", "events.jsonl"].map((name) =>
      readFileSync(resolve(x.store.dir(a.id), name), "utf8"),
    );
    x.workspaces.importRuns(x.store);
    assert.equal(x.workspaces.list().length, 2);
    assert.equal(x.store.get(a.id).workspaceId, x.store.get(b.id).workspaceId);
    assert.notEqual(
      x.store.get(a.id).workspaceId,
      x.store.get(c.id).workspaceId,
    );
    assert.equal(x.store.get(a.id).createdAt, a.createdAt);
    assert.equal(x.store.get(a.id).updatedAt, a.updatedAt);
    assert.equal(x.store.get(a.id).sessionFile, a.sessionFile);
    assert.deepEqual(
      ["notes.md", "report.md", "events.jsonl"].map((name) =>
        readFileSync(resolve(x.store.dir(a.id), name), "utf8"),
      ),
      before,
    );
    const metadata = readFileSync(
      resolve(x.store.dir(a.id), "run.json"),
      "utf8",
    );
    x.workspaces.importRuns(x.store);
    assert.equal(
      readFileSync(resolve(x.store.dir(a.id), "run.json"), "utf8"),
      metadata,
    );
  } finally {
    x.clean();
  }
});
test("workspace identity persists and directory aliases do not create duplicate project records", () => {
  const x = fixture();
  try {
    const source = resolve(x.dir, "project"),
      alias = resolve(x.dir, "alias");
    mkdirSync(source);
    symlinkSync(source, alias, "dir");
    const first = x.workspaces.ensure(source, "  支付服务  "),
      same = x.workspaces.ensure(alias, "另一个名称");
    assert.equal(first.id, same.id);
    assert.equal(first.name, "支付服务");
    const restored = new WorkspaceStore(x.workspaces.file);
    assert.deepEqual(restored.get(first.id), first);
    assert.equal(statSync(x.workspaces.file).mode & 0o777, 0o600);
    assert.throws(() => restored.get("missing"), /不存在/);
  } finally {
    x.clean();
  }
});
