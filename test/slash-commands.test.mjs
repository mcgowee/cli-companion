import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeCustomCommands, frontMatter, mergeCommands, PI_BUILTINS } from "../server/slash-commands.mjs";

test("frontMatter reads name and description, unquoted", () => {
  assert.deepEqual(frontMatter('---\nname: deploy\ndescription: "Ship it"\nother: x\n---\nBody'), {
    name: "deploy",
    description: "Ship it",
  });
  assert.deepEqual(frontMatter("No front matter"), {});
});

test("claudeCustomCommands finds commands (subfolders as a:b) and skills", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-cmds-"));
  mkdirSync(join(dir, "commands", "git"), { recursive: true });
  writeFileSync(join(dir, "commands", "review.md"), "---\ndescription: Review the diff\n---\nDo it.");
  writeFileSync(join(dir, "commands", "git", "sync.md"), "# Sync\nPull then push.");
  mkdirSync(join(dir, "skills", "notes"), { recursive: true });
  writeFileSync(join(dir, "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: Take notes\n---\n");
  const found = await claudeCustomCommands(dir, "user");
  const byName = Object.fromEntries(found.map((c) => [c.name, c]));
  assert.equal(byName.review.description, "Review the diff");
  assert.equal(byName["git:sync"].description, "Pull then push.");
  assert.equal(byName.notes.source, "user skill");
});

test("claudeCustomCommands is empty for a missing folder", async () => {
  assert.deepEqual(await claudeCustomCommands(join(tmpdir(), "no-such-claude-dir-xyz"), "user"), []);
});

test("mergeCommands keeps the first of a name and sorts", () => {
  const merged = mergeCommands([{ name: "b", description: "first" }], [{ name: "b", description: "second" }, { name: "a" }]);
  assert.deepEqual(merged.map((c) => [c.name, c.description]), [["a", ""], ["b", "first"]]);
  assert.ok(PI_BUILTINS.some((c) => c.name === "compact"));
});
