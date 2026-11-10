import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRemoteRel, checkRemoteRoot, parseRemoteFile, parseRemoteList, remoteFileMax, remoteFileScript, remoteListScript, shQuote } from "../server/remote-files.mjs";
import { WorkbenchError } from "../server/workbench.mjs";

test("remote files: paths are relative, single-quoted, never ..", () => {
  assert.equal(shQuote("a b"), "'a b'");
  assert.equal(shQuote("it's"), `'it'\\''s'`);
  assert.equal(checkRemoteRel(""), ".");
  assert.equal(checkRemoteRel("/src/app/"), "src/app");
  assert.equal(checkRemoteRel("src\\app"), "src/app");
  for (const bad of ["../x", "a/../../x", "C:/x", "a\nb"]) assert.throws(() => checkRemoteRel(bad), WorkbenchError, bad);
  assert.equal(checkRemoteRoot("/home/me/projects/app"), "/home/me/projects/app");
  for (const bad of ["relative", "/a/../b", "C:\\x", ""]) assert.throws(() => checkRemoteRoot(bad), WorkbenchError, bad);
  const list = remoteListScript("/home/me/my app", "src");
  assert.match(list, /cd -- '\/home\/me\/my app'/);
  assert.match(list, /cd -- 'src'/);
  assert.match(list, /case "\$t\/" in "\$r"\/\*\)/, "checks it is still inside after following links");
  assert.match(remoteFileScript("/home/me/app", "it's.txt", 100), /realpath -e -- 'it'\\''s\.txt'/);
  assert.equal(remoteFileMax("a/b.png"), 16 * 1024 * 1024);
  assert.equal(remoteFileMax("a/b.txt"), 1024 * 1024);
});

test("remote files: listings and files parsed like the local ones", () => {
  const rows = parseRemoteList(Buffer.from("OK\nfREADME.md\0dsrc\0d.git\0fa b.txt\0dAssets\0"));
  assert.deepEqual(rows, [
    { name: "Assets", kind: "dir" },
    { name: "src", kind: "dir" },
    { name: "a b.txt", kind: "file" },
    { name: "README.md", kind: "file" },
  ]);
  assert.throws(() => parseRemoteList(Buffer.from("NOROOT\n")), /workspace folder not found/);
  assert.throws(() => parseRemoteList(Buffer.from("OUTSIDE\n")), /outside/);
  assert.deepEqual(parseRemoteFile(Buffer.from("OK 5\nhello"), "a.txt"), { kind: "text", size: 5, text: "hello" });
  assert.equal(parseRemoteFile(Buffer.from("OK 3\na\0b"), "a.bin").kind, "binary");
  assert.equal(parseRemoteFile(Buffer.from("OK 2000000\n"), "a.txt").kind, "too-big");
  const img = parseRemoteFile(Buffer.concat([Buffer.from("OK 3\n"), Buffer.from([1, 2, 3])]), "x.png");
  assert.equal(img.kind, "image");
  assert.equal(img.mimeType, "image/png");
  assert.deepEqual([...img.bytes], [1, 2, 3]);
  assert.throws(() => parseRemoteFile(Buffer.from("NOTFILE\n"), "src"), /not a file/);
});
