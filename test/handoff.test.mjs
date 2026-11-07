import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffBrief, handoffFileName, saveHandoff, sessionMarkdown, touchedFiles } from "../server/handoff.mjs";

const items = [
  { kind: "user", text: "Fix the build on Windows" },
  {
    kind: "assistant",
    text: "Looking at it.",
    toolCalls: [
      { name: "Edit", args: { file_path: "C:\\repo\\a.mjs", old_string: "x" } },
      { name: "Read", args: { file_path: "C:\\repo\\not-written.mjs" } },
      { name: "apply_patch", args: "*** Begin Patch\n*** Update File: src/b.ts\n@@\n*** Add File: src/c.ts\n" },
      { name: "write", args: JSON.stringify({ path: "C:\\repo\\a.mjs" }) },
    ],
  },
  { kind: "user", text: "Now run the tests" },
  { kind: "assistant", text: "All 12 pass." },
];

test("touchedFiles: written/edited paths only, newest last, no repeats", () => {
  assert.deepEqual(touchedFiles(items), ["src/b.ts", "src/c.ts", "C:\\repo\\a.mjs"]);
  assert.deepEqual(touchedFiles([{ kind: "compaction", modifiedFiles: ["x.md"] }]), ["x.md"]);
  assert.deepEqual(touchedFiles(undefined), []);
});

test("handoffBrief: sections from the session itself", () => {
  const md = handoffBrief(
    { items },
    { title: "Build fix", cli: "Codex", assistant: "Codex", cwd: "C:\\repo", file: "C:\\x.jsonl", git: { branch: "main", ahead: 2, changed: 1, untracked: 0, added: 5, removed: 1 } },
    { now: new Date("2026-11-07T15:30:00Z") },
  );
  assert.match(md, /^# Handoff: Build fix\n/);
  assert.match(md, /\*\*Codex\*\* session in `C:\\repo`, 2026-11-07 15:30 UTC/);
  assert.match(md, /Git: branch `main`, 2 commits not pushed; 1 changed/);
  assert.match(md, /## Where it started\n\nFix the build on Windows/);
  assert.match(md, /## Recent conversation[^\n]*\n\n- \*\*You:\*\* Fix the build/);
  assert.match(md, /## Latest exchange\n\n\*\*You:\*\*\n\nNow run the tests\n\n\*\*Codex:\*\*\n\nAll 12 pass\./);
  assert.match(md, /## Files written or edited\n\n- `src\/b.ts`/);
  assert.match(md, /## To continue/);
  assert.ok(!md.includes("not-written.mjs"));
  assert.ok(!/\n\n\n/.test(md), "no double blank lines");
});

test("handoffBrief: compaction summary included, compacted messages left out", () => {
  const md = handoffBrief(
    { items: [{ kind: "user", text: "old", compacted: true }, { kind: "compaction", summary: "We did X." }, { kind: "user", text: "next" }] },
    { title: "t", cli: "Pi" },
  );
  assert.match(md, /## Summary from the last compaction\n\nWe did X\./);
  assert.match(md, /## Where it started\n\nnext/);
});

test("sessionMarkdown: messages and tool calls, in order", () => {
  const md = sessionMarkdown({ items }, { title: "Build fix", cli: "Codex", assistant: "Codex" });
  assert.ok(md.indexOf("Fix the build") < md.indexOf("All 12 pass"));
  assert.match(md, /- tool `Edit`:/);
});

test("handoffFileName: dated slug", () => {
  assert.equal(handoffFileName("Fix the Build!", new Date("2026-11-07T15:30:00Z")), "handoff-2026-11-07-15-30-fix-the-build.md");
  assert.equal(handoffFileName("???", new Date("2026-11-07T15:30:00Z")), "handoff-2026-11-07-15-30-session.md");
});

test("saveHandoff: writes the file and keeps the newest 20", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-"));
  for (let i = 0; i < 22; i++) await writeFile(join(dir, `handoff-2026-01-${String(i + 1).padStart(2, "0")}-00-00-x.md`), "old");
  await writeFile(join(dir, "other.txt"), "keep");
  const file = await saveHandoff(dir, "handoff-2026-11-07-15-30-new.md", "# new\n");
  assert.equal(await readFile(file, "utf8"), "# new\n");
  const names = await readdir(dir);
  assert.equal(names.filter((n) => n.startsWith("handoff-")).length, 20);
  assert.ok(names.includes("other.txt") && names.includes("handoff-2026-11-07-15-30-new.md"));
  assert.ok(!names.includes("handoff-2026-01-01-00-00-x.md"));
});
