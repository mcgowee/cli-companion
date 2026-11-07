/**
 * Global Pi extension: bridge to the Pi companion (C:\AI\pi\companion).
 *
 * Mirrors live session events (streaming text, tools, turns, compaction) to the
 * companion server on 127.0.0.1:30143 so its window can show what the CLI is
 * doing. Also adds `/companion` to open that window.
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
 *
 * Source of truth: C:\AI\pi\companion\extension\companion.ts. The copy in
 * ~/.pi/agent/extensions is installed by launcher\install-extension.ps1.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PORT = Number.parseInt(process.env.PI_COMPANION_PORT ?? "30143", 10);
const INGEST_URL = `http://127.0.0.1:${PORT}/ingest`;
const OPEN_SCRIPT = "C:\\AI\\pi\\companion\\launcher\\open-companion.ps1";
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
      context,
    };
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
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const result = await pi.exec(
        "pwsh.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", OPEN_SCRIPT, "-Port", String(PORT)],
        { timeout: 30_000 },
      );
      if (result.code !== 0) {
        ctx.ui.notify(`[companion] ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`, "error");
        return;
      }
      offlineUntil = 0;
      push(ctx, { type: "hello" });
      ctx.ui.notify("[companion] Opened.", "info");
    },
  });
}
