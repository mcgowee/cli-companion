// Claude Code (CLI or desktop app), read-only: transcripts from ~/.claude/projects, running or
// idle from the <pid>.json files it keeps in ~/.claude/sessions while a session runs.

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { claudeTranscriptItems, findClaudeImage, parseClaudeLines } from "../claude-file.mjs";
import { appendingJsonlReader, isProcessAlive, isUnderDir } from "../fsutil.mjs";
import { CLAUDE_PREFIX, scanClaudeSessions } from "../session-index.mjs";
import { CLAUDE_BUILTINS, claudeCustomCommands, mergeCommands } from "../slash-commands.mjs";

export function claudeSource(env = process.env) {
  const home = resolve(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
  const dir = resolve(home, "projects");
  const runningDir = resolve(home, "sessions");
  // CLI_COMPANION_CLAUDE=0 (or the older PI_COMPANION_CLAUDE=0) turns this source off.
  const switchedOff = (env.CLI_COMPANION_CLAUDE ?? env.PI_COMPANION_CLAUDE) === "0";

  const read = appendingJsonlReader(parseClaudeLines);

  let runningCache = { at: 0, map: new Map() };
  async function running() {
    if (Date.now() - runningCache.at < 3000) return runningCache.map;
    const map = new Map();
    map.supported = false;
    try {
      map.supported = (await stat(runningDir)).isDirectory();
      for (const name of await readdir(runningDir)) {
        if (!/^\d+\.json$/.test(name)) continue;
        try {
          const info = JSON.parse(await readFile(join(runningDir, name), "utf8"));
          if (typeof info.sessionId !== "string" || !Number.isInteger(info.pid) || !isProcessAlive(info.pid)) continue;
          // The same session can be open in two processes (CLI and desktop app): busy wins.
          const id = `${CLAUDE_PREFIX}${info.sessionId}`;
          if (map.get(id) !== "busy") map.set(id, info.status === "busy" ? "busy" : "idle");
        } catch {
          // Half-written or unreadable: skip it this time.
        }
      }
    } catch {
      // No sessions folder (older Claude Code): the server falls back to transcript activity.
    }
    runningCache = { at: Date.now(), map };
    return map;
  }

  return {
    id: "claude",
    label: "Claude Code",
    tag: "CC",
    assistant: "Claude",
    live: false,
    canType: false,
    enabled: !switchedOff,
    get installed() {
      return existsSync(dir);
    },
    dir,
    folders: [{ label: "Claude Code transcripts", path: switchedOff ? null : dir }],
    scan: () => (switchedOff ? Promise.resolve([]) : scanClaudeSessions(dir)),
    owns: (file) => isUnderDir(dir, file),
    readEntries: (file) => (isUnderDir(dir, file) ? read(file) : Promise.resolve(undefined)),
    transcript: (entries) => claudeTranscriptItems(entries),
    findImage: findClaudeImage,
    running,
    startActions: [{ action: "claude", label: "Start Claude Code", command: "claude" }],
    resumeCommand: (sessionId) => `claude --resume ${sessionId}`,
    // Your commands and skills (project's .claude, then ~/.claude) and the common built-ins.
    slashCommands: async ({ cwd } = {}) => {
      const [project, user] = await Promise.all([
        cwd ? claudeCustomCommands(join(cwd, ".claude"), "project") : [],
        claudeCustomCommands(home, "user"),
      ]);
      return mergeCommands(project, user, CLAUDE_BUILTINS);
    },
  };
}
