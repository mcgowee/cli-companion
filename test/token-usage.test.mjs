import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeUsageLine, codexUsageLine, newUsage, piUsageLine, publicUsage } from "../server/token-lines.mjs";
import { createTokenTracker, readNewLines } from "../server/token-usage.mjs";

const claudeReply = (id, at, usage, extra = {}) =>
  JSON.stringify({ parentUuid: "p", isSidechain: false, type: "assistant", timestamp: at, message: { id, model: "claude-opus-5-5", usage }, ...extra });

test("Claude: one reply split over several lines counts once; sidechain and synthetic lines don't count", () => {
  const u = newUsage();
  const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 };
  claudeUsageLine(claudeReply("m1", "2026-11-07T10:00:00Z", usage), u);
  claudeUsageLine(claudeReply("m1", "2026-11-07T10:00:01Z", usage), u); // same reply, next block
  claudeUsageLine(claudeReply("m2", "2026-11-07T11:30:00Z", { ...usage, output_tokens: 10 }, { isSidechain: true }), u);
  claudeUsageLine(JSON.stringify({ type: "assistant", message: { id: "m3", model: "<synthetic>", usage } }), u);
  assert.deepEqual(u.tokens, { input: 2, output: 50, cacheRead: 1000, cacheWrite: 100 });
  assert.equal(u.turns, 1);
  assert.equal(u.context.tokens, 1152);
  assert.equal(u.hours["2026-11-07T10"].cr, 1000);
});

test("Claude: cost-state is cumulative per process; a resumed session starts again from 0", () => {
  const u = newUsage();
  const cost = (usd) => JSON.stringify({ type: "cost-state", totalCostUSD: usd, totalLinesAdded: 5, totalLinesRemoved: 1 });
  claudeUsageLine(claudeReply("a", "2026-11-07T09:00:00Z", { input_tokens: 1, output_tokens: 1 }), u);
  claudeUsageLine(cost(2), u);
  claudeUsageLine(cost(2), u); // saved again, nothing new
  claudeUsageLine(cost(3.5), u);
  claudeUsageLine(cost(1), u); // resumed: a new count
  assert.equal(u.costUsd, 4.5);
  assert.equal(u.hours["2026-11-07T09"].c, 4.5);
  assert.deepEqual(u.lines, { added: 5, removed: 1 });
  assert.equal(publicUsage(u, "claude").costKind, "claude-estimate");
});

test("Codex: cumulative counts become per-call deltas; cached input is split out; limits and context kept", () => {
  const u = newUsage();
  const line = (at, total, last) =>
    JSON.stringify({
      timestamp: at,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: total, last_token_usage: last, model_context_window: 400000 },
        rate_limits: { primary: { used_percent: 4, window_minutes: 300, resets_at: 1794078731 }, secondary: { used_percent: 1, window_minutes: 10080 } },
      },
    });
  codexUsageLine(JSON.stringify({ type: "turn_context", payload: { model: "gpt-x" } }), u);
  codexUsageLine(line("2026-11-07T10:00:00Z", { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100 }, { total_tokens: 1100 }), u);
  codexUsageLine(line("2026-11-07T10:05:00Z", { input_tokens: 3000, cached_input_tokens: 2400, output_tokens: 150 }, { total_tokens: 2050 }), u);
  assert.deepEqual(u.tokens, { input: 600, output: 150, cacheRead: 2400, cacheWrite: 0 });
  assert.equal(u.turns, 2);
  assert.deepEqual(u.context, { tokens: 2050, window: 400000, at: "2026-11-07T10:05:00Z" });
  assert.deepEqual(u.rateLimits.map((l) => [l.label, l.usedPercent]), [["5-hour limit", 4], ["Weekly limit", 1]]);
  assert.equal(u.model, "gpt-x");
});

test("Pi: assistant messages with usage and the provider's cost", () => {
  const u = newUsage();
  const msg = (role, usage) => JSON.stringify({ type: "message", timestamp: "2026-11-07T08:00:00Z", message: { role, provider: "anthropic", model: "m", usage } });
  piUsageLine(msg("user", { input: 5 }), u);
  piUsageLine(msg("assistant", { input: 10, output: 20, cacheRead: 300, cacheWrite: 0, totalTokens: 330, cost: { total: 0.25 } }), u);
  assert.deepEqual(u.tokens, { input: 10, output: 20, cacheRead: 300, cacheWrite: 0 });
  assert.equal(u.costUsd, 0.25);
  assert.equal(u.model, "anthropic/m");
  assert.equal(u.context.tokens, 330);
});

test("readNewLines: only complete lines; a half-written line is read next time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokens-"));
  const file = join(dir, "s.jsonl");
  await writeFile(file, 'one\r\ntwo\nthr');
  const seen = [];
  let offset = await readNewLines(file, 0, (l) => seen.push(l));
  assert.deepEqual(seen, ["one", "two"]);
  await appendFile(file, "ee\n");
  offset = await readNewLines(file, offset, (l) => seen.push(l));
  assert.deepEqual(seen, ["one", "two", "three"]);
  assert.equal(offset, 15);
});

test("tracker: reads only what was added, starts over when a file shrinks, sums per local day", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokens-"));
  const file = join(dir, "s.jsonl");
  const msg = (at, input) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", usage: { input, output: 0, cost: { total: 0 } } } }) + "\n";
  await writeFile(file, msg("2026-11-07T07:30:00Z", 100));
  const tracker = createTokenTracker({});
  const meta = { id: "s1", source: "pi", file, name: "Test" };
  assert.equal((await tracker.forSession(meta)).tokens.input, 100);
  await appendFile(file, msg("2026-11-07T09:30:00Z", 50));
  assert.equal((await tracker.forSession(meta)).tokens.input, 150);
  // UTC-8: 07:30Z is Nov 6 locally, 09:30Z is Nov 7.
  const sum = tracker.summary([meta], { now: Date.parse("2026-11-07T20:00:00Z"), days: 2, offsetMin: -480, sources: ["pi"] });
  assert.deepEqual(sum.daily, [{ date: "2026-11-06", pi: 100 }, { date: "2026-11-07", pi: 50 }]);
  assert.equal(sum.topSessions[0].tokens, 150);
  await writeFile(file, msg("2026-11-07T10:00:00Z", 7));
  assert.equal((await tracker.forSession(meta)).tokens.input, 7);
});
