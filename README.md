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
- **Several sessions**: every interactive Pi on the machine shows up in the sidebar; the
  window follows the most recently active one unless you pick one.

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
  reads history from the session file Pi reports, and only from inside Pi's sessions
  folder. It keeps no data on disk.
- The **window** is plain HTML and JavaScript: no build step and no CDN.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PI_COMPANION_PORT` | `30143` | Port for the server and the extension |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's folder (sessions are read from `sessions/`) |

The server log and the app-window browser profile live in `~/.pi/agent/companion/`.

## Limits

- Read-only for now. Sending text or images from the window into Pi is planned.
- Only sessions that are running show up; browsing old sessions is planned.
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
