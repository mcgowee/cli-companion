// Turns a Pi session JSONL file into transcript items for the companion page.
// Pi's file is the source of truth: every entry has an id and a parentId, and
// the active branch is the chain from the leaf back to the root.

const MAX_TOOL_OUTPUT = 6000;
const MAX_ARGS = 2000;

/** Parse JSONL text. A bad or half-written last line is skipped, not fatal. */
export function parseEntries(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Pi may be mid-write; the next read will have it.
    }
  }
  return entries;
}

/** The active branch, root first. `leafId` comes from the live CLI when known. */
export function activeBranch(entries, leafId) {
  const byId = new Map();
  for (const entry of entries) {
    if (entry && typeof entry.id === "string" && entry.type !== "session") byId.set(entry.id, entry);
  }
  let leaf = leafId ? byId.get(leafId) : undefined;
  if (!leaf) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry && entry.type !== "session" && byId.has(entry.id)) {
        leaf = entry;
        break;
      }
    }
  }
  const branch = [];
  const seen = new Set();
  for (let entry = leaf; entry && !seen.has(entry.id); entry = byId.get(entry.parentId)) {
    seen.add(entry.id);
    branch.push(entry);
  }
  return branch.reverse();
}

function truncate(text, max) {
  if (typeof text !== "string") return { text: "", truncated: false };
  return text.length > max
    ? { text: `${text.slice(0, max)}\n…`, truncated: true }
    : { text, truncated: false };
}

function stringifyArgs(args) {
  if (args === undefined) return "";
  try {
    return truncate(typeof args === "string" ? args : JSON.stringify(args, null, 2), MAX_ARGS).text;
  } catch {
    return String(args);
  }
}

/** Split content into text and image refs (image data stays on disk). */
function contentParts(content, entryId) {
  if (typeof content === "string") return { text: content, images: [] };
  const texts = [];
  const images = [];
  if (Array.isArray(content)) {
    content.forEach((block, index) => {
      if (!block || typeof block !== "object") return;
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      if (block.type === "image") images.push({ ref: `${entryId}:${index}`, mimeType: block.mimeType });
    });
  }
  return { text: texts.join("\n"), images };
}

/**
 * Transcript items for the active branch. Entries before the latest compaction's kept range
 * are marked `compacted` (the model no longer sees them) but still shown.
 */
export function transcriptItems(entries, leafId) {
  const branch = activeBranch(entries, leafId);
  const header = entries.find((entry) => entry && entry.type === "session");

  let compactedBefore = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "compaction") {
      const keptIndex = branch.findIndex((entry) => entry.id === branch[i].firstKeptEntryId);
      compactedBefore = keptIndex >= 0 ? keptIndex : i;
      break;
    }
  }

  const items = [];
  const toolCallsById = new Map();
  let name;
  let model;

  branch.forEach((entry, index) => {
    const compacted = index < compactedBefore && entry.type !== "compaction";
    const base = { id: entry.id, timestamp: entry.timestamp, compacted };
    switch (entry.type) {
      case "session_info":
        if (typeof entry.name === "string") name = entry.name;
        return;
      case "model_change":
        model = `${entry.provider}/${entry.modelId}`;
        items.push({ ...base, kind: "event", text: `Model: ${model}` });
        return;
      case "compaction":
        items.push({
          ...base,
          kind: "compaction",
          summary: entry.summary ?? "",
          tokensBefore: entry.tokensBefore,
          readFiles: entry.details?.readFiles ?? [],
          modifiedFiles: entry.details?.modifiedFiles ?? [],
        });
        return;
      case "branch_summary":
        items.push({ ...base, kind: "summary", label: "Branch summary", summary: entry.summary ?? "" });
        return;
      case "custom_message": {
        if (!entry.display) return;
        const parts = contentParts(entry.content, entry.id);
        items.push({ ...base, kind: "custom", customType: entry.customType, ...parts });
        return;
      }
      case "message":
        break;
      default:
        return;
    }

    const message = entry.message;
    if (!message) return;
    if (message.role === "user") {
      items.push({ ...base, kind: "user", ...contentParts(message.content, entry.id) });
    } else if (message.role === "assistant") {
      const texts = [];
      const thinking = [];
      const toolCalls = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === "text" && block.text) texts.push(block.text);
        if (block?.type === "thinking" && block.thinking) thinking.push(block.thinking);
        if (block?.type === "toolCall") {
          const call = {
            id: block.id,
            name: block.name,
            args: stringifyArgs(block.arguments),
            result: undefined,
          };
          toolCalls.push(call);
          toolCallsById.set(block.id, call);
        }
      }
      if (message.model) model = `${message.provider}/${message.model}`;
      items.push({
        ...base,
        kind: "assistant",
        text: texts.join("\n\n"),
        thinking: thinking.join("\n\n"),
        toolCalls,
        model: message.model ? `${message.provider}/${message.model}` : undefined,
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
      });
    } else if (message.role === "toolResult") {
      const parts = contentParts(message.content, entry.id);
      const output = truncate(parts.text, MAX_TOOL_OUTPUT);
      const result = {
        output: output.text,
        truncated: output.truncated,
        isError: Boolean(message.isError),
        durationMs: message.durationMs,
        images: parts.images,
      };
      const call = toolCallsById.get(message.toolCallId);
      if (call) {
        call.result = result;
      } else {
        items.push({ ...base, kind: "orphanToolResult", toolName: message.toolName, ...result });
      }
    } else if (message.role === "bashExecution") {
      const output = truncate(message.output ?? "", MAX_TOOL_OUTPUT);
      items.push({ ...base, kind: "bash", command: message.command ?? "", output: output.text });
    }
  });

  return { cwd: header?.cwd, sessionId: header?.id, name, model, items };
}

/** The image block an `entryId:index` ref points to, or undefined. */
export function findImage(entries, ref) {
  const [entryId, indexText] = String(ref).split(":");
  const index = Number(indexText);
  const entry = entries.find((candidate) => candidate && candidate.id === entryId);
  const content = entry?.message?.content ?? entry?.content;
  const block = Array.isArray(content) ? content[index] : undefined;
  if (!block || block.type !== "image" || typeof block.data !== "string") return undefined;
  return { data: Buffer.from(block.data, "base64"), mimeType: block.mimeType || "image/png" };
}
