# Pi Companion

A live side window for [Pi](https://pi.dev) coding agent sessions. Keep working in the
terminal; the companion shows the same session with formatted markdown, tool calls and
their output, images, thinking, context usage, and **compaction as it happens**.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
  <img alt="Pi Companion showing a session with a compaction in progress" src="docs/screenshot-light.png">
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
- **Workspaces and sessions**: the sidebar lists every workspace (project folder) you have
  used Pi in, with its sessions underneath, newest first, including past sessions you can
  open and read. Nothing to add by hand: they come from Pi's own sessions folder. Running
  sessions get a live dot and float to the top; a filter box searches folder names and
  session titles. The window follows the most recently active session unless you pick one.
  The left panel can be hidden with its button or **Ctrl+B** (⌘B on macOS).
- **Send text to Pi (bottom composer)**: write or collect text, then **Put in Pi's input**
  (**Ctrl+Enter**). It lands in the running Pi CLI's prompt box, with a short notice in the
  terminal. Nothing is sent to the model until you press Enter in the terminal yourself.
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
  - Read-only by design: no editing and no terminal (your terminal is where Pi runs).

## Install

```bash
pi install git:github.com/mcgowee/pi-companion
```

Then, in any Pi session:

```
/companion
```

This starts the companion server if it is not running and opens the window. It opens as
an app window if Chrome, Chromium or Edge is installed, otherwise in your default browser.
Sessions that were already open when you installed need `/reload` once.

`/companion server` starts the server without opening a window. You can also open
<http://127.0.0.1:30143> yourself.

## How it works

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
  changes. It reads history only from inside that folder and keeps no data on disk.
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

| Variable | Default | Meaning |
|---|---|---|
| `PI_COMPANION_PORT` | `30143` | Port for the server and the extension |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's folder (sessions are read from `sessions/`) |

The server log and the app-window browser profile live in `~/.pi/agent/companion/`.

## Limits

- Text goes into Pi's input box for you to send; sending directly, images, and pulling
  Pi's draft into the composer are planned.
- Past sessions open read-only; resume one in Pi with `pi -r`.
- Tested on Windows 11 with Pi 1.4. macOS and Linux use the same code paths but have not
  been tested yet; reports welcome.

## Develop

```bash
npm test              # session-file parser tests (node:test)
npm start             # run the server in the foreground
pi -e ./ ...          # try the extension from a checkout without installing it
```

## License

MIT
