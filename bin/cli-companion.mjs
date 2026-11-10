#!/usr/bin/env node
// cli-companion: start the companion server (if it isn't running) and open its window.
// Works without Pi; the Pi extension's /companion command does the same thing from inside Pi.

import { readFileSync } from "node:fs";
import { companionOpenUrl, companionPort, companionUrl, ensureServer, isCompanion, isPortUp, openWindow, stopServer } from "../server/start.mjs";

const HELP = `CLI Companion: a live side window for coding-agent CLIs (Pi, Claude Code, Codex).

Usage: cli-companion [options]

  (no options)      Start the server if needed and open the window
  --no-open         Start the server only (the key stays out of the output)
  --print-url       Start the server only, and print the address to open it with (it carries
                    your access key, so it lands in this terminal's scrollback)
  --restart         Stop the running server, start a fresh one, open the window
  --stop            Stop the running server
  --foreground      Run the server in this terminal (Ctrl+C stops it)
  --shortcut        Add a CLI Companion shortcut to the Start menu (apps menu on Linux)
  --shortcut=desktop  … on the desktop instead
  --port <n>        Use another port (default 30143, or CLI_COMPANION_PORT, or the port in Settings)
  --version         Print the version
  --help            Show this help

Everything stays on this computer: the server listens on 127.0.0.1 only, and only
requests carrying your access key (~/.cli-companion/access-key) can read it.`;

/** Open the window, or print the address to open by hand if no browser could be started. */
async function open(port) {
  const { url: openUrl, error } = await openWindow({ port });
  if (error) console.log(`Couldn't open a browser (${error}). Open this address yourself:\n  ${openUrl}`);
}

function fail(message) {
  console.error(`cli-companion: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const opts = { open: true, foreground: false, port: undefined, restart: false, stop: false };
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") {
    console.log(HELP);
    process.exit(0);
  } else if (arg === "--version" || arg === "-v") {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    process.exit(0);
  } else if (arg === "--no-open") opts.open = false;
  else if (arg === "--print-url") {
    opts.open = false;
    opts.printUrl = true;
  }
  else if (arg === "--foreground") opts.foreground = true;
  else if (arg === "--restart") opts.restart = true;
  else if (arg === "--stop") opts.stop = true;
  else if (arg === "--shortcut" || arg === "--shortcut=start" || arg === "--shortcut=desktop") {
    const { setShortcut } = await import("../server/shortcut.mjs");
    try {
      console.log(`Added ${await setShortcut(arg.endsWith("desktop") ? "desktop" : "start", true)}`);
      process.exit(0);
    } catch (error) {
      fail(error.message);
    }
  }
  else if (arg === "--port" || arg.startsWith("--port=")) {
    const value = arg.includes("=") ? arg.split("=")[1] : args[++i];
    const port = /^\d+$/.test(value ?? "") ? Number(value) : NaN;
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) fail(`not a port: ${value}`);
    opts.port = port;
  } else fail(`unknown option ${arg} (try --help)`);
}

if (opts.port) process.env.CLI_COMPANION_PORT = String(opts.port);
const port = companionPort();
const url = companionUrl(port);

if (opts.stop || opts.restart) {
  const result = await stopServer(port);
  if (result.error) fail(result.error);
  if (opts.stop) {
    console.log(result.stopped ? `Stopped ${url}` : `No companion was running on ${url}.`);
    process.exit(0);
  }
  if (result.stopped) console.log(`Stopped ${url}`);
}

if (opts.foreground) {
  if (await isPortUp(port)) fail(`something is already listening on ${url}.`);
  if (opts.open) setTimeout(() => open(port), 400);
  await import("../server/server.mjs");
} else {
  const result = await ensureServer({ port });
  if (result.error) fail(result.error);
  if (!result.started && !(await isCompanion(port))) {
    fail(`port ${port} is in use by something else. Try --port <n>.`);
  }
  console.log(`${result.started ? "Started" : "Already running:"} ${url}`);
  if (opts.open) await open(port);
  // The key only when asked: printed, it stays in the terminal's scrollback (and any log of it).
  else if (opts.printUrl) console.log(`Open: ${companionOpenUrl(port)}`);
  else console.log("To open the window: cli-companion (or --print-url for the address with your access key).");
}
