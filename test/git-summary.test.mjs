import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitSummary, parseStatusV2 } from "../server/workbench.mjs";

test("parseStatusV2: branch, ahead/behind, changed (renames count once), untracked", () => {
  const text = [
    "# branch.oid abc",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 a b src/a.js",
    "2 R. N... 100644 100644 100644 a b R100 new.js",
    "old.js",
    "? notes.txt",
    "? tmp/x",
    "",
  ].join("\0");
  assert.deepEqual(parseStatusV2(text), { branch: "main", ahead: 2, behind: 1, changed: 2, untracked: 2 });
});

test("gitSummary: a real repository, and undefined outside one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gitsum-"));
  assert.equal(await gitSummary(dir), undefined);
  const run = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
  run("init", "-q", "-b", "trunk");
  await writeFile(join(dir, "a.txt"), "one\ntwo\n");
  run("add", ".");
  run("commit", "-q", "-m", "first");
  await writeFile(join(dir, "a.txt"), "one\nTWO\nthree\n");
  await writeFile(join(dir, "new.txt"), "x\n");
  const g = await gitSummary(dir);
  assert.equal(g.branch, "trunk");
  assert.deepEqual([g.changed, g.untracked, g.added, g.removed], [1, 1, 2, 1]);
});
