import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSearchLine, codexSearchLine, createSearchIndex, piSearchLine, queryTerms, snippet } from "../server/search.mjs";

test("queryTerms: words and quoted phrases, lower-cased", () => {
  assert.deepEqual(queryTerms('Ollama  "time out" GPU'), ["ollama", "time out", "gpu"]);
  assert.deepEqual(queryTerms("   "), []);
});

test("snippet: text around the first match, on one line", () => {
  const text = `${"a ".repeat(100)}the Ollama\nserver ${"b ".repeat(100)}`;
  const s = snippet(text, ["ollama"]);
  assert.ok(s.startsWith("…") && s.endsWith("…"));
  assert.ok(s.includes("the Ollama server"));
});

test("Claude lines: prompts and reply text; no tool results, meta, sidechain or command echoes", () => {
  const out = [];
  const user = (content, extra = {}) => JSON.stringify({ type: "user", timestamp: "t", message: { content }, ...extra });
  claudeSearchLine(user("fix the <system-reminder>x</system-reminder>build"), out);
  claudeSearchLine(user([{ type: "tool_result", content: "secret output" }]), out);
  claudeSearchLine(user("hidden", { isMeta: true }), out);
  claudeSearchLine(user("<command-name>/clear</command-name>"), out);
  claudeSearchLine(JSON.stringify({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "sub" }] } }), out);
  claudeSearchLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Done." }] } }), out);
  assert.deepEqual(out.map((m) => [m.r, m.t]), [["u", "fix the build"], ["a", "Done."]]);
});

test("Codex and Pi lines: messages only, without CLI wrappers", () => {
  const out = [];
  const codex = (role, text) => JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
  codexSearchLine(codex("user", "<environment_context>cwd</environment_context>"), out);
  codexSearchLine(codex("user", "add tests"), out);
  codexSearchLine(codex("developer", "rules"), out);
  codexSearchLine(codex("assistant", "Added."), out);
  piSearchLine(JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello pi" }] } }), out);
  piSearchLine(JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ls output" }] } }), out);
  assert.deepEqual(out.map((m) => m.t), ["add tests", "Added.", "hello pi"]);
});

test("index: all terms in one message, newest first, and new lines are picked up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "search-"));
  const a = join(dir, "a.jsonl");
  const b = join(dir, "b.jsonl");
  const msg = (role, text, at) => JSON.stringify({ type: "message", timestamp: at, message: { role, content: [{ type: "text", text }] } }) + "\n";
  await writeFile(a, msg("user", "Ollama is down", "2026-11-01T10:00:00Z") + msg("assistant", "The timeout is 30 s", "2026-11-01T10:01:00Z"));
  await writeFile(b, msg("user", "ollama timeout again", "2026-11-05T10:00:00Z"));
  const metas = [
    { id: "a", source: "pi", file: a, name: "A" },
    { id: "b", source: "pi", file: b, name: "B" },
  ];
  const ix = createSearchIndex();
  await ix.updateAll(metas);
  let r = ix.search(metas, "ollama timeout");
  assert.deepEqual(r.results.map((x) => x.id), ["b"]); // a has the words, but not in one message
  await appendFile(a, msg("assistant", "Raised the Ollama timeout", "2026-11-06T10:00:00Z"));
  await ix.updateAll(metas);
  r = ix.search(metas, "ollama timeout");
  assert.deepEqual(r.results.map((x) => x.id), ["a", "b"]);
  assert.equal(r.results[0].hits[0].role, "assistant");
});
