import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frequentPrompts, loadPrompts, PromptError, savePrompts, validatePrompts } from "../server/prompts.mjs";

const clis = new Set(["pi", "claude", "codex"]);

test("validatePrompts: trims, keeps known CLIs only, fills ids, refuses empty or too many", () => {
  const out = validatePrompts([{ text: "  Run the tests\r\n ", label: "  Tests   now ", cli: "claude" }, { text: "x", cli: "nope", id: "keep-me" }], clis);
  assert.equal(out[0].text, "Run the tests");
  assert.equal(out[0].label, "Tests now");
  assert.equal(out[0].cli, "claude");
  assert.match(out[0].id, /^[\w-]+$/);
  assert.equal(out[1].cli, "");
  assert.equal(out[1].id, "keep-me");
  assert.throws(() => validatePrompts([{ text: "  " }], clis), PromptError);
  assert.throws(() => validatePrompts("nope", clis), PromptError);
  assert.throws(() => validatePrompts(Array.from({ length: 101 }, () => ({ text: "a" })), clis), PromptError);
  const dup = validatePrompts([{ id: "a", text: "1" }, { id: "a", text: "2" }], clis);
  assert.notEqual(dup[0].id, dup[1].id);
});

test("loadPrompts / savePrompts round trip; missing file is empty", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "prompts-")), "prompts.json");
  assert.deepEqual(await loadPrompts(file, clis), []);
  const prompts = validatePrompts([{ text: "Continue", cli: "pi" }], clis);
  await savePrompts(file, prompts);
  assert.deepEqual(await loadPrompts(file, clis), prompts);
});

test("frequentPrompts: repeated messages, most used first, without saved ones, commands or CLI notes", () => {
  const m = (t, source = "pi", at = "2026-11-07T10:00:00Z") => ({ t, source, at });
  const messages = [
    m("where are we"),
    m("Where are we?", "claude", "2026-11-07T12:00:00Z"),
    m("where are   we"),
    m("Run the tests please"),
    m("Run the tests please"),
    m("only once here"),
    m("/compact"),
    m("/compact"),
    m("[Request interrupted by user]"),
    m("[Request interrupted by user]"),
    m("ok"),
    m("ok"),
    m("Already saved prompt"),
    m("Already saved prompt"),
  ];
  const out = frequentPrompts(messages, { saved: ["already saved prompt"] });
  assert.deepEqual(
    out.map((g) => [g.text, g.count, g.clis.sort().join("+")]),
    [
      ["Where are we?", 3, "claude+pi"],
      ["Run the tests please", 2, "pi"],
    ],
  );
});
