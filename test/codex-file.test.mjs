import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexTranscriptItems, codexTurnState, findCodexImage, parseCodexLines, readCodexMeta } from "../server/codex-file.mjs";
import { codexSource } from "../server/sources/codex.mjs";

// Line shapes copied from a real Codex 0.166 session (values made up, big fields shortened).
const ID = "01a1b44e-5a45-75b2-b674-45370b8daaf0";
let ordinal = 0;
const line = (type, payload, t = "2026-11-07T04:40:15.000Z") => JSON.stringify({ timestamp: t, ordinal: ordinal++, type, payload });
const PNG = Buffer.from("fake-png").toString("base64");
const LINES = [
  line("session_meta", { session_id: ID, id: ID, timestamp: "2026-11-07T04:39:56.236Z", cwd: "C:\\work\\codex", cli_version: "0.166.0", base_instructions: { text: "You are Codex…" } }),
  line("event_msg", { type: "task_started", turn_id: "t1" }),
  line("response_item", { type: "additional_tools", id: "at_1", role: "developer", tools: [] }),
  line("response_item", { id: "msg_dev", role: "developer", type: "message", content: [{ type: "input_text", text: "You are Codex…" }] }),
  line("response_item", { id: "msg_env", role: "user", type: "message", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>C:\\work\\codex</cwd>\n</environment_context>" }] }),
  line("world_state", { full: true, state: {} }),
  line("turn_context", { turn_id: "t1", cwd: "C:\\work\\codex", model: "gpt-6.1-sol" }),
  line("response_item", { id: "msg_u1", role: "user", type: "message", content: [{ type: "input_text", text: "Make hello.txt" }, { type: "input_image", image_url: `data:image/png;base64,${PNG}` }] }),
  line("response_item", { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "Plan: write the file." }], encrypted_content: "gAAAA" }),
  line("response_item", { status: "completed", id: "msg_a1", role: "assistant", type: "message", content: [{ type: "output_text", text: "I'll create it.", annotations: [] }], phase: "commentary" }),
  line("response_item", { id: "ctc_1", status: "completed", call_id: "call_1", name: "exec", type: "custom_tool_call", input: "text(await tools.exec_command({cmd:\"Set-Content hello.txt hi\"}));" }),
  line("token_usage_record", { thread_id: ID }),
  line("response_item", { id: "ctco_1", call_id: "call_1", type: "custom_tool_call_output", output: [{ type: "input_text", text: "Script failed\nOutput:\n" }, { type: "input_text", text: "Script error: rejected" }] }),
  line("response_item", { id: "fc_1", call_id: "call_2", name: "shell", type: "function_call", arguments: "{\"command\":[\"dir\"]}" }),
  line("response_item", { id: "fco_1", call_id: "call_2", type: "function_call_output", output: "{\"output\":\"hello.txt\",\"metadata\":{}}" }),
  line("response_item", { status: "completed", id: "msg_a2", role: "assistant", type: "message", content: [{ type: "output_text", text: "Done." }], phase: "final_answer" }),
  line("event_msg", { type: "task_complete", turn_id: "t1" }),
  line("compacted", { message: "Summary of the work so far." }),
  line("response_item", { id: "msg_u2", role: "user", type: "message", content: [{ type: "input_text", text: "Thanks" }] }),
  line("event_msg", { type: "task_started", turn_id: "t2" }),
];
const TEXT = `${LINES.join("\n")}\n`;

test("bookkeeping lines are skipped before parsing", () => {
  const types = parseCodexLines(TEXT).map((e) => e.payload?.type ?? e.type);
  assert.ok(!types.includes("world_state") && !types.includes("additional_tools"));
  assert.equal(parseCodexLines(TEXT).filter((e) => e.type === "token_usage_record").length, 0);
});

test("transcript: prompts, replies, reasoning, tool calls with results, compaction", () => {
  const { cwd, model, items } = codexTranscriptItems(parseCodexLines(TEXT));
  assert.equal(cwd, "C:\\work\\codex");
  assert.equal(model, "gpt-6.1-sol");
  assert.deepEqual(
    items.map((i) => [i.kind, i.text ?? i.summary]),
    [
      ["user", "Make hello.txt"],
      ["assistant", "I'll create it."],
      ["assistant", "Done."],
      ["compaction", "Summary of the work so far."],
      ["user", "Thanks"],
    ],
  );
  const [user, first] = items;
  assert.equal(user.images.length, 1);
  assert.equal(user.compacted, true); // before the compaction
  assert.equal(first.thinking, "Plan: write the file.");
  assert.deepEqual(
    first.toolCalls.map((c) => [c.name, c.result.isError, c.result.output.split("\n")[0]]),
    [
      ["exec", true, "Script failed"],
      ["shell", false, "hello.txt"],
    ],
  );
  assert.match(first.toolCalls[1].args, /"command"/);
  assert.equal(items[4].compacted, false);
});

test("images come back from their data URL", () => {
  const entries = parseCodexLines(TEXT);
  const { items } = codexTranscriptItems(entries);
  const image = findCodexImage(entries, items[0].images[0].ref);
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data.toString(), "fake-png");
});

test("meta from the head of the file; busy or idle from the last task event", async () => {
  const meta = await readCodexMeta(async (pos, len) => TEXT.slice(pos, pos + len), TEXT.length);
  assert.deepEqual(meta, { id: ID, cwd: "C:\\work\\codex", created: "2026-11-07T04:39:56.236Z", preview: "Make hello.txt" });
  assert.equal(codexTurnState(TEXT), "busy");
  assert.equal(codexTurnState(LINES.slice(0, 17).join("\n")), "idle");
});

test("the Codex source scans dated folders and takes titles from session_index.jsonl", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const day = join(home, "sessions", "2026", "11", "06");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-11-06T21-39-56-${ID}.jsonl`), TEXT);
  writeFileSync(join(home, "session_index.jsonl"), `${JSON.stringify({ id: ID, thread_name: "Hello file" })}\n`);
  const source = codexSource({ CODEX_HOME: home });
  assert.equal(source.installed, true);
  const [meta] = await source.scan();
  assert.equal(meta.id, `codex:${ID}`);
  assert.equal(meta.name, "Hello file");
  assert.equal(meta.cwd, "C:\\work\\codex");
  assert.equal(source.resumeCommand(ID), `codex resume ${ID}`);
  assert.deepEqual(await codexSource({ CODEX_HOME: home, CLI_COMPANION_CODEX: "0" }).scan(), []);
});

test("codexTurn: an open tool call (no output yet) while busy", async () => {
  const { codexTurn } = await import("../server/codex-file.mjs");
  const ev = (type) => JSON.stringify({ type: "event_msg", payload: { type } });
  const call = (type, id) => JSON.stringify({ type: "response_item", payload: { type, name: "exec", call_id: id } });
  assert.deepEqual(codexTurn([ev("task_started"), call("custom_tool_call", "c1")].join("\n")), { state: "busy", openCall: true });
  assert.deepEqual(codexTurn([ev("task_started"), call("custom_tool_call", "c1"), call("custom_tool_call_output", "c1")].join("\n")), { state: "busy", openCall: false });
  assert.deepEqual(codexTurn([ev("task_started"), call("function_call", "f1"), ev("turn_aborted")].join("\n")), { state: "idle", openCall: false });
});
