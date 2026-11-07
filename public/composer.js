// Bottom composer: write or collect text and put it into the running Pi's input box (you press
// Enter in the terminal; Ctrl+Shift+Enter also sends it). The bridge extension does the work
// inside Pi: paste — add text to the input box; submit — send the input box, like Enter.
// For a Claude Code session it copies the text instead (nothing can type into Claude's prompt).
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

  textEl.value = loadPref("pi-companion.draft", "");
  let draftTimer;
  textEl.addEventListener("input", () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => savePref("pi-companion.draft", textEl.value), 300);
    autoSize();
    renderControls();
  });

  function autoSize() {
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
    // Claude Code: nothing can type into its prompt, so the composer copies instead. Any
    // Claude session, running or saved, is fine.
    if (isClaude()) return undefined;
    if (!s || s.ended) return "This is a saved session. Open it in Pi (pi -r) to send to it.";
    if (s.mode && s.mode !== "tui") return "This Pi has no terminal input box (pi-gui or RPC). Use Copy instead.";
    if (s.listening === false) return "Pi isn't listening yet. Run /reload in that Pi to load the latest companion extension.";
    return undefined;
  }

  function busy() {
    return state.pending.size > 0;
  }

  function isClaude() {
    return typeof state.selectedId === "string" && state.selectedId.startsWith("claude:");
  }

  const sendLabelEl = sendEl.firstChild; // the text node before <kbd>

  function renderControls() {
    const s = state.session;
    const name = s ? (s.name && !["New thread", "New session"].includes(s.name) ? s.name : (s.cwd ?? "").split(/[\\/]/).pop()) : "";
    const why = blocker();
    targetEl.textContent = why || isClaude() ? "" : `→ ${name || "Pi"}`;
    sendEl.disabled = Boolean(why) || !textEl.value.trim() || busy();
    sendLabelEl.textContent = isClaude() ? "Copy for Claude " : "Put in Pi's input ";
    sendEl.title =
      why ??
      (isClaude()
        ? "Copy this text, then paste it into Claude Code with Ctrl+V or right-click (Ctrl+Enter)"
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
    if (isClaude()) {
      // The draft is kept, so it can be copied again.
      const ok = await copyText(textEl.value);
      setStatus(
        ok ? "Copied ✓ Click in Claude Code, paste (Ctrl+V or right-click), then press Enter." : "Copy failed. Select the text and press Ctrl+C.",
        ok ? "ok" : "error",
        true,
      );
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
      savePref("pi-companion.draft", "");
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

  sendEl.addEventListener("click", () => put(false));
  textEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      put(event.shiftKey);
    }
  });
  $("composer-clear").addEventListener("click", () => {
    if (textEl.value) state.lastSent = textEl.value;
    textEl.value = "";
    savePref("pi-companion.draft", "");
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
    savePref("pi-companion.draft", textEl.value);
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
      if (selectedId !== state.selectedId) delete statusEl.dataset.sticky;
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
