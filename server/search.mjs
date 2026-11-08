// Search across all sessions of all CLIs: what you typed and what the assistant replied (not
// tool output, thinking or CLI wrappers). The text is kept in memory only — never written to
// disk — and read incrementally like token use: each file once, then only new lines.

import { stat } from "node:fs/promises";
import { cleanUserText } from "./claude-file.mjs";
import { readNewLines } from "./token-usage.mjs";

const MAX_TEXT = 20_000; // per message; longer ones are cut (search still finds their start)

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

const textBlocks = (content, types = /^(text|input_text|output_text)$/) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => typeof b?.text === "string" && types.test(b.type ?? "text"))
          .map((b) => b.text)
          .join("\n")
      : "";

function push(out, role, text, at) {
  const t = String(text ?? "").trim();
  if (t) out.push({ r: role, t: t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t, at });
}

/** Claude Code: typed prompts and reply text. */
export function claudeSearchLine(line, out) {
  if (line.startsWith('{"type":"api-request') || line.startsWith('{"type":"file-history')) return;
  const isUser = line.includes('"type":"user"');
  if (!isUser && !line.includes('"type":"assistant"')) return;
  const e = parse(line);
  if (!e || e.isSidechain || e.isMeta || e.isCompactSummary) return;
  if (e.type === "assistant") {
    push(out, "a", textBlocks(e.message?.content, /^text$/), e.timestamp);
  } else if (e.type === "user") {
    const text = cleanUserText(textBlocks(e.message?.content, /^text$/));
    if (/^<(command-|local-command)/.test(text) || text.startsWith("Caveat:")) return;
    push(out, "u", text, e.timestamp);
  }
}

/** Codex: user and assistant messages, without the wrappers the CLI adds. */
export function codexSearchLine(line, out) {
  if (!line.includes('"type":"response_item"') || !line.includes('"type":"message"')) return;
  const e = parse(line);
  const p = e?.payload;
  if (e?.type !== "response_item" || p?.type !== "message" || (p.role !== "user" && p.role !== "assistant")) return;
  const text = textBlocks(p.content).trim();
  if (p.role === "user" && (/^<([a-z_][\w-]*)[^>]*>[\s\S]*<\/\1>$/i.test(text) || text.startsWith("# AGENTS.md instructions"))) return;
  push(out, p.role === "user" ? "u" : "a", text, e.timestamp);
}

/** Pi: user and assistant messages. */
export function piSearchLine(line, out) {
  if (!line.startsWith('{"type":"message"')) return;
  const e = parse(line);
  const m = e?.message;
  if (m?.role !== "user" && m?.role !== "assistant") return;
  push(out, m.role === "user" ? "u" : "a", textBlocks(m.content, /^text$/), e.timestamp ?? m.timestamp);
}

const READERS = { claude: claudeSearchLine, codex: codexSearchLine, pi: piSearchLine };

/** Words and "quoted phrases", lower-cased. */
export function queryTerms(query) {
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(query ?? "")))) {
    const t = (m[1] ?? m[2]).trim().toLowerCase();
    if (t) terms.push(t);
  }
  return terms.slice(0, 12);
}

/** ~180 characters around the first term, on one line. */
export function snippet(text, terms) {
  const lower = text.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
  const start = Math.max(0, at - 70);
  const end = Math.min(text.length, at + 110);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

export function createSearchIndex() {
  /** file -> { offset, mtimeMs, msgs, lower } */
  const files = new Map();
  let building;
  let progress = { done: 0, total: 0, running: false };

  async function update(meta) {
    const reader = READERS[meta.source ?? "pi"];
    if (!reader || !meta.file) return;
    let s;
    try {
      s = await stat(meta.file);
    } catch {
      return;
    }
    let entry = files.get(meta.file);
    if (!entry || s.size < entry.offset) entry = { offset: 0, mtimeMs: 0, msgs: [], lower: [] };
    if (entry.offset === s.size && entry.mtimeMs === s.mtimeMs) return;
    const added = [];
    entry.offset = await readNewLines(meta.file, entry.offset, (line) => reader(line, added));
    entry.mtimeMs = s.mtimeMs;
    for (const m of added) {
      entry.msgs.push(m);
      entry.lower.push(m.t.toLowerCase());
    }
    files.set(meta.file, entry);
  }

  /** Bring every file up to date (a second call joins the first). */
  function updateAll(metas) {
    building ??= (async () => {
      progress = { done: 0, total: metas.length, running: true };
      for (const meta of metas) {
        try {
          await update(meta);
        } catch {
          // Unreadable: skip it this time.
        }
        progress.done += 1;
      }
    })().finally(() => {
      progress.running = false;
      building = undefined;
    });
    return building;
  }

  /**
   * Sessions with a message containing every term, newest match first.
   * @returns { results: [{ id, source, name, cwd, count, last, hits: [{ role, at, text }] }], truncated }
   */
  function search(metas, query, { limit = 50, perSession = 3 } = {}) {
    const terms = queryTerms(query);
    if (!terms.length) return { terms, results: [] };
    const results = [];
    for (const meta of metas) {
      const entry = files.get(meta.file);
      if (!entry) continue;
      const hits = [];
      let count = 0;
      let last = 0;
      for (let i = entry.lower.length - 1; i >= 0; i--) {
        const lower = entry.lower[i];
        if (!terms.every((t) => lower.includes(t))) continue;
        count += 1;
        const m = entry.msgs[i];
        last = Math.max(last, Date.parse(m.at ?? "") || 0);
        if (hits.length < perSession) hits.push({ role: m.r === "u" ? "user" : "assistant", at: m.at, text: snippet(m.t, terms) });
      }
      if (count) results.push({ id: meta.id, source: meta.source ?? "pi", name: meta.name || meta.preview || "", cwd: meta.cwd, count, last: last || meta.mtimeMs, hits });
    }
    results.sort((a, b) => b.last - a.last);
    return { terms, results: results.slice(0, limit), total: results.length };
  }

  /** Your own messages in these sessions, as { source, t, at } (for prompt suggestions). */
  function* userMessages(metas) {
    for (const meta of metas) {
      const entry = files.get(meta.file);
      if (!entry) continue;
      for (const m of entry.msgs) if (m.r === "u") yield { source: meta.source ?? "pi", t: m.t, at: m.at };
    }
  }

  return { update, updateAll, search, userMessages, progress: () => ({ ...progress }), size: () => files.size };
}
