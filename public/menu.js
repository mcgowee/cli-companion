// Top menu bar: Home (the session view), Dashboards, Settings and About, switched by the URL hash
// (#/, #/dashboards, #/settings, #/about) so Back/Forward and a reload keep the page. Home's state is
// untouched while another page is shown; it is only hidden.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = window.escapeHtml;
  const pages = { home: $("page-home"), search: $("page-search"), dashboards: $("page-dashboards"), settings: $("page-settings"), about: $("page-about") };

  function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    return parts[0] in pages ? { page: parts[0], rest: parts.slice(1) } : { page: "home", rest: [] };
  }

  function show() {
    const { page, rest } = route();
    for (const [name, el] of Object.entries(pages)) el.hidden = name !== page;
    for (const link of document.querySelectorAll(".menu-item")) {
      const active = link.dataset.page === page;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    document.title = page === "home" ? "CLI Companion" : `${page[0].toUpperCase()}${page.slice(1)} · CLI Companion`;
    if (page === "about") loadAbout();
    window.dashboardsPage?.show(page === "dashboards" ? rest : null);
    window.settingsPage?.show(page === "settings");
    window.searchPage?.show(page === "search");
  }

  /** Ask the server to restart, wait for the new one to answer, then reload the page. */
  async function restartServer(button, note) {
    button.disabled = true;
    note.textContent = "Restarting…";
    let before;
    try {
      before = (await (await fetch("/api/about", { cache: "no-store" })).json()).startedAt;
      const res = await fetch("/api/server", {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-companion-page": "1" },
        body: JSON.stringify({ action: "restart" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (error) {
      button.disabled = false;
      note.textContent = `Couldn't restart: ${error.message}`;
      return;
    }
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const info = await (await fetch("/api/about", { cache: "no-store" })).json();
        if (info.startedAt && info.startedAt !== before) return location.reload();
      } catch {
        // Still down: keep waiting.
      }
    }
    button.disabled = false;
    note.textContent = "The server didn't come back. Run cli-companion in a terminal; see ~/.cli-companion/server.log.";
  }

  async function loadAbout() {
    let info = {};
    try {
      const res = await fetch("/api/about", { cache: "no-store" });
      if (res.ok) info = await res.json();
    } catch {
      // Server unreachable: show the static parts.
    }
    const row = (k, v) => (v === undefined || v === null || v === "" ? "" : `<dt>${esc(k)}</dt><dd>${v}</dd>`);
    const code = (v) => (v ? `<code>${esc(String(v))}</code>` : "");
    $("about-body").innerHTML = `
      <h1>About CLI Companion</h1>
      <p class="page-lead">A live side window for coding-agent CLIs. Keep working in the terminal; the
      companion shows the same session with formatted markdown, tool calls and their output, images,
      thinking, context usage and compaction as it happens.</p>

      <h2>Works with</h2>
      <dl class="about-grid">
        <dt>Pi</dt><dd>Live: status, streaming text, tools and compaction from the companion extension.
          <b>Put in Pi's input</b> sends text into the running Pi's prompt box.</dd>
        <dt>Claude Code</dt><dd>Transcripts from <code>~/.claude/projects</code>, followed while they grow;
          running or idle from the files Claude Code keeps in <code>~/.claude/sessions</code>.
          <b>Copy for Claude</b> copies text to paste into its prompt.</dd>
        <dt>Codex</dt><dd>Sessions from <code>~/.codex/sessions</code>, followed while they grow; running or
          idle from the lock Codex holds on a loaded session, matched against the open Codex windows
          (Windows), and its last task event.
          <b>Copy for Codex</b> copies text to paste into its prompt.</dd>
        <dt>Terminals</dt><dd>The terminal icon beside a workspace or saved session copies the line to
          start or resume Pi, Claude Code or Codex there, or opens it in a new terminal window (pick
          which terminal in Settings).</dd>
      </dl>

      <h2>This server</h2>
      <dl class="about-grid">
        ${row("Version", code(info.version))}
        ${row("Address", code(info.address))}
        ${row("Running Pi sessions", info.livePi === undefined ? "" : esc(String(info.livePi)))}
        ${row("Other CLIs running", info.runningOther === undefined ? "" : esc(String(info.runningOther)))}
        ${(info.sources ?? [])
          .flatMap((source) =>
            source.folders.map((folder) =>
              row(
                folder.label,
                !source.enabled
                  ? `off (CLI_COMPANION_${esc(source.id.toUpperCase())}=0)`
                  : `${code(folder.path)}${source.installed ? "" : " <span class='muted'>(not found)</span>"}`,
              ),
            ),
          )
          .join("")}
        ${row("Node", code(info.node && `${info.node} · ${info.platform}`))}
        ${row("Started", info.startedAt ? esc(window.fmtTime(info.startedAt, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })) : "")}
      </dl>
      <p class="about-actions">
        <button class="btn small" type="button" id="about-restart">Restart server</button>
        <span class="muted" id="about-restart-note">Reloads settings and code; open sessions stay open.
          From a terminal: <code>cli-companion --restart</code> or <code>--stop</code>.</span>
      </p>

      <h2>Shortcuts</h2>
      <dl class="about-grid">
        <dt><kbd>Ctrl+Enter</kbd></dt><dd>Put the composer text in Pi's input, or copy it for Claude</dd>
        <dt><kbd>Ctrl+Shift+Enter</kbd></dt><dd>Put it in Pi's input and send it</dd>
        <dt><kbd>/</kbd></dt><dd>At the start of a composer line: slash commands for the selected CLI</dd>
        <dt><kbd>Ctrl+K</kbd></dt><dd>Command palette: the session's CLI commands (/compact…), sessions, actions</dd>
        <dt><kbd>Ctrl+Shift+F</kbd></dt><dd>Search all sessions</dd>
        <dt><kbd>Ctrl+B</kbd></dt><dd>Show or hide the left panel</dd>
        <dt><kbd>Ctrl+Alt+B</kbd></dt><dd>Show or hide Files and Review</dd>
      </dl>

      <h2>Privacy</h2>
      <p>Everything stays on this computer: the server listens on 127.0.0.1 only and reads your session
      files read-only. Every request for your sessions needs this computer's access key (<code>~/.cli-companion/access-key</code>,
      readable only by you), which this window keeps as a cookie, so other accounts on the computer can't read them.
      It also writes its log (<code>server.log</code>, capped at 2 MB) and this window's browser profile there, and the
      key itself. The only files it writes are its own, in <code>~/.cli-companion</code>: your settings, favorites, saved prompts,
      token counts per session file (numbers only, no text) and your list of custom dashboards (<code>${esc(info.dashboardsFile || "~/.cli-companion/dashboards.json")}</code>), and,
      only when you click <b>Continue in …</b> under <b>Hand off</b>, a brief of that session in <code>~/.cli-companion/handoffs</code>
      (the newest 20 are kept). Outside that folder it writes only images you add in the composer (into that session's folder, under
      <code>.cli-companion/images</code>, deleted after 30 days), new folders you make in Files, and the <b>CLI Companion</b> shortcut, when you click
      <b>Add</b> under Settings → Shortcut. Its only requests are the online check for
      dashboards on this computer and, if you switch on suggested replies, the Ollama on this computer
      (only local models; the last message of the session you're viewing goes to it). It never contacts
      anything outside this computer. If you switch on <b>Phone access</b> (Settings), Tailscale's own proxy
      (<code>tailscale serve</code>) makes it reachable over HTTPS from devices signed in to your Tailscale account only;
      from there it can be read, and, if you allow it, reply to Pi, nothing else. Its settings are in
      <code>~/.cli-companion/remote.json</code>. It starts a program only when
      you click <b>Open</b> in a terminal menu or <b>Continue in …</b>, and only one of a fixed set of commands
      (a shell, <code>pi</code>, <code>pi -c</code>, <code>claude</code>, <code>codex</code>, resuming a listed
      session, or one of those CLIs told to read a handoff brief), or a fresh copy of itself when you click <b>Restart server</b>.
      The one exception is the <b>Terminal</b> tab, off unless you turn it on in Settings: it runs the command you
      typed or put there, in the session's folder, only when you press <b>Run</b> (or <b>Open in terminal</b>); never from the phone.</p>

      <h2>Project</h2>
      <p><a href="https://github.com/mcgowee/cli-companion" target="_blank" rel="noopener">github.com/mcgowee/cli-companion</a>
      · MIT license · run it with <code>npx github:mcgowee/cli-companion</code>, or in Pi with <code>pi install git:github.com/mcgowee/cli-companion</code></p>`;
    const button = $("about-restart");
    button.addEventListener("click", () => restartServer(button, $("about-restart-note")));
  }

  window.addEventListener("hashchange", show);
  show();
})();
