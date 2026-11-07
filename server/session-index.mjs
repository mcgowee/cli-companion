// Index of saved Pi sessions, grouped by workspace (the session's cwd).
//
// Session files can be hundreds of MB (images are stored inline), so only the
// head (header + first prompt) and the tail (latest title) of each file are
// read, and results are cached until the file's size or mtime changes.

import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { readClaudeMeta } from "./claude-file.mjs";

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const DEFAULT_NAMES = new Set(["", "New thread", "New session"]);

/** path -> { mtimeMs, size, meta } */
const metaCache = new Map();

async function readRange(handle, position, length) {
  if (length <= 0) return "";
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

function tryJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** First text of a user message, from a parsed entry or (for a cut-off line) the raw text. */
function userText(entry, rawLine) {
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const block = content.find((b) => b?.type === "text" && typeof b.text === "string");
    if (block) return block.text;
  }
  const match = rawLine?.match(/"type":"text","text":"((?:[^"\\]|\\.)*)"/);
  if (match) return tryJson(`"${match[1]}"`) ?? match[1];
  return "";
}

function oneLine(text, max = 120) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Read the metadata of one session file from its head and tail only.
 * Returns undefined when the file has no valid session header.
 */
export async function readSessionMeta(file, stats) {
  const handle = await open(file, "r");
  try {
    const size = stats.size;
    const head = await readRange(handle, 0, Math.min(HEAD_BYTES, size));
    const tailStart = Math.max(HEAD_BYTES, size - TAIL_BYTES);
    const tail = size > HEAD_BYTES ? await readRange(handle, tailStart, size - tailStart) : "";

    const headLines = head.split("\n");
    const header = tryJson(headLines[0]);
    if (!header || header.type !== "session") return undefined;

    let name;
    let preview = "";
    const scan = (lines, { completeFirst, completeLast }) => {
      lines.forEach((line, index) => {
        if (!line) return;
        const complete = (index > 0 || completeFirst) && (index < lines.length - 1 || completeLast);
        const entry = complete ? tryJson(line) : undefined;
        if (entry?.type === "session_info" && typeof entry.name === "string") name = entry.name;
        if (!preview && (entry?.message?.role === "user" || (!entry && line.includes('"role":"user"')))) {
          preview = oneLine(userText(entry, line));
        }
      });
    };
    scan(headLines.slice(1), { completeFirst: true, completeLast: size <= HEAD_BYTES });
    if (tail) scan(tail.split("\n"), { completeFirst: tailStart === HEAD_BYTES, completeLast: true });

    return {
      id: header.id,
      source: "pi",
      cwd: header.cwd ?? "",
      created: header.timestamp,
      name: name && !DEFAULT_NAMES.has(name.trim()) ? name.trim() : undefined,
      preview,
      file,
      size,
      mtimeMs: stats.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

/** All sessions under `sessionsDir` (one folder per workspace), using the cache. */
export async function scanSessions(sessionsDir) {
  let folders;
  try {
    folders = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const seen = new Set();
  const metas = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    let files;
    try {
      files = await readdir(join(sessionsDir, folder.name));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(sessionsDir, folder.name, name);
      seen.add(file);
      try {
        const stats = await stat(file);
        const cached = metaCache.get(file);
        if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
          if (cached.meta) metas.push(cached.meta);
          continue;
        }
        const meta = await readSessionMeta(file, stats);
        metaCache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, meta });
        if (meta) metas.push(meta);
      } catch {
        // Unreadable or vanished mid-scan: skip it this time.
      }
    }
  }
  // Forget files that disappeared from this folder (the cache also holds Claude Code files).
  for (const file of metaCache.keys()) if (file.startsWith(sessionsDir) && !seen.has(file)) metaCache.delete(file);
  return metas;
}

/** Session id prefix that keeps Claude Code sessions apart from Pi sessions. */
export const CLAUDE_PREFIX = "claude:";

/**
 * Claude Code sessions under `projectsDir` (~/.claude/projects/<folder>/<session-id>.jsonl).
 * Subagent transcripts live one level deeper and are not listed. Same cache as Pi sessions.
 */
export async function scanClaudeSessions(projectsDir) {
  let folders;
  try {
    folders = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    let files;
    try {
      files = await readdir(join(projectsDir, folder.name));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(projectsDir, folder.name, name);
      try {
        const stats = await stat(file);
        if (!stats.isFile() || stats.size === 0) continue;
        const cached = metaCache.get(file);
        if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
          if (cached.meta) metas.push(cached.meta);
          continue;
        }
        const handle = await open(file, "r");
        let raw;
        try {
          raw = await readClaudeMeta((position, length) => readRange(handle, position, length), stats.size);
        } finally {
          await handle.close();
        }
        const sessionId = raw.sessionId ?? name.replace(/\.jsonl$/, "");
        const meta = raw.cwd
          ? {
              id: `${CLAUDE_PREFIX}${sessionId}`,
              source: "claude",
              cwd: raw.cwd,
              created: raw.created,
              name: raw.name && !DEFAULT_NAMES.has(raw.name.trim()) ? raw.name.trim() : undefined,
              preview: raw.preview,
              file,
              size: stats.size,
              mtimeMs: stats.mtimeMs,
            }
          : undefined;
        metaCache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, meta });
        if (meta) metas.push(meta);
      } catch {
        // Unreadable or vanished mid-scan: skip it this time.
      }
    }
  }
  return metas;
}

export function workspaceKey(cwd) {
  const trimmed = String(cwd ?? "").replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** Group sessions by workspace; newest activity first at both levels. */
export function groupByWorkspace(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const key = workspaceKey(session.cwd);
    let group = groups.get(key);
    if (!group) {
      group = { key, cwd: session.cwd, name: basename(session.cwd) || session.cwd || "(unknown)", lastActivity: 0, sessions: [] };
      groups.set(key, group);
    }
    group.sessions.push(session);
    group.lastActivity = Math.max(group.lastActivity, session.lastActivity ?? 0);
  }
  for (const group of groups.values()) group.sessions.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  return [...groups.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}
