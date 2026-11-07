import assert from "node:assert/strict";
import { test } from "node:test";
import { eventFromHook, stopHookOutput, toolSummary } from "../server/claude-hooks.mjs";

test("hook payloads map to companion events", () => {
  assert.deepEqual(eventFromHook({ hook_event_name: "UserPromptSubmit", prompt: "fix it" }), { type: "prompt", prompt: "fix it" });
  assert.deepEqual(eventFromHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }), {
    type: "tool",
    toolName: "Bash",
    summary: "npm test",
  });
  assert.equal(eventFromHook({ hook_event_name: "PreCompact", trigger: "auto" }).type, "compaction_start");
  assert.equal(eventFromHook({ hook_event_name: "SessionStart", source: "compact" }).type, "compaction_end");
  assert.equal(eventFromHook({ hook_event_name: "SessionStart", source: "startup" }).type, "session_start");
  assert.equal(eventFromHook({ hook_event_name: "Notification" }), undefined);
});

test("toolSummary picks the most useful field", () => {
  assert.equal(toolSummary("Read", { file_path: "a.ts" }), "a.ts");
  assert.equal(toolSummary("Grep", { pattern: "foo" }), "foo");
  assert.equal(toolSummary("X", null), "");
});

test("stopHookOutput blocks only when something is queued", () => {
  assert.equal(stopHookOutput([]), undefined);
  assert.equal(stopHookOutput([{ text: "  " }]), undefined);
  const one = stopHookOutput([{ text: "run the tests" }]);
  assert.equal(one.decision, "block");
  assert.match(one.reason, /run the tests$/);
  assert.match(stopHookOutput([{ text: "a" }, { text: "b" }]).reason, /Message 1:\na\n\nMessage 2:\nb/);
});
