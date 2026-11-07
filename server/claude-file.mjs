// Claude Code session transcripts (~/.claude/projects/<folder>/<session-id>.jsonl) turned into
// the same transcript items the page renders for Pi.
//
// Format notes (Claude Code 2.1.x):
// - Each part of an assistant reply (thinking, text, each tool call) is its own line; lines of
//   one reply share message.id and are merged back together here.
// - Tool results arrive in "user" lines as tool_result blocks and attach to their tool call.
// - Lines form a tree through parentUuid. A compaction writes a system "compact_boundary" line
//   whose parentUuid is null; its logicalParentUuid continues the chain, so older history stays.
// - Subagent lines (isSidechain), meta lines (isMeta) and bookkeeping lines are skipped.
// - Files can be hundreds of MB, mostly "api-request…" bookkeeping lines; those are dropped by
//   their first characters without being parsed.

const MAX_TOOL_OUTPUT = 6000;
const MAX_ARGS = 2000;

/** Bookkeeping lines that never matter for the transcript; skipped before JSON.parse. */
const SKIP_PREFIXES = [
  '{"type":"api-request',
  '{"type":"file-history',
  '{"type":"queue-operation"',
  '{"type":"atis-latch"',
  '{"type":"cost-state"',
  '{"type":"tools-used"',
  '{"type":"mode"',
];

/** Parse JSONL text into the entries the transcript needs, slimmed down. */
export function parseClaudeLines(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line || SKIP_PREFIXES.some((p) => line.startsWith(p))) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // half-written last line
    }
    const slim = slimEntry(e);
    if (slim) entries.push(slim);
  }
  return entries;
}

function slimEntry(e) {
  switch (e?.type) {
    case "user":
    case "assistant":
      if (e.isSidechain) return undefined;
      return {
        type: e.type,
        uuid: e.uuid,
        parentUuid: e.parentUuid ?? null,
        timestamp: e.timestamp,
        cwd: e.cwd,
        isMeta: Boolean(e.isMeta),
        isCompactSummary: Boolean(e.isCompactSummary),
        message: {
          id: e.message?.id,
          model: e.message?.model,
          content: e.message?.content,
          stop_reason: e.message?.stop_reason,
        },
      };
    case "system":
      if (e.isSidechain) return undefined;
      return {
        type: "system",
        subtype: e.subtype,
        uuid: e.uuid,
        parentUuid: e.parentUuid ?? null,
        logicalParentUuid: e.logicalParentUuid,
        timestamp: e.timestamp,
        cwd: e.cwd,
        content: typeof e.content === "string" ? e.content : undefined,
        compactMetadata: e.compactMetadata ? { trigger: e.compactMetadata.trigger, preTokens: e.compactMetadata.preTokens } : undefined,
      };
    case "attachment":
      // Only kept as a link in the parent chain.
      return e.isSidechain ? undefined : { type: "attachment", uuid: e.uuid, parentUuid: e.parentUuid ?? null, cwd: e.cwd };
    case "custom-title":
      return { type: "custom-title", title: e.customTitle };
    case "relocated":
      return { type: "relocated", cwd: e.relocatedCwd };
    default:
      return undefined;
  }
}

/** The active branch, oldest first: from the newest line back through parent links. */
export function claudeBranch(entries) {
  const byUuid = new Map();
  let leaf;
  for (const e of entries) {
    if (!e.uuid) continue;
    byUuid.set(e.uuid, e);
    leaf = e;
  }
  const branch = [];
  const seen = new Set();
  for (let e = leaf; e && !seen.has(e.uuid); ) {
    seen.add(e.uuid);
    branch.push(e);
    const parent = e.parentUuid ?? e.logicalParentUuid;
    e = parent ? byUuid.get(parent) : undefined;
  }
  return branch.reverse();
}

function truncate(text, max) {
  if (typeof text !== "string") return { text: "", truncated: false };
  return text.length > max ? { text: `${text.slice(0, max)}\n…`, truncated: true } : { text, truncated: false };
}

function stringifyArgs(input) {
  try {
    return truncate(JSON.stringify(input ?? {}, null, 2), MAX_ARGS).text;
  } catch {
    return "";
  }
}

/** Remove wrappers Claude Code adds around what the person typed. */
export function cleanUserText(text) {
  return String(text ?? "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<\/?pasted_content[^>]*>/g, "")
    .trim();
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function imageRefs(content, uuid) {
  if (!Array.isArray(content)) return [];
  const refs = [];
  content.forEach((b, i) => {
    if (b?.type === "image" && b.source?.type === "base64") refs.push({ ref: `${uuid}:${i}`, mimeType: b.source.media_type });
  });
  return refs;
}

/** A slash command or local command echo: show it as a small event, not as a prompt. */
function commandEvent(text) {
  const name = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (name) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/);
    return `Command: ${name[1].trim()}${args?.[1]?.trim() ? ` ${args[1].trim()}` : ""}`;
  }
  if (/<local-command-(stdout|stderr)>/.test(text) || text.startsWith("Caveat:")) return null; // hide
  return undefined;
}

/** Transcript items for a Claude Code session (same shapes as the Pi transcript). */
export function claudeTranscriptItems(entries) {
  const branch = claudeBranch(entries);
  let name;
  let cwd;
  for (const e of entries) {
    if (e.type === "custom-title" && e.title) name = e.title;
    if (e.type === "relocated" && e.cwd) cwd = e.cwd;
  }

  // Items before the latest compaction are dimmed (the model only sees the summary now).
  let lastBoundary = -1;
  branch.forEach((e, i) => {
    if (e.type === "system" && e.subtype === "compact_boundary") lastBoundary = i;
  });

  const items = [];
  const toolCalls = new Map();
  let model;
  let current; // assistant item being assembled from several lines
  let pendingCompaction;

  branch.forEach((e, index) => {
    if (e.cwd) cwd = cwd ?? e.cwd;
    const compacted = index < lastBoundary;
    const base = { id: e.uuid, timestamp: e.timestamp, compacted };

    if (e.type === "system") {
      current = undefined;
      if (e.subtype === "compact_boundary") {
        pendingCompaction = {
          ...base,
          compacted: false,
          kind: "compaction",
          summary: "",
          tokensBefore: e.compactMetadata?.preTokens,
          readFiles: [],
          modifiedFiles: [],
          trigger: e.compactMetadata?.trigger,
        };
        items.push(pendingCompaction);
      } else if (e.subtype === "api_error") {
        items.push({ ...base, kind: "event", text: "API error (Claude Code retried)" });
      }
      return;
    }

    if (e.type === "assistant") {
      const content = Array.isArray(e.message.content) ? e.message.content : [];
      if (e.message.model && !e.message.model.startsWith("<")) model = e.message.model;
      if (!current || current.messageId !== e.message.id) {
        current = { ...base, kind: "assistant", messageId: e.message.id, text: "", thinking: "", toolCalls: [], model: e.message.model };
        items.push(current);
      }
      for (const b of content) {
        if (b?.type === "text" && b.text) current.text = current.text ? `${current.text}\n\n${b.text}` : b.text;
        if (b?.type === "thinking" && b.thinking) current.thinking = current.thinking ? `${current.thinking}\n\n${b.thinking}` : b.thinking;
        if (b?.type === "tool_use") {
          const call = { id: b.id, name: b.name, args: stringifyArgs(b.input), result: undefined };
          current.toolCalls.push(call);
          toolCalls.set(b.id, call);
        }
      }
      return;
    }

    if (e.type !== "user") return;
    const content = e.message.content;

    // Tool results belong to the reply that made the calls; they don't end it.
    if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) {
      for (const b of content) {
        if (b?.type !== "tool_result") continue;
        const call = toolCalls.get(b.tool_use_id);
        const text = typeof b.content === "string" ? b.content : blockText(b.content);
        const out = truncate(text, MAX_TOOL_OUTPUT);
        const result = {
          output: out.text,
          truncated: out.truncated,
          isError: Boolean(b.is_error),
          images: imageRefs(Array.isArray(b.content) ? b.content : [], e.uuid),
        };
        if (call) call.result = result;
      }
      return;
    }

    current = undefined;
    if (e.isCompactSummary) {
      const summary = cleanUserText(blockText(content));
      if (pendingCompaction && !pendingCompaction.summary) pendingCompaction.summary = summary;
      else items.push({ ...base, kind: "compaction", summary, compacted: false, readFiles: [], modifiedFiles: [] });
      return;
    }
    if (e.isMeta) return;
    const raw = blockText(content);
    const command = commandEvent(raw);
    if (command === null) return;
    if (command) {
      items.push({ ...base, kind: "event", text: command });
      return;
    }
    const text = cleanUserText(raw);
    const images = imageRefs(content, e.uuid);
    if (!text && !images.length) return;
    items.push({ ...base, kind: "user", text, images });
  });

  for (const item of items) delete item.messageId;
  return { cwd, name, model, items };
}

/** The image an `uuid:index` ref points to (user prompt or tool result), or undefined. */
export function findClaudeImage(entries, ref) {
  const [uuid, indexText] = String(ref).split(":");
  const entry = entries.find((e) => e.uuid === uuid);
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return undefined;
  const index = Number(indexText);
  let block = content[index];
  // Images inside a tool result are one level down.
  if (!block || block.type !== "image") {
    for (const b of content) {
      if (b?.type === "tool_result" && Array.isArray(b.content) && b.content[index]?.type === "image") block = b.content[index];
    }
  }
  if (block?.type !== "image" || block.source?.type !== "base64") return undefined;
  return { data: Buffer.from(block.source.data, "base64"), mimeType: block.source.media_type || "image/png" };
}

/**
 * Metadata for the session list from the start and end of the file only: folder, first
 * prompt and latest title. `readRange(position, length)` returns the bytes as a string.
 */
export async function readClaudeMeta(readRange, size) {
  let cwd;
  let preview = "";
  let created;
  let sessionId;
  // Scan forward in chunks: the first lines can be huge bookkeeping lines.
  const CHUNK = 256 * 1024;
  const LIMIT = 4 * 1024 * 1024;
  let carry = "";
  for (let pos = 0; pos < Math.min(size, LIMIT) && !(cwd && preview); pos += CHUNK) {
    const text = carry + (await readRange(pos, Math.min(CHUNK, size - pos)));
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    if (carry.length > 1024 * 1024) carry = ""; // a giant line: skip it
    for (const line of lines) {
      if (!line || SKIP_PREFIXES.some((p) => line.startsWith(p))) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.isSidechain) continue;
      sessionId = sessionId ?? e.sessionId;
      if (e.type === "relocated" && e.relocatedCwd) cwd = cwd ?? e.relocatedCwd;
      if (e.cwd) cwd = cwd ?? e.cwd;
      created = created ?? e.timestamp;
      if (!preview && e.type === "user" && !e.isMeta && !e.isCompactSummary) {
        const raw = blockText(e.message?.content);
        if (raw && commandEvent(raw) === undefined && !(Array.isArray(e.message?.content) && e.message.content.some((b) => b?.type === "tool_result"))) {
          preview = cleanUserText(raw).replace(/\s+/g, " ").slice(0, 120);
        }
      }
    }
  }
  // Latest title from the end of the file.
  let name;
  const tailLen = Math.min(size, 512 * 1024);
  const tail = await readRange(size - tailLen, tailLen);
  for (const line of tail.split("\n")) {
    if (!line.startsWith('{"type":"custom-title"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.customTitle) name = e.customTitle;
    } catch {
      // ignore
    }
  }
  return { cwd, preview, created, sessionId, name };
}
