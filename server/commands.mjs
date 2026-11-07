// Commands the page can send to a running Pi through the bridge's inbox.
//
// paste  — add text to Pi's input box (text required)
// peek   — report what is in Pi's input box
// clear  — empty Pi's input box
// submit — send what is in Pi's input box, like pressing Enter in the terminal
//
// Pure validation, so it can be tested without a server.

import { randomUUID } from "node:crypto";

export const COMMAND_TYPES = new Set(["paste", "peek", "clear", "submit"]);
export const MAX_SEND_CHARS = 200_000;

/**
 * Turn a page request body into a command, or an error with an HTTP status.
 * The page may pick the command id (so a fast reply can't race the response).
 */
export function commandFromRequest(body) {
  const type = body?.type === undefined ? "paste" : String(body.type);
  if (!COMMAND_TYPES.has(type)) return { status: 400, error: "Unknown command." };
  const cmdId = /^[0-9a-f-]{36}$/i.test(String(body?.cmdId ?? "")) ? String(body.cmdId) : randomUUID();
  if (type !== "paste") return { command: { cmdId, type } };
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) return { status: 400, error: "Nothing to send." };
  if (text.length > MAX_SEND_CHARS) return { status: 413, error: "Too long to paste (over 200,000 characters)." };
  return { command: { cmdId, type, text } };
}
