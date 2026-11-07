// Dashboards page (#/dashboards): built-in dashboards (Usage overview) and your own dashboard
// links, kept by the server in ~/.cli-companion/dashboards.json.
//   #/dashboards              the list, with an Add form
//   #/dashboards/usage        Usage overview (from /api/usage)
//   #/dashboards/old          Old sessions: not used for a while (from /api/old-sessions), read-only
//   #/dashboards/view/<id>    a custom dashboard shown inside the companion
// menu.js calls dashboardsPage.show(rest) on every route change (rest = null: page hidden).
(function () {
  const root = document.getElementById("page-dashboards");
  const esc = window.escapeHtml;
  const state = { list: null, usageDays: 30, usage: null, view: null, oldDays: 30, oldSort: "oldest", old: null };

  const BUILT_IN = [
    {
      id: "usage",
      name: "Usage overview",
      description: "Sessions started per day in each CLI, active days, and your busiest workspaces.",
      href: "#/dashboards/usage",
    },
    {
      id: "old",
      name: "Old sessions",
      description: "Sessions you haven't used for a while, oldest or largest first: what to clean up.",
      href: "#/dashboards/old",
    },
  ];

  /* ── old sessions (cleanup list) ──────────────────────── */

  async function loadOld() {
    try {
      const res = await fetch(`/api/old-sessions?days=${state.oldDays}`, { cache: "no-store" });
      state.old = res.ok ? await res.json() : null;
    } catch {
      state.old = null;
    }
  }

  function renderOld() {
    root.className = "page";
    const o = state.old;
    const seg = (name, value, label, current) =>
      `<button class="seg${value === current ? " on" : ""}" type="button" data-${name}="${value}" aria-pressed="${value === current}">${label}</button>`;
    const list = [...(o?.sessions ?? [])];
    if (state.oldSort === "largest") list.sort((a, b) => b.size - a.size);
    else if (state.oldSort === "tokens") list.sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1));
    const byCli = {};
    for (const s of list) {
      byCli[s.source] ??= { n: 0, size: 0 };
      byCli[s.source].n += 1;
      byCli[s.source].size += s.size;
    }
    const base = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
    const day = (ms) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    const rows = list
      .map(
        (s, i) => `<div class="old-row">
          <i class="sw ${esc(s.source)}" aria-hidden="true"></i>
          <div class="old-main">
            <button class="old-name" type="button" data-open="${esc(s.id)}" title="Open this session">${esc(s.name || "(untitled)")}</button>
            <span class="old-sub">${esc(cliSources.get(s.source).label)} · <span title="${esc(s.cwd)}">${esc(base(s.cwd) || s.cwd)}</span> · last used ${esc(day(s.lastActivity))} (${esc(fmtAgo(s.lastActivity))})</span>
          </div>
          <span class="old-num">${fmtBytes(s.size)}${s.tokens ? ` · ${fmtCount(s.tokens)} tokens` : ""}</span>
          <button class="btn small" type="button" data-copy-path="${i}" title="${esc(s.file)}">Copy path</button>
        </div>`,
      )
      .join("");
    const body = !o
      ? `<p class="page-lead">Couldn't load the list. Is the companion server running?</p>`
      : `<div class="tiles">
          <div class="tile"><span class="tile-label">Old sessions</span><span class="tile-value">${fmtInt(list.length)}</span>
            <span class="tile-delta">${Object.entries(byCli).map(([id, v]) => `${v.n} ${esc(cliSources.get(id).label)}`).join(" · ") || "none"}</span></div>
          <div class="tile"><span class="tile-label">Space they use</span><span class="tile-value">${fmtBytes(o.totalSize)}</span>
            <span class="tile-delta">${Object.entries(byCli).map(([id, v]) => `${fmtBytes(v.size)} ${esc(cliSources.get(id).label)}`).join(" · ")}</span></div>
        </div>
        <div class="old-tools"><span class="old-sort-label">Sort</span>
          <div class="segs" role="group" aria-label="Sort">${seg("sort", "oldest", "Oldest first", state.oldSort)}${seg("sort", "largest", "Largest first", state.oldSort)}${seg("sort", "tokens", "Most tokens", state.oldSort)}</div>
        </div>
        ${list.length ? `<div class="old-list">${rows}</div>` : `<p class="page-lead">No sessions that old.</p>`}
        <p class="dash-file">Claude Code deletes its own transcripts after the number of days in its <code>cleanupPeriodDays</code>
          setting (30 unless you changed it), so old Claude Code sessions may disappear on their own. Token counts show once
          Usage overview has read the session files.</p>`;
    root.innerHTML = `<div class="page-inner wide">
      <p class="crumb"><a href="#/dashboards">← Dashboards</a></p>
      <div class="usage-head">
        <h1>Old sessions</h1>
        <div class="segs" role="group" aria-label="Not used for">${[14, 30, 60, 90].map((d) => seg("days", d, `${d}+ days`, state.oldDays)).join("")}</div>
      </div>
      <p class="page-lead">Sessions not used for ${state.oldDays} days or more, and not running. Nothing here is moved or
        deleted: use the list to decide what to clean up. Open one to read it, or copy its file path.</p>
      ${body}
    </div>`;
    for (const b of root.querySelectorAll("[data-days]")) {
      b.addEventListener("click", async () => {
        state.oldDays = Number(b.dataset.days);
        await loadOld();
        renderOld();
      });
    }
    for (const b of root.querySelectorAll("[data-sort]")) {
      b.addEventListener("click", () => {
        state.oldSort = b.dataset.sort;
        renderOld();
      });
    }
    for (const b of root.querySelectorAll("[data-open]")) b.addEventListener("click", () => window.openSession?.(b.dataset.open));
    for (const b of root.querySelectorAll("[data-copy-path]")) {
      b.addEventListener("click", async () => {
        const s = list[Number(b.dataset.copyPath)];
        try {
          await navigator.clipboard.writeText(s.file);
          b.textContent = "Copied ✓";
        } catch {
          b.textContent = "Copy failed";
        }
        setTimeout(() => (b.textContent = "Copy path"), 1500);
      });
    }
  }



  /* ── list ─────────────────────────────────────────────── */

  async function loadList() {
    try {
      const res = await fetch("/api/dashboards", { cache: "no-store" });
      state.list = res.ok ? await res.json() : { dashboards: [], file: "" };
    } catch {
      state.list = { dashboards: [], file: "", error: true };
    }
  }

  function statusDot(online) {
    if (online === true) return `<span class="dash-status on" title="Responding">Online</span>`;
    if (online === false) return `<span class="dash-status off" title="Not responding">Offline</span>`;
    return "";
  }

  function renderList() {
    const custom = state.list?.dashboards ?? [];
    root.className = "page";
    root.innerHTML = `<div class="page-inner wide">
      <h1>Dashboards</h1>
      <p class="page-lead">Built-in views of your sessions, and links to your own dashboards.</p>

      <h2>Built in</h2>
      <div class="dash-grid">${BUILT_IN.map(
        (d) => `<a class="dash-card" href="${d.href}">
          <span class="dash-name">${esc(d.name)}</span>
          <span class="dash-desc">${esc(d.description)}</span>
        </a>`,
      ).join("")}</div>

      <h2>Custom</h2>
      <div class="dash-grid">${
        state.list === null
          ? `<p class="page-lead">Loading…</p>`
          : custom.length
            ? custom
                .map(
                  (d) => `<div class="dash-card custom">
          <span class="dash-head"><span class="dash-name">${esc(d.name)}</span>${statusDot(d.online)}</span>
          <span class="dash-url">${esc(d.url)}</span>
          ${d.description ? `<span class="dash-desc">${esc(d.description)}</span>` : ""}
          <span class="dash-actions">
            <a class="btn primary small" href="#/dashboards/view/${encodeURIComponent(d.id)}">Open</a>
            <a class="btn small" href="${esc(d.url)}" target="_blank" rel="noopener">New tab</a>
            <button class="mini" type="button" data-remove="${esc(d.id)}" data-name="${esc(d.name)}">Remove</button>
          </span>
        </div>`,
                )
                .join("")
            : `<p class="page-lead">None yet. Add one below: any page with an address, such as a local server's dashboard.</p>`
      }</div>

      <form class="dash-add" id="dash-add" autocomplete="off">
        <h3>Add a dashboard</h3>
        <label>Name <input name="name" required maxlength="80" placeholder="GPU and Ollama"></label>
        <label>Address <input name="url" required placeholder="http://127.0.0.1:30142"></label>
        <label class="full">Description <input name="description" maxlength="300" placeholder="Optional"></label>
        <div class="dash-add-foot">
          <span class="dash-msg" id="dash-msg" role="status"></span>
          <button class="btn primary" type="submit">Add</button>
        </div>
      </form>
      ${state.list?.file ? `<p class="dash-file">Saved in <code>${esc(state.list.file)}</code>; you can also edit that file by hand.</p>` : ""}
    </div>`;

    root.querySelector("#dash-add").addEventListener("submit", onAdd);
    for (const button of root.querySelectorAll("[data-remove]")) {
      button.addEventListener("click", () => onRemove(button));
    }
  }

  async function onAdd(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const msg = root.querySelector("#dash-msg");
    const body = Object.fromEntries(new FormData(form));
    msg.textContent = "Adding…";
    msg.dataset.kind = "";
    try {
      const res = await fetch("/api/dashboards", {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-companion-page": "1" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      await loadList();
      renderList();
      const done = root.querySelector("#dash-msg");
      done.textContent = `Added ${out.name}.`;
      done.dataset.kind = "ok";
    } catch (error) {
      msg.textContent = error.message;
      msg.dataset.kind = "error";
    }
  }

  async function onRemove(button) {
    // Two-step: the first click asks, the second removes (no browser dialogs).
    if (button.dataset.armed !== "1") {
      button.dataset.armed = "1";
      button.textContent = "Remove?";
      button.classList.add("danger");
      setTimeout(() => {
        if (!button.isConnected) return;
        button.dataset.armed = "";
        button.textContent = "Remove";
        button.classList.remove("danger");
      }, 3000);
      return;
    }
    await fetch(`/api/dashboards?id=${encodeURIComponent(button.dataset.remove)}`, {
      method: "DELETE",
      headers: { "x-pi-companion-page": "1" },
    }).catch(() => undefined);
    await loadList();
    renderList();
  }

  /* ── custom dashboard inside the companion ────────────── */

  function renderView(id) {
    const d = (state.list?.dashboards ?? []).find((x) => x.id === id);
    root.className = "page page-frame";
    if (!d) {
      root.innerHTML = `<div class="page-inner"><h1>Dashboard not found</h1>
        <p class="page-lead"><a href="#/dashboards">Back to Dashboards</a></p></div>`;
      return;
    }
    if (state.view === d.id && root.querySelector("iframe")) return; // keep it loaded
    state.view = d.id;
    root.innerHTML = `<div class="frame-bar">
        <a class="frame-back" href="#/dashboards">← Dashboards</a>
        <span class="frame-name">${esc(d.name)}</span>
        <span class="frame-url">${esc(d.url)}</span>
        ${statusDot(d.online)}
        <a class="btn small" href="${esc(d.url)}" target="_blank" rel="noopener">Open in new tab</a>
      </div>
      <iframe class="dash-frame" src="${esc(d.url)}" title="${esc(d.name)}"></iframe>
      <p class="frame-hint">Blank? Some pages refuse to be shown inside another page. Use <b>Open in new tab</b>.</p>`;
  }

  /* ── usage overview ───────────────────────────────────── */

  async function loadUsage() {
    const tz = -new Date().getTimezoneOffset();
    try {
      const res = await fetch(`/api/usage?days=${state.usageDays}&tz=${tz}`, { cache: "no-store" });
      state.usage = res.ok ? await res.json() : null;
    } catch {
      state.usage = null;
    }
  }

  const fmtInt = (n) => Number(n ?? 0).toLocaleString();
  const fmtBytes = (n) =>
    n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.round(n / 1e3)} KB`;

  function fmtDay(iso, long = false) {
    const d = new Date(`${iso}T12:00:00`);
    return d.toLocaleDateString([], long ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" });
  }

  function fmtAgo(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function delta(now, before) {
    if (!before) return "";
    const pct = Math.round(((now - before) / before) * 100);
    if (pct === 0) return `<span class="tile-delta">same as the ${state.usageDays} days before</span>`;
    return `<span class="tile-delta">${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs the ${state.usageDays} days before</span>`;
  }

  /** The CLIs to chart: those with any sessions on disk (Pi at least), in the server's order. */
  function seriesOf(u) {
    const ids = (u.sources ?? ["pi", "claude"]).filter((id) => (u.totals[id] ?? 0) > 0);
    return (ids.length ? ids : ["pi"]).map((id) => ({ id, label: cliSources.get(id).label, tag: cliSources.get(id).tag || cliSources.get(id).label }));
  }
  const total = (row, series) => series.reduce((sum, s) => sum + (row[s.id] ?? 0), 0);
  const legend = (series) =>
    `<div class="legend">${series.map((s) => `<span class="key"><i class="sw ${esc(s.id)}"></i>${esc(s.label)}</span>`).join("")}</div>`;

  function renderUsage() {
    root.className = "page";
    const u = state.usage;
    const series = u ? seriesOf(u) : [];
    const ranges = [7, 30, 90]
      .map((d) => `<button class="seg${d === state.usageDays ? " on" : ""}" type="button" data-days="${d}" aria-pressed="${d === state.usageDays}">${d} days</button>`)
      .join("");
    root.innerHTML = `<div class="page-inner wide">
      <p class="crumb"><a href="#/dashboards">← Dashboards</a></p>
      <div class="usage-head">
        <h1>Usage overview</h1>
        <div class="segs" role="group" aria-label="Time range">${ranges}</div>
      </div>
      ${
        !u
          ? `<p class="page-lead">Couldn't load usage. Is the companion server running?</p>`
          : `<div class="tiles">
        <div class="tile"><span class="tile-label">Sessions started</span><span class="tile-value">${fmtInt(u.started)}</span>${delta(u.started, u.startedPrevious)}</div>
        <div class="tile"><span class="tile-label">Active days</span><span class="tile-value">${u.activeDays} <small>of ${u.days}</small></span></div>
        <div class="tile"><span class="tile-label">Workspaces used</span><span class="tile-value">${fmtInt(u.workspacesUsed)}</span></div>
        <div class="tile"><span class="tile-label">All sessions on disk</span><span class="tile-value">${fmtInt(u.totals.sessions)}</span>
          <span class="tile-delta">${series.map((x) => `${fmtInt(u.totals[x.id])} ${esc(x.label)}`).join(" · ")} · ${fmtBytes(u.totals.bytes)}</span></div>
      </div>

      <section class="chart-card">
        <div class="chart-head">
          <h2>Sessions started per day</h2>
          ${legend(series)}
        </div>
        <div class="chart" id="usage-chart"></div>
        <details class="chart-table"><summary>Show as a table</summary>
          <table><thead><tr><th>Day</th>${series.map((x) => `<th>${esc(x.label)}</th>`).join("")}<th>Total</th></tr></thead><tbody>
          ${[...u.daily].reverse().map((d) => `<tr><td>${esc(fmtDay(d.date, true))}</td>${series.map((x) => `<td>${d[x.id] ?? 0}</td>`).join("")}<td>${total(d, series)}</td></tr>`).join("")}
          </tbody></table>
        </details>
      </section>

      ${tokensSection(u)}

      <section class="chart-card">
        <div class="chart-head">
          <h2>Busiest workspaces${u.workspacesUsed > u.workspaces.length ? ` <span class="h2-note">top ${u.workspaces.length} of ${u.workspacesUsed}</span>` : ""}</h2>
          ${legend(series)}
        </div>
        ${workspaceRows(u, series)}
      </section>
      <p class="dash-file">Counted from the session files on disk: a session counts on the day it started; a workspace counts every session started or active in the range.</p>`
      }
    </div>`;
    for (const b of root.querySelectorAll("[data-days]")) {
      b.addEventListener("click", async () => {
        state.usageDays = Number(b.dataset.days);
        await loadUsage();
        renderUsage();
      });
    }
    for (const b of root.querySelectorAll("[data-open-session]")) {
      b.addEventListener("click", () => window.openSession?.(b.dataset.openSession));
    }
    drawCharts();
    // The first time, the server is still reading session files: ask again shortly.
    clearTimeout(state.rescan);
    if (u?.tokens?.scanning) {
      state.rescan = setTimeout(async () => {
        if (root.hidden || !root.querySelector("#usage-chart")) return;
        await loadUsage();
        renderUsage();
      }, 2000);
    }
  }

  function drawCharts() {
    const u = state.usage;
    if (!u) return;
    drawDaily(u.daily, seriesOf(u));
    if (u.tokens) drawDaily(u.tokens.daily, tokenSeries(u.tokens), { boxId: "tokens-chart", fmt: fmtCount, what: "Tokens per day" });
  }

  /* ── tokens (from /api/usage → tokens) ── */

  function fmtCount(n) {
    for (const [size, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "k"]]) {
      if (n >= size) return `${(n / size).toFixed(n >= size * 100 ? 0 : 1).replace(/\.0$/, "")}${unit}`;
    }
    return String(Math.round(n));
  }
  const fmtUsd = (n) => (n >= 100 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`);
  const tokenSum = (b) => b.input + b.output + b.cacheRead + b.cacheWrite;

  function tokenSeries(t) {
    const ids = t.sources.filter((id) => tokenSum(t.bySource[id]) > 0);
    return ids.map((id) => ({ id, label: cliSources.get(id).label, tag: cliSources.get(id).tag || cliSources.get(id).label }));
  }

  function tokensSection(u) {
    const t = u.tokens;
    if (!t) return "";
    const series = tokenSeries(t);
    const all = Object.values(t.bySource).reduce(
      (a, b) => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, turns: a.turns + b.turns }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 },
    );
    const costs = series.filter((x) => t.bySource[x.id].costUsd > 0);
    const scanning = t.scanning
      ? `<p class="scan-note" role="status">Reading session files for token counts… ${t.scanning.done} of ${t.scanning.total}. The first time takes a few seconds; after that only new lines are read.</p>`
      : "";
    const costTile = costs.length
      ? `<div class="tile"><span class="tile-label">Estimated cost</span><span class="tile-value">${fmtUsd(costs.reduce((s, x) => s + t.bySource[x.id].costUsd, 0))}</span>
          <span class="tile-delta">${costs.map((x) => `${fmtUsd(t.bySource[x.id].costUsd)} ${esc(x.label)}`).join(" · ")}</span></div>`
      : "";
    const top = t.topSessions.length
      ? `<div class="top-sessions">${t.topSessions
          .map(
            (s) => `<button class="top-row" type="button" data-open-session="${esc(s.id)}" title="${esc(s.cwd ?? "")}">
            <i class="sw ${esc(s.source)}" aria-hidden="true"></i>
            <span class="top-name">${esc(s.name || "(untitled)")}</span>
            <span class="top-sub">${esc(cliSources.get(s.source).label)}${s.model ? ` · ${esc(s.model)}` : ""}</span>
            <span class="top-num">${fmtCount(s.tokens)}${s.costUsd ? ` · ${fmtUsd(s.costUsd)}` : ""}</span>
          </button>`,
          )
          .join("")}</div>`
      : `<p class="page-lead">No token use recorded in this range.</p>`;
    return `${scanning}
      <div class="tiles">
        <div class="tile"><span class="tile-label">Tokens</span><span class="tile-value">${fmtCount(tokenSum(all))}</span>
          <span class="tile-delta">${fmtInt(all.turns)} model calls</span></div>
        <div class="tile"><span class="tile-label">Read from cache</span><span class="tile-value">${tokenSum(all) ? Math.round((all.cacheRead / tokenSum(all)) * 100) : 0}%</span>
          <span class="tile-delta">${fmtCount(all.cacheRead)} of the tokens</span></div>
        <div class="tile"><span class="tile-label">Output tokens</span><span class="tile-value">${fmtCount(all.output)}</span>
          <span class="tile-delta">${fmtCount(all.input)} new input</span></div>
        ${costTile}
      </div>
      <section class="chart-card">
        <div class="chart-head"><h2>Tokens per day</h2>${legend(series)}</div>
        <div class="chart" id="tokens-chart"></div>
        <details class="chart-table"><summary>Show as a table</summary>
          <table><thead><tr><th>Day</th>${series.map((x) => `<th>${esc(x.label)}</th>`).join("")}<th>Total</th></tr></thead><tbody>
          ${[...t.daily].reverse().map((d) => `<tr><td>${esc(fmtDay(d.date, true))}</td>${series.map((x) => `<td>${fmtInt(d[x.id] ?? 0)}</td>`).join("")}<td>${fmtInt(total(d, series))}</td></tr>`).join("")}
          </tbody></table>
        </details>
      </section>
      <section class="chart-card">
        <div class="chart-head"><h2>Most tokens <span class="h2-note">sessions in this range</span></h2></div>
        ${top}
      </section>
      <p class="dash-file">Tokens are counted from each CLI's session files (input, cache and output, in the hour the model call was made).
        Cost: Pi's comes from the provider's prices as Pi recorded them; Claude Code's is its own estimate at API prices,
        saved now and then (a Pro or Max plan isn't billed it). Codex records no cost; its plan limits show in the session header.</p>`;
  }

  function workspaceRows(u, series) {
    if (!u.workspaces.length) return `<p class="page-lead">No sessions in this range.</p>`;
    const max = Math.max(...u.workspaces.map((w) => total(w, series)), 1);
    return `<div class="ws-rows">${u.workspaces
      .map((w) => {
        const sum = total(w, series);
        const pct = (n) => `${((n / max) * 100).toFixed(2)}%`;
        return `<div class="ws-row" title="${esc(w.cwd)}">
          <span class="ws-row-name">${esc(w.name)}</span>
          <span class="ws-bar" aria-hidden="true">
            ${series.map((x) => (w[x.id] ? `<i class="seg-${esc(x.id)}" style="width:${pct(w[x.id])}"></i>` : "")).join("")}
          </span>
          <span class="ws-row-num">${sum}</span>
          <span class="ws-row-sub">${series.map((x) => `${w[x.id] ?? 0} ${esc(x.tag)}`).join(" · ")} · ${esc(fmtAgo(w.lastActivity))}</span>
        </div>`;
      })
      .join("")}</div>`;
  }

  /** A round axis step giving at most about 5 grid lines: 1, 2, 5, 10, 20, 50, … */
  function niceStep(max) {
    const rough = max / 5;
    const pow = 10 ** Math.floor(Math.log10(Math.max(rough, 1)));
    return [1, 2, 5, 10].map((m) => m * pow).find((st) => st >= rough) ?? 10 * pow;
  }

  /** Stacked columns (one segment per CLI, in series order from the baseline), with a hover tooltip. */
  function drawDaily(daily, series, { boxId = "usage-chart", fmt = String, what = "Sessions started per day" } = {}) {
    const box = root.querySelector(`#${boxId}`);
    if (!box) return;
    const W = Math.max(320, box.clientWidth);
    const H = 220;
    const pad = { l: 34, r: 8, t: 10, b: 26 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const maxTotal = Math.max(...daily.map((d) => total(d, series)), 1);
    const step = niceStep(maxTotal);
    const top = Math.ceil(maxTotal / step) * step;
    const y = (v) => pad.t + ih - (v / top) * ih;
    const band = iw / daily.length;
    const barW = Math.max(2, Math.min(24, band * 0.62));
    const GAP = 2;
    const R = Math.min(4, barW / 2);

    let grid = "";
    for (let v = 0; v <= top; v += step) {
      grid += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`;
      grid += `<text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`;
    }
    const labelEvery = Math.ceil(daily.length / Math.max(2, Math.floor(iw / 64)));
    let xLabels = "";
    daily.forEach((d, i) => {
      const last = i === daily.length - 1;
      if ((daily.length - 1 - i) % labelEvery === 0 || (last && labelEvery === 1)) {
        xLabels += `<text class="axis" x="${pad.l + band * i + band / 2}" y="${H - 8}" text-anchor="middle">${esc(fmtDay(d.date))}</text>`;
      }
    });

    // Top segment gets the 4px rounded end; the baseline stays square.
    const topRounded = (x, yTop, w, h) =>
      h <= 0
        ? ""
        : `M${x},${yTop + h} V${yTop + Math.min(R, h)} Q${x},${yTop} ${x + Math.min(R, h)},${yTop} H${x + w - Math.min(R, h)} Q${x + w},${yTop} ${x + w},${yTop + Math.min(R, h)} V${yTop + h} Z`;
    const square = (x, yTop, w, h) => (h <= 0 ? "" : `M${x},${yTop} H${x + w} V${yTop + h} H${x} Z`);

    let bars = "";
    daily.forEach((d, i) => {
      const x0 = pad.l + band * i + (band - barW) / 2;
      // Segments stack up from the baseline with a 2px gap; only the top one gets the rounded end.
      const present = series.filter((x) => d[x.id]);
      let yBase = pad.t + ih;
      present.forEach((x, k) => {
        const h = (d[x.id] / top) * ih;
        const yTop = yBase - h;
        const shape = k === present.length - 1 ? topRounded : square;
        bars += `<path class="m-${esc(x.id)}" d="${shape(x0, yTop, barW, h)}"/>`;
        yBase = yTop - GAP;
      });
      bars += `<rect class="hit" data-i="${i}" x="${pad.l + band * i}" y="${pad.t}" width="${band}" height="${ih}"/>`;
    });

    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
        aria-label="${esc(what)}, ${esc(series.map((x) => x.label).join(", "))}, stacked">${grid}${bars}${xLabels}</svg>
      <div class="tip" hidden></div>`;
    const tip = box.querySelector(".tip");
    const svg = box.querySelector("svg");
    svg.addEventListener("mousemove", (event) => {
      const hit = event.target.closest?.(".hit");
      if (!hit) return void (tip.hidden = true);
      const d = daily[Number(hit.dataset.i)];
      for (const h of svg.querySelectorAll(".hit.on")) h.classList.remove("on");
      hit.classList.add("on");
      tip.innerHTML = `<b>${esc(fmtDay(d.date, true))}</b>
        ${series.map((x) => `<span><i class="sw ${esc(x.id)}"></i>${esc(x.label)} <b>${esc(fmt(d[x.id] ?? 0))}</b></span>`).join("")}
        <span class="muted">Total ${esc(fmt(total(d, series)))}</span>`;
      tip.hidden = false;
      const rect = box.getBoundingClientRect();
      const left = Math.min(event.clientX - rect.left + 12, rect.width - tip.offsetWidth - 4);
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, event.clientY - rect.top - tip.offsetHeight - 10)}px`;
    });
    svg.addEventListener("mouseleave", () => {
      tip.hidden = true;
      for (const h of svg.querySelectorAll(".hit.on")) h.classList.remove("on");
    });
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!root.hidden && state.usage && root.querySelector("#usage-chart")) drawCharts();
    }, 120);
  });

  /* ── routing ──────────────────────────────────────────── */

  window.dashboardsPage = {
    async show(rest) {
      if (rest === null) return;
      const [sub, id] = rest;
      if (sub === "old") {
        state.view = null;
        if (!state.old) {
          root.className = "page";
          root.innerHTML = `<div class="page-inner"><p class="page-lead">Loading…</p></div>`;
        }
        await loadOld();
        renderOld();
      } else if (sub === "usage") {
        state.view = null;
        if (!state.usage) {
          root.className = "page";
          root.innerHTML = `<div class="page-inner"><p class="page-lead">Loading…</p></div>`;
        }
        await loadUsage();
        renderUsage();
      } else if (sub === "view" && id) {
        if (!state.list) await loadList();
        renderView(decodeURIComponent(id));
      } else {
        state.view = null;
        if (state.list === null) renderList();
        await loadList();
        renderList();
      }
    },
  };
})();
