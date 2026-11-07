import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeBranch,
  claudeTranscriptItems,
  cleanUserText,
  findClaudeImage,
  parseClaudeLines,
  readClaudeMeta,
} from "../server/claude-file.mjs";

const cwd = "/work/demo";
const L = (o) => JSON.stringify(o);
const lines = [
  L({ type: "queue-operation", operation: "enqueue" }),
  L({ type: "api-request-blob", sessionId: "s", message: "x".repeat(5000) }),
  L({ type: "user", uuid: "u1", parentUuid: null, cwd, sessionId: "s", timestamp: "t1",
    message: { role: "user", content: "Fix the build <system-reminder>secret context</system-reminder>" } }),
  L({ type: "attachment", uuid: "a1", parentUuid: "u1", cwd }),
  L({ type: "user", uuid: "m1", parentUuid: "a1", isMeta: true, message: { role: "user", content: [{ type: "text", text: "skill body" }] } }),
  // One reply split over three lines with the same message id.
  L({ type: "assistant", uuid: "b1", parentUuid: "m1", message: { id: "msg_1", model: "claude-x", content: [{ type: "thinking", thinking: "hmm" }] } }),
  L({ type: "assistant", uuid: "b2", parentUuid: "b1", message: { id: "msg_1", model: "claude-x", content: [{ type: "text", text: "Running tests." }] } }),
  L({ type: "assistant", uuid: "b3", parentUuid: "b2", message: { id: "msg_1", model: "claude-x", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } }),
  L({ type: "user", uuid: "r1", parentUuid: "b3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "1 failing" }], is_error: true }] } }),
  L({ type: "assistant", uuid: "b4", parentUuid: "r1", message: { id: "msg_2", model: "claude-x", content: [{ type: "text", text: "Found it." }] } }),
  L({ type: "system", subtype: "compact_boundary", uuid: "c1", parentUuid: null, logicalParentUuid: "b4", compactMetadata: { trigger: "auto", preTokens: 200000 } }),
  L({ type: "user", uuid: "c2", parentUuid: "c1", isCompactSummary: true, message: { role: "user", content: "Summary: fixing the build." } }),
  L({ type: "user", uuid: "u2", parentUuid: "c2", message: { role: "user", content: "<command-name>/model</command-name><command-args>opus</command-args>" } }),
  L({ type: "user", uuid: "u3", parentUuid: "u2", message: { role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("png!").toString("base64") } },
    { type: "text", text: "look" },
  ] } }),
  L({ type: "user", uuid: "s1", parentUuid: "u3", isSidechain: true, message: { role: "user", content: "subagent prompt" } }),
  L({ type: "custom-title", customTitle: "Build fix", sessionId: "s" }),
].join("\n");

test("parseClaudeLines drops bookkeeping and subagent lines", () => {
  const entries = parseClaudeLines(lines + '\n{"type":"user","uu');
  assert.ok(!entries.some((e) => e.uuid === "s1"));
  assert.ok(!entries.some((e) => e.type === "api-request-blob" || e.type === "queue-operation"));
});

test("claudeBranch follows logicalParentUuid across a compaction", () => {
  const ids = claudeBranch(parseClaudeLines(lines)).map((e) => e.uuid);
  assert.deepEqual(ids, ["u1", "a1", "m1", "b1", "b2", "b3", "r1", "b4", "c1", "c2", "u2", "u3"]);
});

test("claudeTranscriptItems merges reply lines and attaches tool results", () => {
  const t = claudeTranscriptItems(parseClaudeLines(lines));
  assert.equal(t.name, "Build fix");
  assert.equal(t.cwd, cwd);
  assert.equal(t.model, "claude-x");
  assert.deepEqual(t.items.map((i) => i.kind), ["user", "assistant", "assistant", "compaction", "event", "user"]);
  const [user, reply, , compaction, command, imageMsg] = t.items;
  assert.equal(user.text, "Fix the build");
  assert.equal(user.compacted, true);
  assert.equal(reply.thinking, "hmm");
  assert.equal(reply.text, "Running tests.");
  assert.equal(reply.toolCalls[0].name, "Bash");
  assert.equal(reply.toolCalls[0].result.output, "1 failing");
  assert.equal(reply.toolCalls[0].result.isError, true);
  assert.equal(compaction.summary, "Summary: fixing the build.");
  assert.equal(compaction.tokensBefore, 200000);
  assert.equal(command.text, "Command: /model opus");
  assert.deepEqual(imageMsg.images, [{ ref: "u3:0", mimeType: "image/png" }]);
});

test("findClaudeImage decodes an image block", () => {
  const image = findClaudeImage(parseClaudeLines(lines), "u3:0");
  assert.equal(image.data.toString(), "png!");
});

test("cleanUserText strips reminders and paste wrappers", () => {
  assert.equal(cleanUserText('<pasted_content id="a">hi</pasted_content> <system-reminder>x</system-reminder>'), "hi");
});

test("readClaudeMeta reads folder, first prompt and latest title from the ends", async () => {
  const buf = Buffer.from(lines);
  const readRange = async (pos, len) => buf.subarray(pos, pos + len).toString("utf8");
  const meta = await readClaudeMeta(readRange, buf.length);
  assert.equal(meta.cwd, cwd);
  assert.equal(meta.preview, "Fix the build");
  assert.equal(meta.name, "Build fix");
  assert.equal(meta.sessionId, "s");
});
