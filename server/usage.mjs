// Usage overview for the Dashboards page, computed from the session index (no session file is
// read again): sessions started per day by CLI, active days, and the busiest workspaces.
// Days are the viewer's local days: the page sends its UTC offset.

const DAY_MS = 86_400_000;

function startedAt(meta) {
  const created = Date.parse(meta.created ?? "");
  return Number.isFinite(created) ? created : meta.mtimeMs;
}

/** "YYYY-MM-DD" of a timestamp in a zone `offsetMin` minutes ahead of UTC. */
export function localDay(ms, offsetMin) {
  return new Date(ms + offsetMin * 60_000).toISOString().slice(0, 10);
}

function basename(path) {
  const parts = String(path ?? "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? String(path ?? "");
}

/**
 * @param metas session index rows ({ source, cwd, created, mtimeMs, size })
 * @param opts { now, days, offsetMin }
 */
export function usageSummary(metas, { now = Date.now(), days = 30, offsetMin = 0 } = {}) {
  const today = localDay(now, offsetMin);
  const firstDay = localDay(now - (days - 1) * DAY_MS, offsetMin);
  const prevFirstDay = localDay(now - (2 * days - 1) * DAY_MS, offsetMin);

  const perDay = new Map();
  for (let i = days - 1; i >= 0; i--) perDay.set(localDay(now - i * DAY_MS, offsetMin), { pi: 0, claude: 0 });

  const workspaces = new Map();
  let inRange = 0;
  let previous = 0;
  const totals = { sessions: 0, pi: 0, claude: 0, bytes: 0 };
  const allWorkspaces = new Set();

  for (const meta of metas) {
    const source = meta.source === "claude" ? "claude" : "pi";
    totals.sessions += 1;
    totals[source] += 1;
    totals.bytes += meta.size ?? 0;
    const key = String(meta.cwd ?? "").replace(/[\\/]+$/, "").toLowerCase();
    allWorkspaces.add(key);

    const day = localDay(startedAt(meta), offsetMin);
    if (day >= prevFirstDay && day < firstDay) previous += 1;
    // A session counts for the period it started in, or that it was last active in.
    const lastDay = localDay(meta.mtimeMs ?? startedAt(meta), offsetMin);
    const touched = (day >= firstDay && day <= today) || (lastDay >= firstDay && lastDay <= today);
    if (perDay.has(day)) perDay.get(day)[source] += 1;
    if (day >= firstDay && day <= today) inRange += 1;
    if (!touched) continue;

    let ws = workspaces.get(key);
    if (!ws) {
      ws = { name: basename(meta.cwd) || "(unknown)", cwd: meta.cwd ?? "", pi: 0, claude: 0, lastActivity: 0, bytes: 0 };
      workspaces.set(key, ws);
    }
    ws[source] += 1;
    ws.lastActivity = Math.max(ws.lastActivity, meta.mtimeMs ?? 0);
    ws.bytes += meta.size ?? 0;
  }

  const daily = [...perDay].map(([date, c]) => ({ date, pi: c.pi, claude: c.claude }));
  return {
    days,
    firstDay,
    today,
    started: inRange,
    startedPrevious: previous,
    activeDays: daily.filter((d) => d.pi + d.claude > 0).length,
    daily,
    workspacesUsed: workspaces.size,
    workspaces: [...workspaces.values()]
      .sort((a, b) => b.pi + b.claude - (a.pi + a.claude) || b.lastActivity - a.lastActivity)
      .slice(0, 12),
    totals: { ...totals, workspaces: allWorkspaces.size },
  };
}
