// Codex CLI, read-only: transcripts from ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, titles
// from ~/.codex/session_index.jsonl. Running: Codex holds ~/.codex/thread-writer-locks/<id>.lock
// while a session is loaded (on Windows a read of a held lock fails with EBUSY); busy or idle then
// comes from the last task event in the transcript. The lock is held by Codex's background
// app-server, which keeps a session loaded for a while after its window quits, so a held lock alone
// isn't enough: with N Codex windows open (codex.exe processes outside the app-server's folder),
// busy sessions plus the most recently written idle ones, up to N in all, count as running.

import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { codexTranscriptItems, codexTurnFromFile, findCodexImage, parseCodexLines, readCodexMeta } from "../codex-file.mjs";
import { appendingJsonlReader, isUnderDir } from "../fsutil.mjs";
import { mergeCommands } from "../slash-commands.mjs";

const PREFIX = "codex:";
const DEFAULT_NAMES = new Set(["", "New thread", "New session"]);

/** Common Codex built-ins (0.166). Codex doesn't expose its list, so this is a fixed copy. */
export const CODEX_BUILTINS = [
  ["model", "Choose what model and reasoning effort to use"],
  ["permissions", "Choose what Codex is allowed to do"],
  ["review", "Review my current changes and find issues"],
  ["new", "Start a new chat during a conversation"],
  ["resume", "Resume a saved chat"],
  ["fork", "Fork the current chat"],
  ["rename", "Rename the current thread"],
  ["init", "Create an AGENTS.md file with instructions for Codex"],
  ["compact", "Summarize conversation to prevent hitting the context limit"],
  ["plan", "Switch to Plan mode"],
  ["diff", "Show git diff (including untracked files)"],
  ["mention", "Mention a file"],
  ["status", "Show current session configuration and token usage"],
  ["mcp", "List MCP tools"],
  ["skills", "Use skills to improve how Codex performs specific tasks"],
  ["copy", "Copy the last response"],
  ["clear", "Clear the terminal and start a new chat"],
  ["feedback", "Send logs to maintainers"],
  ["logout", "Log out of Codex"],
  ["quit", "Exit Codex"],
].map(([name, description]) => ({ name, description, source: "builtin" }));

async function readRange(handle, position, length) {
  if (length <= 0) return "";
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

/** All rollout-*.jsonl files under the dated folders. */
async function rolloutFiles(dir, depth = 0) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth < 4) files.push(...(await rolloutFiles(path, depth + 1)));
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(path);
  }
  return files;
}

/** Is a lock file held by a running Codex? Only knowable on Windows (see the top). */
function isLockHeld(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return false;
  } catch (error) {
    return error.code === "EBUSY";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * How many Codex windows are open (Windows only): codex.exe processes that aren't the background
 * app-server, whose copy lives under ~/.codex/packages. null when it can't be told.
 */
function countCodexWindows() {
  return new Promise((done) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process codex -ErrorAction SilentlyContinue).Path"],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) return done(null);
        const paths = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        done(paths.filter((path) => !/[\\/]packages[\\/]app-server-daemon[\\/]/i.test(path)).length);
      },
    );
  });
}

/** A busy Codex with an open tool call and no writes for this long probably waits for you. */
const QUIET_MS = 8000;

/**
 * Which loaded sessions have a window: busy ones first, then the most recently written, up to the
 * number of open windows. With the window count unknown, every loaded session counts.
 * @param {{id: string, status: string, mtimeMs: number}[]} loaded
 * @param {number | null} windows
 */
export function pickRunning(loaded, windows) {
  if (windows === null) return loaded;
  const working = (s) => s.status === "busy" || s.status === "waiting";
  const ordered = [...loaded].sort((a, b) => working(b) - working(a) || b.mtimeMs - a.mtimeMs);
  return ordered.slice(0, Math.max(windows, ordered.filter(working).length));
}

export function codexSource(env = process.env) {
  const home = resolve(env.CODEX_HOME ?? join(homedir(), ".codex"));
  const dir = resolve(home, "sessions");
  const lockDir = resolve(home, "thread-writer-locks");
  const indexFile = resolve(home, "session_index.jsonl");
  const switchedOff = env.CLI_COMPANION_CODEX === "0";
  const read = appendingJsonlReader(parseCodexLines);

  /** file -> { mtimeMs, size, meta } */
  const metaCache = new Map();
  /** native session id -> transcript file, from the last scan */
  let fileById = new Map();
  let names = { mtimeMs: -1, map: new Map() };

  /** Titles from session_index.jsonl (the last line for an id wins). */
  async function threadNames() {
    try {
      const stats = await stat(indexFile);
      if (stats.mtimeMs === names.mtimeMs) return names.map;
      const map = new Map();
      for (const line of (await readFile(indexFile, "utf8")).split("\n")) {
        try {
          const e = JSON.parse(line);
          if (typeof e.id === "string" && typeof e.thread_name === "string") map.set(e.id, e.thread_name.trim());
        } catch {
          // skip
        }
      }
      names = { mtimeMs: stats.mtimeMs, map };
    } catch {
      names = { mtimeMs: -1, map: new Map() };
    }
    return names.map;
  }

  async function scan() {
    if (switchedOff) return [];
    const files = await rolloutFiles(dir);
    const titles = await threadNames();
    const metas = [];
    const seen = new Set(files);
    const byId = new Map();
    for (const file of files) {
      try {
        const stats = await stat(file);
        let cached = metaCache.get(file);
        if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
          const handle = await open(file, "r");
          let raw;
          try {
            raw = await readCodexMeta((position, length) => readRange(handle, position, length), stats.size);
          } finally {
            await handle.close();
          }
          cached = { mtimeMs: stats.mtimeMs, size: stats.size, raw };
          metaCache.set(file, cached);
        }
        const { raw } = cached;
        if (!raw.id || !raw.cwd) continue;
        const name = titles.get(raw.id);
        byId.set(raw.id, file);
        metas.push({
          id: `${PREFIX}${raw.id}`,
          source: "codex",
          cwd: raw.cwd,
          created: raw.created,
          name: name && !DEFAULT_NAMES.has(name) ? name : undefined,
          preview: raw.preview,
          file,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        });
      } catch {
        // Unreadable or vanished mid-scan: skip it this time.
      }
    }
    for (const file of metaCache.keys()) if (!seen.has(file)) metaCache.delete(file);
    fileById = byId;
    return metas;
  }

  let runningCache = { at: 0, map: new Map() };
  // Running session file → byte offset of its last task event, so a long turn isn't re-searched.
  const taskAt = new Map();
  async function running() {
    if (Date.now() - runningCache.at < 3000) return runningCache.map;
    const map = new Map();
    // Lock probing only works on Windows; elsewhere the server falls back to recent writes.
    map.supported = process.platform === "win32" && existsSync(lockDir);
    if (map.supported) {
      let names = [];
      try {
        names = await readdir(lockDir);
      } catch {
        // gone
      }
      const loaded = [];
      for (const name of names) {
        const match = name.match(/^([0-9a-f][0-9a-f-]{7,63})\.lock$/i);
        if (!match || !isLockHeld(join(lockDir, name))) continue;
        let status = "idle";
        let mtimeMs = 0;
        const file = fileById.get(match[1]);
        if (file) {
          try {
            const stats = await stat(file);
            mtimeMs = stats.mtimeMs;
            const handle = await open(file, "r");
            try {
              const turn = await codexTurnFromFile((position, length) => readRange(handle, position, length), stats.size, taskAt.get(file));
              if (turn.taskAt === undefined) taskAt.delete(file);
              else taskAt.set(file, turn.taskAt);
              status = turn.state;
              // A tool call with no result and no writes for a while: probably asking you.
              if (turn.openCall && Date.now() - stats.mtimeMs > QUIET_MS) status = "waiting";
            } finally {
              await handle.close();
            }
          } catch {
            // keep idle
          }
        }
        loaded.push({ id: match[1], status, mtimeMs });
      }
      const windows = loaded.length ? await countCodexWindows() : 0;
      map.waitingFor = new Map();
      for (const { id, status } of pickRunning(loaded, windows)) {
        map.set(`${PREFIX}${id}`, status);
        if (status === "waiting") map.waitingFor.set(`${PREFIX}${id}`, "maybe an approval");
      }
    }
    runningCache = { at: Date.now(), map };
    return map;
  }

  return {
    id: "codex",
    label: "Codex",
    tag: "CX",
    assistant: "Codex",
    live: false,
    canType: false,
    enabled: !switchedOff,
    get installed() {
      return existsSync(dir);
    },
    dir,
    home: { env: "CODEX_HOME", path: home, usual: "~/.codex" },
    folders: [{ label: "Codex sessions", path: switchedOff ? null : dir }],
    scan,
    owns: (file) => isUnderDir(dir, file),
    readEntries: (file) => (isUnderDir(dir, file) ? read(file) : Promise.resolve(undefined)),
    transcript: (entries) => codexTranscriptItems(entries),
    findImage: findCodexImage,
    running,
    startActions: [
      { action: "codex", label: "Start Codex", command: "codex" },
      { action: "codex-last", label: "Continue last Codex session", command: "codex resume --last" },
    ],
    resumeCommand: (sessionId) => `codex resume ${sessionId}`,
    slashCommands: async () => mergeCommands(CODEX_BUILTINS),
  };
}
