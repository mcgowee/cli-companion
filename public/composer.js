// Bottom composer: write or collect text here, then put it into the running Pi's input box
// (the bridge extension pastes it there; you press Enter in the terminal).
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

  const state = {
    session: null, // live session object from /events, or null
    selectedId: null,
    pending: new Map(), // cmdId -> sent text
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
    renderTarget();
  });

  function autoSize() {
    textEl.style.height = "auto";
    textEl.style.height = `${Math.min(textEl.scrollHeight + 2, Math.round(window.innerHeight * 0.45))}px`;
  }

  function setCollapsed(collapsed) {
    composerEl.classList.toggle("collapsed", collapsed);
    $("composer-toggle").setAttribute("aria-expanded", String(!collapsed));
    savePref("pi-companion.composerCollapsed", collapsed);
    if (!collapsed) autoSize();
  }
  $("composer-toggle").addEventListener("click", () => setCollapsed(!composerEl.classList.contains("collapsed")));
  setCollapsed(loadPref("pi-companion.composerCollapsed", false) === true);

  /* ── can we send? ────────────────────────────────────── */

  function blocker() {
    const s = state.session;
    if (!state.selectedId) return "Pick a session first.";
    if (!s || s.ended) return "This is a saved session. Open it in Pi (pi -r) to send to it.";
    if (s.mode && s.mode !== "tui") return "This Pi has no terminal input box (pi-gui or RPC). Use Copy instead.";
    if (s.listening === false) return "Pi isn't listening yet. Run /reload in that Pi to load the latest companion extension.";
    return undefined;
  }

  function renderTarget() {
    const s = state.session;
    const name = s ? s.name && !["New thread", "New session"].includes(s.name) ? s.name : (s.cwd ?? "").split(/[\\/]/).pop() : "";
    const why = blocker();
    targetEl.textContent = why ? "" : `→ ${name || "Pi"}`;
    sendEl.disabled = Boolean(why) || !textEl.value.trim() || state.pending.size > 0;
    sendEl.title = why ?? "Put this text in Pi's input box (Ctrl+Enter)";
    if (why && !state.pending.size && !statusEl.dataset.sticky) setStatus(why, "muted");
    else if (!why && statusEl.dataset.kind === "muted") setStatus("");
  }

  function setStatus(text, kind = "", sticky = false) {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
    if (sticky) statusEl.dataset.sticky = "1";
    else delete statusEl.dataset.sticky;
  }

  /* ── send ────────────────────────────────────────────── */

  async function send() {
    if (blocker() || !textEl.value.trim() || state.pending.size) return;
    const text = textEl.value;
    setStatus("Sending to Pi…", "busy");
    sendEl.disabled = true;
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-companion-page": "1" },
        body: JSON.stringify({ id: state.selectedId, text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      state.pending.set(body.cmdId, text);
    } catch (error) {
      setStatus(`Not sent: ${error.message}`, "error", true);
      renderTarget();
    }
  }

  sendEl.addEventListener("click", send);
  textEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  $("composer-clear").addEventListener("click", () => {
    if (textEl.value) state.lastSent = textEl.value;
    textEl.value = "";
    savePref("pi-companion.draft", "");
    autoSize();
    setStatus(state.lastSent ? "Cleared." : "", "", false);
    renderTarget();
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
    renderTarget();
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
      renderTarget();
    },
    /** The bridge reported back on a send. */
    delivered({ cmdId, ok, error }) {
      const text = state.pending.get(cmdId);
      if (text === undefined) return;
      state.pending.delete(cmdId);
      if (ok) {
        state.lastSent = text;
        if (textEl.value === text) {
          textEl.value = "";
          savePref("pi-companion.draft", "");
          autoSize();
        }
        statusEl.innerHTML = `In Pi's input. Press Enter in the terminal to send it. <button type="button" class="link" data-restore>Bring text back</button>`;
        statusEl.dataset.kind = "ok";
        statusEl.dataset.sticky = "1";
      } else {
        setStatus(`Not delivered: ${error || "unknown error"}`, "error", true);
      }
      renderTarget();
    },
  };

  autoSize();
  renderTarget();
})();
