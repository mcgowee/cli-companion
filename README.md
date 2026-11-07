# CLI Companion

A live side window for coding-agent CLIs: [Pi](https://pi.dev), Claude Code and Codex. Keep
working in the terminal; the companion shows the same session with formatted markdown,
tool calls and their output, images, thinking, context usage, and **compaction as it
happens**. You don't need Pi to use it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
  <img alt="CLI Companion showing a session with a compaction in progress" src="docs/screenshot-light.png">
</picture>

## Why

The Pi CLI is great to drive, but a long session is hard to read back in a terminal, and a
compaction gives you little to look at while it runs. The companion is a read-only window
next to it:

- **Live transcript**: your prompts, replies rendered as markdown, thinking (collapsed),
  and every tool call with its input and output. Streaming text and running tools appear
  as they happen.
- **Compaction you can see**: a "Compacting context…" banner with the reason (`/compact`,
  context near its limit, or overflow) and a timer, then "finished" or "failed". Each
  compaction becomes a card with the summary the model now sees and the files it lists;
  messages that were summarized are dimmed.
- **Context meter** and a status pill (Idle, Running, Compacting).
- **Active and Workspaces**: the sidebar starts with **Active**, a flat list of every running
  session with its folder name under the title. Below it, **Workspaces** lists every workspace
  (project folder) you have used Pi in, newest first and collapsed, with its sessions
  underneath (running ones keep their live dot there too), including past sessions you can
  open and read. Only the folder of the open session expands by itself; what you open or
  close is remembered. Nothing to add by hand: they come from Pi's own sessions folder. A
  filter box searches folder names and session titles in both lists. The window follows the most recently active session unless you pick one.
  The left panel can be hidden with its button or **Ctrl+B** (⌘B on macOS).
- **Open in a terminal**: the small terminal icon beside a workspace or a saved session
  opens a menu. For a workspace: **Terminal here**, then start or continue each installed CLI
  (**Start Pi**, `pi -c`, **Start Claude Code**, **Start Codex**, `codex resume --last`), and
  **Copy folder path**. For a saved session: resume it in its own CLI (`pi --session <id>`,
  `claude --resume <id>`, `codex resume <id>`). Running sessions have no icon, since their
  terminal is already open. Each option has **Copy** (the line to paste yourself, such as
  `cd 'C:\AI\pi'; pi -c` in PowerShell) and **Open**, which starts a new terminal window in
  that folder running the command: Windows Terminal or a PowerShell window on Windows,
  Terminal or iTerm2 on macOS, and the first terminal found on Linux (x-terminal-emulator,
  GNOME Terminal, Konsole, Xfce Terminal, kitty, Alacritty, WezTerm, xterm). Which one is set
  in **Settings**. The commands come from a fixed list in the server; the page only picks one.
- **Claude Code sessions too (read-only)**: sessions from Claude Code (CLI or desktop app)
  appear in the same folders, tagged **CC**, read from `~/.claude/projects`. Open one to read
  the transcript (replies, thinking, tool calls with results, compactions, images); a running
  Claude Code (found from the small per-process files it keeps in `~/.claude/sessions`) is
  listed under Active as running or idle, and the open transcript follows it within about
  2 seconds. Files and Review work for them as well. Claude Code has no way for
  another program to type into its prompt, so for a Claude Code session the composer's button
  is **Copy for Claude**: it copies the text for you to paste into Claude Code and empties
  the box (**Bring text back** restores it).
- **Codex sessions too (read-only)**: sessions from the Codex CLI appear the same way, tagged
  **CX**, read from `~/.codex/sessions` with titles from `~/.codex/session_index.jsonl`:
  prompts, replies, reasoning summaries, tool calls with their output, compactions and pasted
  images. A Codex that is open is listed under Active (on Windows, from the lock Codex holds
  on a loaded session, matched against the Codex windows that are open, since Codex's background
  service keeps a session loaded for a while after its window quits), as running or idle from its
  last task event. The composer's
  button is **Copy for Codex**. Tested with Codex CLI 0.166.
- **Send text to Pi (bottom composer)**: write or collect text, then **Put in Pi's input**
  (**Ctrl+Enter**). It lands in the running Pi CLI's prompt box, with a short notice in the
  terminal; press Enter there to send it. **Ctrl+Shift+Enter** puts the text in and sends it
  in one go. If
  Pi is busy, the message waits until it finishes. `/` commands and `!` shell lines are left
  for you to send from the terminal.
  Type **/** at the start of a line for a list of the selected CLI's slash commands (↑/↓,
  Enter or Tab to insert, Esc to close). For Pi: its built-ins plus the extension, prompt and
  skill commands the running Pi reports. For Claude Code: its common built-ins plus your
  commands and skills from `~/.claude` and the project's `.claude` folder.
  Every code block, message, tool input/output, file (Files tab) and diff (Review tab) has
  **Copy** and **Add** buttons; Add drops it into the composer as a fenced block. The draft is
  kept if you close the window. Works for running terminal sessions; sessions opened before
  the extension was updated need `/reload` once.
- **Resizable panels**: drag the inner edge of the left or right panel (or focus it and use
  ←/→; Shift for bigger steps). Double-click an edge to reset its width. Widths are
  remembered, and the transcript always keeps at least 360 px.
- **Right panel (Files and Review)**, like pi-gui's workbench, for the selected session's
  folder. Toggle it with the button at the top right or **Ctrl+Alt+B**.
  - **Files**: browse the folder tree and read files with line numbers. Markdown is
    rendered (with a Source toggle) and images are shown.
  - **Review**: git changes, either **Uncommitted** (including untracked files) or
    **Branch** (everything since the branch split from main/master), with +/− counts and
    a coloured diff per file. **Changed in this session** lists the files Pi edited or
    wrote in the open session.
  - Read-only by design: no editing and no terminal inside the page (your terminal is where Pi runs).
- **First run**: with no sessions anywhere yet, the window shows which CLIs it found, where it
  looked, and how to start each one.
- **Menu bar: Home, Dashboards, Settings, About.** Home is the session view.
  - **Dashboards** has built-in dashboards and your own. **Usage overview** shows sessions
    started per day in Pi and Claude Code (7, 30 or 90 days, with a table view), active days
    and your busiest workspaces, all from the session files already indexed. **Custom**
    dashboards are links to any page, such as a local server's status page: add them with the
    form, open them inside the companion or in a new tab. Ones on this computer show online
    or offline. The list is kept in `~/.cli-companion/dashboards.json`.
  - **Settings**: show or hide each CLI (Pi, Claude Code, Codex), change where its folder is,
    and pick the terminal **Open** uses. Saved in `~/.cli-companion/settings.json`; changes
    apply at once.
  - **About** shows the version, this server's address and folders, shortcuts and privacy.

## Install

Needs [Node.js](https://nodejs.org) 20 or newer.

**Without Pi** (Claude Code, or just to look around):

```bash
npx github:mcgowee/cli-companion
```

This starts the companion server if it is not running and opens the window. It opens as an
app window if Chrome, Chromium or Edge is installed, otherwise in your default browser. To
have the `cli-companion` command on your PATH, install it once:

```bash
npm install -g github:mcgowee/cli-companion
cli-companion              # start (if needed) and open the window
cli-companion --no-open    # start the server only
cli-companion --foreground # run the server in this terminal; Ctrl+C stops it
cli-companion --help
```

The server keeps running in the background after the command exits. You can also open
<http://127.0.0.1:30143> yourself.

**With Pi**, install it as a Pi package. This adds the live view of Pi sessions (status,
streaming text, tools, compaction) and **Put in Pi's input**:

```bash
pi install git:github.com/mcgowee/cli-companion
```

Then, in any Pi session:

```
/companion
```

This does the same as `cli-companion`. Sessions that were already open when you installed
need `/reload` once. `/companion server` starts the server without opening a window.
(Installs from the old name, `pi-companion`, keep working.)

## How it works

Each CLI is a *source* in `server/sources/` (`pi.mjs`, `claude.mjs`, `codex.mjs`) with the same
shape: where its sessions are and how to read one, whether one is running, its start and resume
commands, and its slash commands. Adding a CLI means adding one module there.

```
Pi (interactive) ──events──► companion server ──SSE──► window
 extension/companion.ts      server/server.mjs         public/
                             reads the session file ◄── history
```

- The **extension** forwards live events (streaming text, tool start/update/end, turns,
  model, context usage, compaction start/end/failure) to the server with a short HTTP POST.
  It never returns a value from an event handler, so it cannot cancel or change anything
  Pi does. It does nothing in print/JSON mode. If the server is not running, events are
  dropped quietly; a heartbeat every 15 s makes running sessions appear once it starts.
- The **server** (Node built-ins only, no dependencies) listens on `127.0.0.1` only. It
  builds the workspace list from Pi's sessions folder, reading only the start and end of
  each file (session files can be hundreds of MB with images), cached until a file
  changes. It reads history only from inside that folder and keeps no session data on disk; the only
  files it writes are its own settings and custom dashboard list, in `~/.cli-companion`.
  The right panel only reads inside the folder of a session it knows (the page sends a
  session id, never a path), rejects `..` and symlinks that lead outside it, and runs
  only read-only `git` commands. Requests whose `Host` is not `127.0.0.1`/`localhost`
  are refused, which blocks DNS-rebinding attacks from web pages.
- **Sending to Pi**: Pi never opens a port. The extension in each interactive Pi keeps one
  request open to the server (`/bridge/inbox`) and receives only commands for its own
  session; it pastes the text with Pi's `ctx.ui.pasteToEditor` and reports back. The page's
  send request needs a custom header (a cross-site page can't add one without a CORS
  preflight, which is never answered), and a command nobody picks up within 20 s is dropped.
- The **window** is plain HTML and JavaScript: no build step and no CDN.

## Settings

Most people only need the **Settings** page. The same things can be set with environment
variables (a `CLI_COMPANION_<CLI>=0` variable always hides that CLI, whatever the page says):

| Variable | Default | Meaning |
|---|---|---|
| `CLI_COMPANION_PORT` | `30143` | Port for the server and the extension (`PI_COMPANION_PORT` also works) |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's folder (sessions are read from `sessions/`) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's folder (transcripts are read from `projects/`) |
| `CLI_COMPANION_CLAUDE` | on | Set to `0` to hide Claude Code sessions (`PI_COMPANION_CLAUDE` also works) |
| `CODEX_HOME` | `~/.codex` | Codex's folder (sessions are read from `sessions/`) |
| `CLI_COMPANION_CODEX` | on | Set to `0` to hide Codex sessions |
| `CLI_COMPANION_PI` | on | Set to `0` to hide saved Pi sessions |
| `CLI_COMPANION_HOME` | `~/.cli-companion` | The companion's own files: settings, custom dashboards, server log, app-window browser profile |

Older versions kept these files in `~/.pi/agent/companion/`; the dashboard list is copied
over on first start.

## Limits

- Images from the composer, and pulling Pi's draft into the composer for editing, are planned.
- Past sessions open read-only; resume one with the terminal icon beside it.
- Tested on Windows 11 with Pi 1.4, Claude Code 2.1 and Codex CLI 0.166. macOS and Linux use
  the same code paths but have not been tested yet; reports welcome. There, a running Codex is
  recognised only by recent writes to its session file.

## Develop

```bash
npm test              # tests (node:test)
npm start             # run the server in the foreground
node bin/cli-companion.mjs   # the standalone command from a checkout
pi -e ./ ...          # try the extension from a checkout without installing it
```

## License

MIT
