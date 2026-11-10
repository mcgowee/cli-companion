# CLI Companion — agent notes

A live side window for coding-agent CLIs (Pi, Claude Code, Codex): an
extension/CLI → Node server → web page (no build step). Shipped both as a
Pi package (`pi install git:github.com/mcgowee/cli-companion`) and a standalone
`cli-companion` command (`bin/`) that works without Pi. Repo: mcgowee/cli-companion.

## Layout

| Path | What it is |
|---|---|
| `extension/companion.ts` | The only TS file. Registers `/companion`; mirrors live Pi events to the server; long-polls `/bridge/inbox` to paste text into Pi's input. Loaded because `package.json` declares `pi.extensions`. |
| `server/start.mjs` | Server start + window open, the port, the state folder and the access key, shared by the Pi extension's `/companion` and the CLI. |
| `server/access.mjs` | The access-key gate: which paths need the key, header/cookie check, the locked page. |
| `server/remote.mjs` | Phone access over `tailscale serve` (identity check, what a phone may do). |
| `server/favorites.mjs`, `colors.mjs` | Sidebar Favorites (ids) and per-session colours (id → strict `#rrggbb`, set from a row's ⋯ / right-click menu). |
| `server/places.mjs`, `public/places.js` | The Workspaces menu: added local folders (launch kind `folder`) and SSH computers — list `~/projects` there over `ssh -o BatchMode=yes`, open a folder in a local terminal as `ssh -t <host> tmux new-session -A …` (plain words only; host/folder names pattern-checked; argument list, no shell on Windows). Never from the phone. |
| `server/prompts.mjs`, `handoff.mjs`, `shortcut.mjs`, `apps.mjs` | Saved prompts, handoff briefs, the Start menu/desktop shortcut, and the Apps tab's link finder. |
| `server/server.mjs` | HTTP server on `127.0.0.1`: `/ingest`, `/events` (SSE), `/api/{history,sessions,workspaces,image}`, `/bridge/{inbox,ack}`, `/healthz`, workbench endpoints, and static `public/`. |
| `server/sources/*.mjs` | One module per CLI the companion knows (Pi, Claude Code, Codex). Adding a CLI means adding a module here + a transcript parser (`claude-file.mjs`, `codex-file.mjs` produce the same items the page renders for Pi) — no changes to server or page. |
| `server/session-file.mjs` | Pi session JSONL → transcript items (active branch = leaf→root chain). |
| `server/session-index.mjs` | Workspace/session list; reads only head+tail of huge files, cached on mtime/size. |
| `server/workbench.mjs` | Right panel: path-guarded file browsing and read-only git review (`WorkbenchError` carries the HTTP status). |
| `server/commands.mjs`, `slash-commands.mjs` | What the composer may send to a running CLI (paste), and its `/` command lookup. |
| `server/settings.mjs`, `dashboards.mjs`, `usage.mjs`, `launch.mjs`, `fsutil.mjs` | Settings (`~/.cli-companion/settings.json`, written only from the Settings page), user dashboards (http(s) links only, plus an optional start command run detached by POST /api/dashboards/start under the same runCommands gate as the Terminal tab), usage stats from the index, opening workspaces/sessions in a terminal (the page names an action, never a command/path), shared file/process helpers. |
| `bin/cli-companion.mjs` | Standalone launcher: start the server if needed and open the window, without Pi. |
| `server/runner.mjs`, `public/terminal.js` | Terminal tab: runs a command you typed (or put there from a code block's ▶ Terminal) in the session folder, output in memory, Stop kills the tree; Open in terminal = real window via `-EncodedCommand`. Off unless `settings.runCommands`; page header on every /api/run* call; never from the phone; nothing ever runs without a Run click. |
| `server/uploads.mjs`, `public/images.js` | Composer images: saved into the session folder (`.cli-companion/images/`, own .gitignore, 30-day cleanup), path put into the text. |
| `public/*.js` | Vanilla JS, no build, no CDN. Plain IIFEs loaded by `<script>` order: `sources.js`, `markdown.js`, `resize.js`, `composer.js`, `app.js`, `workbench.js`, `launch.js`, `dashboards.js`, `settings.js`, `menu.js` (hash-routed top menu: Home, Dashboards, Settings, About — other pages only hide Home's state). |
| `test/*.test.mjs` | `node:test` + `assert/strict`, fixtures inline, ~1 s, no network. |

## Invariants — keep these when changing anything

- **Node built-ins only** in `server/` and `public/`: the package has zero dependencies, no build step, no lockfile. Don't add an import that needs `npm install`.
- **The extension never blocks or changes Pi**: handlers return immediately unless `ctx.hasUI`; no handler returns a value; work happens on short unref'd timers with batched HTTP posts (80 ms flush; back off 5 s when the server is down — events are dropped and the *next* snapshot heals the view).
- **Read-only by design** (except the opt-in Terminal tab, which runs only what you send with Run): the page never edits. Server reads Pi's files only from under its `sessions/` dir; the workbench resolves paths inside a workspace root the server already knows (the page sends a session id, never a path), re-checks after symlink resolution, and rejects `..`. Only read-only `git` subcommands run.
- **Localhost trust**: bind `127.0.0.1` only, refuse requests whose `Host` isn't `127.0.0.1`/`localhost` (DNS rebinding), and require the `x-pi-companion` / `x-pi-companion-page` headers on bridge and write endpoints (a cross-site page can't set them without a CORS preflight).
- **Access key**: `/api`, `/events`, `/bridge`, `/ingest` and `/app-files` need `~/.cli-companion/access-key`, as the `x-companion-key` header (extension, CLI) or the cookie the window gets from `/?key=…` (`server/access.mjs`). Static files and `/healthz` stay open. Phone requests are checked by Tailscale identity instead. Anything new that calls the server must send the key.
- **Sessions can be hundreds of MB with inline images**: never read one whole file end-to-end; head/tail ranges + cache-until-changed is the pattern.
- Nothing persists session data on disk — state lives in memory (handoff briefs, made on request, are the exception). The companion never writes the CLIs' own files. Everything it writes lives in `~/.cli-companion` (`CLI_COMPANION_HOME`) and is listed in the README's Privacy section — keep that list current when adding a file.

## Conventions

- ESM throughout (`"type": "module"`; server modules are `.mjs`). Target Node ≥ 20.
- Each server/public module opens with a short comment block stating the module's job and its hard rules — update that header when behaviour changes.
- Defensive style: try/catch with quiet fallbacks, `?.`/`??` for optional data, half-written JSONL lines skipped rather than fatal, cross-platform care for Windows (case-insensitive path compares, `windowsHide`/`unref` on spawned processes, `where` vs `which`).
- Env knobs: `CLI_COMPANION_PORT` (else the port in Settings, else `30143`; `PI_COMPANION_PORT` still works), `CLI_COMPANION_HOME`, `PI_CODING_AGENT_DIR` (default `~/.pi/agent`), `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OLLAMA_HOST`. Use `join` on `homedir()` defaults like existing top constants; never hard-code a user's own paths (tests use generic ones like `C:\work\myapp`).
- Extension API shape: `pi.on(event, (event, ctx) => ...)` and `pi.registerCommand("name", { description, handler })`. Live events: `session_start/shutdown`, `agent_start/settled`, `message_update/end` (`stream`), `tool_execution_start/update/end` (skip `parentToolCallId` children), `session_before_compact`/`compact`/`compact_failed`.
- Test what has pure logic (parsers, workbench) rather than the HTTP/DOM layer; mirror existing test file names to the module under test.

## Commands

```bash
npm test        # node --test test/*.test.mjs — run before finishing any change
npm start       # run the server in the foreground
pi -e ./ ...    # try the extension from a checkout without installing it
```

Windows 11 + Pi 1.4 is the tested platform; macOS/Linux are experimental, but their code paths (Open via osascript or a Linux terminal, `.desktop` shortcuts) must stay correct even if untested. After editing `server/*.mjs`, restart the server before checking anything in the browser: `public/*` is served fresh, server code isn't.

Commit history is short and squashed per feature; keep commit messages descriptive of behaviour ("Sidebar: workspaces with their sessions…").
