// Dashboards page (#/dashboards): built-in dashboards (Usage overview) and your own dashboard
// links, kept by the server in ~/.cli-companion/dashboards.json.
//   #/dashboards              the list, with an Add form
//   #/dashboards/usage        Usage overview (from /api/usage)
//   #/dashboards/view/<id>    a custom dashboard shown inside the companion
// menu.js calls dashboardsPage.show(rest) on every route change (rest = null: page hidden).
(function () {
  const root = document.getElementById("page-dashboards");
  const esc = window.escapeHtml;
  const state = { list: null, usageDays: 30, usage: null, view: null };

  const BUILT_IN = [
    {
      id: "usage",
      name: "Usage overview",
      description: "Sessions started per day in Pi and Claude Code, active days, and your busiest workspaces.",
      href: "#/dashboards/usage",
    },
  ];

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

  function renderUsage() {
    root.className = "page";
    const u = state.usage;
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
          <span class="tile-delta">${fmtInt(u.totals.pi)} Pi · ${fmtInt(u.totals.claude)} Claude Code · ${fmtBytes(u.totals.bytes)}</span></div>
      </div>

      <section class="chart-card">
        <div class="chart-head">
          <h2>Sessions started per day</h2>
          <div class="legend"><span class="key"><i class="sw pi"></i>Pi</span><span class="key"><i class="sw claude"></i>Claude Code</span></div>
        </div>
        <div class="chart" id="usage-chart"></div>
        <details class="chart-table"><summary>Show as a table</summary>
          <table><thead><tr><th>Day</th><th>Pi</th><th>Claude Code</th><th>Total</th></tr></thead><tbody>
          ${[...u.daily].reverse().map((d) => `<tr><td>${esc(fmtDay(d.date, true))}</td><td>${d.pi}</td><td>${d.claude}</td><td>${d.pi + d.claude}</td></tr>`).join("")}
          </tbody></table>
        </details>
      </section>

      <section class="chart-card">
        <div class="chart-head">
          <h2>Busiest workspaces${u.workspacesUsed > u.workspaces.length ? ` <span class="h2-note">top ${u.workspaces.length} of ${u.workspacesUsed}</span>` : ""}</h2>
          <div class="legend"><span class="key"><i class="sw pi"></i>Pi</span><span class="key"><i class="sw claude"></i>Claude Code</span></div>
        </div>
        ${workspaceRows(u)}
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
    if (u) drawDaily(u.daily);
  }

  function workspaceRows(u) {
    if (!u.workspaces.length) return `<p class="page-lead">No sessions in this range.</p>`;
    const max = Math.max(...u.workspaces.map((w) => w.pi + w.claude), 1);
    return `<div class="ws-rows">${u.workspaces
      .map((w) => {
        const total = w.pi + w.claude;
        const pct = (n) => `${((n / max) * 100).toFixed(2)}%`;
        return `<div class="ws-row" title="${esc(w.cwd)}">
          <span class="ws-row-name">${esc(w.name)}</span>
          <span class="ws-bar" aria-hidden="true">
            ${w.pi ? `<i class="seg-pi" style="width:${pct(w.pi)}"></i>` : ""}${w.claude ? `<i class="seg-claude" style="width:${pct(w.claude)}"></i>` : ""}
          </span>
          <span class="ws-row-num">${total}</span>
          <span class="ws-row-sub">${w.pi} Pi · ${w.claude} CC · ${esc(fmtAgo(w.lastActivity))}</span>
        </div>`;
      })
      .join("")}</div>`;
  }

  /** Stacked columns (Pi below, Claude Code above), one per day, with a hover tooltip. */
  function drawDaily(daily) {
    const box = root.querySelector("#usage-chart");
    if (!box) return;
    const W = Math.max(320, box.clientWidth);
    const H = 220;
    const pad = { l: 34, r: 8, t: 10, b: 26 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const maxTotal = Math.max(...daily.map((d) => d.pi + d.claude), 1);
    const step = maxTotal <= 4 ? 1 : maxTotal <= 10 ? 2 : maxTotal <= 25 ? 5 : maxTotal <= 50 ? 10 : 25;
    const top = Math.ceil(maxTotal / step) * step;
    const y = (v) => pad.t + ih - (v / top) * ih;
    const band = iw / daily.length;
    const barW = Math.max(2, Math.min(24, band * 0.62));
    const GAP = 2;
    const R = Math.min(4, barW / 2);

    let grid = "";
    for (let v = 0; v <= top; v += step) {
      grid += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`;
      grid += `<text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
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
      const x = pad.l + band * i + (band - barW) / 2;
      const hPi = (d.pi / top) * ih;
      const hCl = (d.claude / top) * ih;
      const base = pad.t + ih;
      if (d.pi) bars += `<path class="m-pi" d="${(d.claude ? square : topRounded)(x, base - hPi, barW, hPi)}"/>`;
      if (d.claude) {
        const yTop = base - hPi - (d.pi ? GAP : 0) - hCl;
        bars += `<path class="m-claude" d="${topRounded(x, yTop, barW, hCl)}"/>`;
      }
      bars += `<rect class="hit" data-i="${i}" x="${pad.l + band * i}" y="${pad.t}" width="${band}" height="${ih}"/>`;
    });

    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
        aria-label="Sessions started per day, Pi and Claude Code, stacked">${grid}${bars}${xLabels}</svg>
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
        <span><i class="sw pi"></i>Pi <b>${d.pi}</b></span>
        <span><i class="sw claude"></i>Claude Code <b>${d.claude}</b></span>
        <span class="muted">Total ${d.pi + d.claude}</span>`;
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
      if (!root.hidden && state.usage && root.querySelector("#usage-chart")) drawDaily(state.usage.daily);
    }, 120);
  });

  /* ── routing ──────────────────────────────────────────── */

  window.dashboardsPage = {
    async show(rest) {
      if (rest === null) return;
      const [sub, id] = rest;
      if (sub === "usage") {
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
