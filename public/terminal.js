// Right panel → Terminal tab (server/runner.mjs): run a command in the selected session's folder
// and watch its output, or open it in a real terminal window. Code blocks in replies get a
// "Terminal" button that only puts the command in the box: nothing runs until you press Run.
// Off unless Settings → Terminal → "Let the companion run commands" is on; never on the phone.
(function () {
  const $ = (id) => document.getElementById(id);
  const el = $("wb-terminal");
  const SHELL_LANGS = ["powershell", "ps", "ps1", "pwsh", "shell", "sh", "bash", "zsh", "console", "cmd", "bat", "batch", "terminal", "shell-session"];
  const INTERACTIVE = /^(?:&\s*)?["']?(?:[\w.:\\/-]*[\\/])?(codex|pi|claude|ssh|vim|nvim|nano|less|more|top|htop|psql|mysql|sqlite3|wsl)(?:\.(?:cmd|exe|bat|ps1))?["']?(?:\s+(?!exec\b|list\b|ls\b|--version\b|-v\b|--help\b|-h\b|install\b|update\b|login\b)|$)|^(python3?|py|node|pwsh|powershell|bash|sh|zsh|cmd)(\.exe)?$/i;

  const t = {
    sessionId: null,
    info: null, // { enabled, cwd, platform, runs }
    run: null, // the run shown: { runId, command, status, exitCode, output, next, startedAt, endedAt, error }
    draft: "",
    timer: 0,
    error: "",
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const onPhone = () => window.companionRemote?.you?.remote === true;
  const enabled = () => window.companionSettings?.runCommands === true && !onPhone();

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

  /** Put a command in the box (never runs it) and show the tab. */
  function put(command) {
    t.draft = command;
    window.workbench?.openTool("terminal");
    render();
    const box = $("term-cmd");
    if (box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
  }

  /* ── tab ─────────────────────────────────────────────── */

  async function refresh(sessionId) {
    if (sessionId !== t.sessionId) {
      t.sessionId = sessionId;
      t.run = null;
      t.error = "";
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
    } catch (error) {
      t.info = null;
      t.error = error.message;
    }
    render();
  }

  function statusLine(run) {
    if (!run) return "";
    const secs = ((run.endedAt ?? Date.now()) - run.startedAt) / 1000;
    const took = secs < 60 ? `${secs.toFixed(1)} s` : `${Math.floor(secs / 60)} min ${Math.round(secs % 60)} s`;
    if (run.status === "running") return `<span class="term-st running">Running… ${took}</span>`;
    if (run.status === "stopped") return `<span class="term-st stopped">Stopped after ${took}</span>`;
    if (run.error) return `<span class="term-st failed">${esc(run.error)}</span>`;
    return run.exitCode === 0
      ? `<span class="term-st ok">✓ Done in ${took}</span>`
      : `<span class="term-st failed">✗ Exit code ${esc(run.exitCode)} after ${took}</span>`;
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
        <b>Run</b>. It runs in this session's folder (PowerShell on Windows) and its output shows here. Nothing ever runs
        by itself.</p>
        <p>It's off. Turn it on in <a href="#/settings">Settings → Terminal</a>.</p></div>`;
      return;
    }
    if (!t.sessionId) {
      el.innerHTML = `<p class="wb-empty">Pick a session: commands run in its folder.</p>`;
      return;
    }
    const busy = t.run?.status === "running";
    const interactive = INTERACTIVE.test(t.draft.trim().split("\n")[0].trim());
    const runs = (t.info?.runs ?? []).filter((r) => r.runId !== t.run?.runId).slice(0, 8);
    el.innerHTML = `<div class="term">
      <p class="wb-note" title="${esc(t.info?.cwd)}">In <code>${esc(t.info?.cwd ?? "")}</code> · ${t.info?.platform === "win32" ? "PowerShell" : "your shell"}</p>
      <textarea id="term-cmd" class="term-cmd" rows="3" spellcheck="false" autocomplete="off"
        placeholder="A command to run here. Enter runs it; Shift+Enter for a new line.">${esc(t.draft)}</textarea>
      ${
        interactive
          ? `<p class="term-hint">This looks like a program you type into while it runs. It can't take input here, so use <b>Open in terminal</b>.</p>`
          : ""
      }
      <div class="term-actions">
        <button class="btn small primary" type="button" id="term-run" ${t.draft.trim() ? "" : "disabled"}>Run <kbd>Enter</kbd></button>
        <button class="btn small" type="button" id="term-stop" ${busy ? "" : "disabled"}>Stop</button>
        <button class="btn small" type="button" id="term-open" ${t.draft.trim() ? "" : "disabled"} title="Open a terminal window in this folder with this command (for interactive programs)">Open in terminal</button>
        <span class="wb-spacer"></span>
        ${t.run ? `<button class="btn small" type="button" id="term-clear">Clear</button>` : ""}
      </div>
      ${t.error ? `<p class="term-st failed">${esc(t.error)}</p>` : ""}
      ${
        t.run
          ? `<div class="term-run"><div class="term-head"><code class="term-cmdline">${esc(t.run.command)}</code>${statusLine(t.run)}</div>
             <pre class="term-out" id="term-out">${t.run.trimmed ? "… (earlier output trimmed)\n" : ""}${esc(t.run.output) || (busy ? "" : "(no output)")}</pre></div>`
          : ""
      }
      ${
        runs.length
          ? `<div class="term-history"><p class="wb-note">Earlier here</p>${runs
              .map(
                (r) => `<button type="button" class="term-past" data-run="${esc(r.runId)}" title="Show its output">
                  <span class="term-past-st ${esc(r.status)}">${r.status === "running" ? "…" : r.status === "done" ? "✓" : r.status === "stopped" ? "■" : "✗"}</span>
                  <code>${esc(r.command.split("\n")[0])}</code></button>`,
              )
              .join("")}</div>`
          : ""
      }
    </div>`;
    const box = $("term-cmd");
    box.addEventListener("input", () => {
      const had = Boolean(t.draft.trim());
      const wasInteractive = INTERACTIVE.test(t.draft.trim().split("\n")[0].trim());
      t.draft = box.value;
      const has = Boolean(t.draft.trim());
      const nowInteractive = INTERACTIVE.test(t.draft.trim().split("\n")[0].trim());
      if (had !== has || wasInteractive !== nowInteractive) {
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
      }
    });
    $("term-run").addEventListener("click", () => void runIt());
    $("term-stop").addEventListener("click", () => void stopIt());
    $("term-open").addEventListener("click", () => void openIt());
    $("term-clear")?.addEventListener("click", () => {
      t.run = null;
      render();
    });
    for (const b of el.querySelectorAll(".term-past")) b.addEventListener("click", () => void show(b.dataset.run));
    const out = $("term-out");
    if (out) out.scrollTop = out.scrollHeight;
  }

  async function runIt() {
    const command = t.draft.trim();
    if (!command || t.run?.status === "running") return;
    t.error = "";
    try {
      t.run = await call("/api/run", { method: "POST", body: { id: t.sessionId, command } });
      t.info = await call("/api/runs", { params: { id: t.sessionId } }).catch(() => t.info);
      render();
      poll();
    } catch (error) {
      t.error = error.message;
      render();
    }
  }

  async function stopIt() {
    if (!t.run) return;
    try {
      await call("/api/run/stop", { method: "POST", body: { run: t.run.runId } });
      t.run = await call("/api/run", { params: { run: t.run.runId, from: 0 } });
    } catch (error) {
      t.error = error.message;
    }
    render();
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
  }

  async function show(runId) {
    try {
      t.run = await call("/api/run", { params: { run: runId, from: 0 } });
      t.draft = t.run.command;
      render();
      if (t.run.status === "running") poll();
    } catch (error) {
      t.error = error.message;
      render();
    }
  }

  function poll() {
    clearTimeout(t.timer);
    const run = t.run;
    if (!run || run.status !== "running") return;
    t.timer = setTimeout(async () => {
      if (t.run?.runId !== run.runId) return;
      try {
        const next = await call("/api/run", { params: { run: run.runId, from: run.next } });
        if (t.run?.runId !== run.runId) return;
        const out = $("term-out");
        const atBottom = !out || out.scrollHeight - out.scrollTop - out.clientHeight < 40;
        t.run = { ...next, output: run.output + next.output, trimmed: run.trimmed || next.trimmed };
        if (next.status !== "running") t.info = await call("/api/runs", { params: { id: t.sessionId } }).catch(() => t.info);
        // Keep typing undisturbed: only redraw the output while the box has focus.
        if (document.activeElement?.id === "term-cmd" && out && next.status === "running") {
          out.textContent += next.output;
          el.querySelector(".term-head").innerHTML = `<code class="term-cmdline">${esc(t.run.command)}</code>${statusLine(t.run)}`;
        } else {
          render();
        }
        const outNow = $("term-out");
        if (outNow && atBottom) outNow.scrollTop = outNow.scrollHeight;
      } catch (error) {
        t.run = { ...run, status: "failed", error: error.message, endedAt: Date.now() };
        render();
        return;
      }
      poll();
    }, 400);
  }

  window.terminalTab = { refresh, put, render };
  window.terminalLangs = SHELL_LANGS;
})();
