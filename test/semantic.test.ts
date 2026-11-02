import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, basename } from "node:path";
import { semanticReferences } from "../src/semantic.js";

function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(resolve(tmpdir(), "harness-semantic-"));
  for (const [name, text] of Object.entries(files))
    writeFileSync(resolve(dir, name), text);
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
test("real TS language server resolves aliases and excludes unrelated same-name properties and shadowed bindings", async () => {
  const x = fixture({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include: ["*.ts"],
    }),
    "api.ts":
      "export function save() { return 1; }\nexport class Store { save() { return 2; } }\n",
    "use.ts":
      "import {save as persist, Store} from './api.js';\npersist();\nnew Store().save();\nfunction other(save: () => void) { save(); }\n",
  });
  try {
    const result = await semanticReferences(x.dir, {
      path: "api.ts",
      line: 1,
      column: 18,
    });
    assert.equal(result.mode, "language-server semantic references");
    assert.ok(
      result.references.some(
        (r) => basename(r.path || "") === "use.ts" && r.line === 2,
      ),
    );
    assert.ok(
      !result.references.some(
        (r) => r.line >= 3 && basename(r.path || "") === "use.ts",
      ),
    );
    assert.ok(result.definitions.length > 0);
    const method = await semanticReferences(x.dir, {
      path: "api.ts",
      line: 2,
      column: 24,
    });
    assert.ok(
      method.references.some(
        (r) => basename(r.path || "") === "use.ts" && r.line === 3,
      ),
    );
    assert.ok(
      !method.references.some(
        (r) => basename(r.path || "") === "use.ts" && r.line === 2,
      ),
    );
    x.clean();
  } finally {
    x.clean();
  }
});
test("real Python server follows imported aliases while excluding another same-name method", async () => {
  const x = fixture({
    "pyrightconfig.json": JSON.stringify({ include: ["."] }),
    "api.py":
      "def save():\n    return 1\nclass Store:\n    def save(self):\n        return 2\n",
    "use.py":
      "from api import save as persist\npersist()\nfrom api import Store\nStore().save()\n",
  });
  try {
    const result = await semanticReferences(x.dir, {
      path: "api.py",
      line: 1,
      column: 6,
    });
    assert.ok(
      result.references.some(
        (r) => basename(r.path || "") === "use.py" && r.line === 2,
      ),
    );
    assert.ok(
      !result.references.some(
        (r) => basename(r.path || "") === "use.py" && r.line === 4,
      ),
    );
  } finally {
    x.clean();
  }
});
test("real gopls distinguishes receiver methods", async (t) => {
  const x = fixture({
    "go.mod": "module example.com/semantic\n\ngo 1.23\n",
    "main.go":
      "package semantic\ntype A struct{}\nfunc (A) Save() {}\ntype B struct{}\nfunc (B) Save() {}\nfunc use() { A{}.Save(); B{}.Save() }\n",
  });
  try {
    const result = await semanticReferences(x.dir, {
      path: "main.go",
      line: 3,
      column: 11,
    });
    assert.ok(result.references.some((r) => r.line === 6 && r.column === 18));
    assert.ok(
      !result.references.some(
        (r) => r.line === 5 || (r.line === 6 && r.column > 20),
      ),
    );
  } catch (error) {
    if (String(error).includes("ENOENT")) t.skip("gopls is not installed");
    else throw error;
  } finally {
    x.clean();
  }
});
test("semantic query aborts real indexing promptly and never silently returns text matches", async () => {
  const x = fixture({ "main.ts": "const x=1; console.log(x);" });
  try {
    const controller = new AbortController();
    const task = semanticReferences(
      x.dir,
      { path: "main.ts", line: 1, column: 7 },
      controller.signal,
    );
    controller.abort();
    await assert.rejects(task, /取消|超时|aborted/);
    await assert.rejects(
      semanticReferences(x.dir, { path: "main.ts", line: 0, column: 1 }),
      /line\/column/,
    );
  } finally {
    x.clean();
  }
});
