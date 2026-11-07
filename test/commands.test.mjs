import assert from "node:assert/strict";
import { test } from "node:test";
import { commandFromRequest } from "../server/commands.mjs";

const ID = "123e4567-e89b-12d3-a456-426614174000";

test("paste needs text and keeps the page's id", () => {
  assert.deepEqual(commandFromRequest({ type: "paste", text: "hi", cmdId: ID }), {
    command: { cmdId: ID, type: "paste", text: "hi" },
  });
  assert.equal(commandFromRequest({ type: "paste", text: "   " }).status, 400);
  assert.equal(commandFromRequest({ type: "paste", text: "x".repeat(200_001) }).status, 413);
});

test("type defaults to paste (older pages)", () => {
  assert.equal(commandFromRequest({ text: "hi" }).command.type, "paste");
});

test("peek, clear and submit carry no text", () => {
  for (const type of ["peek", "clear", "submit"]) {
    const { command } = commandFromRequest({ type, text: "ignored", cmdId: ID });
    assert.deepEqual(command, { cmdId: ID, type });
  }
});

test("unknown types and bad ids", () => {
  assert.equal(commandFromRequest({ type: "exec", text: "rm -rf /" }).status, 400);
  const { command } = commandFromRequest({ type: "peek", cmdId: "not-a-uuid" });
  assert.match(command.cmdId, /^[0-9a-f-]{36}$/);
  assert.notEqual(command.cmdId, "not-a-uuid");
});
