import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { groupByWorkspace, readSessionMeta, scanSessions } from "../server/session-index.mjs";

let dir;
const line = (value) => `${JSON.stringify(value)}\n`;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "companion-index-"));
  await mkdir(join(dir, "--a--"));
  await mkdir(join(dir, "--b--"));
  // Small session with a title.
  await writeFile(
    join(dir, "--a--", "one.jsonl"),
    line({ type: "session", id: "s1", cwd: "/work/a", timestamp: "2026-11-01T00:00:00Z" }) +
      line({ type: "session_info", id: "x", name: "New thread" }) +
      line({ type: "message", id: "m", message: { role: "user", content: [{ type: "text", text: "Fix the\nbuild please" }] } }) +
      line({ type: "session_info", id: "y", name: "Fix build" }),
  );
  // Big session: an inline image pushes the first prompt past the head, and the rename sits in the tail.
  const big = "A".repeat(200 * 1024);
  await writeFile(
    join(dir, "--b--", "two.jsonl"),
    line({ type: "session", id: "s2", cwd: "/work/b" }) +
      line({
        type: "message",
        id: "m",
        message: { role: "user", content: [{ type: "text", text: "Look at this image" }, { type: "image", data: big }] },
      }) +
      "B".repeat(300 * 1024) +
      "\n" +
      line({ type: "session_info", id: "z", name: "Image review" }),
  );
  await writeFile(join(dir, "--b--", "junk.jsonl"), "not json\n");
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("readSessionMeta takes title and first prompt from a small file", async () => {
  const file = join(dir, "--a--", "one.jsonl");
  const meta = await readSessionMeta(file, await stat(file));
  assert.equal(meta.id, "s1");
  assert.equal(meta.cwd, "/work/a");
  assert.equal(meta.name, "Fix build");
  assert.equal(meta.preview, "Fix the build please");
});

test("readSessionMeta reads only head and tail of a big file", async () => {
  const file = join(dir, "--b--", "two.jsonl");
  const meta = await readSessionMeta(file, await stat(file));
  assert.equal(meta.name, "Image review");
  assert.equal(meta.preview, "Look at this image");
});

test("scanSessions skips files without a session header", async () => {
  const metas = await scanSessions(dir);
  assert.deepEqual(metas.map((m) => m.id).sort(), ["s1", "s2"]);
});

test("groupByWorkspace groups by cwd, newest first", () => {
  const groups = groupByWorkspace([
    { id: "1", cwd: "/work/a", lastActivity: 10 },
    { id: "2", cwd: "/work/b", lastActivity: 30 },
    { id: "3", cwd: "/work/a/", lastActivity: 20 },
  ]);
  assert.deepEqual(groups.map((g) => g.name), ["b", "a"]);
  assert.deepEqual(groups[1].sessions.map((s) => s.id), ["3", "1"]);
});
