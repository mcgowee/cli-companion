// CLI Companion page: live sessions from /events, history from /api/history.
(function () {
  const $ = (id) => document.getElementById(id);
  const md = window.renderMarkdown;
  const esc = window.escapeHtml;

  const state = {
    sessions: new Map(),
    selectedId: null,
    pinnedByUser: false,
    history: null,
    historyVersionLoaded: -1,
    historyLoading: false,
    stickToBottom: true,
    workspaces: [],
    /** workspace id -> true (open) / false (closed), set by the user; remembered per browser. */
    wsOpen: loadPref("pi-companion.wsOpen", {}),
    showAll: new Set(),
    filter: "",
  };

  function loadPref(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function savePref(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage can be unavailable; the sidebar still works.
    }
  }

  const transcriptEl = $("transcript");
  const liveEl = $("live");
  const mainEl = document.querySelector(".main");

  /* ── helpers ─────────────────────────────────────────── */

  function basename(path) {
    if (!path) return "";
    const parts = String(path).split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
  }

  function fmtTokens(n) {
    if (typeof n !== "number") return "?";
    return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
  }

  function fmtDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function fmtTime(ts) {
    const d = typeof ts === "number" ? new Date(ts) : new Date(ts ?? Date.now());
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function reasonText(reason) {
    return (
      { manual: "/compact", threshold: "context near its limit", overflow: "context overflowed" }[reason] ??
      reason ??
      ""
    );
  }

  function statusLabel(session) {
    if (session.status === "compacting") return "Compacting";
    if (session.status === "running") return "Running";
    if (session.status === "ended") return "Ended";
    return "Idle";
  }

  function atBottom() {
    return mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight < 80;
  }

  function scrollToBottom() {
    mainEl.scrollTop = mainEl.scrollHeight;
  }

  mainEl.addEventListener("scroll", () => {
    state.stickToBottom = atBottom();
    $("jump").hidden = state.stickToBottom;
  });
  $("jump").addEventListener("click", () => {
    state.stickToBottom = true;
    scrollToBottom();
    $("jump").hidden = true;
  });

  /* ── sidebar ─────────────────────────────────────────── */

  function sortedSessions() {
    return [...state.sessions.values()].sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
  }

  const SESSIONS_SHOWN = 6;

  function fmtAgo(ms) {
    if (!ms) return "";
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
    return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function rowTitle(row) {
    return row.name || row.preview || "Untitled session";
  }

  /** The sidebar row for a session, with live status from /events when it is running. */
  function rowFor(id) {
    for (const ws of state.workspaces) {
      const row = ws.sessions.find((s) => s.id === id);
      if (row) return { ws, row };
    }
    return undefined;
  }

  /** Live sessions the tree has not picked up yet (no file on disk at the last scan). */
  function treeWithLive() {
    const known = new Set(state.workspaces.flatMap((ws) => ws.sessions.map((s) => s.id)));
    const groups = state.workspaces.map((ws) => ({ ...ws, sessions: [...ws.sessions] }));
    for (const live of state.sessions.values()) {
      if (known.has(live.id) || live.ended) continue;
      const key = (live.cwd ?? "").replace(/[\\/]+$/, "").toLowerCase();
      let ws = groups.find((g) => g.id.toLowerCase() === key);
      if (!ws) {
        ws = { id: key, cwd: live.cwd, name: basename(live.cwd) || "(unknown)", lastActivity: 0, sessions: [] };
        groups.unshift(ws);
      }
      ws.sessions.unshift({ id: live.id, name: live.name, preview: "", lastActivity: live.lastEventAt });
    }
    return groups;
  }

  /** Workspaces start collapsed; only the one holding the open session opens by itself. */
  function isWsOpen(ws) {
    if (state.filter) return true;
    if (ws.id in state.wsOpen) return state.wsOpen[ws.id];
    return ws.sessions.some((s) => s.id === state.selectedId);
  }

  function liveStatus(id) {
    const live = state.sessions.get(id);
    return live && !live.ended ? live.status : undefined;
  }

  /** Running Pi, or a running Claude Code (from its ~/.claude/sessions process file). */
  function isActive(s) {
    return Boolean(liveStatus(s.id)) || (s.source === "claude" && s.active);
  }

  function activityOf(s) {
    return Math.max(state.sessions.get(s.id)?.lastEventAt ?? 0, s.lastActivity ?? 0);
  }

  /** One session row; `wsName` adds the workspace name (used in the Active list). */
  function sessionRow(s, wsName) {
    const status = liveStatus(s.id);
    const active = s.id === state.selectedId ? " active" : "";
    const claude = s.source === "claude" || String(s.id).startsWith("claude:");
    const claudeBusy = claude && s.active && s.claudeStatus !== "idle";
    const dot = status ? esc(status) : claude && s.active ? (claudeBusy ? "claude-active" : "claude-idle") : "saved";
    const ago = status && status !== "idle" ? statusLabel({ status }) : claudeBusy ? "Running" : fmtAgo(s.lastActivity);
    const tip = `${claude ? "Claude Code" : "Pi"}: ${rowTitle(s)}${wsName ? ` · ${wsName}` : ""}`;
    return `<button class="session${active}" data-id="${esc(s.id)}" title="${esc(tip)}">
      <span class="sdot ${dot}"></span>
      ${claude ? `<span class="src-tag" aria-label="Claude Code">CC</span>` : ""}
      ${
        wsName
          ? `<span class="stext"><span class="sname">${esc(rowTitle(s))}</span><span class="sws">${esc(wsName)}</span></span>`
          : `<span class="sname">${esc(rowTitle(s))}</span>`
      }
      <span class="sago">${esc(ago)}</span>
    </button>`;
  }

  function renderSidebar() {
    const list = $("session-list");
    const filter = state.filter.trim().toLowerCase();
    let groups = treeWithLive();
    if (filter) {
      groups = groups
        .map((ws) => {
          const wsMatch = `${ws.name} ${ws.cwd}`.toLowerCase().includes(filter);
          const sessions = wsMatch
            ? ws.sessions
            : ws.sessions.filter((s) => `${s.name ?? ""} ${s.preview ?? ""}`.toLowerCase().includes(filter));
          return { ...ws, sessions };
        })
        .filter((ws) => ws.sessions.length);
    }
    // Newest activity first (a running session keeps its workspace near the top anyway).
    groups.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));

    // Active: every running session, flat, with its workspace name. They stay in the tree too.
    const activeRows = groups
      .flatMap((ws) => ws.sessions.filter(isActive).map((s) => ({ s, ws })))
      .sort((a, b) => activityOf(b.s) - activityOf(a.s));
    const activeHtml = `<div class="section-head side-section">Active${activeRows.length ? ` <span class="ws-count">${activeRows.length}</span>` : ""}</div>
      <div class="active-list">${
        activeRows.length
          ? activeRows.map(({ s, ws }) => sessionRow(s, ws.name)).join("")
          : `<p class="hint">${filter ? "No running sessions match." : "No running sessions."}</p>`
      }</div>
      <div class="section-head side-section">Workspaces</div>`;

    $("empty-hint").hidden = groups.length > 0 || Boolean(filter);
    list.innerHTML = activeHtml + groups
      .map((ws) => {
        const open = isWsOpen(ws);
        const anyLive = ws.sessions.some(isActive);
        const showAll = state.showAll.has(ws.id) || Boolean(filter);
        const shown = showAll ? ws.sessions : ws.sessions.slice(0, SESSIONS_SHOWN);
        // Keep the selected session visible even past the cut.
        const selectedRow = ws.sessions.find((s) => s.id === state.selectedId);
        if (selectedRow && !shown.includes(selectedRow)) shown.push(selectedRow);
        const hidden = ws.sessions.length - shown.length;
        const rows = shown.map((s) => sessionRow(s)).join("");
        return `<section class="ws${open ? " open" : ""}">
          <button class="ws-head" data-ws="${esc(ws.id)}" title="${esc(ws.cwd)}" aria-expanded="${open}">
            <svg class="ws-icon closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>
            <svg class="ws-icon opened" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 17.5V7.5a2 2 0 0 1 2-2h3.6l2 2h6.4a2 2 0 0 1 2 2v1"/><path d="M3.5 17.5l2.3-5.6a2 2 0 0 1 1.9-1.3H21a1 1 0 0 1 .9 1.4l-2.2 5.3a2 2 0 0 1-1.9 1.2H5.5a2 2 0 0 1-2-1z"/></svg>
            <span class="ws-name">${esc(ws.name)}</span>
            ${anyLive ? `<span class="ws-live"></span>` : ""}
            <span class="ws-count">${ws.sessions.length}</span>
          </button>
          <div class="ws-sessions">${rows}${
            hidden > 0 ? `<button class="ws-more" data-more="${esc(ws.id)}">Show ${hidden} more</button>` : ""
          }</div>
        </section>`;
      })
      .join("");

    for (const button of list.querySelectorAll(".session")) {
      button.addEventListener("click", () => {
        state.pinnedByUser = true;
        select(button.dataset.id);
      });
    }
    for (const head of list.querySelectorAll(".ws-head")) {
      head.addEventListener("click", () => {
        const section = head.parentElement;
        const open = !section.classList.contains("open");
        state.wsOpen[head.dataset.ws] = open;
        savePref("pi-companion.wsOpen", state.wsOpen);
        section.classList.toggle("open", open);
        head.setAttribute("aria-expanded", String(open));
      });
    }
    for (const more of list.querySelectorAll(".ws-more")) {
      more.addEventListener("click", () => {
        state.showAll.add(more.dataset.more);
        renderSidebar();
      });
    }
  }

  let workspacesTimer;
  async function loadWorkspaces() {
    try {
      const res = await fetch("/api/workspaces", { cache: "no-store" });
      if (!res.ok) throw new Error(`workspaces ${res.status}`);
      state.workspaces = (await res.json()).workspaces ?? [];
      renderSidebar();
      if (!state.sessions.has(state.selectedId)) renderHeader();
    } catch (error) {
      console.warn(error);
    }
  }

  /** Re-read the tree soon (debounced): a session started, ended or was saved for the first time. */
  function scheduleWorkspaces(delay = 1200) {
    clearTimeout(workspacesTimer);
    workspacesTimer = setTimeout(loadWorkspaces, delay);
  }

  setInterval(loadWorkspaces, 10_000);

  /* ── left panel: hide / show ─────────────────────────── */

  const appEl = document.querySelector(".app");
  function setSidebarHidden(hidden) {
    appEl.classList.toggle("sidebar-hidden", hidden);
    savePref("pi-companion.sidebarHidden", hidden);
  }
  setSidebarHidden(loadPref("pi-companion.sidebarHidden", false) === true);

  /* ── left panel: resize ──────────────────────────────── */

  const SIDE_DEFAULT = 270;
  // Keep at least 360 px for the transcript between the two panels.
  const clampSide = (w) => {
    const bench = document.getElementById("workbench");
    const benchWidth = bench && !bench.hidden ? bench.offsetWidth : 0;
    const max = Math.max(200, Math.min(560, window.innerWidth - benchWidth - 360));
    return Math.round(Math.min(Math.max(w, 200), max));
  };
  let sideWidth = clampSide(Number(loadPref("pi-companion.sideWidth", SIDE_DEFAULT)) || SIDE_DEFAULT);
  function setSideWidth(w, save = true) {
    sideWidth = clampSide(w);
    appEl.style.setProperty("--side-size", `${sideWidth}px`);
    $("side-resize").setAttribute("aria-valuenow", String(sideWidth));
    if (save) savePref("pi-companion.sideWidth", sideWidth);
  }
  setSideWidth(sideWidth, false);
  window.makeResizeHandle($("side-resize"), {
    get: () => sideWidth,
    set: setSideWidth,
    direction: 1,
    reset: () => setSideWidth(SIDE_DEFAULT),
  });
  $("sidebar-hide").addEventListener("click", () => setSidebarHidden(true));
  $("sidebar-show").addEventListener("click", () => setSidebarHidden(false));
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "b") {
      event.preventDefault();
      setSidebarHidden(!appEl.classList.contains("sidebar-hidden"));
    }
  });

  $("filter").addEventListener("input", (event) => {
    state.filter = event.target.value;
    renderSidebar();
  });

  /* ── header + banner ─────────────────────────────────── */

  /** Header for a saved session that is not running: title, folder, model from its history. */
  function renderSavedHeader() {
    const found = rowFor(state.selectedId);
    $("topbar").hidden = !found && !state.history;
    $("compaction-banner").hidden = true;
    if (!found && !state.history) return;
    const cwd = state.history?.cwd ?? found?.ws.cwd;
    $("session-title").textContent = state.history?.name || (found ? rowTitle(found.row) : "Pi session");
    $("session-meta").innerHTML = [
      cwd && `<span>${esc(cwd)}</span>`,
      state.history?.model && `<span>${esc(state.history.model)}</span>`,
      found?.row.lastActivity && `<span>last active ${esc(new Date(found.row.lastActivity).toLocaleString())}</span>`,
    ]
      .filter(Boolean)
      .join("<span class='sep'>·</span>");
    $("context").hidden = true;
    const pill = $("status-pill");
    if (isClaude(state.selectedId)) {
      // /api/stat (every 2 s) is fresher than the sidebar row (every 10 s).
      const fresh = state.claudeStatFor === state.selectedId;
      const running = fresh ? state.claudeActive : found?.row.active;
      const busy = running && (fresh ? state.claudeStatus : found?.row.claudeStatus) !== "idle";
      pill.textContent = running ? `Claude Code · ${busy ? "Running" : "Idle"}` : "Claude Code";
      pill.className = `pill claude${running ? " active" : ""}`;
    } else {
      pill.textContent = "Saved";
      pill.className = "pill saved";
    }
  }

  function isClaude(id) {
    return typeof id === "string" && id.startsWith("claude:");
  }

  /* ── follow a Claude Code session while its file grows (no live bridge yet) ── */

  let claudeStat = null;
  setInterval(async () => {
    const id = state.selectedId;
    if (!isClaude(id) || document.hidden) return;
    try {
      const res = await fetch(`/api/stat?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!res.ok || id !== state.selectedId) return;
      const s = await res.json();
      const key = `${s.size}:${s.mtimeMs}`;
      const changed = claudeStat && claudeStat.id === id && claudeStat.key !== key;
      const activeChanged =
        state.claudeStatFor !== id || state.claudeActive !== s.active || state.claudeStatus !== s.claudeStatus;
      claudeStat = { id, key };
      state.claudeStatFor = id;
      state.claudeActive = s.active;
      state.claudeStatus = s.claudeStatus;
      if (changed) loadHistory(true);
      if (activeChanged) renderHeader();
    } catch {
      // Server restarting: try again next tick.
    }
  }, 2000);

  function renderHeader() {
    const s = state.sessions.get(state.selectedId);
    if (!s && state.selectedId) {
      renderSavedHeader();
      return;
    }
    $("topbar").hidden = !s;
    if (!s) {
      $("compaction-banner").hidden = true;
      return;
    }
    $("session-title").textContent =
      s.name && s.name !== "New thread" ? s.name : basename(s.cwd) || "Pi session";
    $("session-meta").innerHTML = [s.cwd && `<span>${esc(s.cwd)}</span>`, s.model && `<span>${esc(s.model)}</span>`]
      .filter(Boolean)
      .join("<span class='sep'>·</span>");

    const pill = $("status-pill");
    pill.textContent = statusLabel(s);
    pill.className = `pill ${s.status}`;

    const ctx = s.context;
    const ctxEl = $("context");
    if (ctx && typeof ctx.contextWindow === "number") {
      ctxEl.hidden = false;
      const pct = typeof ctx.percent === "number" ? ctx.percent : null;
      $("context-fill").style.width = `${Math.min(100, pct ?? 0)}%`;
      $("context-fill").className = `context-fill${pct >= 85 ? " hot" : pct >= 70 ? " warm" : ""}`;
      $("context-text").textContent =
        pct === null
          ? `? / ${fmtTokens(ctx.contextWindow)}`
          : `${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.contextWindow)} · ${Math.round(pct)}%`;
    } else {
      ctxEl.hidden = true;
    }

    const banner = $("compaction-banner");
    if (s.compaction) {
      banner.hidden = false;
      banner.className = "banner";
      const tokens = s.compaction.tokens ? ` · ${fmtTokens(s.compaction.tokens)} tokens` : "";
      $("compaction-detail").textContent = `${reasonText(s.compaction.reason)}${tokens}`;
    } else if (s.lastCompaction && Date.now() - (s.lastCompaction.endedAt ?? 0) < 20_000) {
      banner.hidden = false;
      const lc = s.lastCompaction;
      const took = lc.startedAt ? ` in ${fmtDuration(lc.endedAt - lc.startedAt)}` : "";
      if (lc.ok) {
        banner.className = "banner done";
        banner.querySelector("strong").textContent = "Compaction finished";
        $("compaction-detail").textContent = `${reasonText(lc.reason)}${took} · summary below`;
      } else {
        banner.className = "banner failed";
        banner.querySelector("strong").textContent = lc.aborted ? "Compaction cancelled" : "Compaction failed";
        $("compaction-detail").textContent = `${reasonText(lc.reason)}${took}${lc.errorMessage ? ` · ${lc.errorMessage}` : ""}`;
      }
      $("compaction-timer").textContent = "";
    } else {
      banner.hidden = true;
    }
    if (s.compaction) banner.querySelector("strong").textContent = "Compacting context…";
  }

  setInterval(() => {
    const s = state.sessions.get(state.selectedId);
    if (s?.compaction) $("compaction-timer").textContent = fmtDuration(Date.now() - s.compaction.startedAt);
    if (s && !s.compaction && s.lastCompaction) renderHeader();
    for (const el of liveEl.querySelectorAll("[data-started]")) {
      el.textContent = fmtDuration(Date.now() - Number(el.dataset.started));
    }
  }, 1000);

  /* ── transcript ──────────────────────────────────────── */

  function imagesHtml(images) {
    if (!images?.length) return "";
    return `<div class="images">${images
      .map(
        (img) =>
          `<a href="/api/image?id=${encodeURIComponent(state.selectedId)}&ref=${encodeURIComponent(img.ref)}" target="_blank">
            <img loading="lazy" src="/api/image?id=${encodeURIComponent(state.selectedId)}&ref=${encodeURIComponent(img.ref)}" alt="attached image">
          </a>`,
      )
      .join("")}</div>`;
  }

  function toolHtml(call) {
    const r = call.result;
    const status = !r ? "pending" : r.isError ? "error" : "ok";
    const dur =
      typeof r?.durationMs === "number"
        ? `<span class="tdur">${r.durationMs < 1000 ? `${Math.round(r.durationMs)} ms` : `${(r.durationMs / 1000).toFixed(1)}s`}</span>`
        : "";
    const firstArg = (() => {
      try {
        const parsed = JSON.parse(call.args);
        const v = parsed.path ?? parsed.command ?? parsed.pattern ?? parsed.url ?? parsed.query ?? Object.values(parsed)[0];
        return typeof v === "string" ? v : "";
      } catch {
        return "";
      }
    })();
    return `<details class="tool ${status}">
      <summary><span class="tname">${esc(call.name)}</span><span class="targ">${esc(firstArg)}</span>${dur}</summary>
      <div class="tbody">
        <div class="tlabel">Input</div>${window.codeBlock(call.args, "json")}
        ${r ? `<div class="tlabel">${r.isError ? "Error" : "Output"}${r.truncated ? " (cut short)" : ""}</div>${window.codeBlock(r.output || "(empty)", "text")}${imagesHtml(r.images)}` : ""}
      </div>
    </details>`;
  }

  /** Copy / Add buttons for a whole message (its raw markdown is kept in composer.textRefs). */
  function msgTools(id, text) {
    if (!text || !window.composer) return "";
    window.composer.textRefs.set(id, text);
    return `<span class="msg-tools"><button type="button" class="mini" data-copy data-ref="${esc(id)}">Copy</button><button type="button" class="mini" data-add data-ref="${esc(id)}" title="Add to the composer">Add</button></span>`;
  }

  function itemHtml(item) {
    const dim = item.compacted ? " compacted" : "";
    switch (item.kind) {
      case "user":
        return `<article class="msg user${dim}"><div class="who">${msgTools(item.id, item.text)}You <time>${fmtTime(item.timestamp)}</time></div>
          <div class="bubble">${md(item.text)}${imagesHtml(item.images)}</div></article>`;
      case "assistant": {
        const thinking = item.thinking
          ? `<details class="thinking"><summary>Thinking</summary><div>${md(item.thinking)}</div></details>`
          : "";
        const err = item.errorMessage ? `<div class="err">${esc(item.errorMessage)}</div>` : "";
        const tools = item.toolCalls?.length ? `<div class="tools">${item.toolCalls.map(toolHtml).join("")}</div>` : "";
        if (!item.text && !thinking && !tools && !err) return "";
        return `<article class="msg assistant${dim}"><div class="who">${state.history?.source === "claude" ? "Claude" : "Pi"} <time>${fmtTime(item.timestamp)}</time>${msgTools(item.id, item.text)}</div>
          ${thinking}${item.text ? `<div class="prose">${md(item.text)}</div>` : ""}${err}${tools}</article>`;
      }
      case "compaction": {
        const files = [...(item.modifiedFiles ?? []).map((f) => `✎ ${f}`), ...(item.readFiles ?? []).map((f) => f)];
        return `<article class="card compaction"><div class="card-head">
            <span class="badge">Compaction</span>
            <span>${item.tokensBefore ? `${fmtTokens(item.tokensBefore)} tokens summarized` : "Summary"}</span>
            <time>${fmtTime(item.timestamp)}</time></div>
          <details open><summary>Summary the model now sees</summary><div class="prose">${md(item.summary)}</div></details>
          ${files.length ? `<details><summary>Files (${files.length})</summary><ul class="files">${files.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></details>` : ""}
        </article>`;
      }
      case "summary":
        return `<article class="card"><div class="card-head"><span class="badge">${esc(item.label)}</span></div><div class="prose">${md(item.summary)}</div></article>`;
      case "custom":
        return `<article class="msg custom${dim}"><div class="who">${esc(item.customType)}</div><div class="prose">${md(item.text)}</div>${imagesHtml(item.images)}</article>`;
      case "bash":
        return `<article class="msg bash${dim}"><div class="who">! shell</div>${window.codeBlock(`$ ${item.command}\n${item.output}`, "text")}</article>`;
      case "event":
        return `<div class="event${dim}">${esc(item.text)}</div>`;
      case "orphanToolResult":
        return `<div class="event${dim}">${esc(item.toolName)} result</div>`;
      default:
        return "";
    }
  }

  function renderTranscript() {
    const h = state.history;
    if (!h) return;
    const items = h.items ?? [];
    let html = "";
    let shownDivider = false;
    for (const item of items) {
      if (!item.compacted && !shownDivider && items.some((i) => i.compacted)) {
        shownDivider = true;
      }
      html += itemHtml(item);
    }
    if (items.some((i) => i.compacted)) {
      html = `<div class="note">Dimmed messages were summarized by a compaction; the model only sees the summary now.</div>${html}`;
    }
    transcriptEl.innerHTML = html || `<div class="placeholder">Nothing in this session yet.</div>`;
  }

  function renderLive() {
    const s = state.sessions.get(state.selectedId);
    if (!s) {
      liveEl.innerHTML = "";
      return;
    }
    let html = "";
    const tools = Object.entries(s.tools ?? {});
    if (s.stream && (s.stream.text || s.stream.thinking)) {
      html += `<article class="msg assistant streaming"><div class="who">Pi <span class="typing">writing…</span></div>
        ${s.stream.thinking && !s.stream.text ? `<div class="thinking-live">${md(s.stream.thinking.slice(-1500))}</div>` : ""}
        ${s.stream.text ? `<div class="prose">${md(s.stream.text)}</div>` : ""}</article>`;
    }
    if (tools.length) {
      html += `<div class="tools live-tools">${tools
        .map(
          ([, t]) => `<div class="tool running"><div class="tsum"><span class="mini-spin"></span><span class="tname">${esc(t.name)}</span>
            <span class="targ">${esc(t.args)}</span><span class="tdur" data-started="${t.startedAt}">${fmtDuration(Date.now() - t.startedAt)}</span></div>
            ${t.partial ? `<pre class="partial">${esc(t.partial)}</pre>` : ""}</div>`,
        )
        .join("")}</div>`;
    }
    if (s.status === "running" && !html) {
      html = `<div class="event working"><span class="mini-spin"></span> Working${s.turnStartedAt ? ` · <span data-started="${s.turnStartedAt}">${fmtDuration(Date.now() - s.turnStartedAt)}</span>` : ""}</div>`;
    }
    liveEl.innerHTML = html;
  }

  async function loadHistory(force = false) {
    const s = state.sessions.get(state.selectedId);
    if (s && !s.hasHistory && !state.history) {
      transcriptEl.innerHTML = `<div class="placeholder">Pi hasn't saved this session to disk yet. It will appear after the first reply.</div>`;
    }
    if (!state.selectedId || (s && !s.hasHistory) || state.historyLoading) return;
    // A saved (not running) session never changes, so version 0 loads once.
    const wanted = s ? s.historyVersion : 0;
    if (!force && wanted === state.historyVersionLoaded) return;
    state.historyLoading = true;
    const id = state.selectedId;
    try {
      const res = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (res.status === 404 && s) {
        // A new Pi session has a file name but writes the file only after the first reply.
        if (id === state.selectedId && !state.history) {
          transcriptEl.innerHTML = `<div class="placeholder">New session. Pi saves it after the first reply; it will show up here then.</div>`;
        }
        // Wait for the next change from Pi rather than retrying in a loop.
        state.historyVersionLoaded = wanted;
        return;
      }
      if (!res.ok) throw new Error(`history ${res.status}`);
      const data = await res.json();
      if (id !== state.selectedId) return;
      const stick = state.stickToBottom;
      state.history = data;
      state.historyVersionLoaded = wanted;
      renderTranscript();
      if (!s) renderHeader();
      if (stick) scrollToBottom();
      notifyWorkbench(true);
    } catch (error) {
      console.warn(error);
      if (id === state.selectedId && !state.history) {
        transcriptEl.innerHTML = `<div class="placeholder">Could not load this session.</div>`;
      }
    } finally {
      state.historyLoading = false;
      const now = state.sessions.get(state.selectedId);
      if (now && now.historyVersion !== state.historyVersionLoaded) setTimeout(() => loadHistory(), 150);
    }
  }

  function select(id) {
    if (state.selectedId !== id) {
      state.selectedId = id;
      state.claudeActive = undefined;
      state.history = null;
      state.historyVersionLoaded = -1;
      state.stickToBottom = true;
      transcriptEl.innerHTML = `<div class="placeholder">Loading…</div>`;
    }
    renderSidebar();
    renderHeader();
    renderLive();
    notifyWorkbench(false);
    loadHistory();
  }

  /** Tell the right panel which session (and folder) is shown. */
  function notifyWorkbench(historyChanged) {
    const live = state.sessions.get(state.selectedId);
    const cwd = live?.cwd ?? state.history?.cwd ?? rowFor(state.selectedId)?.ws.cwd;
    window.workbench?.update({ sessionId: state.selectedId, cwd, history: state.history, historyChanged });
    notifyComposer();
  }

  /** Tell the composer which session it would send to, and whether that session is live. */
  function notifyComposer() {
    window.composer?.update({ selectedId: state.selectedId, session: state.sessions.get(state.selectedId) });
  }

  function autoSelect() {
    // A session the user clicked (running or saved) stays selected.
    if (state.selectedId && state.pinnedByUser) return;
    const live = sortedSessions().filter((s) => !s.ended);
    const candidate = live[0] ?? sortedSessions()[0];
    if (!state.selectedId || !state.sessions.has(state.selectedId)) {
      if (candidate) select(candidate.id);
      return;
    }
    // Follow the most recently active session unless the user picked one.
    if (candidate && candidate.id !== state.selectedId && candidate.status !== "idle") select(candidate.id);
  }

  function upsert(session) {
    const previous = state.sessions.get(session.id);
    if (!previous || !rowFor(session.id) || previous.ended !== session.ended || previous.name !== session.name) {
      scheduleWorkspaces();
    }
    state.sessions.set(session.id, session);
    autoSelect();
    renderSidebar();
    if (session.id === state.selectedId) {
      notifyComposer();
      const stick = state.stickToBottom;
      renderHeader();
      renderLive();
      loadHistory();
      if (stick) scrollToBottom();
    }
  }

  /* ── live connection ─────────────────────────────────── */

  function setConn(ok, text) {
    $("conn").className = `conn ${ok ? "ok" : "down"}`;
    $("conn-text").textContent = text;
  }

  function connect() {
    const source = new EventSource("/events");
    source.onopen = () => setConn(true, "Live");
    source.onerror = () => setConn(false, "Reconnecting…");
    source.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "hello") {
        state.sessions.clear();
        for (const s of msg.sessions) state.sessions.set(s.id, s);
        autoSelect();
        renderSidebar();
        renderHeader();
        renderLive();
        notifyComposer();
        loadHistory(true);
      } else if (msg.type === "session") {
        upsert(msg.session);
      } else if (msg.type === "removed") {
        state.sessions.delete(msg.id);
        // A session that ended stays open as a saved session; its history is on disk.
        if (state.selectedId === msg.id) {
          liveEl.innerHTML = "";
          state.pinnedByUser = true;
        }
        scheduleWorkspaces(300);
        renderSidebar();
        renderHeader();
        notifyComposer();
      } else if (msg.type === "delivered") {
        window.composer?.delivered(msg);
      }
    };
  }

  loadWorkspaces();
  connect();
})();
