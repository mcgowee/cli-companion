import assert from "node:assert/strict";
import { test } from "node:test";
import { activeBranch, findImage, parseEntries, transcriptItems } from "../server/session-file.mjs";

const lines = [
  { type: "session", version: 3, id: "s1", cwd: "C:\\work\\pi\\x" },
  { type: "model_change", id: "a", parentId: null, provider: "p", modelId: "m" },
  { type: "session_info", id: "b", parentId: "a", name: "My thread" },
  {
    type: "message",
    id: "c",
    parentId: "b",
    message: {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", data: Buffer.from("png!").toString("base64"), mimeType: "image/png" },
      ],
    },
  },
  {
    type: "message",
    id: "d",
    parentId: "c",
    message: {
      role: "assistant",
      provider: "p",
      model: "m",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Reading it." },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.md" } },
      ],
    },
  },
  {
    type: "message",
    id: "e",
    parentId: "d",
    message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "# A" }] },
  },
  { type: "custom_message", id: "f", parentId: "e", customType: "hindsight", content: "hidden", display: false },
  { type: "compaction", id: "g", parentId: "f", summary: "## Goal\nx", firstKeptEntryId: "e", tokensBefore: 5000 },
  // A sibling branch that is not on the active path.
  { type: "message", id: "z", parentId: "b", message: { role: "user", content: "abandoned" } },
];
const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"type":"mess`;

test("parseEntries skips a half-written last line", () => {
  assert.equal(parseEntries(text).length, lines.length);
});

test("activeBranch follows the given leaf, else the last entry", () => {
  const entries = parseEntries(text);
  assert.deepEqual(
    activeBranch(entries, "g").map((entry) => entry.id),
    ["a", "b", "c", "d", "e", "f", "g"],
  );
  assert.deepEqual(
    activeBranch(entries).map((entry) => entry.id),
    ["a", "b", "z"],
  );
});

test("transcriptItems builds user, assistant+tool and compaction items", () => {
  const result = transcriptItems(parseEntries(text), "g");
  assert.equal(result.name, "My thread");
  assert.equal(result.model, "p/m");
  assert.equal(result.cwd, "C:\\work\\pi\\x");
  assert.deepEqual(
    result.items.map((item) => item.kind),
    ["event", "user", "assistant", "compaction"],
  );
  const [, user, assistant, compaction] = result.items;
  assert.equal(user.text, "look at this");
  assert.deepEqual(user.images, [{ ref: "c:1", mimeType: "image/png" }]);
  assert.equal(user.compacted, true);
  assert.equal(assistant.thinking, "hmm");
  assert.equal(assistant.toolCalls[0].name, "read");
  assert.equal(assistant.toolCalls[0].result.output, "# A");
  assert.equal(compaction.tokensBefore, 5000);
  assert.equal(compaction.compacted, false);
});

test("findImage returns the decoded bytes", () => {
  const image = findImage(parseEntries(text), "c:1");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data.toString(), "png!");
  assert.equal(findImage(parseEntries(text), "c:0"), undefined);
});
