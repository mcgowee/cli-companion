// The CLIs the companion knows. Each one is a "source" with the same shape, so adding a CLI
// means adding one module here, not touching the server or the page.
//
// A source:
//   id            "pi", "claude", … Also the session-id prefix ("claude:<id>"); Pi ids have none.
//   label         "Claude Code"      shown in menus, the status pill and About
//   tag           "CC"               short badge in the sidebar ("" for none)
//   assistant     "Claude"           who replies, in the transcript
//   live          true if a bridge streams live events (only Pi, through its extension)
//   canType       true if the page can put text into the CLI's prompt (only Pi)
//   enabled       false when switched off (CLI_COMPANION_<ID>=0, or later in Settings)
//   installed     true if its sessions folder exists (checked each time)
//   folders       [{ label, path }] for About
//   scan()                         -> saved sessions [{ id, source, cwd, created, name, preview, file, size, mtimeMs }]
//   owns(file)                     -> true if the file is inside this source's folder
//   readEntries(file)              -> parsed entries (cached), or undefined
//   transcript(entries, { leafId }) -> { items, … } for the page
//   findImage(entries, ref)        -> { mimeType, data } or undefined
//   running()      (optional)      -> Map(id -> "busy" | "idle"), with .supported = can tell at all
//   startActions                   [{ action, label, command }] for a workspace's terminal menu
//   resumeCommand(sessionId)       -> command that resumes a saved session
//   slashCommands({ cwd, live })   -> [{ name, description, source }] for the "/" lookup

import { claudeSource } from "./claude.mjs";
import { piSource } from "./pi.mjs";

export function createSources(env = process.env) {
  return [piSource(env), claudeSource(env)];
}

/** Which source a session id belongs to: a known "<source>:" prefix, else Pi. */
export function sourceForId(sources, id) {
  const text = String(id ?? "");
  const colon = text.indexOf(":");
  if (colon > 0) {
    const found = sources.find((s) => s.id === text.slice(0, colon) && s.id !== "pi");
    if (found) return found;
  }
  return sources.find((s) => s.id === "pi");
}

/** The id inside the CLI (without our "<source>:" prefix). */
export function nativeId(source, id) {
  const prefix = `${source.id}:`;
  return source.id !== "pi" && String(id).startsWith(prefix) ? String(id).slice(prefix.length) : String(id);
}

/** What the page needs to know about each source. */
export function describeSources(sources) {
  return sources.map((s) => ({
    id: s.id,
    label: s.label,
    tag: s.tag,
    assistant: s.assistant,
    live: s.live,
    canType: s.canType,
    enabled: s.enabled,
    installed: s.installed,
    folders: s.folders,
  }));
}
