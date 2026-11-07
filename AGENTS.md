# Pi Companion — agent notes

A live, read-only side window for coding-agent CLIs (Pi, Claude Code, Codex):
an extension/CLI → Node server → web page (no build step). Shipped both as a
Pi package (`pi install git:github.com/mcgowee/pi-companion`) and a standalone
`cli-companion` command (`bin/`) that works without Pi.

## Layout

| Path | What it is |
|---|---|
| `extension/companion.ts` | The only TS file. Registers `/companion`; mirrors live Pi events to the server; long-polls `/bridge/inbox` to paste text into Pi's input. Loaded because `package.json` declares `pi.extensions`. |
| `server/start.mjs` | Server start + window open, shared by the Pi extension's `/companion` and the CLI. |
| `server/server.mjs` | HTTP server on `127.0.0.1`: `/ingest`, `/events` (SSE), `/api/{history,sessions,workspaces,image}`, `/bridge/{inbox,ack}`, `/healthz`, workbench endpoints, and static `public/`. |
| `server/sources/*.mjs` | One module per CLI the companion knows (Pi, Claude Code, Codex). Adding a CLI means adding a module here + a transcript parser (`claude-file.mjs`, `codex-file.mjs` produce the same items the page renders for Pi) — no changes to server or page. |
| `server/session-file.mjs` | Pi session JSONL → transcript items (active branch = leaf→root chain). |
| `server/session-index.mjs` | Workspace/session list; reads only head+tail of huge files, cached on mtime/size. |
| `server/workbench.mjs` | Right panel: path-guarded file browsing and read-only git review (`WorkbenchError` carries the HTTP status). |
| `server/commands.mjs`, `slash-commands.mjs` | What the composer may send to a running CLI (paste), and its `/` command lookup. |
| `server/settings.mjs`, `dashboards.mjs`, `usage.mjs`, `launch.mjs`, `fsutil.mjs` | Settings (`~/.cli-companion/settings.json`, written only from the Settings page), user dashboards (http(s) links only), usage stats from the index, opening workspaces/sessions in a terminal (the page names an action, never a command/path), shared file/process helpers. |
| `bin/cli-companion.mjs` | Standalone launcher: start the server if needed and open the window, without Pi. |
| `public/*.js` | Vanilla JS, no build, no CDN. Plain IIFEs loaded by `<script>` order: `sources.js`, `markdown.js`, `resize.js`, `composer.js`, `app.js`, `workbench.js`, `launch.js`, `dashboards.js`, `settings.js`, `menu.js` (hash-routed top menu: Home, Dashboards, Settings, About — other pages only hide Home's state). |
| `test/*.test.mjs` | `node:test` + `assert/strict`, fixtures inline, ~1 s, no network. |

## Invariants — keep these when changing anything

- **Node built-ins only** in `server/` and `public/`: the package has zero dependencies, no build step, no lockfile. Don't add an import that needs `npm install`.
- **The extension never blocks or changes Pi**: handlers return immediately unless `ctx.hasUI`; no handler returns a value; work happens on short unref'd timers with batched HTTP posts (80 ms flush; back off 5 s when the server is down — events are dropped and the *next* snapshot heals the view).
- **Read-only by design**: the page never edits. Server reads Pi's files only from under its `sessions/` dir; the workbench resolves paths inside a workspace root the server already knows (the page sends a session id, never a path), re-checks after symlink resolution, and rejects `..`. Only read-only `git` subcommands run.
- **Localhost trust**: bind `127.0.0.1` only, refuse requests whose `Host` isn't `127.0.0.1`/`localhost` (DNS rebinding), and require the `x-pi-companion` header on bridge/send endpoints (a cross-site page can't set it without a CORS preflight).
- **Sessions can be hundreds of MB with inline images**: never read one whole file end-to-end; head/tail ranges + cache-until-changed is the pattern.
- Nothing persists session data on disk — state lives in memory. Only user config is written, by explicit action in the UI: `~/.cli-companion/{settings,dashboards}.json`. Scratch files: `logs/` (gitignored), state dir `~/.pi/agent/companion/` (server.log, browser-profile).

## Conventions

- ESM throughout (`"type": "module"`; server modules are `.mjs`). Target Node ≥ 20.
- Each server/public module opens with a short comment block stating the module's job and its hard rules — update that header when behaviour changes.
- Defensive style: try/catch with quiet fallbacks, `?.`/`??` for optional data, half-written JSONL lines skipped rather than fatal, cross-platform care for Windows (case-insensitive path compares, `windowsHide`/`unref` on spawned processes, `where` vs `which`).
- Env knobs: `PI_COMPANION_PORT` (default `30143`), `PI_CODING_AGENT_DIR` (default `~/.pi/agent`). Use `join` on `homedir()` defaults like existing top constants.
- Extension API shape: `pi.on(event, (event, ctx) => ...)` and `pi.registerCommand("name", { description, handler })`. Live events: `session_start/shutdown`, `agent_start/settled`, `message_update/end` (`stream`), `tool_execution_start/update/end` (skip `parentToolCallId` children), `session_before_compact`/`compact`/`compact_failed`.
- Test what has pure logic (parsers, workbench) rather than the HTTP/DOM layer; mirror existing test file names to the module under test.

## Commands

```bash
npm test        # node --test test/*.test.mjs — run before finishing any change
npm start       # run the server in the foreground
pi -e ./ ...    # try the extension from a checkout without installing it
```

Windows 11 + Pi 1.4 is the tested platform; cross-platform code paths must stay correct for macOS/Linux even if untested.

Commit history is short and squashed per feature; keep commit messages descriptive of behaviour ("Sidebar: workspaces with their sessions…").
