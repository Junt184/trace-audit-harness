// Live Pi/DeepSeek + actual DokuWiki source + canonical upstream sources.
// A second, explicitly labelled controlled Git sample verifies real script regression.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
const base = process.env.HARNESS_URL || "http://127.0.0.1:4317";
const repositoryArg = process.argv[2];
if (!repositoryArg)
  throw new Error("用法：npm run smoke:research -- /path/to/dokuwiki");
const repository = resolve(repositoryArg);
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
  assert.ok(r.ok, v.error || String(r.status));
  return v;
}
async function wait(id) {
  const deadline = Date.now() + 480000;
  while (Date.now() < deadline) {
    const d = await request("/api/runs/" + id);
    if (
      !["starting", "running", "stopping", "compacting"].includes(d.run.status)
    ) {
      assert.equal(d.run.status, "completed", d.run.error || d.run.status);
      return d;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error("验收超时，任务与证据保留，请从工作台检查");
}
function tools(id) {
  return readFileSync(
    resolve(".audit-harness/runs", id, "events.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "tool_end");
}
const active = (await request("/api/runs")).filter((r) =>
  ["starting", "running", "stopping", "compacting"].includes(r.status),
);
assert.equal(active.length, 0, "等待现有审计空闲后再运行真实模型验收");
const upstream =
  "https://github.com/lodash/lodash/commit/3469357cff396a26c363f8c1b5a91dde28ba4b1c";
const run = await request("/api/runs", {
  repository,
  title: "PHP · 调用图/向量/上游证据真实验收",
  goal: `这是 Harness 新工具的真实只读验收，不要求发现漏洞，也不要修改原仓库。请依次实际调用：code_outline 与 read_symbol 定位 inc/auth.php 的 auth_login，再用准确光标调用 semantic_references；semantic_search(scope="inc/auth.php",query="用户登录认证与会话校验",limit=2)；build_call_graph(scope="inc/auth.php",timeoutSeconds=180)，再 query_call_graph 查询 auth_login 的传递去向，limit=10。实际 read_fix_source 读取 https://github.com/huggingface/transformers.js/issues/324 （includeComments=true）和 https://gist.github.com/paulirish/1579671 （不请求评论，正文即可）。verify_fix_source(url="${upstream}",claimUrl="https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm",expectedRepository="lodash/lodash",expectedCommit="3469357cff396a26c363f8c1b5a91dde28ba4b1c")。check_fix_applicability(url="${upstream}",evidenceFiles=["VERSION"],conditions=[{description:"核对实际 PHP 文件和 Node 验证运行时",command:"${process.execPath}",args:["-e","const fs=require('fs');if(!fs.existsSync('inc/auth.php'))process.exit(1);console.log(process.version+' AUTH_SOURCE_PRESENT');"],expectedExitCode:0,expectedOutput:"AUTH_SOURCE_PRESENT"}])。在线 Lodash 例子只验收资料链，不代表 DokuWiki 受其影响；正确保留仓库不同/补丁不匹配等边界。若工具失败说明原因，不编造成功；最后 audit_notes 保存事实与限制并简短中文回答。`,
});
console.log("真实项目验收：" + base + "/?run=" + run.id + "&view=trace");
await wait(run.id);
const done = tools(run.id);
const successful = (name) =>
  done
    .filter((e) => e.data.name === name && !e.data.isError)
    .map((e) => e.data.result?.details);
for (const name of [
  "code_outline",
  "read_symbol",
  "semantic_references",
  "semantic_search",
  "build_call_graph",
  "query_call_graph",
  "read_fix_source",
  "verify_fix_source",
  "check_fix_applicability",
])
  assert.ok(successful(name).length, "没有成功实际调用 " + name);
assert.ok(
  successful("semantic_references").some(
    (r) => r.language === "php" && r.references.length > 0,
  ),
);
assert.ok(
  successful("semantic_search").some(
    (r) => r.dimension === 384 && r.results.length > 0,
  ),
);
const graph = successful("build_call_graph").at(-1);
assert.ok(graph.nodes > 0 && graph.edges > 0);
assert.equal(graph.coverage.runtimeComplete, false);
const sources = successful("read_fix_source");
assert.ok(sources.some((r) => r.kind === "issue" && r.body.length > 0));
assert.ok(
  sources.some(
    (r) => r.kind === "gist" && r.files.some((f) => f.content.length > 0),
  ),
);
const verified = successful("verify_fix_source").at(-1);
assert.equal(verified.checks.repositoryMatches, true);
assert.equal(verified.checks.commitMatches, true);
assert.equal(verified.checks.claimExplicitlyLinksSource, true);
assert.equal(
  successful("check_fix_applicability").at(-1).conditions[0].satisfied,
  true,
);
for (const artifact of [graph.artifact, verified.artifact])
  assert.ok(
    (await fetch(base + `/api/runs/${run.id}/artifacts/${artifact}`)).ok,
  );
console.log(
  "LIVE_PROJECT_PASS",
  JSON.stringify({ id: run.id, graph, verification: verified.checks }),
);
const fixture = resolve(".audit-harness/validation/patch-regression");
if (existsSync(fixture))
  throw Error("受控回归样例目录已存在；保留旧证据，请选择新目录后再运行");
mkdirSync(fixture, { recursive: true });
writeFileSync(
  resolve(fixture, "package.json"),
  JSON.stringify({
    name: "controlled-path-regression",
    private: true,
    type: "module",
  }),
);
writeFileSync(
  resolve(fixture, "path.js"),
  "import path from 'node:path';\nexport function isWithin(root, target) { return path.resolve(target).startsWith(path.resolve(root)); }\n",
);
const git = (...args) =>
  execFileSync(
    "git",
    [
      "-C",
      fixture,
      "-c",
      "user.name=Harness Validation",
      "-c",
      "user.email=validation@localhost",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
git("init", "-q");
git("add", ".");
git("commit", "-qm", "controlled before");
const before = git("rev-parse", "HEAD");
writeFileSync(
  resolve(fixture, "path.js"),
  "import path from 'node:path';\nexport function isWithin(root, target) { const rel = path.relative(path.resolve(root), path.resolve(target)); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); }\n",
);
git("commit", "-qam", "controlled fix");
const after = git("rev-parse", "HEAD");
const original = readFileSync(resolve(fixture, "path.js"), "utf8");
const regression = await request("/api/runs", {
  repository: fixture,
  title: "受控真实 Git 样例 · 补丁前后脚本回归",
  goal: `这是受控 Git 源码的工具验收，不是对第三方项目的漏洞结论。请 read 阅读 path.js，再查看 git_patch(base="${before}",revision="${after}")。自行编写真实 Node 断言脚本，覆盖正常子目录、根目录本身和根前缀相同但实际不同目录的越界路径。调用 compare_patch(base="${before}",revision="${after}",command="${process.execPath}",args=["probe.mjs"],files=[{path:"probe.mjs",content:你写的相同脚本}],expectedBeforeExitCode=1,expectedAfterExitCode=0)。检查实际前后结果，再用 audit_notes 保存事实与边界；不修改当前工作树。`,
});
console.log("受控回归验收：" + base + "/?run=" + regression.id + "&view=trace");
await wait(regression.id);
const compared = tools(regression.id)
  .filter((e) => e.data.name === "compare_patch" && !e.data.isError)
  .at(-1)?.data.result?.details;
assert.ok(compared);
assert.equal(compared.expectationsMet, true);
assert.equal(compared.runs.before.result.exitCode, 1);
assert.equal(compared.runs.after.result.exitCode, 0);
assert.equal(readFileSync(resolve(fixture, "path.js"), "utf8"), original);
assert.equal(git("status", "--porcelain"), "");
console.log(
  "LIVE_REGRESSION_PASS",
  JSON.stringify({
    id: regression.id,
    artifact: compared.artifact,
    before: compared.runs.before.result.exitCode,
    after: compared.runs.after.result.exitCode,
    originalUnchanged: true,
  }),
);
