// Token use, read line by line from each CLI's own session file. Each reader takes one raw JSONL
// line and adds to a usage record (`newUsage()`); it never needs the lines before it beyond what
// the record keeps in `_`. Lines that can't matter are skipped by a cheap text check before parsing.
//
// What each CLI writes (checked 2026-11-07):
// - Claude Code 2.1.x: every assistant line has message.usage; the lines of one reply repeat the
//   same message.id and usage (counted once). Now and then a "cost-state" line with Claude Code's
//   own running cost estimate (totalCostUSD, cumulative per process: drops back when resumed).
// - Codex 0.166: event_msg "token_count" lines with cumulative total_token_usage, the last turn's
//   last_token_usage, model_context_window, and the plan's rate limits. input_tokens includes the
//   cached ones. No cost.
// - Pi: assistant "message" lines with usage { input, output, cacheRead, cacheWrite, totalTokens,
//   cost.total } (cost only when the provider prices it).

/** An empty usage record. Plain JSON, so it can be cached on disk. */
export function newUsage() {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    turns: 0,
    costUsd: 0,
    costAt: undefined, // Claude: when its estimate was last saved
    hours: {}, // "YYYY-MM-DDTHH" (UTC) -> { i, o, cr, cw, c, n }
    context: undefined, // { tokens, window?, at }
    model: undefined,
    rateLimits: undefined, // Codex: [{ label, usedPercent, windowMinutes, resetsAt }]
    lines: undefined, // Claude: { added, removed } as Claude Code counts them
    _: { ids: [], lastAt: undefined, lastCost: 0, prev: undefined },
  };
}

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

function hourOf(at) {
  const ms = typeof at === "number" ? at : Date.parse(at ?? "");
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 13) : undefined;
}

function bucket(u, at) {
  const hour = hourOf(at ?? u._.lastAt);
  if (!hour) return undefined;
  return (u.hours[hour] ??= { i: 0, o: 0, cr: 0, cw: 0, c: 0, n: 0 });
}

/** Add one model call's tokens (and cost, when known) to the record and its hour. */
function addCall(u, at, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0 }, countTurn = true) {
  u.tokens.input += input;
  u.tokens.output += output;
  u.tokens.cacheRead += cacheRead;
  u.tokens.cacheWrite += cacheWrite;
  u.costUsd += cost;
  if (countTurn) u.turns += 1;
  const b = bucket(u, at);
  if (b) {
    b.i += input;
    b.o += output;
    b.cr += cacheRead;
    b.cw += cacheWrite;
    b.c += cost;
    if (countTurn) b.n += 1;
  }
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined; // half-written last line
  }
}

/* ── Claude Code ─────────────────────────────────────── */

export function claudeUsageLine(line, u) {
  if (line.startsWith('{"type":"cost-state"')) {
    const e = parse(line);
    const total = Number(e?.totalCostUSD);
    if (!Number.isFinite(total)) return;
    // Cumulative per process; a resumed session starts again from 0.
    const delta = total >= u._.lastCost ? total - u._.lastCost : total;
    u._.lastCost = total;
    if (delta > 0) addCall(u, undefined, { cost: delta }, false);
    if (delta > 0 || u.costAt === undefined) u.costAt = u._.lastAt;
    if (Number.isFinite(e.totalLinesAdded)) u.lines = { added: e.totalLinesAdded, removed: num(e.totalLinesRemoved) };
    return;
  }
  if (!line.includes('"usage"') || !line.includes('"type":"assistant"')) return;
  const e = parse(line);
  if (e?.type !== "assistant" || e.isSidechain) return;
  const m = e.message;
  const usage = m?.usage;
  if (!usage || typeof m.model !== "string" || m.model.startsWith("<")) return;
  if (e.timestamp) u._.lastAt = e.timestamp;
  // The lines of one reply share its id and usage.
  if (m.id) {
    if (u._.ids.includes(m.id)) return;
    u._.ids.push(m.id);
    if (u._.ids.length > 40) u._.ids.shift();
  }
  const call = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
  };
  addCall(u, e.timestamp, call);
  u.model = m.model;
  u.context = { tokens: call.input + call.cacheRead + call.cacheWrite + call.output, at: e.timestamp };
}

/* ── Codex ───────────────────────────────────────────── */

const LIMIT_LABELS = { 300: "5-hour limit", 10080: "Weekly limit" };

export function codexUsageLine(line, u) {
  if (line.includes('"type":"turn_context"')) {
    const e = parse(line);
    if (e?.type === "turn_context" && typeof e.payload?.model === "string") u.model = e.payload.model;
    return;
  }
  if (!line.includes('"token_count"')) return;
  const e = parse(line);
  const p = e?.payload;
  if (e?.type !== "event_msg" || p?.type !== "token_count") return;
  if (e.timestamp) u._.lastAt = e.timestamp;
  const info = p.info;
  const total = info?.total_token_usage;
  if (total) {
    const now = {
      input: num(total.input_tokens),
      cached: num(total.cached_input_tokens),
      write: num(total.cache_write_input_tokens),
      output: num(total.output_tokens),
    };
    let prev = u._.prev ?? { input: 0, cached: 0, write: 0, output: 0 };
    // Cumulative; if it went down, this is a fresh count.
    if (now.input < prev.input || now.output < prev.output) prev = { input: 0, cached: 0, write: 0, output: 0 };
    const dInput = now.input - prev.input;
    const dCached = Math.max(0, now.cached - prev.cached);
    const call = {
      input: Math.max(0, dInput - dCached),
      cacheRead: dCached,
      cacheWrite: Math.max(0, now.write - prev.write),
      output: now.output - prev.output,
    };
    u._.prev = now;
    if (call.input || call.output || call.cacheRead || call.cacheWrite) addCall(u, e.timestamp, call);
  }
  const last = info?.last_token_usage;
  if (last) {
    u.context = {
      tokens: num(last.total_tokens) || num(last.input_tokens) + num(last.output_tokens),
      window: num(info.model_context_window) || undefined,
      at: e.timestamp,
    };
  }
  const limits = [p.rate_limits?.primary, p.rate_limits?.secondary].filter((l) => l && Number.isFinite(l.used_percent));
  if (limits.length) {
    u.rateLimits = limits.map((l) => ({
      label: LIMIT_LABELS[l.window_minutes] ?? `${Math.round(l.window_minutes / 60)}-hour limit`,
      usedPercent: l.used_percent,
      windowMinutes: l.window_minutes,
      resetsAt: Number.isFinite(l.resets_at) ? l.resets_at * 1000 : undefined,
      at: e.timestamp,
    }));
  }
}

/* ── Pi ──────────────────────────────────────────────── */

export function piUsageLine(line, u) {
  if (!line.startsWith('{"type":"message"') || !line.includes('"usage"')) return;
  const e = parse(line);
  const m = e?.message;
  if (m?.role !== "assistant" || !m.usage) return;
  const usage = m.usage;
  const at = e.timestamp ?? m.timestamp;
  if (at) u._.lastAt = at;
  const call = {
    input: num(usage.input),
    output: num(usage.output),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
    cost: num(usage.cost?.total),
  };
  addCall(u, at, call);
  if (m.model) u.model = m.provider ? `${m.provider}/${m.model}` : m.model;
  u.context = { tokens: num(usage.totalTokens) || call.input + call.cacheRead + call.cacheWrite + call.output, at };
}

/** The per-source line readers. */
export const USAGE_LINE_READERS = { claude: claudeUsageLine, codex: codexUsageLine, pi: piUsageLine };

/** What the page sees of a record (no bookkeeping, no hours). */
export function publicUsage(u, source) {
  if (!u) return undefined;
  return {
    source,
    tokens: u.tokens,
    turns: u.turns,
    // Claude: Claude Code's own estimate, as last saved. Pi: summed from the provider's prices.
    costUsd: u.costUsd > 0 ? u.costUsd : undefined,
    costKind: u.costUsd > 0 ? (source === "claude" ? "claude-estimate" : "provider") : undefined,
    costAt: u.costAt,
    context: u.context,
    model: u.model,
    rateLimits: u.rateLimits,
    lines: u.lines,
  };
}
