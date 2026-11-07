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
    wsOpen: loadPref("pi-companion.wsOpen", {}), // by "<cli>|<workspace id>"
    cliOpen: loadPref("pi-companion.cliOpen", {}),
    showAll: new Set(),
    filter: "",
    /** Favorite session ids, most recently added first (kept by the server in favorites.json). */
    favorites: [],
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

  /** 1.2k, 34k, 1.2M, 3.4B */
  function fmtCount(n) {
    if (!Number.isFinite(n)) return "?";
    for (const [size, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "k"]]) {
      if (n >= size) return `${(n / size).toFixed(n >= size * 100 ? 0 : 1).replace(/\.0$/, "")}${unit}`;
    }
    return String(Math.round(n));
  }

  function fmtUsd(n) {
    return n >= 100 ? `$${Math.round(n)}` : n >= 0.01 ? `$${n.toFixed(2)}` : "<$0.01";
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

  /** Tell the suggested-replies row (public/suggest.js) what the selected session is doing. */
  function considerSuggest() {
    const id = state.selectedId;
    if (!id || !window.suggest) return;
    const live = state.sessions.get(id);
    const row = rowFor(id)?.row ?? { id };
    const running = live ? !live.ended : isActive(row);
    window.suggest.consider({ id, items: state.history?.items, running, working: running && isWorking(row) });
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

  /**
   * CLI groups and workspaces start collapsed; only the ones holding the open session open by
   * themselves. `key` is the group's key in `prefs` (state.cliOpen or state.wsOpen).
   */
  function isOpen(prefs, key, sessions) {
    if (state.filter) return true;
    if (key in prefs) return prefs[key];
    return sessions.some((s) => s.id === state.selectedId);
  }

  /**
   * The Workspaces tree, by CLI first: one group per CLI (in Settings order) holding that CLI's
   * workspaces, each with only that CLI's sessions. Newest activity first within a group.
   */
  function byCli(groups) {
    const out = new Map(cliSources.list().map((src) => [src.id, { src, workspaces: [] }]));
    for (const ws of groups) {
      const split = new Map();
      for (const s of ws.sessions) {
        const id = cliSources.forRow(s).id;
        if (!split.has(id)) split.set(id, []);
        split.get(id).push(s);
      }
      for (const [id, sessions] of split) {
        if (!out.has(id)) out.set(id, { src: cliSources.get(id), workspaces: [] });
        const lastActivity = Math.max(0, ...sessions.map((s) => s.lastActivity ?? 0));
        out.get(id).workspaces.push({ ...ws, sessions, lastActivity });
      }
    }
    return [...out.values()]
      .filter((g) => g.workspaces.length)
      .map((g) => ({ ...g, workspaces: g.workspaces.sort((a, b) => b.lastActivity - a.lastActivity) }));
  }

  /** The dot beside a CLI or workspace name: shown while one of its sessions runs, pulsing while one works. */
  function liveDot(sessions) {
    if (!sessions.some(isActive)) return "";
    const busy = sessions.some((s) => {
      const status = liveStatus(s.id);
      return status === "running" || status === "compacting" || fileBusy(s);
    });
    return `<span class="ws-live${busy ? " busy" : ""}"></span>`;
  }

  function liveStatus(id) {
    const live = state.sessions.get(id);
    return live && !live.ended ? live.status : undefined;
  }

  /** Running: a live Pi, or another CLI the server reports running (e.g. Claude Code's process file). */
  function isActive(s) {
    return Boolean(liveStatus(s.id)) || (!cliSources.forRow(s).live && Boolean(s.active));
  }

  /** A CLI without a live bridge that is running and working (not idle). */
  function fileBusy(s) {
    return !cliSources.forRow(s).live && Boolean(s.active) && s.runStatus !== "idle";
  }

  /** Running and in the middle of a turn (not waiting for you). */
  function isWorking(s) {
    const status = liveStatus(s.id);
    return status ? status !== "idle" : fileBusy(s);
  }

  function activityOf(s) {
    return Math.max(state.sessions.get(s.id)?.lastEventAt ?? 0, s.lastActivity ?? 0);
  }

  /* ── "Needs you" count in the browser tab title: "(2) CLI Companion" ──
     Running sessions waiting for you that did something since you last looked at them. A session
     counts as looked at while it is the one open and this tab is visible. Kept per browser in
     localStorage (session id -> time), newest 200. */
  const SEEN_KEY = "pi-companion.seen";
  const BASE_TITLE = document.title || "CLI Companion";
  let seenAt = {};
  try {
    seenAt = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") || {};
  } catch {}
  let lastActiveRows = [];

  function markSeen() {
    const id = state.selectedId;
    if (!id || document.hidden) return;
    seenAt[id] = Date.now();
    const ids = Object.keys(seenAt);
    if (ids.length > 200) for (const old of ids.sort((a, b) => seenAt[a] - seenAt[b]).slice(0, ids.length - 200)) delete seenAt[old];
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(seenAt));
    } catch {}
  }

  function updateTitle() {
    markSeen();
    const n = lastActiveRows.filter(({ s }) => !isWorking(s) && activityOf(s) > (seenAt[s.id] ?? 0) + 1000).length;
    const title = n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
    if (document.title !== title) document.title = title;
  }
  document.addEventListener("visibilitychange", updateTitle);

  /* ── git branch and uncommitted changes (Active and Favorites rows, the header) ── */

  const gitById = new Map(); // session id -> summary | null (not a git folder)
  let gitWanted = [];
  let gitAsked = "";

  /** "main, 2 ahead · +71 −1" (short, for a row) */
  function gitText(g) {
    if (!g) return "";
    let text = g.branch ?? "";
    if (g.ahead) text += `, ${g.ahead} ahead`;
    if (g.behind) text += `, ${g.behind} behind`;
    if (g.added || g.removed) text += ` · +${g.added} −${g.removed}`;
    else if (g.changed || g.untracked) text += ` · ${g.changed + g.untracked} file${g.changed + g.untracked === 1 ? "" : "s"}`;
    return text;
  }

  /** The full sentence for a tooltip. */
  function gitTip(g) {
    if (!g) return "";
    const parts = [`Branch ${g.branch}`];
    if (g.ahead || g.behind) parts.push(`${g.ahead} commit${g.ahead === 1 ? "" : "s"} ahead, ${g.behind} behind its upstream`);
    if (g.changed || g.untracked) {
      parts.push(`uncommitted: ${g.changed} changed file${g.changed === 1 ? "" : "s"} (+${g.added} −${g.removed} lines), ${g.untracked} untracked`);
    } else parts.push("nothing uncommitted");
    return parts.join("; ");
  }

  async function refreshGit(force = false) {
    if (window.companionPrefs?.showGit === false) return;
    const ids = [...new Set([...gitWanted, state.selectedId].filter(Boolean))];
    const key = ids.join(",");
    if (!ids.length || (!force && key === gitAsked)) return;
    gitAsked = key;
    try {
      const res = await fetch(`/api/git?ids=${encodeURIComponent(key)}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      let changed = false;
      for (const [id, g] of Object.entries(data)) {
        if (JSON.stringify(gitById.get(id)) !== JSON.stringify(g)) changed = true;
        gitById.set(id, g);
      }
      if (changed) {
        renderSidebar();
        renderHeader();
      }
    } catch {
      // Server restarting: try again on the next tick.
    }
  }
  setInterval(() => {
    if (!document.hidden) refreshGit(true);
  }, 20_000);
  // Settings changed (git info or cost switched on/off): redraw, and fetch git info if it's back on.
  window.addEventListener("prefs-changed", () => {
    if (window.companionPrefs?.showGit === false) gitById.clear();
    gitAsked = "";
    renderSidebar();
    renderHeader();
  });

  /** One session row; `wsName` adds the workspace name (used in the Active list). */
  function sessionRow(s, wsName) {
    const status = liveStatus(s.id);
    const active = s.id === state.selectedId ? " active" : "";
    const src = cliSources.forRow(s);
    const busy = fileBusy(s);
    const dot = status ? esc(status) : !src.live && s.active ? (busy ? "file-busy" : "file-idle") : "saved";
    const ago = status && status !== "idle" ? statusLabel({ status }) : busy ? "Running" : fmtAgo(s.lastActivity);
    const g = wsName ? gitById.get(s.id) : undefined;
    const tip = `${src.label}: ${rowTitle(s)}${wsName ? ` · ${wsName}` : ""}${g ? `\n${gitTip(g)}` : ""}`;
    const row = `<button class="session${active}" data-id="${esc(s.id)}" data-src="${esc(src.id)}" title="${esc(tip)}">
      <span class="sdot ${dot}"></span>
      ${src.tag ? `<span class="src-tag" aria-label="${esc(src.label)}">${esc(src.tag)}</span>` : ""}
      ${
        wsName
          ? `<span class="stext"><span class="sname">${esc(rowTitle(s))}</span><span class="sws">${esc(wsName)}${
              g ? `<span class="sgit"> · ${esc(gitText(g))}</span>` : ""
            }</span></span>`
          : `<span class="sname">${esc(rowTitle(s))}</span>`
      }
      <span class="sago">${esc(ago)}</span>
    </button>`;
    // Sessions in the tree get the terminal icon: resume a saved one in a new terminal; for a
    // running one, a terminal in its folder and where the session is open.
    if (wsName) return row;
    const label = isActive(s) ? `Open a terminal for ${rowTitle(s)}` : `Resume ${rowTitle(s)} in a terminal`;
    return `<div class="row-wrap">${row}${termButton("session", s.id, label)}</div>`;
  }

  /** The star beside a row in Active and Favorites: adds the session to Favorites or removes it. */
  function favButton(s) {
    const on = state.favorites.includes(s.id);
    const label = on ? `Remove ${rowTitle(s)} from Favorites` : `Add ${rowTitle(s)} to Favorites`;
    return `<button class="row-fav${on ? " on" : ""}" type="button" data-fav="${esc(s.id)}" aria-pressed="${on}" aria-label="${esc(label)}" title="${esc(label)}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>
    </button>`;
  }

  async function loadFavorites() {
    try {
      const res = await fetch("/api/favorites", { cache: "no-store" });
      if (!res.ok) return;
      state.favorites = (await res.json()).favorites ?? [];
      renderSidebar();
    } catch {
      // Server restarting: the SSE hello reloads them.
    }
  }

  async function toggleFavorite(id) {
    const on = state.favorites.includes(id);
    // Show it at once; the server's answer (and its broadcast to other windows) settles it.
    state.favorites = on ? state.favorites.filter((other) => other !== id) : [id, ...state.favorites];
    renderSidebar();
    try {
      const res = await fetch(on ? `/api/favorites?id=${encodeURIComponent(id)}` : "/api/favorites", {
        method: on ? "DELETE" : "POST",
        headers: { "content-type": "application/json", "x-pi-companion-page": "1" },
        body: on ? undefined : JSON.stringify({ id }),
      });
      if (res.ok) state.favorites = (await res.json()).favorites ?? state.favorites;
    } catch {
      // Keep what is shown; the next load corrects it.
    }
    renderSidebar();
  }

  /** The small terminal icon that opens the Open / Copy menu (public/launch.js). */
  function termButton(kind, id, label) {
    return `<button class="row-term" type="button" data-launch-kind="${kind}" data-launch-id="${esc(id)}" aria-label="${esc(label)}" title="${esc(label)}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 10l3 2.2L7 14.4M12.5 15h4.5"/></svg>
    </button>`;
  }

  let sidebarHtml = ""; // what the list shows now
  let sidebarPointerDown = false;
  let sidebarPending = false;
  let sidebarPointerTimer;
  function releaseSidebar() {
    clearTimeout(sidebarPointerTimer);
    if (!sidebarPointerDown) return;
    sidebarPointerDown = false;
    // Let the click land on the rows it started on, then catch up.
    setTimeout(() => {
      if (sidebarPending && !sidebarPointerDown) {
        sidebarPending = false;
        renderSidebar();
      }
    }, 0);
  }
  $("session-list").addEventListener("pointerdown", () => {
    sidebarPointerDown = true;
    clearTimeout(sidebarPointerTimer);
    sidebarPointerTimer = setTimeout(releaseSidebar, 2000); // never hold updates for long
  });
  window.addEventListener("pointerup", releaseSidebar);
  window.addEventListener("pointercancel", releaseSidebar);

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
    // Waiting for you first, the one that finished most recently on top (its last write is when
    // it finished); sessions still working go below them, so the top is always what to do next.
    const activeRows = groups
      .flatMap((ws) => ws.sessions.filter(isActive).map((s) => ({ s, ws })))
      .sort((a, b) => isWorking(a.s) - isWorking(b.s) || activityOf(b.s) - activityOf(a.s));
    // Favorites: in the order they were added, newest first; running or not. Ids whose session is
    // gone (or hidden by the filter) are left out.
    const byId = new Map(groups.flatMap((ws) => ws.sessions.map((s) => [s.id, { s, ws }])));
    const favRows = state.favorites.map((id) => byId.get(id)).filter(Boolean);
    lastActiveRows = activeRows;
    updateTitle();
    gitWanted = [...activeRows, ...favRows].map(({ s }) => s.id);
    void refreshGit();
    const activeHtml = `<div class="section-head side-section">Active${activeRows.length ? ` <span class="ws-count">${activeRows.length}</span>` : ""}</div>
      <div class="active-list">${
        activeRows.length
          ? activeRows.map(({ s, ws }) => `<div class="row-wrap">${sessionRow(s, ws.name)}${favButton(s)}</div>`).join("")
          : `<p class="hint">${filter ? "No running sessions match." : "No running sessions."}</p>`
      }</div>
      <div class="section-head side-section">Favorites${favRows.length ? ` <span class="ws-count">${favRows.length}</span>` : ""}</div>
      <div class="fav-list">${
        favRows.length
          ? favRows
              .map(({ s, ws }) => `<div class="row-wrap">${sessionRow(s, ws.name)}${termButton("session", s.id, isActive(s) ? `Open a terminal for ${rowTitle(s)}` : `Resume ${rowTitle(s)} in a terminal`)}${favButton(s)}</div>`)
              .join("")
          : `<p class="hint">${filter && state.favorites.length ? "No favorites match." : "Click the star beside a session under Active to keep it here."}</p>`
      }</div>
      <div class="section-head side-section">Workspaces</div>`;

    $("empty-hint").hidden = groups.length > 0 || Boolean(filter);
    // The welcome card is for a real first run: only once the list has loaded, and gone again
    // as soon as a session exists.
    const welcome = transcriptEl.querySelector(".welcome");
    if (!groups.length && !filter && !state.selectedId && state.workspacesLoaded) renderWelcome();
    else if (welcome && groups.length) transcriptEl.innerHTML = `<div class="placeholder" id="placeholder">Pick a session on the left.</div>`;
    const wsSection = (ws, cliId) => {
        const key = `${cliId}|${ws.id}`;
        const open = isOpen(state.wsOpen, key, ws.sessions);
        const showAll = state.showAll.has(key) || Boolean(filter);
        const shown = showAll ? ws.sessions : ws.sessions.slice(0, SESSIONS_SHOWN);
        // Keep the selected session visible even past the cut.
        const selectedRow = ws.sessions.find((s) => s.id === state.selectedId);
        if (selectedRow && !shown.includes(selectedRow)) shown.push(selectedRow);
        const hidden = ws.sessions.length - shown.length;
        const rows = shown.map((s) => sessionRow(s)).join("");
        return `<section class="ws${open ? " open" : ""}">
          <div class="row-wrap ws-row-wrap">
          <button class="ws-head" data-ws="${esc(key)}" title="${esc(ws.cwd)}" aria-expanded="${open}">
            <svg class="ws-icon closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>
            <svg class="ws-icon opened" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 17.5V7.5a2 2 0 0 1 2-2h3.6l2 2h6.4a2 2 0 0 1 2 2v1"/><path d="M3.5 17.5l2.3-5.6a2 2 0 0 1 1.9-1.3H21a1 1 0 0 1 .9 1.4l-2.2 5.3a2 2 0 0 1-1.9 1.2H5.5a2 2 0 0 1-2-1z"/></svg>
            <span class="ws-name">${esc(ws.name)}</span>
            ${liveDot(ws.sessions)}
            <span class="ws-count">${ws.sessions.length}</span>
          </button>
          ${termButton("workspace", ws.id, `Open ${ws.name} in a terminal`)}
          </div>
          <div class="ws-sessions">${rows}${
            hidden > 0 ? `<button class="ws-more" data-more="${esc(key)}">Show ${hidden} more</button>` : ""
          }</div>
        </section>`;
    };
    const html = activeHtml + byCli(groups)
      .map(({ src, workspaces }) => {
        const sessions = workspaces.flatMap((ws) => ws.sessions);
        const open = isOpen(state.cliOpen, src.id, sessions);
        return `<section class="cli-group${open ? " open" : ""}">
          <button class="cli-head" data-cli="${esc(src.id)}" aria-expanded="${open}">
            <svg class="cli-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
            <span class="src-dot" data-src="${esc(src.id)}"></span>
            <span class="ws-name">${esc(src.label)}</span>
            ${liveDot(sessions)}
            <span class="ws-count" title="${workspaces.length} workspaces, ${sessions.length} sessions">${workspaces.length}</span>
          </button>
          <div class="cli-workspaces">${workspaces.map((ws) => wsSection(ws, src.id)).join("")}</div>
        </section>`;
      })
      .join("");
    // A working session streams many updates a second, and each one comes here. Replacing the rows
    // between a mouse press and release loses the click, so: leave the rows alone when nothing on
    // them changed, and while a button is held down over the list, wait until it's released.
    if (html === sidebarHtml) {
      considerSuggest();
      return;
    }
    if (sidebarPointerDown) {
      sidebarPending = true;
      return;
    }
    sidebarHtml = html;
    list.innerHTML = html;

    for (const button of list.querySelectorAll(".row-fav")) {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void toggleFavorite(button.dataset.fav);
      });
    }
    for (const button of list.querySelectorAll(".session")) {
      button.addEventListener("click", () => {
        state.pinnedByUser = true;
        select(button.dataset.id);
      });
    }
    for (const head of list.querySelectorAll(".cli-head")) {
      head.addEventListener("click", () => {
        const section = head.closest(".cli-group");
        const open = !section.classList.contains("open");
        state.cliOpen[head.dataset.cli] = open;
        savePref("pi-companion.cliOpen", state.cliOpen);
        section.classList.toggle("open", open);
        head.setAttribute("aria-expanded", String(open));
      });
    }
    for (const head of list.querySelectorAll(".ws-head")) {
      head.addEventListener("click", () => {
        const section = head.closest(".ws");
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
    considerSuggest();
  }

  /** First run (no sessions anywhere yet): which CLIs were found, where we looked, how to start. */
  function renderWelcome() {
    const shown = cliSources.list().filter((s) => s.enabled !== false);
    const rows = shown
      .map((s) => {
        const where = s.folders?.[0]?.path;
        const state = s.installed ? `<span class="wel-ok">Found</span>` : `<span class="wel-miss">Not found yet</span>`;
        return `<li><span class="src-dot" data-src="${esc(s.id)}"></span><b>${esc(s.label)}</b> ${state}
          <span class="wel-sub">${where ? `Looks in <code>${esc(where)}</code>.` : ""} ${s.start ? `Start it with <code>${esc(s.start)}</code> in a terminal.` : ""}</span></li>`;
      })
      .join("");
    transcriptEl.innerHTML = `<div class="welcome">
      <h2>Welcome to CLI Companion</h2>
      <p>A live side window for your coding-agent CLIs. Keep working in the terminal; sessions show up on the
        left within a few seconds, running ones under Active.</p>
      <ul class="wel-list">${rows}</ul>
      <p class="wel-foot">Pi also needs its extension for the live view: <code>pi install git:github.com/mcgowee/cli-companion</code>,
        then <code>/companion</code>. Hide a CLI or change where it looks in <a href="#/settings">Settings</a>.</p>
    </div>`;
  }

  let workspacesTimer;
  async function loadWorkspaces() {
    try {
      const res = await fetch("/api/workspaces", { cache: "no-store" });
      if (!res.ok) throw new Error(`workspaces ${res.status}`);
      state.workspaces = (await res.json()).workspaces ?? [];
      state.workspacesLoaded = true;
      renderSidebar();
      // While a session is working, look again soon so it moves to the top of Active when it finishes.
      if (state.workspaces.some((ws) => ws.sessions?.some((s) => isActive(s) && isWorking(s)))) scheduleWorkspaces(3000);
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
  /** For the command palette: every session it can jump to, and the left panel switch. */
  window.companionApp = {
    sessions: () =>
      treeWithLive().flatMap((ws) =>
        ws.sessions.map((s) => ({
          id: s.id,
          title: rowTitle(s),
          ws: ws.name,
          src: cliSources.forRow(s).id,
          active: isActive(s),
          at: activityOf(s),
        })),
      ),
    selectedId: () => state.selectedId,
    toggleSidebar: () => setSidebarHidden(!appEl.classList.contains("sidebar-hidden")),
  };
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
    const src = cliSources.forId(state.selectedId);
    if (!src.live) {
      // /api/stat (every 2 s) is fresher than the sidebar row (every 10 s).
      const fresh = state.fileStatFor === state.selectedId;
      const running = fresh ? state.fileActive : found?.row.active;
      const busy = running && (fresh ? state.fileRunStatus : found?.row.runStatus) !== "idle";
      pill.textContent = running ? `${src.label} · ${busy ? "Running" : "Idle"}` : src.label;
      pill.className = `pill file${running ? " active" : ""}`;
      pill.dataset.src = src.id;
    } else {
      pill.textContent = "Saved";
      pill.className = "pill saved";
    }
  }

  // The server's list of CLIs arrives after the first render: redraw tags, labels and the pill.
  window.addEventListener("sources-ready", () => {
    renderSidebar();
    renderHeader();
  });

  /* ── follow a session without a live bridge (Claude Code, …) while its file grows ── */

  let fileStat = null;
  setInterval(async () => {
    const id = state.selectedId;
    if (!id || cliSources.forId(id).live || document.hidden) return;
    try {
      const res = await fetch(`/api/stat?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!res.ok || id !== state.selectedId) return;
      const s = await res.json();
      const key = `${s.size}:${s.mtimeMs}`;
      const changed = fileStat && fileStat.id === id && fileStat.key !== key;
      const activeChanged =
        state.fileStatFor !== id || state.fileActive !== s.active || state.fileRunStatus !== s.runStatus;
      fileStat = { id, key };
      state.fileStatFor = id;
      state.fileActive = s.active;
      state.fileRunStatus = s.runStatus;
      if (changed) loadHistory(true);
      if (activeChanged) renderHeader();
    } catch {
      // Server restarting: try again next tick.
    }
  }, 2000);

  function renderHeader() {
    renderHeaderParts();
    renderUsage();
    const g = gitById.get(state.selectedId);
    if (g && !$("topbar").hidden) {
      $("session-meta").insertAdjacentHTML(
        "beforeend",
        `<span class='sep'>·</span><span class="meta-git" title="${esc(gitTip(g))}">${esc(gitText(g))}</span>`,
      );
    }
  }

  /* ── token use (from the session file, /api/history → usage) ── */

  function usageTotal(u) {
    return u.tokens.input + u.tokens.output + u.tokens.cacheRead + u.tokens.cacheWrite;
  }

  function timeOf(at) {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return "";
    if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function renderUsage() {
    const box = $("usage");
    const u = state.history?.usage;
    const live = state.sessions.get(state.selectedId);
    const liveContext = live?.context && typeof live.context.contextWindow === "number";
    if (!u || !state.selectedId || (!usageTotal(u) && !u.rateLimits)) {
      box.hidden = true;
      $("usage-pop").hidden = true;
      if (!liveContext) $("context").hidden = true;
      return;
    }
    box.hidden = false;
    const limit = u.rateLimits?.length ? u.rateLimits.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a)) : undefined;
    const approx = u.costKind === "claude-estimate" ? "~" : "";
    const chip = [`${fmtCount(usageTotal(u))} tokens`];
    const showCost = window.companionPrefs?.showCost !== false;
    if (u.costUsd && showCost) chip.push(`${approx}${fmtUsd(u.costUsd)}`);
    else if (limit) chip.push(`${limit.label.replace(" limit", "")} ${Math.round(limit.usedPercent)}%`);
    $("usage-chip").textContent = chip.join(" · ");

    // Context: the live Pi meter wins; otherwise what the file last recorded.
    const ctxEl = $("context");
    const bar = ctxEl.querySelector(".context-bar");
    if (!liveContext) {
      const ctx = u.context;
      ctxEl.hidden = !ctx?.tokens;
      if (ctx?.tokens) {
        const pct = ctx.window ? (ctx.tokens / ctx.window) * 100 : null;
        bar.hidden = pct === null;
        $("context-fill").style.width = `${Math.min(100, pct ?? 0)}%`;
        $("context-fill").className = `context-fill${pct >= 85 ? " hot" : pct >= 70 ? " warm" : ""}`;
        $("context-text").textContent =
          pct === null ? `${fmtTokens(ctx.tokens)} in context` : `${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)} · ${Math.round(pct)}%`;
        ctxEl.title = `Context at the last reply${ctx.at ? ` (${timeOf(ctx.at)})` : ""}${pct === null ? ". The session file doesn't say how big the window is." : ""}`;
      }
    } else {
      bar.hidden = false;
      ctxEl.title = "Context used";
    }

    const row = (label, value, note = "") => `<div class="u-row"><span>${label}</span><b>${value}</b>${note ? `<small>${note}</small>` : ""}</div>`;
    const t = u.tokens;
    const parts = [
      `<div class="u-head">Token use<span>${esc(u.model ?? "")}</span></div>`,
      row("Total", fmtCount(usageTotal(u)), `${u.turns.toLocaleString()} model calls`),
      row("Input", fmtCount(t.input), "new, not from cache"),
      t.cacheWrite ? row("Cache write", fmtCount(t.cacheWrite)) : "",
      row("Cache read", fmtCount(t.cacheRead), "re-read from cache, much cheaper than new input"),
      row("Output", fmtCount(t.output)),
    ];
    if (u.context?.tokens) {
      const value = u.context.window ? `${fmtCount(u.context.tokens)} / ${fmtCount(u.context.window)}` : fmtCount(u.context.tokens);
      parts.push(row("Context", value, "at the last reply"));
    }
    if (u.costUsd && showCost) {
      const note =
        u.costKind === "claude-estimate"
          ? `Claude Code's own estimate at API prices${u.costAt ? `, last saved ${timeOf(u.costAt)}` : ""}. A Pro or Max plan isn't billed this.`
          : "From the provider's prices, as Pi recorded them.";
      parts.push(row("Cost", `${approx}${fmtUsd(u.costUsd)}`, note));
    }
    if (u.lines) parts.push(row("Lines changed", `+${u.lines.added.toLocaleString()} −${u.lines.removed.toLocaleString()}`, "as Claude Code counts them"));
    for (const l of u.rateLimits ?? []) {
      const note = [l.resetsAt && `resets ${timeOf(l.resetsAt)}`, l.at && `as of ${timeOf(l.at)}`].filter(Boolean).join(" · ");
      parts.push(row(esc(l.label), `${Math.round(l.usedPercent)}% used`, note));
    }
    parts.push(`<p class="u-foot">Read from the session file. Totals for all sessions: <a href="#/dashboards/usage">Usage overview</a>.</p>`);
    $("usage-pop").innerHTML = parts.join("");
  }

  function closeUsagePop(focusChip) {
    $("usage-pop").hidden = true;
    $("usage-chip").setAttribute("aria-expanded", "false");
    if (focusChip) $("usage-chip").focus();
  }
  $("usage-chip").addEventListener("click", (event) => {
    event.stopPropagation();
    const pop = $("usage-pop");
    pop.hidden = !pop.hidden;
    $("usage-chip").setAttribute("aria-expanded", String(!pop.hidden));
    if (!pop.hidden) {
      // Open toward whichever side has room (the header wraps on narrow windows).
      const chip = $("usage-chip").getBoundingClientRect();
      const main = $("topbar").getBoundingClientRect();
      pop.classList.toggle("align-left", chip.right - pop.offsetWidth < main.left + 8);
    }
  });
  document.addEventListener("click", (event) => {
    if (!$("usage-pop").hidden && !$("usage").contains(event.target)) closeUsagePop(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("usage-pop").hidden) closeUsagePop(true);
  });

  function renderHeaderParts() {
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
        return `<article class="msg assistant${dim}"><div class="who">${esc(cliSources.get(state.history?.source).assistant)} <time>${fmtTime(item.timestamp)}</time>${msgTools(item.id, item.text)}</div>
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
      considerSuggest();
      if (!s) renderHeader();
      else renderUsage();
      if (stick) scrollToBottom();
      if (state.pendingFind) requestAnimationFrame(applyFind);
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
      state.fileActive = undefined;
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

  /** Show a session from another page (e.g. Usage overview's top sessions). */
  window.openSession = (id, { find, nth = 0 } = {}) => {
    state.pinnedByUser = true;
    state.pendingFind = find?.length ? { id, terms: find, nth } : null;
    if (location.hash && location.hash !== "#/") location.hash = "#/";
    const already = state.selectedId === id && state.history;
    select(id);
    if (already) applyFind();
  };

  /** After Search: scroll to the nth newest message with every term, and mark it for a moment. */
  function applyFind() {
    const f = state.pendingFind;
    if (!f || f.id !== state.selectedId) return;
    state.pendingFind = null;
    const matches = [...transcriptEl.querySelectorAll("article.msg.user, article.msg.assistant")]
      .reverse()
      .filter((el) => {
        const text = el.textContent.toLowerCase();
        return f.terms.every((t) => text.includes(t));
      });
    const target = matches[f.nth] ?? matches[0];
    if (!target) return;
    state.stickToBottom = false;
    target.scrollIntoView({ block: "center" });
    target.classList.add("find-hit");
    setTimeout(() => target.classList.remove("find-hit"), 4000);
  }

  /** Tell the right panel which session (and folder) is shown. */
  function notifyWorkbench(historyChanged) {
    const live = state.sessions.get(state.selectedId);
    const cwd = live?.cwd ?? state.history?.cwd ?? rowFor(state.selectedId)?.ws.cwd;
    const row = rowFor(state.selectedId)?.row ?? { id: state.selectedId };
    const working = Boolean(state.selectedId) && (live ? !live.ended && live.status !== "idle" : isWorking(row));
    window.workbench?.update({ sessionId: state.selectedId, cwd, history: state.history, historyChanged, working });
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
      } else if (msg.type === "favorites") {
        // Changed here or in another window.
        state.favorites = msg.favorites ?? [];
        renderSidebar();
      } else if (msg.type === "sources") {
        // Settings changed (which CLIs are read, suggested replies): refresh the list, then the sidebar.
        window.suggest?.reset();
        cliSources.reload().then(loadWorkspaces);
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
  loadFavorites();
  connect();
})();
