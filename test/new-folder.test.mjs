import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFolderName, makeFolder, WorkbenchError } from "../server/workbench.mjs";

test("checkFolderName: plain names pass, trimmed", () => {
  assert.equal(checkFolderName("  notes "), "notes");
  assert.equal(checkFolderName("My Project 2"), "My Project 2");
  assert.equal(checkFolderName(".config"), ".config");
});

test("checkFolderName: refuses empty, separators, bad characters, reserved and trailing dot", () => {
  for (const bad of ["", "   ", ".", "..", "a/b", "a\\b", "c:", "what?", "x*", 'say"hi"', "a<b", "pipe|", "end.", "con", "NUL.txt", "lpt1", "x".repeat(121), "tab\there"]) {
    assert.throws(() => checkFolderName(bad), WorkbenchError, `should refuse ${JSON.stringify(bad)}`);
  }
});

test("makeFolder: creates inside the parent and returns its relative path", async () => {
  const root = await mkdtemp(join(tmpdir(), "newfolder-"));
  await mkdir(join(root, "docs"));
  assert.equal(await makeFolder(root, "", "drafts"), "drafts");
  assert.equal(await makeFolder(root, "docs", "img"), "docs/img");
  assert.ok((await stat(join(root, "docs", "img"))).isDirectory());
});

test("makeFolder: never overwrites, and stays inside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "newfolder-"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "readme.md"), "hi");
  await assert.rejects(makeFolder(root, "", "docs"), (e) => e instanceof WorkbenchError && e.status === 409);
  await assert.rejects(makeFolder(root, "", "readme.md"), (e) => e instanceof WorkbenchError && e.status === 409);
  await assert.rejects(makeFolder(root, "..", "escape"), (e) => e instanceof WorkbenchError && e.status === 403);
  await assert.rejects(makeFolder(root, "readme.md", "x"), (e) => e instanceof WorkbenchError && e.status === 400);
  await assert.rejects(makeFolder(root, "missing", "x"), (e) => e instanceof WorkbenchError && e.status === 404);
});
