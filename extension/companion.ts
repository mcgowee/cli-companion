/**
 * Pi extension: bridge to the CLI Companion window.
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
// Starting the server and opening the window is shared with the standalone `cli-companion` command.
import { ACCESS_HEADER, accessKey, companionPort, companionUrl, ensureServer, isPortUp, openWindow } from "../server/start.mjs";

const PORT = companionPort();
const URL_BASE = companionUrl(PORT);
const INGEST_URL = `${URL_BASE}/ingest`;

/** Every request to the companion carries this computer's access key (read once, made if missing). */
let keyHeaders: Record<string, string> | undefined;
function companionHeaders(): Record<string, string> {
  keyHeaders ??= { "x-pi-companion": "1", [ACCESS_HEADER]: accessKey() };
  return keyHeaders;
}
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

export default function companionBridge(pi: ExtensionAPI): void {
  let queue: BridgeEvent[] = [];
  let lastCtx: ExtensionContext | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let offlineUntil = 0;
  let posting = false;
  let agentRunning = false;

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
      // Our own flag: true from agent_start until agent_settled. ctx.isIdle() only means "not
      // streaming", so it is true while a tool runs and can't tell working from idle.
      running: agentRunning,
      mode: ctx.mode,
      context,
    };
  };

  /** Extension, prompt-template and skill commands (Pi's built-ins are listed by the server). */
  const commandList = () => {
    try {
      return pi.getCommands().map((c) => ({ name: c.name, description: c.description ?? "", source: c.source }));
    } catch {
      return undefined;
    }
  };

  /* ── commands from the companion window (long poll) ── */

  let inboxAbort: AbortController | undefined;

  type CommandResult = { error?: string; editor?: string; detail?: string };
  const EDITOR_REPORT_MAX = 50_000;

  /**
   * Apply one command from the window:
   *  - paste:  add text to Pi's input box (the user still decides when to send)
   *  - peek:   report what is in the input box (so the window can show it)
   *  - clear:  empty the input box
   *  - submit: send what is in the input box as the user's message, like pressing Enter
   * Every result carries the input box's text afterwards, so the window can verify it.
   */
  const runCommand = (ctx: ExtensionContext, command: { type?: string; text?: unknown }): CommandResult => {
    if (ctx.mode !== "tui") return { error: "Only the Pi CLI (terminal) has an input box." };
    const report = (): string => ctx.ui.getEditorText().slice(0, EDITOR_REPORT_MAX);

    switch (command.type) {
      case "peek":
        return { editor: report() };

      case "clear":
        ctx.ui.setEditorText("");
        ctx.ui.notify("[companion] Cleared the input box.", "info");
        return { editor: report() };

      case "paste": {
        if (typeof command.text !== "string") return { error: "Nothing to paste." };
        const before = ctx.ui.getEditorText();
        // Something already typed: start the pasted text on a new line instead of gluing it on.
        const text = before && !/\s$/.test(before) ? `\n${command.text}` : command.text;
        try {
          ctx.ui.pasteToEditor(text);
        } catch {
          // Older Pi without paste handling: append to whatever is already typed.
          ctx.ui.setEditorText(before ? `${before}\n${text}` : text);
        }
        if (ctx.ui.getEditorText() === before) {
          return { error: "Pi's input box did not change (is a dialog open in Pi?).", editor: report() };
        }
        // The paste does not redraw the terminal by itself; a notice does, and says where the text came from.
        const lines = command.text.split("\n").length;
        ctx.ui.notify(`[companion] Pasted ${lines} line${lines === 1 ? "" : "s"} into the input.`, "info");
        return { editor: report() };
      }

      case "submit": {
        const text = ctx.ui.getEditorText();
        if (!text.trim()) return { error: "Pi's input box is empty.", editor: "" };
        // Slash commands, !shell lines and prompt templates are handled by the terminal's Enter key,
        // not by sendUserMessage, so leave those for the user to press Enter on.
        if (/^\s*[/!]/.test(text)) {
          return { error: "That's a / command or ! shell line. Press Enter in the terminal for those.", editor: report() };
        }
        const busy = !ctx.isIdle();
        ctx.ui.setEditorText("");
        try {
          if (busy) pi.sendUserMessage(text, { deliverAs: "followUp" });
          else pi.sendUserMessage(text);
        } catch (err) {
          ctx.ui.setEditorText(text); // put it back so nothing is lost
          return { error: `Pi refused the message: ${String(err)}`, editor: report() };
        }
        return { editor: report(), detail: busy ? "queued" : "sent" };
      }

      default:
        return { error: "Unknown command." };
    }
  };

  const ack = (cmdId: unknown, result: CommandResult) =>
    fetch(`${URL_BASE}/bridge/ack`, {
      method: "POST",
      headers: { "content-type": "application/json", ...companionHeaders() },
      body: JSON.stringify({ cmdId, ok: !result.error, ...result }),
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
            { headers: companionHeaders(), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
          );
          if (res.status === 200) {
            const { commands } = (await res.json()) as { commands?: Array<{ cmdId: string; type?: string; text?: unknown }> };
            for (const command of commands ?? []) {
              let result: CommandResult;
              try {
                result = runCommand(lastCtx ?? ctx, command);
              } catch (err) {
                result = { error: `Pi could not do that: ${String(err)}` };
              }
              void ack(command.cmdId, result);
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
    // The slash-command list (for the window's "/" lookup) rides only on start and heartbeat.
    const withCommands = events.some((e) => e.type === "session_start" || e.type === "hello");
    try {
      await fetch(INGEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", ...companionHeaders() },
        body: JSON.stringify({ ...snapshot(ctx), ...(withCommands ? { commands: commandList() } : {}), events }),
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

  pi.on("agent_start", async (_event, ctx) => {
    agentRunning = true;
    push(ctx, { type: "agent_start" });
  });
  pi.on("agent_settled", async (event, ctx) => {
    agentRunning = false;
    push(ctx, { type: "agent_settled", aborted: event.aborted });
  });
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
    description: "Open the CLI Companion window (live view of this session); starts its server if needed",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const wasUp = await isPortUp(PORT);
      const { error } = await ensureServer({ port: PORT });
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
      const opened = await openWindow({ port: PORT });
      if (opened.error) {
        ctx.ui.notify(`[companion] Couldn't open a browser (${opened.error}). Open ${opened.url} yourself.`, "warning");
        return;
      }
      ctx.ui.notify(`[companion] ${wasUp ? "Opened" : "Started the server and opened"} ${URL_BASE}.`, "info");
    },
  });
}
