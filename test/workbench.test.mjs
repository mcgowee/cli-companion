import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  listDir,
  parseNameStatus,
  parseNumstat,
  readFileForView,
  resolveInside,
  reviewDiff,
  reviewStatus,
} from "../server/workbench.mjs";

let root;
let outside;
const run = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });

before(async () => {
  root = await mkdtemp(join(tmpdir(), "companion-wb-"));
  outside = await mkdtemp(join(tmpdir(), "companion-outside-"));
  await writeFile(join(outside, "secret.txt"), "nope");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "README.md"), "# demo\n");
  await writeFile(join(root, "blob.bin"), Buffer.from([1, 0, 2, 3]));
  run("init", "-q", "-b", "main");
  run("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  await writeFile(join(root, "src", "a.ts"), "export const a = 2;\n");
  await writeFile(join(root, "new.txt"), "hello\nworld\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("resolveInside refuses paths that leave the workspace", async () => {
  await assert.rejects(resolveInside(root, "../" + outside.split(/[\\/]/).pop() + "/secret.txt"), { status: 403 });
  // A drive path is refused on Windows; elsewhere "/tmp/x" loses its leading "/" and is looked up
  // inside the workspace instead (still contained), so it isn't found.
  await assert.rejects(resolveInside(root, join(outside, "secret.txt")), { status: process.platform === "win32" ? 400 : 404 });
  assert.ok((await resolveInside(root, "src/a.ts")).endsWith("a.ts"));
});

test("listDir lists folders first and hides .git", async () => {
  const rows = await listDir(root, "");
  assert.deepEqual(rows.map((r) => r.name), ["src", "blob.bin", "new.txt", "README.md"]);
});

test("readFileForView tells text from binary", async () => {
  assert.equal((await readFileForView(root, "README.md")).text, "# demo\n");
  assert.equal((await readFileForView(root, "blob.bin")).kind, "binary");
});

test("reviewStatus lists modified and untracked files with counts", async () => {
  const status = await reviewStatus(root, "uncommitted");
  assert.equal(status.git, true);
  assert.equal(status.branch, "main");
  assert.deepEqual(
    status.files.map((f) => [f.status, f.path]),
    [["?", "new.txt"], ["M", "src/a.ts"]],
  );
  const a = status.files.find((f) => f.path === "src/a.ts");
  assert.deepEqual([a.added, a.removed], [1, 1]);
});

test("reviewDiff gives a unified diff, and untracked files as all added", async () => {
  const diff = await reviewDiff(root, "uncommitted", "src/a.ts");
  assert.match(diff.text, /-export const a = 1;/);
  assert.match(diff.text, /\+export const a = 2;/);
  const added = await reviewDiff(root, "uncommitted", "new.txt");
  assert.match(added.text, /\+hello\n\+world/);
});

test("parsers handle renames", () => {
  assert.deepEqual(parseNameStatus("M\0a.txt\0R100\0old.txt\0new.txt\0"), [
    { status: "M", path: "a.txt" },
    { status: "R", path: "new.txt", from: "old.txt" },
  ]);
  const counts = parseNumstat("1\t2\ta.txt\0" + "0\t0\t\0old.txt\0new.txt\0" + "-\t-\timg.png\0");
  assert.deepEqual(counts.get("a.txt"), { added: 1, removed: 2 });
  assert.deepEqual(counts.get("new.txt"), { added: 0, removed: 0 });
  assert.deepEqual(counts.get("img.png"), { added: null, removed: null });
});
