// Codex CLI session files (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl) turned into
// the same transcript items the page renders for Pi.
//
// Format notes (Codex CLI 0.166; built against real files):
// - Every line is { timestamp, type, payload }. type is session_meta (first line: id, cwd),
//   turn_context (model), response_item (what the model saw and said), event_msg (UI events:
//   task_started / task_complete / turn_aborted, token_count, …), or compacted.
// - response_item payload.type: message (role user / assistant / developer, content blocks
//   input_text / output_text / input_image), reasoning (summary blocks; the rest is encrypted),
//   function_call / custom_tool_call / local_shell_call and their *_output, matched by call_id.
// - The first user messages of a session are wrappers the CLI adds (<environment_context>,
//   AGENTS.md instructions); those are hidden. Developer messages are never shown.
// - Bookkeeping lines (world_state, token_usage_record, additional_tools) are large and skipped
//   by their first characters without being parsed.
// - The session's title lives outside the file, in ~/.codex/session_index.jsonl (thread_name).

const MAX_TOOL_OUTPUT = 6000;
const MAX_ARGS = 2000;

// The line's own type comes before its payload object; additional_tools is a payload type.
const SKIP = /^\{[^{]*"type":"(world_state|token_usage_record)"|"payload":\{"type":"additional_tools"/;

/** Parse JSONL text into entries, skipping bookkeeping lines. */
export function parseCodexLines(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line || SKIP.test(line.slice(0, 160))) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object" && e.type) entries.push(e);
    } catch {
      // A cut-off or corrupt line: skip it.
    }
  }
  return entries;
}

function truncate(text, max) {
  if (typeof text !== "string") return { text: "", truncated: false };
  return text.length > max ? { text: `${text.slice(0, max)}\n…`, truncated: true } : { text, truncated: false };
}

/** Text of message or output content: a string, or blocks with .text. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => typeof b?.text === "string" && /^(input_text|output_text|text)$/.test(b.type ?? "text"))
    .map((b) => b.text)
    .join("\n");
}

/** A tool's output in any of the shapes Codex has used: string, { content }, or blocks. */
function outputText(output) {
  if (typeof output === "string") {
    // function_call_output sometimes holds JSON: { output, metadata }.
    if (output.startsWith("{")) {
      try {
        const parsed = JSON.parse(output);
        if (typeof parsed?.output === "string") return parsed.output;
      } catch {
        // plain text that starts with "{"
      }
    }
    return output;
  }
  if (Array.isArray(output)) return contentText(output);
  if (typeof output?.content === "string") return output.content;
  if (Array.isArray(output?.content)) return contentText(output.content);
  return output === undefined ? "" : JSON.stringify(output);
}

/** Wrappers the CLI adds as user messages: a whole message inside one <tag>…</tag>, or AGENTS.md. */
function isWrapper(text) {
  const t = text.trim();
  return /^<([a-z_][\w-]*)[^>]*>[\s\S]*<\/\1>$/i.test(t) || t.startsWith("# AGENTS.md instructions");
}

function imageRefs(content, lineIndex) {
  if (!Array.isArray(content)) return [];
  const refs = [];
  content.forEach((b, i) => {
    const url = typeof b?.image_url === "string" ? b.image_url : b?.image_url?.url;
    const match = typeof url === "string" ? url.match(/^data:(image\/[\w.+-]+);base64,/) : null;
    if (b?.type === "input_image" && match) refs.push({ ref: `${lineIndex}:${i}`, mimeType: match[1] });
  });
  return refs;
}

function toolArgs(p) {
  let text;
  if (p.type === "function_call") {
    try {
      text = JSON.stringify(JSON.parse(p.arguments ?? "{}"), null, 2);
    } catch {
      text = String(p.arguments ?? "");
    }
  } else if (p.type === "local_shell_call") {
    const cmd = p.action?.command;
    text = Array.isArray(cmd) ? cmd.join(" ") : JSON.stringify(p.action ?? {}, null, 2);
  } else {
    text = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {}, null, 2);
  }
  return truncate(text, MAX_ARGS).text;
}

const CALL_TYPES = new Set(["function_call", "custom_tool_call", "local_shell_call", "web_search_call"]);
const OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output", "local_shell_call_output"]);

/** Transcript items for a Codex session (same shapes as the Pi transcript). */
export function codexTranscriptItems(entries) {
  let cwd;
  let model;
  // Items before the latest compaction are dimmed (the model only sees the summary now).
  let lastCompaction = -1;
  entries.forEach((e, i) => {
    if (e.type === "compacted") lastCompaction = i;
  });

  const items = [];
  const calls = new Map();
  let current; // the assistant item tool calls and reasoning attach to
  let pendingThinking = "";

  const assistant = (base) => {
    if (!current) {
      current = { ...base, kind: "assistant", text: "", thinking: pendingThinking, toolCalls: [], model };
      pendingThinking = "";
      items.push(current);
    }
    return current;
  };

  entries.forEach((e, index) => {
    const p = e.payload ?? {};
    const base = { id: p.id ?? `codex-${index}`, timestamp: e.timestamp, compacted: index < lastCompaction };

    if (e.type === "session_meta") {
      cwd = p.cwd ?? cwd;
      return;
    }
    if (e.type === "turn_context") {
      cwd = p.cwd ?? cwd;
      if (typeof p.model === "string") model = p.model;
      return;
    }
    if (e.type === "compacted") {
      current = undefined;
      items.push({ ...base, compacted: false, kind: "compaction", summary: typeof p.message === "string" ? p.message : "", readFiles: [], modifiedFiles: [] });
      return;
    }
    if (e.type === "event_msg") {
      if (p.type === "turn_aborted") {
        current = undefined;
        items.push({ ...base, kind: "event", text: "Interrupted" });
      } else if (p.type === "error" && typeof p.message === "string") {
        items.push({ ...base, kind: "event", text: `Error: ${p.message}` });
      }
      return;
    }
    if (e.type !== "response_item") return;

    if (p.type === "message") {
      if (p.role === "assistant") {
        const text = contentText(p.content);
        if (!text) return;
        // A reply that already has text or tool calls ends here; the next message starts a new one.
        if (current && (current.text || current.toolCalls.length)) current = undefined;
        const item = assistant(base);
        item.text = text;
        return;
      }
      if (p.role !== "user") return;
      const text = contentText(p.content);
      const images = imageRefs(p.content, index);
      if ((!text || isWrapper(text)) && !images.length) return;
      current = undefined;
      pendingThinking = "";
      items.push({ ...base, kind: "user", text: isWrapper(text) ? "" : text, images });
      return;
    }

    if (p.type === "reasoning") {
      const summary = (Array.isArray(p.summary) ? p.summary : [])
        .map((b) => (typeof b?.text === "string" ? b.text : ""))
        .filter(Boolean)
        .join("\n\n");
      if (!summary) return;
      if (current && !current.text && !current.toolCalls.length) current.thinking = [current.thinking, summary].filter(Boolean).join("\n\n");
      else {
        current = undefined;
        pendingThinking = [pendingThinking, summary].filter(Boolean).join("\n\n");
      }
      return;
    }

    if (CALL_TYPES.has(p.type)) {
      const name = p.type === "local_shell_call" ? "shell" : p.type === "web_search_call" ? "web_search" : (p.name ?? "tool");
      const call = { id: p.call_id ?? p.id, name, args: toolArgs(p), result: undefined };
      assistant(base).toolCalls.push(call);
      if (call.id) calls.set(call.id, call);
      return;
    }

    if (OUTPUT_TYPES.has(p.type)) {
      const call = calls.get(p.call_id);
      if (!call) return;
      const out = truncate(outputText(p.output), MAX_TOOL_OUTPUT);
      const failed = /^Script failed|^exec_command failed|^Error:/m.test(out.text.slice(0, 200));
      call.result = { output: out.text, truncated: out.truncated, isError: failed, images: [] };
    }
  });

  return { cwd, model, items };
}

/** The image a `line:block` ref points to (a data URL in a user message), or undefined. */
export function findCodexImage(entries, ref) {
  const [lineText, blockText] = String(ref).split(":");
  const content = entries[Number(lineText)]?.payload?.content;
  const block = Array.isArray(content) ? content[Number(blockText)] : undefined;
  const url = typeof block?.image_url === "string" ? block.image_url : block?.image_url?.url;
  const match = typeof url === "string" ? url.match(/^data:(image\/[\w.+-]+);base64,(.*)$/s) : null;
  return match ? { mimeType: match[1], data: Buffer.from(match[2], "base64") } : undefined;
}

/**
 * Metadata for the session list from the start of the file: id, folder, start time and first
 * prompt. `readRange(position, length)` returns the bytes as a string.
 */
export async function readCodexMeta(readRange, size) {
  let id;
  let cwd;
  let created;
  let preview = "";
  const CHUNK = 256 * 1024;
  const LIMIT = 4 * 1024 * 1024;
  let carry = "";
  for (let pos = 0; pos < Math.min(size, LIMIT) && !(id && preview); pos += CHUNK) {
    const text = carry + (await readRange(pos, Math.min(CHUNK, size - pos)));
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const e of parseCodexLines(lines.join("\n"))) {
      const p = e.payload ?? {};
      if (e.type === "session_meta") {
        id = id ?? p.id ?? p.session_id;
        cwd = cwd ?? p.cwd;
        created = created ?? p.timestamp ?? e.timestamp;
      } else if (!preview && e.type === "response_item" && p.type === "message" && p.role === "user") {
        const t = contentText(p.content);
        if (t && !isWrapper(t)) preview = t.replace(/\s+/g, " ").trim().slice(0, 120);
      }
    }
  }
  return { id, cwd, created, preview };
}

/**
 * Busy or idle from the end of a running session's file: the last task event wins
 * (task_started = working; task_complete or turn_aborted = waiting for you).
 */
export function codexTurnState(tailText) {
  return codexTurn(tailText).state;
}

/**
 * The turn state plus whether a tool call is still open: { state: "busy" | "idle", openCall }.
 * openCall is true when the last tool call has no output yet. Codex writes nothing while it asks
 * you to approve a tool, so an open call plus a quiet file is the only sign of that (a long
 * command looks the same).
 */
export function codexTurn(tailText) {
  let state = "idle";
  const open = new Set();
  for (const line of tailText.split("\n")) {
    const match = line.match(/"type":"event_msg","payload":\{"type":"(task_started|task_complete|turn_aborted)"/);
    if (match) {
      state = match[1] === "task_started" ? "busy" : "idle";
      if (state === "idle") open.clear();
      continue;
    }
    const call = line.match(/"type":"response_item","payload":\{"type":"(function_call|custom_tool_call|function_call_output|custom_tool_call_output)".*?"call_id":"([^"]+)"/);
    if (!call) continue;
    if (call[1].endsWith("_output")) open.delete(call[2]);
    else open.add(call[2]);
  }
  return { state, openCall: state === "busy" && open.size > 0 };
}
