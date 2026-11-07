// Top menu bar: Home (the session view), Dashboards, Settings and About, switched by the URL hash
// (#/, #/dashboards, #/settings, #/about) so Back/Forward and a reload keep the page. Home's state is
// untouched while another page is shown; it is only hidden.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = window.escapeHtml;
  const pages = { home: $("page-home"), dashboards: $("page-dashboards"), settings: $("page-settings"), about: $("page-about") };

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
          idle from the lock Codex holds on an open session (Windows) and its last task event.
          <b>Copy for Codex</b> copies text to paste into its prompt.</dd>
        <dt>Terminals</dt><dd>The terminal icon beside a workspace or saved session copies a PowerShell
          line to start or resume Pi, Claude Code or Codex there, or (on Windows) opens it in a new
          Windows Terminal window.</dd>
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
        ${row("Started", info.startedAt ? esc(new Date(info.startedAt).toLocaleString()) : "")}
      </dl>

      <h2>Shortcuts</h2>
      <dl class="about-grid">
        <dt><kbd>Ctrl+Enter</kbd></dt><dd>Put the composer text in Pi's input, or copy it for Claude</dd>
        <dt><kbd>Ctrl+Shift+Enter</kbd></dt><dd>Put it in Pi's input and send it</dd>
        <dt><kbd>/</kbd></dt><dd>At the start of a composer line: slash commands for the selected CLI</dd>
        <dt><kbd>Ctrl+B</kbd></dt><dd>Show or hide the left panel</dd>
        <dt><kbd>Ctrl+Alt+B</kbd></dt><dd>Show or hide Files and Review</dd>
      </dl>

      <h2>Privacy</h2>
      <p>Everything stays on this computer: the server listens on 127.0.0.1 only and reads your session
      files read-only. The only files it writes are its own, in <code>~/.cli-companion</code>: your settings and
      your list of custom dashboards (<code>${esc(info.dashboardsFile || "~/.cli-companion/dashboards.json")}</code>). Its only requests are the online check for
      dashboards on this computer; it never contacts anything outside it. It starts a program only when
      you click <b>Open</b> in a terminal menu, and only one of a fixed set of commands
      (a shell, <code>pi</code>, <code>pi -c</code>, <code>claude</code>, or resuming a listed session).</p>

      <h2>Project</h2>
      <p><a href="https://github.com/mcgowee/cli-companion" target="_blank" rel="noopener">github.com/mcgowee/cli-companion</a>
      · MIT license · run it with <code>npx github:mcgowee/cli-companion</code>, or in Pi with <code>pi install git:github.com/mcgowee/cli-companion</code></p>`;
  }

  window.addEventListener("hashchange", show);
  show();
})();
