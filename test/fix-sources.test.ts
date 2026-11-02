import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseFixUrl, localFixState, getSource } from "../src/fix-sources.js";
test("fix URLs preserve exact commit or PR identity and reject credential destinations", () => {
  assert.equal(
    parseFixUrl(
      "https://github.com/lodash/lodash/commit/3469357cff396a26c363f8c1b5a91dde28ba4b1c",
    ).api,
    "https://api.github.com/repos/lodash/lodash/commits/3469357cff396a26c363f8c1b5a91dde28ba4b1c",
  );
  assert.equal(
    parseFixUrl("https://github.com/owner/repo/pull/42/files").kind,
    "pull_request",
  );
  assert.equal(
    parseFixUrl("https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm").kind,
    "osv",
  );
  assert.throws(() =>
    parseFixUrl("https://github.com.evil.invalid/owner/repo/commit/1234567"),
  );
  assert.throws(() =>
    parseFixUrl("https://user:password@github.com/owner/repo/pull/42"),
  );
});
test("local fix history distinguishes ancestor, missing object and unrelated origin without fetching", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "fix-history-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        dir,
        "-c",
        "user.name=Harness Test",
        "-c",
        "user.email=test@localhost",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  try {
    git("init", "-q");
    git("remote", "add", "origin", "https://github.com/owner/repo.git");
    writeFileSync(resolve(dir, "code"), "first");
    git("add", ".");
    git("commit", "-qm", "first");
    const first = git("rev-parse", "HEAD");
    writeFileSync(resolve(dir, "code"), "second");
    git("commit", "-qam", "second");
    const second = git("rev-parse", "HEAD");
    assert.equal(
      (await localFixState(dir, "owner/repo", first)).isAncestorOfHead,
      true,
    );
    git("checkout", "-q", "--detach", first);
    assert.equal(
      (await localFixState(dir, "owner/repo", second)).isAncestorOfHead,
      false,
    );
    assert.equal(
      (await localFixState(dir, "owner/repo", "f".repeat(40))).state,
      "object_missing",
    );
    assert.equal(
      (await localFixState(dir, "other/repo", first)).state,
      "not_compared",
    );
    assert.equal(git("status", "--porcelain"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("online requests honor pre-cancelled signals without returning successful empty evidence", async () => {
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    getSource("https://api.github.com/advisories", c.signal),
  );
});
