// Slash commands for the composer's "/" lookup.
//
// Pi: its built-ins (copied from Pi 1.4's BUILTIN_SLASH_COMMANDS, which extensions can't
// import) plus what the bridge extension reports from pi.getCommands() (extensions, prompt
// templates, skills).
// Claude Code: its common built-ins plus the user's own commands and skills, read from
// ~/.claude and the session's project folder (.claude/commands/**/*.md, .claude/skills/*/SKILL.md).
// Read-only; only small Markdown front matter is parsed.

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const PI_BUILTINS = [
  ["settings", "Open settings menu"],
  ["model", "Select model (opens selector UI)"],
  ["tree", "Navigate session tree (switch branches)"],
  ["thinking", "Set thinking level"],
  ["scoped-models", "Enable/disable models for Ctrl+P cycling"],
  ["export", "Export session (HTML default, or specify path: .html/.jsonl)"],
  ["import", "Import a JSONL session, preserving its ID and working directory"],
  ["share", "Share session via a Radius artifact or a GitHub gist"],
  ["bug", "Report a bug to the Pi developers"],
  ["copy", "Copy last agent message to clipboard"],
  ["name", "Set session display name"],
  ["session", "Show session info and stats"],
  ["changelog", "Show changelog entries"],
  ["hotkeys", "Show all keyboard shortcuts"],
  ["fork", "Create a new fork from a previous user message"],
  ["clone", "Duplicate the current session at the current position"],
  ["trust", "Save project trust decision for future sessions"],
  ["login", "Configure provider authentication"],
  ["logout", "Remove provider authentication"],
  ["new", "Start a new session"],
  ["compact", "Manually compact the session context"],
  ["resume", "Resume another session"],
  ["reload", "Reload keybindings, extensions, skills, prompts, themes, and context files"],
  ["quit", "Quit Pi"],
].map(([name, description]) => ({ name, description, source: "builtin" }));

// The common Claude Code built-ins (not exhaustive; Claude Code shows the full list itself).
export const CLAUDE_BUILTINS = [
  ["add-dir", "Add a working directory"],
  ["agents", "Manage subagents"],
  ["clear", "Clear the conversation and start fresh"],
  ["compact", "Compact the conversation, with optional focus instructions"],
  ["config", "Open settings"],
  ["context", "Show context usage"],
  ["cost", "Show token usage and cost"],
  ["doctor", "Check the Claude Code installation"],
  ["exit", "Exit Claude Code"],
  ["export", "Export the conversation"],
  ["help", "Show help and available commands"],
  ["hooks", "Manage hooks"],
  ["ide", "Connect to an IDE"],
  ["init", "Create a CLAUDE.md for this project"],
  ["login", "Sign in"],
  ["logout", "Sign out"],
  ["mcp", "Manage MCP servers"],
  ["memory", "Edit memory files"],
  ["model", "Choose the model"],
  ["permissions", "Manage tool permissions"],
  ["plugin", "Manage plugins"],
  ["resume", "Resume a previous conversation"],
  ["review", "Review a pull request"],
  ["rewind", "Rewind the conversation and/or code"],
  ["status", "Show version, model and account status"],
  ["statusline", "Set up the status line"],
  ["terminal-setup", "Set up terminal key bindings"],
  ["todos", "Show the current todo list"],
  ["usage", "Show plan usage limits"],
  ["vim", "Toggle vim editing mode"],
].map(([name, description]) => ({ name, description, source: "builtin" }));

/** The `description:` (and `name:`) from a Markdown file's front matter, if any. */
export function frontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!match) return out;
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^(name|description):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** First non-empty, non-heading line of a Markdown body: a fallback description. */
function firstLine(text) {
  const body = text.replace(/^---[\s\S]*?\n---\r?\n?/, "");
  const line = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"));
  return (line ?? "").trim().slice(0, 140);
}

async function markdownFiles(dir, depth = 0) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && depth < 3) out.push(...(await markdownFiles(full, depth + 1)));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

async function readHead(file) {
  try {
    return (await readFile(file, "utf8")).slice(0, 4000);
  } catch {
    return "";
  }
}

/** Custom Claude Code commands and skills under one `.claude` folder. */
export async function claudeCustomCommands(claudeDir, source) {
  const out = [];
  const commandsDir = join(claudeDir, "commands");
  for (const file of await markdownFiles(commandsDir)) {
    const name = relative(commandsDir, file).slice(0, -3).split(sep).join(":");
    const text = await readHead(file);
    out.push({ name, description: frontMatter(text).description || firstLine(text), source });
  }
  let skills = [];
  try {
    skills = await readdir(join(claudeDir, "skills"), { withFileTypes: true });
  } catch {
    // No skills folder.
  }
  for (const entry of skills) {
    if (!entry.isDirectory()) continue;
    const text = await readHead(join(claudeDir, "skills", entry.name, "SKILL.md"));
    if (!text) continue;
    const fm = frontMatter(text);
    out.push({ name: fm.name || entry.name, description: fm.description || firstLine(text), source: `${source} skill` });
  }
  return out;
}

/** Merge lists: first occurrence of a name wins; sorted by name. */
export function mergeCommands(...lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const c of list ?? []) {
      if (!c?.name || seen.has(c.name)) continue;
      seen.set(c.name, { name: String(c.name), description: String(c.description ?? "").slice(0, 200), source: c.source ?? "" });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
