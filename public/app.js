// Pi Companion page: live sessions from /events, history from /api/history.
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
  };

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

  function renderSidebar() {
    const list = $("session-list");
    const sessions = sortedSessions();
    $("empty-hint").hidden = sessions.length > 0;
    list.innerHTML = sessions
      .map((s) => {
        const active = s.id === state.selectedId ? " active" : "";
        return `<button class="session${active}" data-id="${esc(s.id)}">
          <span class="sdot ${esc(s.status)}"></span>
          <span class="sbody">
            <span class="sname">${esc(s.name && s.name !== "New thread" ? s.name : basename(s.cwd) || "Pi session")}</span>
            <span class="ssub">${esc(basename(s.cwd))} · ${esc(statusLabel(s))}</span>
          </span>
        </button>`;
      })
      .join("");
    for (const button of list.querySelectorAll(".session")) {
      button.addEventListener("click", () => {
        state.pinnedByUser = true;
        select(button.dataset.id);
      });
    }
  }

  /* ── header + banner ─────────────────────────────────── */

  function renderHeader() {
    const s = state.sessions.get(state.selectedId);
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
    const dur = r?.durationMs ? `<span class="tdur">${(r.durationMs / 1000).toFixed(1)}s</span>` : "";
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
        <div class="tlabel">Input</div><pre>${esc(call.args)}</pre>
        ${r ? `<div class="tlabel">${r.isError ? "Error" : "Output"}${r.truncated ? " (cut short)" : ""}</div><pre>${esc(r.output || "(empty)")}</pre>${imagesHtml(r.images)}` : ""}
      </div>
    </details>`;
  }

  function itemHtml(item) {
    const dim = item.compacted ? " compacted" : "";
    switch (item.kind) {
      case "user":
        return `<article class="msg user${dim}"><div class="who">You <time>${fmtTime(item.timestamp)}</time></div>
          <div class="bubble">${md(item.text)}${imagesHtml(item.images)}</div></article>`;
      case "assistant": {
        const thinking = item.thinking
          ? `<details class="thinking"><summary>Thinking</summary><div>${md(item.thinking)}</div></details>`
          : "";
        const err = item.errorMessage ? `<div class="err">${esc(item.errorMessage)}</div>` : "";
        const tools = item.toolCalls?.length ? `<div class="tools">${item.toolCalls.map(toolHtml).join("")}</div>` : "";
        if (!item.text && !thinking && !tools && !err) return "";
        return `<article class="msg assistant${dim}"><div class="who">Pi <time>${fmtTime(item.timestamp)}</time></div>
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
        return `<article class="msg bash${dim}"><div class="who">! shell</div><pre>$ ${esc(item.command)}\n${esc(item.output)}</pre></article>`;
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
    if (!s || !s.hasHistory || state.historyLoading) return;
    if (!force && s.historyVersion === state.historyVersionLoaded) return;
    state.historyLoading = true;
    const id = s.id;
    const wanted = s.historyVersion;
    try {
      const res = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`history ${res.status}`);
      const data = await res.json();
      if (id !== state.selectedId) return;
      const stick = state.stickToBottom;
      state.history = data;
      state.historyVersionLoaded = wanted;
      renderTranscript();
      if (stick) scrollToBottom();
    } catch (error) {
      console.warn(error);
    } finally {
      state.historyLoading = false;
      const now = state.sessions.get(state.selectedId);
      if (now && now.historyVersion !== state.historyVersionLoaded) setTimeout(() => loadHistory(), 150);
    }
  }

  function select(id) {
    if (state.selectedId !== id) {
      state.selectedId = id;
      state.history = null;
      state.historyVersionLoaded = -1;
      state.stickToBottom = true;
      transcriptEl.innerHTML = `<div class="placeholder">Loading…</div>`;
    }
    renderSidebar();
    renderHeader();
    renderLive();
    loadHistory();
  }

  function autoSelect() {
    if (state.selectedId && state.sessions.has(state.selectedId) && state.pinnedByUser) return;
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
    state.sessions.set(session.id, session);
    autoSelect();
    renderSidebar();
    if (session.id === state.selectedId) {
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
        loadHistory(true);
      } else if (msg.type === "session") {
        upsert(msg.session);
      } else if (msg.type === "removed") {
        state.sessions.delete(msg.id);
        if (state.selectedId === msg.id) {
          state.selectedId = null;
          state.pinnedByUser = false;
          transcriptEl.innerHTML = `<div class="placeholder">That Pi session ended.</div>`;
          liveEl.innerHTML = "";
        }
        autoSelect();
        renderSidebar();
        renderHeader();
      }
    };
  }

  connect();
})();
