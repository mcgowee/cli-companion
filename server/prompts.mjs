// Saved prompts for the composer (Prompts button, Ctrl+K): text you send often, kept in
// ~/.cli-companion/prompts.json as { prompts: [{ id, text, label, cli }] }, in your order.
// `cli` is "" for every CLI, or one CLI's id. Written only from the companion page on this
// computer. Suggestions come from messages you typed more than once (read from the in-memory
// search index; nothing is saved until you pick one).

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class PromptError extends Error {}

export const MAX_PROMPTS = 100;
const MAX_TEXT = 4000;
const MAX_LABEL = 60;
const ID = /^[\w-]{1,64}$/;

/** Check and tidy a list from the page. `clis` is the set of known CLI ids. */
export function validatePrompts(input, clis = new Set()) {
  if (!Array.isArray(input)) throw new PromptError("Expected a list of prompts.");
  if (input.length > MAX_PROMPTS) throw new PromptError(`At most ${MAX_PROMPTS} prompts.`);
  const seen = new Set();
  return input.map((p) => {
    const text = typeof p?.text === "string" ? p.text.replace(/\r\n/g, "\n").trim() : "";
    if (!text) throw new PromptError("A prompt can't be empty.");
    if (text.length > MAX_TEXT) throw new PromptError(`A prompt can be at most ${MAX_TEXT} characters.`);
    const label = typeof p.label === "string" ? p.label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL) : "";
    const cli = typeof p.cli === "string" && clis.has(p.cli) ? p.cli : "";
    let id = typeof p.id === "string" && ID.test(p.id) ? p.id : randomUUID();
    if (seen.has(id)) id = randomUUID();
    seen.add(id);
    return { id, text, label, cli };
  });
}

export async function loadPrompts(file, clis) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return validatePrompts(Array.isArray(data?.prompts) ? data.prompts.slice(0, MAX_PROMPTS) : [], clis);
  } catch {
    return [];
  }
}

export async function savePrompts(file, prompts) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ prompts }, null, 2)}\n`);
  await rename(tmp, file);
}

// "Where are we?" and "where are we" count as one.
const key = (text) => text.replace(/\s+/g, " ").trim().toLowerCase().replace(/[\s.?!…]+$/, "");
// Not something you typed: CLI notes ("[Request interrupted by user]", "[Image: …]") and markup.
const NOT_TYPED = /^\s*[[<]/;

/**
 * Messages you typed more than once, most used first.
 * @param messages iterable of { source, t, at } (your messages only)
 * @param saved texts already saved (left out)
 * @returns [{ text, count, clis: [id], last }]
 */
export function frequentPrompts(messages, { saved = [], min = 2, limit = 20, minLength = 10, maxLength = 400 } = {}) {
  const skip = new Set(saved.map(key));
  const groups = new Map();
  for (const m of messages) {
    const text = String(m.t ?? "").trim();
    if (text.length < minLength || text.length > maxLength || text.startsWith("/") || NOT_TYPED.test(text)) continue;
    const k = key(text);
    if (skip.has(k)) continue;
    const at = Date.parse(m.at ?? "") || 0;
    const g = groups.get(k) ?? { text, count: 0, clis: new Set(), last: 0 };
    g.count += 1;
    g.clis.add(m.source ?? "pi");
    if (at >= g.last) {
      g.last = at;
      g.text = text;
    }
    groups.set(k, g);
  }
  return [...groups.values()]
    .filter((g) => g.count >= min)
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, limit)
    .map((g) => ({ ...g, clis: [...g.clis] }));
}
