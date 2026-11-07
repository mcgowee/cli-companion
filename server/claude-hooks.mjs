// Claude Code hook events → companion events (pure helpers, shared by hooks/claude-hook.mjs
// and the server, so they can be tested without either).
//
// Claude Code passes each hook a JSON object on stdin with session_id, transcript_path, cwd,
// hook_event_name and event-specific fields (prompt, tool_name, tool_input, trigger, source…).

/** The companion event for one hook payload, or undefined for events we ignore. */
export function eventFromHook(payload) {
  const name = payload?.hook_event_name;
  switch (name) {
    case "SessionStart":
      // source "compact" means a compaction just finished.
      return { type: payload.source === "compact" ? "compaction_end" : "session_start", source: payload.source };
    case "UserPromptSubmit":
      return { type: "prompt", prompt: clip(payload.prompt, 4000) };
    case "PreToolUse":
      return { type: "tool", toolName: payload.tool_name, summary: toolSummary(payload.tool_name, payload.tool_input) };
    case "PreCompact":
      return { type: "compaction_start", reason: payload.trigger === "manual" ? "manual" : "threshold" };
    case "Stop":
      return { type: "stop" };
    case "SessionEnd":
      return { type: "shutdown", reason: payload.reason };
    default:
      return undefined;
  }
}

function clip(value, max) {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A short description of a tool call: the path, command or pattern it works on. */
export function toolSummary(name, input) {
  if (!input || typeof input !== "object") return "";
  const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.description;
  return clip(typeof v === "string" ? v : "", 200);
}

/**
 * What the Stop hook prints for queued messages: Claude keeps going with this as its next
 * instruction. No messages → nothing (Claude stops as usual).
 */
export function stopHookOutput(messages) {
  const texts = (messages ?? []).map((m) => (typeof m === "string" ? m : m?.text)).filter((t) => t && t.trim());
  if (!texts.length) return undefined;
  const body = texts.length === 1 ? texts[0] : texts.map((t, i) => `Message ${i + 1}:\n${t}`).join("\n\n");
  return {
    decision: "block",
    reason: `The user sent this from the Pi Companion window. Treat it as their next message:\n\n${body}`,
  };
}
