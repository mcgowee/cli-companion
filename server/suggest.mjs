// Suggested replies for the composer: when a session has finished a turn, ask a model on the
// local Ollama for 2–4 short replies the user might send next. If the CLI's last message asks
// the user to pick (numbered options, "A or B?", yes/no), the replies are those choices.
//
// Rules: local only. The Ollama address must be on this computer (loopback), and cloud models
// (names ending in "cloud", or with a remote host) are refused, so the transcript never leaves the
// machine. Off unless switched on in Settings. Results are cached per session message.

import { isLoopbackUrl } from "./dashboards.mjs";

export class SuggestError extends Error {}

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const MAX_REPLY_CHARS = 6000;
const MAX_ASK_CHARS = 1500;
const MAX_SUGGESTIONS = 4;
const MAX_SUGGESTION_CHARS = 400;

/** The Ollama address to use: OLLAMA_HOST when it is on this computer, else the default. */
export function ollamaUrl(env = process.env) {
  const host = String(env.OLLAMA_HOST ?? "").trim();
  if (!host) return DEFAULT_OLLAMA_URL;
  const url = /^https?:\/\//.test(host) ? host : `http://${host}`;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "0.0.0.0" || parsed.hostname === "::") parsed.hostname = "127.0.0.1";
    if (!parsed.port) parsed.port = "11434";
    return isLoopbackUrl(parsed.href) ? parsed.origin : DEFAULT_OLLAMA_URL;
  } catch {
    return DEFAULT_OLLAMA_URL;
  }
}

/** A model that runs elsewhere (Ollama Cloud): never used for suggestions. */
export function isCloudModel(model) {
  return Boolean(model?.remote_host || model?.remote_model) || /(^|[:-])cloud$/i.test(String(model?.name ?? model ?? ""));
}

/** Local chat models on this Ollama (no cloud, embedding or OCR models), smallest first. */
export async function localModels(baseUrl, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new SuggestError(`Ollama isn't answering at ${baseUrl} (${error.cause?.code ?? error.name}). Is it running?`);
  }
  if (!res.ok) throw new SuggestError(`Ollama answered ${res.status} at ${baseUrl}.`);
  const data = await res.json();
  return (Array.isArray(data?.models) ? data.models : [])
    .filter((m) => typeof m?.name === "string" && !isCloudModel(m) && !/embed|ocr/i.test(m.name))
    .map((m) => ({ name: m.name, size: Number(m.size) || 0, parameters: m.details?.parameter_size ?? "" }))
    .sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
}

/**
 * The turn that just finished: the user's last message and the CLI's last text reply after it.
 * null while there is no reply yet (still working, or the session ends on the user's message).
 */
export function lastExchange(items) {
  if (!Array.isArray(items)) return null;
  let userIndex = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.kind === "user" && String(items[i].text ?? "").trim()) {
      userIndex = i;
      break;
    }
  }
  for (let i = items.length - 1; i > userIndex; i--) {
    const item = items[i];
    const text = String(item?.text ?? "").trim();
    if (item?.kind === "assistant" && text) {
      return { id: String(item.id ?? i), reply: text, ask: userIndex >= 0 ? String(items[userIndex].text).trim() : "" };
    }
  }
  return null;
}

const SYSTEM = `You help someone reply to a coding assistant that runs in their terminal.
You get the person's last message and the assistant's reply. Suggest what the person might send next.
- If the reply asks the person to choose (numbered or lettered options, "A or B?", "should I…?", yes/no), give those choices as replies, in the reply's order, each worded as the person's answer (for example "Yes, push it" or "Use option 2: local Ollama").
- Otherwise give 2 to 4 short, useful next messages: a follow-up, a go-ahead, a check, a correction.
- Write each as the person speaking, in plain words, under 25 words. No numbering, no quotes, no emoji.
- Never invent facts that are not in the reply.
Answer only with JSON: {"replies": ["...", "..."]}`;

/** Ollama's structured-output schema for the answer. */
const FORMAT = {
  type: "object",
  properties: { replies: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_SUGGESTIONS } },
  required: ["replies"],
};

/** Clean what the model returned: strings only, trimmed, no repeats, at most four. */
export function cleanSuggestions(value) {
  const list = Array.isArray(value?.replies) ? value.replies : Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const text = entry
      .replace(/^\s*(?:[-*•]|\d+[.)]|[A-Da-d][.)])\s+/, "")
      .replace(/^["“](.*)["”]$/s, "$1")
      .trim()
      .slice(0, MAX_SUGGESTION_CHARS);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

/** Ask the model. Returns a list of reply strings. */
export async function suggestReplies({ baseUrl, model, exchange, fetchImpl = fetch, timeoutMs = 120_000 }) {
  if (!model) throw new SuggestError("Pick a model for suggested replies in Settings.");
  if (!isLoopbackUrl(baseUrl)) throw new SuggestError("Suggested replies only use an Ollama on this computer.");
  if (isCloudModel(model)) throw new SuggestError("Cloud models aren't used for suggested replies. Pick a local one in Settings.");
  const reply = exchange.reply.length > MAX_REPLY_CHARS ? `…${exchange.reply.slice(-MAX_REPLY_CHARS)}` : exchange.reply;
  const ask = exchange.ask.length > MAX_ASK_CHARS ? `${exchange.ask.slice(0, MAX_ASK_CHARS)}…` : exchange.ask;
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: FORMAT,
        options: { temperature: 0.3, num_ctx: 8192 },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `The person wrote:\n${ask || "(nothing)"}\n\nThe assistant replied:\n${reply}` },
        ],
      }),
    });
  } catch (error) {
    if (error.name === "TimeoutError") throw new SuggestError(`${model} took too long to answer.`);
    throw new SuggestError(`Ollama isn't answering at ${baseUrl}. Is it running?`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new SuggestError(`Ollama: ${body.error ?? `HTTP ${res.status}`}`);
  let parsed;
  try {
    parsed = JSON.parse(body.message?.content ?? "");
  } catch {
    throw new SuggestError(`${model} didn't answer in the expected form. Try another model in Settings.`);
  }
  const suggestions = cleanSuggestions(parsed);
  if (!suggestions.length) throw new SuggestError(`${model} gave no suggestions.`);
  return suggestions;
}

/** Remembers suggestions per session message, and shares one request between callers. */
export function suggestionCache(limit = 50) {
  const entries = new Map();
  return {
    get(key, make) {
      if (entries.has(key)) return entries.get(key);
      const promise = make().catch((error) => {
        entries.delete(key); // don't keep a failure: the next look tries again
        throw error;
      });
      entries.set(key, promise);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      return promise;
    },
  };
}
