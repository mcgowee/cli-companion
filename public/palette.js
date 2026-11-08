// Command palette (Ctrl+K, or the ⌘ button in the composer): one floating box over the app to
// find and run things by typing:
//   - the selected session's CLI commands (/compact, /model, …): Enter puts the command in Pi's
//     input, Ctrl+Enter also presses Enter; for Claude Code and Codex it is copied to paste;
//   - sessions to jump to (running ones first);
//   - companion actions (Search, Usage, Settings, panels).
(function () {
  const esc = window.escapeHtml;
  const $ = (id) => document.getElementById(id);

  const root = document.createElement("div");
  root.className = "palette-backdrop";
  root.hidden = true;
  root.innerHTML = `<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <input class="palette-input" type="text" placeholder="Type a command, session or action…" aria-label="Find a command, session or action"
        role="combobox" aria-expanded="true" aria-controls="palette-list" autocomplete="off" spellcheck="false">
      <div class="palette-list" id="palette-list" role="listbox" aria-label="Results"></div>
      <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span>
        <span class="palette-send-hint"><kbd>Ctrl+Enter</kbd> run and send</span><span><kbd>Esc</kbd> close</span>
        <span class="palette-note" role="status" aria-live="polite"></span></div>
    </div>`;
  document.body.appendChild(root);
  const input = root.querySelector(".palette-input");
  const listEl = root.querySelector(".palette-list");
  const noteEl = root.querySelector(".palette-note");

  const state = { items: [], shown: [], index: 0, commands: [], commandsFor: null, returnFocus: null };

  const ACTIONS = [
    { label: "Search all sessions", hint: "Ctrl+Shift+F", run: () => (location.hash = "#/search") },
    { label: "Usage overview", hint: "tokens, cost, sessions", run: () => (location.hash = "#/dashboards/usage") },
    { label: "Old sessions", hint: "not used for a while", run: () => (location.hash = "#/dashboards/old") },
    { label: "Dashboards", run: () => (location.hash = "#/dashboards") },
    { label: "Settings", run: () => (location.hash = "#/settings") },
    { label: "About and keyboard shortcuts", run: () => (location.hash = "#/about") },
    { label: "Hand off this session", hint: "continue in another CLI, or export", run: () => window.handoff?.open() },
    { label: "Copy handoff brief", hint: "for pasting into another CLI", run: () => window.handoff?.copy() },
    { label: "Show or hide the left panel", hint: "Ctrl+B", run: () => window.companionApp?.toggleSidebar() },
    { label: "Show or hide Files, Review and Apps", hint: "Ctrl+Alt+B", run: () => $("wb-toggle")?.click() },
  ];

  async function loadCommands() {
    const id = window.companionApp?.selectedId();
    state.commandsFor = id;
    state.commands = [];
    if (!id) return;
    try {
      const res = await fetch(`/api/commands?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = res.ok ? await res.json() : { commands: [] };
      if (state.commandsFor !== id) return;
      state.commands = data.commands ?? [];
    } catch {
      state.commands = [];
    }
  }

  function buildItems() {
    const id = window.companionApp?.selectedId();
    const src = id ? cliSources.forId(id) : null;
    const items = [];
    for (const c of state.commands) {
      items.push({ group: src ? `${src.label} commands` : "Commands", kind: "command", label: `/${c.name}`, hint: c.description ?? "", text: `/${c.name}` });
    }
    const sessions = (window.companionApp?.sessions() ?? []).sort((a, b) => b.active - a.active || b.at - a.at);
    for (const s of sessions) {
      items.push({
        group: "Sessions",
        kind: "session",
        label: s.title,
        hint: `${cliSources.get(s.src).label} · ${s.ws}${s.active ? " · running" : ""}`,
        id: s.id,
        src: s.src,
      });
    }
    for (const p of window.companionPrompts?.forPalette() ?? []) {
      items.push({ group: "Prompts", kind: "action", label: p.label, hint: p.hint, run: () => window.companionPrompts.insert(p.text) });
    }
    for (const a of ACTIONS) items.push({ group: "Companion", kind: "action", ...a });
    state.items = items;
  }

  /** Every word must match the label or hint; a label match ranks first. */
  function filter(query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
      // Nothing typed: commands, then the running sessions, then actions.
      return state.items.filter((it) => it.kind !== "session" || it.hint.endsWith("running")).slice(0, 80);
    }
    const scored = [];
    for (const it of state.items) {
      const label = it.label.toLowerCase();
      const hay = `${label} ${String(it.hint).toLowerCase()} ${it.group.toLowerCase()}`;
      if (!words.every((w) => hay.includes(w))) continue;
      const score = (label.startsWith(words[0]) || label.startsWith(`/${words[0]}`) ? 0 : label.includes(words[0]) ? 1 : 2);
      scored.push({ it, score });
    }
    // Keep the groups together, best match first inside each.
    const order = ["command", "session", "action"];
    scored.sort((a, b) => a.score - b.score || order.indexOf(a.it.kind) - order.indexOf(b.it.kind));
    const byKind = order.flatMap((k) => scored.filter((x) => x.it.kind === k));
    const best = scored.length ? scored[0].it.kind : "command";
    return [...byKind.filter((x) => x.it.kind === best), ...byKind.filter((x) => x.it.kind !== best)].map((x) => x.it).slice(0, 80);
  }

  function render() {
    state.shown = filter(input.value);
    state.index = Math.min(state.index, Math.max(0, state.shown.length - 1));
    let group = "";
    listEl.innerHTML = state.shown.length
      ? state.shown
          .map((it, i) => {
            const head = it.group !== group ? `<div class="palette-group">${esc((group = it.group))}</div>` : "";
            const icon = it.kind === "session" ? `<i class="sw ${esc(it.src)}" aria-hidden="true"></i>` : it.kind === "command" ? `<span class="palette-icon">/</span>` : `<span class="palette-icon">›</span>`;
            return `${head}<div class="palette-item${i === state.index ? " on" : ""}" role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === state.index}">
              ${icon}<span class="palette-label">${esc(it.label)}</span><span class="palette-hint">${esc(it.hint ?? "")}</span></div>`;
          })
          .join("")
      : `<p class="palette-empty">${state.commandsFor ? "Nothing matches." : "Nothing matches. Pick a session to see its CLI's commands."}</p>`;
    input.setAttribute("aria-activedescendant", state.shown.length ? `pal-${state.index}` : "");
    listEl.querySelector(".palette-item.on")?.scrollIntoView({ block: "nearest" });
    const cur = state.shown[state.index];
    // Ctrl+Enter only means something for a CLI the page can type into (Pi).
    root.querySelector(".palette-send-hint").hidden = !(cur?.kind === "command" && state.commandsFor && cliSources.forId(state.commandsFor).canType);
  }

  async function run(item, { send = false } = {}) {
    if (!item) return;
    if (item.kind === "command") {
      noteEl.textContent = "…";
      const result = await window.composer?.runCommand(item.text, { send });
      if (result?.ok) close();
      else noteEl.textContent = result?.message ?? "Couldn't run it.";
      return;
    }
    close();
    if (item.kind === "session") window.openSession?.(item.id);
    else item.run();
  }

  async function open() {
    if (!root.hidden) return;
    state.returnFocus = document.activeElement;
    root.hidden = false;
    input.value = "";
    noteEl.textContent = "";
    state.index = 0;
    buildItems();
    render();
    input.focus();
    await loadCommands();
    if (root.hidden) return;
    buildItems();
    render();
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    if (state.returnFocus?.isConnected) state.returnFocus.focus();
  }

  input.addEventListener("input", () => {
    state.index = 0;
    noteEl.textContent = "";
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const n = state.shown.length;
      if (n) state.index = (state.index + (event.key === "ArrowDown" ? 1 : -1) + n) % n;
      render();
    } else if (event.key === "Enter") {
      event.preventDefault();
      void run(state.shown[state.index], { send: event.ctrlKey || event.metaKey });
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      event.preventDefault(); // keep focus in the palette
    }
  });
  listEl.addEventListener("mousemove", (event) => {
    const row = event.target.closest(".palette-item");
    if (row && Number(row.dataset.i) !== state.index) {
      state.index = Number(row.dataset.i);
      for (const el of listEl.querySelectorAll(".palette-item")) {
        const on = Number(el.dataset.i) === state.index;
        el.classList.toggle("on", on);
        el.setAttribute("aria-selected", String(on));
      }
    }
  });
  listEl.addEventListener("click", (event) => {
    const row = event.target.closest(".palette-item");
    if (row) void run(state.shown[Number(row.dataset.i)], { send: event.ctrlKey || event.metaKey });
  });
  root.addEventListener("mousedown", (event) => {
    if (event.target === root) close();
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (root.hidden) void open();
      else close();
    }
  });

  $("palette-open")?.addEventListener("click", () => void open());

  window.commandPalette = { open, close };
})();
