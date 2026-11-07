#!/usr/bin/env node
// Add (or remove with --remove) the Pi Companion hooks in Claude Code's user settings
// (~/.claude/settings.json, or $CLAUDE_CONFIG_DIR/settings.json).
//
// - Backs the file up first (settings.json.bak-companion-<timestamp>).
// - Leaves every other setting and hook as it is; adds one entry per event, only if missing.
// - Prints what it added or removed. Restart open Claude Code sessions to pick it up.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PreCompact", "Stop", "SessionEnd"];
const hookScript = resolve(dirname(fileURLToPath(import.meta.url)), "claude-hook.mjs");
const command = `node "${hookScript}"`;
const settingsFile = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
const remove = process.argv.includes("--remove");

const isOurs = (h) => typeof h?.command === "string" && h.command.replace(/\\/g, "/").includes("companion/hooks/claude-hook.mjs");

const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
if (existsSync(settingsFile)) {
  const backup = `${settingsFile}.bak-companion-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(settingsFile, backup);
  console.log(`Backup: ${backup}`);
}
settings.hooks ??= {};
const changes = [];

for (const event of EVENTS) {
  const groups = (settings.hooks[event] ??= []);
  if (remove) {
    for (const g of groups) {
      const before = g.hooks?.length ?? 0;
      g.hooks = (g.hooks ?? []).filter((h) => !isOurs(h));
      if (g.hooks.length !== before) changes.push(`removed ${event}`);
    }
    settings.hooks[event] = groups.filter((g) => g.hooks?.length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  } else if (!groups.some((g) => (g.hooks ?? []).some(isOurs))) {
    groups.push({ ...(event === "PreToolUse" ? { matcher: "*" } : {}), hooks: [{ type: "command", command, timeout: 5 }] });
    changes.push(`added ${event}`);
  }
}

writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
console.log(changes.length ? changes.join("\n") : "Nothing to change.");
console.log(`Hook command: ${command}`);
console.log(`Settings: ${settingsFile}`);
if (changes.length) console.log("Restart (or /exit and resume) open Claude Code sessions so they load the change.");
