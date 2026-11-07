// Pi: saved sessions from ~/.pi/agent/sessions; live sessions come through the Pi extension's
// bridge (handled in server.mjs, since only Pi has one).

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isUnderDir } from "../fsutil.mjs";
import { findImage, parseEntries, transcriptItems } from "../session-file.mjs";
import { scanSessions } from "../session-index.mjs";
import { mergeCommands, PI_BUILTINS } from "../slash-commands.mjs";

export function piSource(env = process.env) {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const dir = resolve(agentDir, "sessions");

  // Parsed entries of the few most recently opened files, reused until the file changes.
  const cache = new Map();
  async function readEntries(file) {
    if (!isUnderDir(dir, file)) return undefined;
    try {
      const stats = await stat(file);
      const cached = cache.get(file);
      if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.entries;
      const entries = parseEntries(await readFile(file, "utf8"));
      cache.delete(file);
      cache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, entries });
      while (cache.size > 4) cache.delete(cache.keys().next().value);
      return entries;
    } catch {
      return undefined;
    }
  }

  return {
    id: "pi",
    label: "Pi",
    tag: "",
    assistant: "Pi",
    live: true,
    canType: true,
    // Pi sessions also arrive live from the extension, so Pi stays on even before its folder exists.
    enabled: true,
    get installed() {
      return existsSync(dir);
    },
    dir,
    folders: [{ label: "Pi sessions", path: dir }],
    scan: () => scanSessions(dir),
    owns: (file) => isUnderDir(dir, file),
    readEntries,
    transcript: (entries, { leafId } = {}) => transcriptItems(entries, leafId),
    findImage,
    startActions: [
      { action: "pi", label: "Start Pi", command: "pi" },
      { action: "pi-continue", label: "Continue last Pi session", command: "pi -c" },
    ],
    resumeCommand: (sessionId) => `pi --session ${sessionId}`,
    // Built-ins plus the extension, prompt and skill commands the running Pi reported.
    slashCommands: async ({ live } = {}) => mergeCommands(PI_BUILTINS, live?.commands ?? []),
  };
}
