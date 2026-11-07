// Bottom composer: write or collect text and put it into the running Pi's input box (you press
// Enter in the terminal; Ctrl+Shift+Enter also sends it). The bridge extension does the work
// inside Pi: paste — add text to the input box; submit — send the input box, like Enter.
// For a CLI the page can't type into (Claude Code, …) it copies the text instead.
// Also handles every Copy / Add button on the page.
(function () {
  const $ = (id) => document.getElementById(id);
  const textEl = $("composer-text");
  const sendEl = $("composer-send");
  const statusEl = $("composer-status");
  const targetEl = $("composer-target");
  const composerEl = $("composer");

  /** id -> raw text for messages (filled by app.js when it renders them). */
  const textRefs = new Map();

  const REPLY_TIMEOUT_MS = 30_000;

  const state = {
    session: null, // live session object from /events, or null
    selectedId: null,
    pending: new Map(), // cmdId -> { type, text, resolve }
    lastSent: "",
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
      // ignore
    }
  }

  /* ── draft, size, collapse ───────────────────────────── */

  // One draft per session (id -> { text, at }), so text typed for one session doesn't follow you
  // to another. "" holds the draft while no session is selected.
  const DRAFTS_KEY = "pi-companion.drafts";
  const MAX_DRAFTS = 100;
  function saveDraft(text, id = state.selectedId ?? "") {
    const drafts = loadPref(DRAFTS_KEY, {});
    if (text) drafts[id] = { text, at: Date.now() };
    else delete drafts[id];
    // Keep the newest ones only.
    const ids = Object.keys(drafts).sort((a, b) => drafts[b].at - drafts[a].at);
    for (const old of ids.slice(MAX_DRAFTS)) delete drafts[old];
    savePref(DRAFTS_KEY, drafts);
  }
  function loadDraft(id) {
    return loadPref(DRAFTS_KEY, {})[id ?? ""]?.text ?? "";
  }
  // Before drafts were per session there was one shared draft: it goes to the first session shown.
  let legacyDraft = loadPref("pi-companion.draft", "");

  textEl.value = loadDraft("");
  let draftTimer;
  textEl.addEventListener("input", () => {
    clearTimeout(draftTimer);
    const id = state.selectedId ?? "";
    draftTimer = setTimeout(() => saveDraft(textEl.value, id), 300);
    autoSize();
    renderControls();
  });

  // Where the browser can size the box to its text (field-sizing), let it: setting the height by
  // script makes the whole transcript lay out again on every keystroke, which lags long sessions.
  const cssSized = typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content");
  function autoSize() {
    if (cssSized) return;
    textEl.style.height = "auto";
    textEl.style.height = `${Math.min(textEl.scrollHeight + 2, Math.round(window.innerHeight * 0.4))}px`;
  }

  function setCollapsed(collapsed) {
    composerEl.classList.toggle("collapsed", collapsed);
    $("composer-toggle").setAttribute("aria-expanded", String(!collapsed));
    savePref("pi-companion.composerCollapsed", collapsed);
    if (!collapsed) autoSize();
  }
  $("composer-toggle").addEventListener("click", () => setCollapsed(!composerEl.classList.contains("collapsed")));
  setCollapsed(loadPref("pi-companion.composerCollapsed", false) === true);

  /* ── can we talk to this Pi? ─────────────────────────── */

  function blocker() {
    const s = state.session;
    if (!state.selectedId) return "Pick a session first.";
    // CLIs the page can't type into (Claude Code, …): the composer copies instead. Any
    // session, running or saved, is fine.
    if (copyOnly()) return undefined;
    if (!s || s.ended) return "This is a saved session. Open it in Pi (pi -r) to send to it.";
    if (s.mode && s.mode !== "tui") return "This Pi has no terminal input box (pi-gui or RPC). Use Copy instead.";
    if (s.listening === false) return "Pi isn't listening yet. Run /reload in that Pi to load the latest companion extension.";
    return undefined;
  }

  function busy() {
    return state.pending.size > 0;
  }

  /** The selected session's CLI. */
  function src() {
    return cliSources.forId(state.selectedId);
  }

  /** Can't type into this CLI's prompt, so the button copies the text instead. */
  function copyOnly() {
    return Boolean(state.selectedId) && !src().canType;
  }

  const sendLabelEl = sendEl.firstChild; // the text node before <kbd>

  function renderControls() {
    const s = state.session;
    const name = s ? (s.name && !["New thread", "New session"].includes(s.name) ? s.name : (s.cwd ?? "").split(/[\\/]/).pop()) : "";
    const why = blocker();
    $("composer-title").textContent = !state.selectedId ? "Composer" : `To ${src().label}`;
    targetEl.textContent = why || copyOnly() ? "" : `→ ${name || "Pi"}`;
    sendEl.disabled = Boolean(why) || !textEl.value.trim() || busy();
    sendLabelEl.textContent = copyOnly() ? `Copy for ${src().assistant} ` : "Put in Pi's input ";
    sendEl.title =
      why ??
      (copyOnly()
        ? `Copy this text, then paste it into ${src().label} with Ctrl+V or right-click (Ctrl+Enter)`
        : "Put this text in Pi's input box (Ctrl+Enter). Ctrl+Shift+Enter also presses Enter for you.");
    if (why && !busy() && !statusEl.dataset.sticky) setStatus(why, "muted");
    else if (!why && statusEl.dataset.kind === "muted") setStatus("");
  }

  function setStatus(text, kind = "", sticky = false) {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
    if (sticky) statusEl.dataset.sticky = "1";
    else delete statusEl.dataset.sticky;
  }

  /* ── commands to Pi ──────────────────────────────────── */

  /**
   * Send one command to the selected Pi and wait for its report.
   * Resolves to { ok, error, detail }; never rejects.
   */
  function command(type, text) {
    const sessionId = state.selectedId;
    // Register before the request: Pi can answer before the server's response arrives.
    const cmdId = crypto.randomUUID();
    return new Promise((resolve) => {
      state.pending.set(cmdId, { type, text, sessionId, resolve });
      renderControls();
      setTimeout(() => {
        if (!state.pending.has(cmdId)) return;
        state.pending.delete(cmdId);
        resolve({ ok: false, error: "No reply from Pi. Check the terminal." });
        renderControls();
      }, REPLY_TIMEOUT_MS);
      fetch("/api/send", {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-companion-page": "1" },
        body: JSON.stringify({ id: sessionId, type, text, cmdId }),
      })
        .then(async (res) => {
          if (res.ok) return;
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        })
        .catch((error) => {
          if (!state.pending.has(cmdId)) return;
          state.pending.delete(cmdId);
          resolve({ ok: false, error: error.message });
          renderControls();
        });
    });
  }

  /** Put the composer text in Pi's input box; with `andEnter`, also send it. */
  async function put(andEnter = false) {
    if (blocker() || !textEl.value.trim() || busy()) return;
    if (copyOnly()) {
      const text = textEl.value;
      if (!(await copyText(text))) {
        setStatus("Copy failed. Select the text and press Ctrl+C.", "error", true);
        return;
      }
      state.lastSent = text;
      if (textEl.value === text) {
        textEl.value = "";
        saveDraft("");
        autoSize();
      }
      statusEl.innerHTML = `Copied ✓ Paste it into ${window.escapeHtml(src().label)} (Ctrl+V or right-click), then press Enter. <button type="button" class="link" data-restore>Bring text back</button>`;
      statusEl.dataset.kind = "ok";
      statusEl.dataset.sticky = "1";
      renderControls();
      return;
    }
    const text = textEl.value;
    setStatus("Putting it in Pi's input…", "busy");
    const result = await command("paste", text);
    if (!result.ok) {
      setStatus(`Not delivered: ${result.error || "unknown error"}`, "error", true);
      renderControls();
      return;
    }
    state.lastSent = text;
    if (textEl.value === text) {
      textEl.value = "";
      saveDraft("");
      autoSize();
    }
    if (andEnter) {
      await enter();
      return;
    }
    statusEl.innerHTML = `In Pi's input ✓ Press Enter in the terminal to send it. <button type="button" class="link" data-restore>Bring text back</button>`;
    statusEl.dataset.kind = "ok";
    statusEl.dataset.sticky = "1";
    renderControls();
  }

  /** Send what is in Pi's input box, as if Enter was pressed in the terminal. */
  async function enter() {
    if (blocker() || busy()) return;
    setStatus("Sending to Pi…", "busy");
    const result = await command("submit");
    if (result.ok) {
      setStatus(result.detail === "queued" ? "Sent. Pi is busy, so it will read it when it finishes." : "Sent to Pi ✓", "ok", true);
    } else {
      setStatus(`Not sent: ${result.error || "unknown error"}`, "error", true);
    }
    renderControls();
  }

  /* ── "/" command lookup ───────────────────────────────── */

  // Typing "/" at the start of a line lists the selected CLI's slash commands; ↑/↓ to move,
  // Enter or Tab to insert, Esc to close. The list comes from /api/commands (cached ~30 s).
  const menuEl = $("slash-menu");
  const slash = { cache: new Map(), items: [], index: 0, start: -1 };

  async function commandsFor(id) {
    const hit = slash.cache.get(id);
    if (hit && Date.now() - hit.at < 30_000) return hit.commands;
    try {
      const res = await fetch(`/api/commands?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const commands = res.ok ? ((await res.json()).commands ?? []) : [];
      slash.cache.set(id, { at: Date.now(), commands });
      return commands;
    } catch {
      return hit?.commands ?? [];
    }
  }

  /** The "/word" being typed at the start of the caret's line, or undefined. */
  function slashQuery() {
    const caret = textEl.selectionStart;
    if (caret !== textEl.selectionEnd) return undefined;
    const lineStart = textEl.value.lastIndexOf("\n", caret - 1) + 1;
    const typed = textEl.value.slice(lineStart, caret);
    return /^\/[\w:.-]*$/.test(typed) ? { start: lineStart, query: typed.slice(1).toLowerCase() } : undefined;
  }

  function closeMenu() {
    menuEl.hidden = true;
    slash.items = [];
  }

  async function updateMenu() {
    const q = state.selectedId ? slashQuery() : undefined;
    if (!q) return closeMenu();
    const id = state.selectedId;
    const all = await commandsFor(id);
    const again = slashQuery();
    if (id !== state.selectedId || !again || again.query !== q.query) return; // typed on meanwhile
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(q.query));
    const contains = all.filter((c) => !c.name.toLowerCase().startsWith(q.query) && c.name.toLowerCase().includes(q.query));
    slash.items = [...starts, ...contains].slice(0, 50);
    slash.start = q.start;
    slash.index = 0;
    if (!slash.items.length) return closeMenu();
    renderMenu();
  }

  function renderMenu() {
    menuEl.innerHTML = slash.items
      .map(
        (c, i) => `<div class="slash-item${i === slash.index ? " selected" : ""}" role="option" data-i="${i}" aria-selected="${i === slash.index}">
          <span class="slash-name">/${window.escapeHtml(c.name)}</span>
          <span class="slash-desc">${window.escapeHtml(c.description || "")}</span>
          ${c.source && c.source !== "builtin" ? `<span class="slash-src">${window.escapeHtml(c.source)}</span>` : ""}
        </div>`,
      )
      .join("");
    menuEl.hidden = false;
    menuEl.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }

  function pickCommand(i) {
    const c = slash.items[i];
    if (!c) return;
    const caret = textEl.selectionStart;
    const before = textEl.value.slice(0, slash.start);
    const after = textEl.value.slice(caret);
    const insertText = `/${c.name} `;
    textEl.value = `${before}${insertText}${after.replace(/^ /, "")}`;
    const pos = before.length + insertText.length;
    textEl.setSelectionRange(pos, pos);
    closeMenu();
    saveDraft(textEl.value);
    autoSize();
    renderControls();
    textEl.focus();
  }

  textEl.addEventListener("input", () => void updateMenu());
  textEl.addEventListener("click", () => void updateMenu());
  textEl.addEventListener("blur", () => setTimeout(closeMenu, 150));
  menuEl.addEventListener("mousedown", (event) => {
    const item = event.target.closest(".slash-item");
    if (!item) return;
    event.preventDefault(); // keep focus in the textarea
    pickCommand(Number(item.dataset.i));
  });

  sendEl.addEventListener("click", () => put(false));
  textEl.addEventListener("keydown", (event) => {
    if (!menuEl.hidden && slash.items.length && !event.ctrlKey && !event.metaKey) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const n = slash.items.length;
        slash.index = (slash.index + (event.key === "ArrowDown" ? 1 : n - 1)) % n;
        renderMenu();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pickCommand(slash.index);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      put(event.shiftKey);
    }
  });
  $("composer-clear").addEventListener("click", () => {
    if (textEl.value) state.lastSent = textEl.value;
    textEl.value = "";
    saveDraft("");
    autoSize();
    setStatus(state.lastSent ? "Cleared." : "", "", false);
    renderControls();
    textEl.focus();
  });

  statusEl.addEventListener("click", (event) => {
    if (event.target.matches("[data-restore]")) {
      insert(state.lastSent);
      setStatus("");
    }
  });

  /* ── Copy / Add buttons anywhere on the page ─────────── */

  function textForButton(button) {
    const ref = button.dataset.ref;
    if (ref) return textRefs.get(ref) ?? "";
    const wrap = button.closest(".code-wrap");
    if (wrap) return wrap.querySelector("pre")?.textContent ?? "";
    return button.dataset.text ?? "";
  }

  function fenced(text, lang = "") {
    const fence = text.includes("```") ? "````" : "```";
    return `${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}`;
  }

  /** What "Add" puts in the composer for a button: code is fenced, messages go in as written. */
  function addTextForButton(button) {
    const text = textForButton(button);
    if (button.dataset.ref) return text;
    const wrap = button.closest(".code-wrap");
    const lang = wrap?.dataset.lang ?? button.dataset.lang ?? "";
    const label = button.dataset.label ? `${button.dataset.label}\n` : "";
    return `${label}${fenced(text, lang)}`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    }
  }

  function flash(button, label) {
    const original = button.dataset.original ?? button.textContent;
    button.dataset.original = original;
    button.textContent = label;
    button.classList.add("done");
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove("done");
    }, 1200);
  }

  /** Insert text at the cursor (or the end), on its own paragraph. */
  function insert(text) {
    if (!text) return;
    setCollapsed(false);
    const value = textEl.value;
    const start = document.activeElement === textEl ? textEl.selectionStart : value.length;
    const end = document.activeElement === textEl ? textEl.selectionEnd : value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const pre = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
    const post = after && !after.startsWith("\n") ? "\n\n" : "";
    textEl.value = `${before}${pre}${text}${post}${after}`;
    const caret = before.length + pre.length + text.length;
    textEl.focus();
    textEl.setSelectionRange(caret, caret);
    saveDraft(textEl.value);
    autoSize();
    renderControls();
  }

  document.addEventListener("click", async (event) => {
    const copyBtn = event.target.closest("[data-copy]");
    if (copyBtn) {
      event.preventDefault();
      event.stopPropagation();
      flash(copyBtn, (await copyText(textForButton(copyBtn))) ? "Copied" : "Copy failed");
      return;
    }
    const addBtn = event.target.closest("[data-add]");
    if (addBtn) {
      event.preventDefault();
      event.stopPropagation();
      insert(addTextForButton(addBtn));
      flash(addBtn, "Added");
    }
  });

  /* ── hooks for app.js ────────────────────────────────── */

  window.composer = {
    textRefs,
    insert,
    fenced,
    /** The selected session changed or its live state updated. */
    update({ selectedId, session }) {
      if (selectedId !== state.selectedId) {
        delete statusEl.dataset.sticky;
        // Keep the text with the session it was typed for, and show the new session's own draft.
        clearTimeout(draftTimer);
        saveDraft(textEl.value, state.selectedId ?? "");
        state.selectedId = selectedId;
        closeMenu?.();
        let draft = loadDraft(selectedId);
        if (legacyDraft && selectedId) {
          draft = draft ? `${draft}

${legacyDraft}` : legacyDraft;
          legacyDraft = "";
          saveDraft(draft, selectedId);
          try {
            localStorage.removeItem("pi-companion.draft");
          } catch {
            // ignore
          }
        }
        textEl.value = draft;
        state.lastSent = "";
        setStatus(draft ? "Draft for this session." : "", "", false);
        autoSize();
      }
      state.selectedId = selectedId;
      state.session = session ?? null;
      renderControls();
    },
    /** The bridge reported back on a command. */
    delivered(msg) {
      const pending = state.pending.get(msg.cmdId);
      if (!pending) return;
      state.pending.delete(msg.cmdId);
      pending.resolve({ ok: msg.ok, error: msg.error, detail: msg.detail });
    },
  };

  autoSize();
  renderControls();
})();
