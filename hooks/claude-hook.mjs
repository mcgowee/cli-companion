#!/usr/bin/env node
// Claude Code hook → Pi Companion.
//
// Install as a command hook for SessionStart, UserPromptSubmit, PreToolUse, PreCompact, Stop and
// SessionEnd (see README). It forwards the event to the companion server on 127.0.0.1 so the
// window can show live status, and on Stop it collects text queued in the companion's composer
// and hands it to Claude as the next instruction.
//
// Rules: never slow Claude Code down or break it. Every request has a short timeout; if the
// companion isn't running, the hook prints nothing and exits 0 (Claude carries on as usual).

import { eventFromHook, stopHookOutput } from "../server/claude-hooks.mjs";

const PORT = Number.parseInt(process.env.PI_COMPANION_PORT ?? "30143", 10);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const event = eventFromHook(payload);
  if (!event || !payload.session_id) return;
  const res = await fetch(`http://127.0.0.1:${PORT}/claude/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pi-companion": "1" },
    body: JSON.stringify({
      sessionId: payload.session_id,
      transcriptPath: payload.transcript_path,
      cwd: payload.cwd,
      // No pid: Claude Code runs hooks through a short-lived shell, so process.ppid is gone
      // as soon as the hook ends. The companion relies on SessionEnd (and a long idle expiry).
      event: { ...event, at: Date.now() },
    }),
    signal: AbortSignal.timeout(event.type === "stop" ? 2500 : 1200),
  });
  if (event.type !== "stop" || !res.ok) return;
  const body = await res.json().catch(() => ({}));
  const output = stopHookOutput(body.messages);
  if (output) process.stdout.write(JSON.stringify(output));
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
