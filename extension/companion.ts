/**
 * Pi extension: bridge to the Pi companion window.
 *
 * Mirrors live session events (streaming text, tools, turns, compaction) to the
 * companion server on 127.0.0.1:30143 so its window can show what Pi is doing.
 * `/companion` starts that server (from this package) if it is not running and
 * opens the window.
 *
 * Rules:
 *  1. Non-interactive modes (json/print) are never affected: every handler
 *     returns at once when `ctx.hasUI` is false.
 *  2. Nothing here blocks or changes Pi. Handlers only queue an event; a
 *     short-lived timer posts the batch. No handler returns a value, so no
 *     compaction, tool call or message is ever cancelled or altered.
 *  3. If the companion is not running, posts fail quietly and the bridge backs
 *     off for a few seconds. Events in that window are dropped; the next batch
 *     carries the current state (idle, model, context, leaf), so the view heals.
 *  4. The heartbeat timer starts on session start and is unref'd, so it never
 *     keeps Pi alive; it stops on session shutdown.
 *  5. Nothing starts on load. The server and browser window start only when
 *     you run `/companion`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number.parseInt(process.env.PI_COMPANION_PORT ?? "30143", 10);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const INGEST_URL = `${URL_BASE}/ingest`;
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_SCRIPT = join(PACKAGE_ROOT, "server", "server.mjs");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const STATE_DIR = join(AGENT_DIR, "companion");
const FLUSH_MS = 80;
const HEARTBEAT_MS = 15_000;
const BACKOFF_MS = 5_000;

type BridgeEvent = { type: string; at: number; [key: string]: unknown };

function textOf(content: unknown, kind: "text" | "thinking"): string {
  if (!Array.isArray(content)) return typeof content === "string" && kind === "text" ? content : "";
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (kind === "text" && block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    if (kind === "thinking" && block?.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    }
  }
  return parts.join(kind === "text" ? "\n\n" : "\n");
}

function short(value: unknown, max: number): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function tail(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : textOf((value as { content?: unknown })?.content, "text");
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/** TCP probe: true only if something accepts a connection. */
function isPortUp(timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: PORT });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Pi usually runs on Node; if it is a standalone binary, fall back to `node` on PATH. */
function nodeBinary(): string {
  return /^node(\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : "node";
}

/** Start the server detached (it outlives this Pi). Returns an error message, or undefined. */
async function ensureServer(): Promise<string | undefined> {
  if (await isPortUp()) return undefined;
  mkdirSync(STATE_DIR, { recursive: true });
  const logPath = join(STATE_DIR, "server.log");
  const log = openSync(logPath, "a");
  const child = spawn(nodeBinary(), [SERVER_SCRIPT], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: { ...process.env, PI_COMPANION_PORT: String(PORT) },
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isPortUp()) return undefined;
  }
  return `The companion server did not start on ${URL_BASE}. See ${logPath}.`;
}

function which(command: string): string | undefined {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split(/\r?\n/).find(Boolean);
  } catch {
    return undefined;
  }
}

/** A Chromium-based browser that supports --app windows, if one is installed. */
function findAppBrowser(): string | undefined {
  if (process.platform === "win32") {
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(
      (root): root is string => Boolean(root),
    );
    for (const root of roots) {
      for (const rel of ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe"]) {
        const candidate = join(root, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ].find((candidate) => existsSync(candidate));
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
    const found = which(name);
    if (found) return found;
  }
  return undefined;
}

/** Open the companion as an app window (own browser profile), or in the default browser. */
function openWindow(): void {
  const browser = findAppBrowser();
  const detached = { detached: true, stdio: "ignore" as const, windowsHide: true };
  if (browser) {
    spawn(
      browser,
      [`--app=${URL_BASE}`, `--user-data-dir=${join(STATE_DIR, "browser-profile")}`, "--window-size=1100,900"],
      detached,
    ).unref();
  } else if (process.platform === "win32") {
    spawn("explorer.exe", [URL_BASE], detached).unref();
  } else {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [URL_BASE], detached).unref();
  }
}

export default function companionBridge(pi: ExtensionAPI): void {
  let queue: BridgeEvent[] = [];
  let lastCtx: ExtensionContext | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let offlineUntil = 0;
  let posting = false;

  const snapshot = (ctx: ExtensionContext) => {
    let context: unknown;
    try {
      context = ctx.getContextUsage();
    } catch {
      context = undefined;
    }
    const sm = ctx.sessionManager;
    return {
      pid: process.pid,
      sessionId: sm.getSessionId(),
      sessionFile: sm.getSessionFile(),
      leafId: sm.getLeafId() ?? undefined,
      cwd: ctx.cwd,
      name: sm.getSessionName(),
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      idle: ctx.isIdle(),
      mode: ctx.mode,
      context,
    };
  };

  /* ── commands from the companion window (long poll) ── */

  let inboxAbort: AbortController | undefined;

  /** Apply one command from the window; returns an error message, or undefined on success. */
  const runCommand = (ctx: ExtensionContext, command: { type?: string; text?: unknown }): string | undefined => {
    if (command.type !== "paste" || typeof command.text !== "string") return "Unknown command.";
    if (ctx.mode !== "tui") return "Only the Pi CLI (terminal) has an input box to paste into.";
    const before = ctx.ui.getEditorText();
    // Something already typed: start the pasted text on a new line instead of gluing it on.
    const text = before && !/\s$/.test(before) ? `\n${command.text}` : command.text;
    try {
      ctx.ui.pasteToEditor(text);
    } catch {
      // Older Pi without paste handling: append to whatever is already typed.
      ctx.ui.setEditorText(before ? `${before}\n${text}` : text);
    }
    if (ctx.ui.getEditorText() === before) return "Pi's input box did not change (is a dialog open in Pi?).";
    // The paste does not redraw the terminal by itself; a notice does, and says where the text came from.
    const lines = command.text.split("\n").length;
    ctx.ui.notify(`[companion] Pasted ${lines} line${lines === 1 ? "" : "s"} into the input. Press Enter to send.`, "info");
    return undefined;
  };

  const ack = (cmdId: unknown, error: string | undefined) =>
    fetch(`${URL_BASE}/bridge/ack`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-companion": "1" },
      body: JSON.stringify({ cmdId, ok: !error, error }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => undefined);

  /**
   * Wait for commands for this session; one request at a time, re-opened after each answer.
   * Each loop owns its controller, so a session switch stops the old loop and starts a new one.
   */
  const runInbox = async (controller: AbortController) => {
    const signal = controller.signal;
    {
      while (!signal.aborted) {
        const ctx = lastCtx;
        if (!ctx) break;
        try {
          const res = await fetch(
            `${URL_BASE}/bridge/inbox?session=${encodeURIComponent(ctx.sessionManager.getSessionId())}`,
            { headers: { "x-pi-companion": "1" }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
          );
          if (res.status === 200) {
            const { commands } = (await res.json()) as { commands?: Array<{ cmdId: string; type?: string; text?: unknown }> };
            for (const command of commands ?? []) {
              const error = runCommand(lastCtx ?? ctx, command);
              void ack(command.cmdId, error);
            }
          } else if (res.status !== 204) {
            await new Promise((r) => setTimeout(r, BACKOFF_MS).unref?.());
          }
        } catch {
          if (signal.aborted) break;
          // Server not running (or restarting): try again in a few seconds.
          await new Promise((r) => setTimeout(r, BACKOFF_MS).unref?.());
        }
      }
    }
  };

  const startInbox = () => {
    inboxAbort?.abort();
    inboxAbort = new AbortController();
    void runInbox(inboxAbort);
  };

  const flush = async () => {
    flushTimer = undefined;
    const ctx = lastCtx;
    if (!ctx || posting) return;
    if (Date.now() < offlineUntil) {
      queue = [];
      return;
    }
    const events = queue;
    queue = [];
    posting = true;
    try {
      await fetch(INGEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-companion": "1" },
        body: JSON.stringify({ ...snapshot(ctx), events }),
        signal: AbortSignal.timeout(1500),
      });
    } catch {
      offlineUntil = Date.now() + BACKOFF_MS;
    } finally {
      posting = false;
      if (queue.length && !flushTimer) schedule();
    }
  };

  const schedule = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => void flush(), FLUSH_MS);
    flushTimer.unref?.();
  };

  const push = (ctx: ExtensionContext, event: { type: string; [key: string]: unknown }) => {
    if (!ctx.hasUI) return;
    lastCtx = ctx;
    // Streaming updates replace each other; only the newest text matters.
    if (event.type === "stream" && queue.length && queue[queue.length - 1].type === "stream") {
      queue[queue.length - 1] = { ...event, at: Date.now() };
    } else {
      queue.push({ ...event, at: Date.now() });
    }
    schedule();
  };

  pi.on("session_start", async (event, ctx) => {
    if (!ctx.hasUI) return;
    offlineUntil = 0;
    push(ctx, { type: "session_start", reason: event.reason });
    startInbox();
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        if (lastCtx) push(lastCtx, { type: "hello" });
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    inboxAbort?.abort();
    inboxAbort = undefined;
    push(ctx, { type: "shutdown" });
    if (flushTimer) clearTimeout(flushTimer);
    await flush();
  });

  pi.on("session_info_changed", async (_event, ctx) => push(ctx, { type: "hello" }));
  pi.on("model_select", async (_event, ctx) => push(ctx, { type: "hello" }));

  pi.on("agent_start", async (_event, ctx) => push(ctx, { type: "agent_start" }));
  pi.on("agent_settled", async (event, ctx) => push(ctx, { type: "agent_settled", aborted: event.aborted }));
  pi.on("turn_end", async (_event, ctx) => push(ctx, { type: "turn_end" }));

  pi.on("message_update", async (event, ctx) => {
    if (event.message?.role !== "assistant") return;
    const content = (event.message as { content?: unknown }).content;
    push(ctx, { type: "stream", text: textOf(content, "text"), thinking: textOf(content, "thinking") });
  });
  pi.on("message_end", async (event, ctx) => push(ctx, { type: "message_end", role: event.message?.role }));

  pi.on("tool_execution_start", async (event, ctx) => {
    if (event.parentToolCallId) return;
    push(ctx, {
      type: "tool_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: short(event.args, 400),
    });
  });
  pi.on("tool_execution_update", async (event, ctx) => {
    if (event.parentToolCallId) return;
    push(ctx, { type: "tool_update", toolCallId: event.toolCallId, partial: tail(event.partialResult, 1500) });
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.parentToolCallId) return;
    push(ctx, { type: "tool_end", toolCallId: event.toolCallId, isError: event.isError });
  });

  pi.on("session_before_compact", async (event, ctx) => {
    let tokens: number | undefined;
    try {
      tokens = ctx.getContextUsage()?.tokens ?? undefined;
    } catch {
      tokens = undefined;
    }
    push(ctx, { type: "compaction_start", reason: event.reason, tokens });
    // Send now: compaction can take a while and nothing else is queued meanwhile.
    if (flushTimer) clearTimeout(flushTimer);
    void flush();
  });
  pi.on("session_compact", async (event, ctx) =>
    push(ctx, {
      type: "compaction_end",
      reason: event.reason,
      tokensBefore: (event.compactionEntry as { tokensBefore?: number })?.tokensBefore,
    }),
  );
  pi.on("session_compact_failed", async (event, ctx) =>
    push(ctx, {
      type: "compaction_failed",
      reason: event.reason,
      aborted: event.aborted,
      errorMessage: event.errorMessage,
    }),
  );

  pi.registerCommand("companion", {
    description: "Open the Pi companion window (live view of this session); starts its server if needed",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const wasUp = await isPortUp();
      const error = await ensureServer();
      if (error) {
        ctx.ui.notify(`[companion] ${error}`, "error");
        return;
      }
      offlineUntil = 0;
      push(ctx, { type: "hello" });
      if (/\b(server|no-?open)\b/i.test(args)) {
        ctx.ui.notify(`[companion] Server ${wasUp ? "already running" : "started"} on ${URL_BASE}.`, "info");
        return;
      }
      try {
        openWindow();
      } catch (err) {
        ctx.ui.notify(`[companion] Open ${URL_BASE} in a browser (could not launch one: ${String(err)}).`, "warning");
        return;
      }
      ctx.ui.notify(`[companion] ${wasUp ? "Opened" : "Started the server and opened"} ${URL_BASE}.`, "info");
    },
  });
}
