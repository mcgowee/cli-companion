// Right panel → Terminal tab (server/runner.mjs): run a command in the selected session's folder
// and watch its output, or open it in a real terminal window. Code blocks in replies get a
// "Terminal" button that only puts the command at the prompt: nothing runs until you press Enter
// (or ▶). Off unless Settings → Terminal → "Let the companion run commands" is on; never on the phone.
// Looks like pi-gui's terminal: a thin toolbar, then one scrolling screen of prompts and output.
(function () {
  const $ = (id) => document.getElementById(id);
  const el = $("wb-terminal");
  const SHELL_LANGS = ["powershell", "ps", "ps1", "pwsh", "shell", "sh", "bash", "zsh", "console", "cmd", "bat", "batch", "terminal", "shell-session"];
  const INTERACTIVE = /^(?:&\s*)?["']?(?:[\w.:\\/-]*[\\/])?(codex|pi|claude|ssh|vim|nvim|nano|less|more|top|htop|psql|mysql|sqlite3|wsl)(?:\.(?:cmd|exe|bat|ps1))?["']?(?:\s+(?!exec\b|list\b|ls\b|--version\b|-v\b|--help\b|-h\b|install\b|update\b|login\b)|$)|^(python3?|py|node|pwsh|powershell|bash|sh|zsh|cmd)(\.exe)?$/i;
  const SHOW_RUNS = 6; // earlier runs in this folder shown above the prompt
  const ICONS = {
    run: `<svg viewBox="0 0 24 24"><path d="M7 5l11 7-11 7z"/></svg>`,
    stop: `<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
    open: `<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-8 8M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>`,
    clear: `<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>`,
  };

  const t = {
    sessionId: null,
    info: null, // { enabled, cwd, platform, runs }
    blocks: [], // runs on screen, oldest first: { runId, command, status, exitCode, output, next, startedAt, endedAt, error, trimmed }
    clearedAt: 0, // Clear hides runs started before this (they stay on the server)
    draft: "",
    back: -1, // ↑/↓ position in the command history (-1 = the draft)
    saved: "", // the draft while stepping through history
    timer: 0,
    error: "",
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // eslint-disable-next-line no-control-regex
  const plain = (s) => String(s ?? "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r(?!\n)/g, "");
  const onPhone = () => window.companionRemote?.you?.remote === true;
  const enabled = () => window.companionSettings?.runCommands === true && !onPhone();
  const running = () => t.blocks.find((b) => b.status === "running");
  const isInteractive = (s) => INTERACTIVE.test(String(s).trim().split("\n")[0].trim());

  function call(path, { method = "GET", body, params } = {}) {
    const q = params ? `?${new URLSearchParams(params)}` : "";
    return fetch(`${path}${q}`, {
      method,
      cache: "no-store",
      headers: { "x-pi-companion-page": "1", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (res) => {
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      return out;
    });
  }

  /* ── code block buttons ─────────────────────────────── */

  function applyEnabled() {
    document.documentElement.classList.toggle("can-run", enabled());
  }
  window.addEventListener("prefs-changed", () => {
    applyEnabled();
    if (!el.hidden) void refresh(t.sessionId);
  });
  window.addEventListener("remote-ready", applyEnabled);
  applyEnabled();

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-term]");
    if (!button) return;
    event.preventDefault();
    const code = button.closest(".code-wrap")?.querySelector("pre code")?.textContent ?? "";
    put(code.replace(/\n+$/, ""));
  });

  /** Put a command at the prompt (never runs it) and show the tab. */
  function put(command) {
    t.draft = command;
    t.back = -1;
    window.workbench?.openTool("terminal");
    render();
    focusPrompt();
  }

  /* ── tab ─────────────────────────────────────────────── */

  async function refresh(sessionId) {
    if (sessionId !== t.sessionId) {
      t.sessionId = sessionId;
      t.blocks = [];
      t.clearedAt = 0;
      t.back = -1;
      t.error = "";
      t.info = null;
      clearTimeout(t.timer);
    }
    if (!sessionId || !enabled()) {
      t.info = null;
      render();
      return;
    }
    try {
      t.info = await call("/api/runs", { params: { id: sessionId } });
      t.error = "";
      await loadBlocks();
    } catch (error) {
      t.info = null;
      t.error = error.message;
    }
    render();
    poll();
  }

  /** Fill the screen with this folder's recent runs (output fetched once per run). */
  async function loadBlocks() {
    const have = new Map(t.blocks.map((b) => [b.runId, b]));
    const wanted = (t.info?.runs ?? [])
      .filter((r) => r.startedAt >= t.clearedAt)
      .slice(0, SHOW_RUNS)
      .reverse();
    t.blocks = await Promise.all(
      wanted.map(async (r) => {
        const old = have.get(r.runId);
        if (old && (old.status !== "running" || r.status === "running")) return old;
        return call("/api/run", { params: { run: r.runId, from: 0 } }).catch(() => ({ ...r, output: "" }));
      }),
    );
  }

  function prompt() {
    const cwd = t.info?.cwd ?? "";
    if (t.info?.platform !== "win32") return `${cwd.split(/[\\/]/).filter(Boolean).pop() ?? ""} $`;
    // Like PowerShell's prompt; a very long folder keeps its last part.
    return `PS ${cwd.length > 42 ? `…${cwd.slice(-40)}` : cwd}>`;
  }

  function took(run) {
    const secs = ((run.endedAt ?? Date.now()) - run.startedAt) / 1000;
    return secs < 60 ? `${secs.toFixed(1)} s` : `${Math.floor(secs / 60)} min ${Math.round(secs % 60)} s`;
  }

  function endLine(run) {
    if (run.status === "running") return `<div class="term-end running"><span class="term-caret"></span> running ${took(run)} · Ctrl+C stops</div>`;
    if (run.status === "stopped") return `<div class="term-end stopped">^C stopped after ${took(run)}</div>`;
    if (run.error) return `<div class="term-end failed">${esc(run.error)}</div>`;
    if (run.exitCode === 0) return `<div class="term-end ok">✓ ${took(run)}</div>`;
    return `<div class="term-end failed">✗ exit code ${esc(run.exitCode)} · ${took(run)}</div>`;
  }

  function blockHtml(run) {
    const out = plain(run.output);
    return `<div class="term-block" data-run="${esc(run.runId)}">
      <div class="term-line"><span class="term-ps">${esc(prompt())}</span><span class="term-in">${esc(run.command)}</span></div>
      ${run.trimmed ? `<div class="term-end">… earlier output trimmed</div>` : ""}
      ${out ? `<pre class="term-out">${esc(out)}</pre>` : ""}
      ${endLine(run)}
    </div>`;
  }

  function render() {
    if (!el || el.hidden) return;
    if (onPhone()) {
      el.innerHTML = `<p class="wb-empty">The Terminal tab works on the computer only.</p>`;
      return;
    }
    if (!enabled()) {
      el.innerHTML = `<div class="term-off">
        <p><b>Run commands here</b>: type a command, or click <b>Terminal</b> on a code block in a reply, then press
        <b>Enter</b>. It runs in this session's folder (PowerShell on Windows) and its output shows here. Nothing ever runs
        by itself.</p>
        <p>It's off. Turn it on in <a href="#/settings">Settings → Terminal</a>.</p></div>`;
      return;
    }
    if (!t.sessionId) {
      el.innerHTML = `<p class="wb-empty">Pick a session: commands run in its folder.</p>`;
      return;
    }
    const busy = Boolean(running());
    const has = Boolean(t.draft.trim());
    const shell = t.info?.platform === "win32" ? "PowerShell" : "Shell";
    const cwd = t.info?.cwd ?? "";
    const scroller = $("term-screen");
    const atBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    el.innerHTML = `<div class="term">
      <div class="term-bar">
        <span class="term-tab"><span class="term-dot${busy ? " running" : ""}"></span>${shell}</span>
        <span class="term-cwd" title="${esc(cwd)}"><bdi>${esc(cwd)}</bdi></span>
        <span class="term-tools">
          <button class="icon-btn small term-tool" type="button" id="term-run" title="Run (Enter)" aria-label="Run" ${has && !busy ? "" : "disabled"}>${ICONS.run}</button>
          <button class="icon-btn small term-tool" type="button" id="term-stop" title="Stop (Ctrl+C)" aria-label="Stop" ${busy ? "" : "disabled"}>${ICONS.stop}</button>
          <button class="icon-btn small term-tool" type="button" id="term-open" title="Open in a terminal window (for programs you type into)" aria-label="Open in terminal" ${has ? "" : "disabled"}>${ICONS.open}</button>
          <button class="icon-btn small term-tool" type="button" id="term-clear" title="Clear the screen" aria-label="Clear" ${t.blocks.length ? "" : "disabled"}>${ICONS.clear}</button>
        </span>
      </div>
      <div class="term-screen" id="term-screen">
        ${t.blocks.length ? "" : `<div class="term-end">Commands run in this folder. Enter runs · Shift+Enter new line · ↑ ↓ earlier commands. Nothing runs by itself.</div>`}
        ${t.blocks.map(blockHtml).join("")}
        ${t.error ? `<div class="term-end failed">${esc(t.error)}</div>` : ""}
        ${
          isInteractive(t.draft)
            ? `<div class="term-end warn">This looks like a program you type into while it runs. It can't take input here: use Open in terminal (↗ above).</div>`
            : ""
        }
        <div class="term-prompt${busy ? " busy" : ""}">
          <span class="term-ps">${esc(prompt())}</span>
          <textarea id="term-cmd" class="term-cmd" rows="1" style="text-indent: ${[...prompt()].length + 1}ch" spellcheck="false" autocomplete="off" autocapitalize="off"
            aria-label="Command" placeholder="${busy ? "waiting for the command above…" : ""}">${esc(t.draft)}</textarea>
        </div>
      </div>
    </div>`;
    wire();
    const screen = $("term-screen");
    if (atBottom) screen.scrollTop = screen.scrollHeight;
  }

  function grow(box) {
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }

  function focusPrompt() {
    const box = $("term-cmd");
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }

  /** Commands typed here before, newest first, for ↑ / ↓. */
  function history() {
    const seen = new Set();
    return (t.info?.runs ?? []).map((r) => r.command).filter((c) => !seen.has(c) && seen.add(c));
  }

  function wire() {
    const box = $("term-cmd");
    grow(box);
    box.addEventListener("input", () => {
      const before = [Boolean(t.draft.trim()), isInteractive(t.draft)];
      t.draft = box.value;
      t.back = -1;
      grow(box);
      const after = [Boolean(t.draft.trim()), isInteractive(t.draft)];
      if (before[0] !== after[0] || before[1] !== after[1]) {
        const at = box.selectionStart;
        render();
        $("term-cmd").focus();
        $("term-cmd").setSelectionRange(at, at);
      }
    });
    box.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void runIt();
      } else if (event.key === "c" && event.ctrlKey && running() && box.selectionStart === box.selectionEnd) {
        event.preventDefault();
        void stopIt();
      } else if (
        (event.key === "ArrowUp" && !box.value.slice(0, box.selectionStart).includes("\n")) ||
        (event.key === "ArrowDown" && !box.value.slice(box.selectionEnd).includes("\n"))
      ) {
        const past = history();
        const step = event.key === "ArrowUp" ? 1 : -1;
        const next = Math.max(-1, Math.min(past.length - 1, t.back + step));
        if (next === t.back) return;
        event.preventDefault();
        if (t.back === -1) t.saved = t.draft;
        t.back = next;
        t.draft = next === -1 ? t.saved : past[next];
        const keep = t.back;
        render();
        t.back = keep;
        focusPrompt();
      } else if (event.key === "l" && event.ctrlKey) {
        event.preventDefault();
        clearIt();
      }
    });
    $("term-run").addEventListener("click", () => void runIt());
    $("term-stop").addEventListener("click", () => void stopIt());
    $("term-open").addEventListener("click", () => void openIt());
    $("term-clear").addEventListener("click", clearIt);
    // Clicking the screen (not selecting text in it) puts the cursor at the prompt, like a terminal.
    $("term-screen").addEventListener("mouseup", () => {
      if (!window.getSelection()?.toString()) focusPrompt();
    });
  }

  function clearIt() {
    t.clearedAt = Date.now();
    t.blocks = t.blocks.filter((b) => b.status === "running");
    t.error = "";
    render();
    focusPrompt();
  }

  async function runIt() {
    const command = t.draft.trim();
    if (!command || running()) return;
    t.error = "";
    try {
      const run = await call("/api/run", { method: "POST", body: { id: t.sessionId, command } });
      t.blocks.push(run);
      t.blocks = t.blocks.slice(-SHOW_RUNS);
      t.draft = "";
      t.back = -1;
      t.info = await call("/api/runs", { params: { id: t.sessionId } }).catch(() => t.info);
      render();
      focusPrompt();
      poll();
    } catch (error) {
      t.error = error.message;
      render();
      focusPrompt();
    }
  }

  async function stopIt() {
    const run = running();
    if (!run) return;
    try {
      await call("/api/run/stop", { method: "POST", body: { run: run.runId } });
      const done = await call("/api/run", { params: { run: run.runId, from: 0 } });
      t.blocks = t.blocks.map((b) => (b.runId === run.runId ? done : b));
    } catch (error) {
      t.error = error.message;
    }
    render();
    focusPrompt();
  }

  async function openIt() {
    const command = t.draft.trim();
    if (!command) return;
    try {
      await call("/api/run/open", { method: "POST", body: { id: t.sessionId, command } });
      t.error = "";
      window.composer?.setStatus?.("Opened a terminal window with that command.", "ok");
    } catch (error) {
      t.error = error.message;
    }
    render();
    focusPrompt();
  }

  /** Follow the running command: append new output in place so typing at the prompt isn't disturbed. */
  function poll() {
    clearTimeout(t.timer);
    const run = running();
    if (!run) return;
    const sessionId = t.sessionId;
    t.timer = setTimeout(async () => {
      if (t.sessionId !== sessionId) return;
      try {
        const next = await call("/api/run", { params: { run: run.runId, from: run.next } });
        const current = t.blocks.find((b) => b.runId === run.runId);
        if (t.sessionId !== sessionId || !current) return;
        Object.assign(current, next, { output: current.output + next.output, trimmed: current.trimmed || next.trimmed });
        if (next.status !== "running") {
          t.info = await call("/api/runs", { params: { id: t.sessionId } }).catch(() => t.info);
          const focused = document.activeElement?.id === "term-cmd";
          render();
          if (focused) focusPrompt();
        } else {
          const node = el.querySelector(`.term-block[data-run="${CSS.escape(run.runId)}"]`);
          const screen = $("term-screen");
          const atBottom = screen && screen.scrollHeight - screen.scrollTop - screen.clientHeight < 40;
          if (node) {
            let pre = node.querySelector(".term-out");
            if (!pre && next.output) {
              pre = document.createElement("pre");
              pre.className = "term-out";
              node.querySelector(".term-end:last-child").before(pre);
            }
            if (pre) pre.textContent = plain(current.output);
            node.querySelector(".term-end:last-child").outerHTML = endLine(current);
          }
          if (screen && atBottom) screen.scrollTop = screen.scrollHeight;
        }
      } catch (error) {
        const current = t.blocks.find((b) => b.runId === run.runId);
        if (current) Object.assign(current, { status: "failed", error: error.message, endedAt: Date.now() });
        render();
        return;
      }
      poll();
    }, 400);
  }

  window.terminalTab = { refresh, put, render };
  window.terminalLangs = SHELL_LANGS;
})();
