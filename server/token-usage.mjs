// Token use across all saved sessions, read incrementally: each session file is read once, then
// only the bytes added since. Results are kept in ~/.cli-companion/token-usage.json so a restart
// doesn't read gigabytes again. Only the companion's own file is written.

import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { localDay } from "./usage.mjs";
import { newUsage, publicUsage, USAGE_LINE_READERS } from "./token-lines.mjs";

const CHUNK = 4 * 1024 * 1024;
const CACHE_VERSION = 1;

/** Feed the complete lines of `file` from byte `from` to `reader`; returns the new offset. */
export async function readNewLines(file, from, reader) {
  const handle = await open(file, "r");
  try {
    let offset = from;
    let carry = Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, offset + carry.length);
      if (!bytesRead) break;
      const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : Buffer.from(buffer.subarray(0, bytesRead));
      const end = data.lastIndexOf(10);
      if (end < 0) {
        carry = data; // one long line, not finished in this chunk
        continue;
      }
      for (const line of data.toString("utf8", 0, end).split("\n")) if (line) reader(line.endsWith("\r") ? line.slice(0, -1) : line);
      offset += end + 1;
      carry = data.subarray(end + 1);
    }
    return offset; // a half-written last line is read next time
  } finally {
    await handle.close();
  }
}

export function createTokenTracker({ cacheFile } = {}) {
  /** file -> { source, id, offset, mtimeMs, usage } */
  let files = new Map();
  let loaded;
  let dirty = false;
  let saveTimer;
  let scan; // the running full scan, if any
  let progress = { done: 0, total: 0, running: false };

  async function load() {
    loaded ??= (async () => {
      if (!cacheFile) return;
      try {
        const data = JSON.parse(await readFile(cacheFile, "utf8"));
        if (data?.v === CACHE_VERSION && data.files && typeof data.files === "object") files = new Map(Object.entries(data.files));
      } catch {
        // No cache yet, or unreadable: start over.
      }
    })();
    return loaded;
  }

  function scheduleSave() {
    dirty = true;
    if (!cacheFile || saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = undefined;
      if (!dirty) return;
      dirty = false;
      try {
        const tmp = `${cacheFile}.tmp`;
        await writeFile(tmp, JSON.stringify({ v: CACHE_VERSION, files: Object.fromEntries(files) }));
        await rename(tmp, cacheFile);
      } catch {
        dirty = true; // try again next time
      }
    }, 3000);
    saveTimer.unref?.();
  }

  /** Bring one session's record up to date. meta: { id, source, file }. */
  async function update(meta) {
    await load();
    const reader = USAGE_LINE_READERS[meta.source ?? "pi"];
    if (!reader || !meta.file) return undefined;
    let s;
    try {
      s = await stat(meta.file);
    } catch {
      return files.get(meta.file)?.usage;
    }
    let entry = files.get(meta.file);
    // A file that shrank was rewritten: read it again from the start.
    if (!entry || s.size < entry.offset) entry = { source: meta.source ?? "pi", id: meta.id, offset: 0, mtimeMs: 0, usage: newUsage() };
    if (entry.offset === s.size && entry.mtimeMs === s.mtimeMs) return entry.usage;
    const usage = entry.usage;
    entry.offset = await readNewLines(meta.file, entry.offset, (line) => reader(line, usage));
    entry.mtimeMs = s.mtimeMs;
    entry.id = meta.id;
    files.set(meta.file, entry);
    scheduleSave();
    return usage;
  }

  /** Public usage of one session, up to date. */
  async function forSession(meta) {
    return publicUsage(await update(meta), meta.source ?? "pi");
  }

  /** Bring every session up to date (one at a time; a second call joins the first). */
  function updateAll(metas) {
    scan ??= (async () => {
      progress = { done: 0, total: metas.length, running: true };
      for (const meta of metas) {
        try {
          await update(meta);
        } catch {
          // Unreadable file: skip it this time.
        }
        progress.done += 1;
      }
    })().finally(() => {
      progress.running = false;
      scan = undefined;
    });
    return scan;
  }

  /**
   * Tokens and cost per local day and per CLI, for the Usage page.
   * @param metas the saved-session index (only these files count)
   */
  function summary(metas, { now = Date.now(), days = 30, offsetMin = 0, sources = ["pi", "claude", "codex"] } = {}) {
    const firstDay = localDay(now - (days - 1) * 86_400_000, offsetMin);
    const today = localDay(now, offsetMin);
    const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 });
    const perDay = new Map();
    for (let i = days - 1; i >= 0; i--) perDay.set(localDay(now - i * 86_400_000, offsetMin), Object.fromEntries(sources.map((id) => [id, 0])));
    const bySource = Object.fromEntries(sources.map((id) => [id, blank()]));
    const top = [];
    for (const meta of metas) {
      const source = meta.source ?? "pi";
      const entry = files.get(meta.file);
      if (!entry || !bySource[source]) continue;
      const inRange = blank();
      for (const [hour, b] of Object.entries(entry.usage.hours)) {
        const day = localDay(Date.parse(`${hour}:00:00Z`), offsetMin);
        if (day < firstDay || day > today) continue;
        inRange.input += b.i;
        inRange.output += b.o;
        inRange.cacheRead += b.cr;
        inRange.cacheWrite += b.cw;
        inRange.costUsd += b.c;
        inRange.turns += b.n;
        perDay.get(day)[source] += b.i + b.o + b.cr + b.cw;
      }
      const total = inRange.input + inRange.output + inRange.cacheRead + inRange.cacheWrite;
      if (!total && !inRange.costUsd) continue;
      for (const key of Object.keys(inRange)) bySource[source][key] += inRange[key];
      top.push({ id: meta.id, source, name: meta.name || meta.preview || "", cwd: meta.cwd, tokens: total, output: inRange.output, costUsd: inRange.costUsd, model: entry.usage.model });
    }
    top.sort((a, b) => b.tokens - a.tokens);
    return {
      days,
      firstDay,
      today,
      sources,
      daily: [...perDay].map(([date, counts]) => ({ date, ...counts })),
      bySource,
      topSessions: top.slice(0, 10),
      scanning: progress.running ? { done: progress.done, total: progress.total } : undefined,
    };
  }

  /** What is already known for a file, without reading it (undefined if never read). */
  function peek(file) {
    const entry = files.get(file);
    return entry ? publicUsage(entry.usage, entry.source) : undefined;
  }

  return { load, update, forSession, updateAll, summary, peek, progress: () => ({ ...progress }) };
}
