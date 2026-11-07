# Pi Companion

A live, read-only window onto the Pi CLI sessions you are running. You code in the
terminal; the companion shows the same session with formatted markdown, images, tool
calls, thinking and compaction, including a **"Compacting context…" banner while a
compaction runs** (Pi CLI or pi-gui never showed this in a second window).

Built 2026-11-06 as phase 1 of replacing pi-gui-as-viewer. Same pattern as
`C:\AI\pi\dashboard`: localhost-only Node server, Chrome `--app` window, small global
Pi extension.

## How it works

```
Pi CLI ──(bridge extension: events)──► server :30143 ──(SSE)──► companion window
            ~/.pi/agent/extensions/       server/server.mjs        public/*
            companion.ts                  reads session JSONL ◄─── /api/history
```

- **Bridge extension** (`extension/companion.ts`, installed to
  `~/.pi/agent/extensions/companion.ts`): forwards streaming text, tool start/update/end,
  turns, model and context usage, and compaction start / end / failure. It never returns a
  value from a handler, so it cannot cancel or change anything in Pi. It does nothing in
  print/json mode (`ctx.hasUI` false). If the server is down it drops events quietly and
  retries after 5 s; a 15 s heartbeat makes an already-running Pi show up once the
  server starts.
- **Server** (`server/server.mjs`, Node built-ins only): binds `127.0.0.1:30143`. `/ingest`
  requires the `x-pi-companion: 1` header (a browser page cannot send that without a CORS
  preflight, which is never answered). History is read from the session file Pi reports,
  and only if it is under `~/.pi/agent/sessions`. Sessions whose Pi process exited are
  dropped within 10 s.
- **Page** (`public/`): no build step, no CDN. Follows the most recently active session
  unless you click one. Messages that a compaction summarized are dimmed; the compaction
  card shows the summary the model now sees and the files it lists.

## Use

```powershell
pwsh -File C:\AI\pi\companion\launcher\open-companion.ps1      # start server if needed + open window
pwsh -File C:\AI\pi\companion\launcher\install-extension.ps1   # (re)install the bridge
```

Inside Pi: `/companion` does the same as `open-companion.ps1`. Already-open Pi sessions
need `/reload` once to load the bridge.

Settings: `PI_COMPANION_PORT` (default 30143) for both server and bridge.

## Test

```powershell
cd C:\AI\pi\companion; npm test
```

Verified 2026-11-06 with real Pi 1.4.0 RPC runs (prompt + bash tool + markdown reply; a
"nothing to compact" failure; a real manual compaction of 47k tokens) and a simulated
9-second threshold compaction for the banner/timer.

## Not yet (later phases)

- Phase 2: paste/drop images and text in the window → `pi.sendUserMessage()` into the CLI.
- Phase 3: browse past (not running) sessions; logon task so the server is always up.
- The server keeps no state on disk; restarting it forgets live status until the next event.
