// The Workspaces menu: click the "Workspaces" box at the top of the sidebar.
//   Folders — folders you added by hand. Each opens the usual terminal menu (Terminal here, or
//             start Pi / Claude Code / Codex there); they also show in the sidebar under Folders.
//   SSH     — computers you reach with ssh. Pick one to list the folders in ~/projects there, then
//             Terminal or Pi opens a terminal on this computer, ssh'd into that folder's tmux
//             session (it rejoins the session if it's already running). Copy gives the line.
// The page names a saved host id, a folder name and an action; the server builds the command
// (server/places.mjs). Never from the phone.
(function () {
  const esc = window.escapeHtml;
  const button = document.querySelector('.nav-item[data-view="workspaces"]');
  if (!button) return;
  button.setAttribute("aria-haspopup", "menu");
  button.title = "Add folders, start sessions, or open a folder on another computer over SSH";

  const menu = document.createElement("div");
  menu.className = "launch-menu places-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.append(menu);

  const st = { places: null, open: null, remote: {}, adding: null, msg: "", msgKind: "" };
  const page = { "x-pi-companion-page": "1" };
  const json = { "content-type": "application/json", ...page };
  const base = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;

  const termIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 10l3 2.2L7 14.4M12.5 15h4.5"/></svg>`;

  function place() {
    const r = button.getBoundingClientRect();
    menu.style.left = "0px";
    menu.style.top = "0px";
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`;
    menu.style.top = `${Math.max(8, Math.min(r.bottom + 4, innerHeight - h - 8))}px`;
  }

  function close() {
    menu.hidden = true;
    button.classList.remove("open");
    button.setAttribute("aria-expanded", "false");
  }

  async function load() {
    try {
      const res = await fetch("/api/places", { cache: "no-store" });
      st.places = res.ok ? await res.json() : { folders: [], hosts: [], error: `HTTP ${res.status}` };
    } catch {
      st.places = { folders: [], hosts: [], error: "Couldn't reach the companion server." };
    }
  }

  function remoteHtml(h) {
    const r = st.remote[h.id];
    if (!r || r.loading) return `<div class="launch-msg">Looking at ${esc(h.host)}…</div>`;
    if (r.error) return `<div class="launch-msg error">${esc(r.error)}</div><button type="button" class="launch-path" data-reload="${esc(h.id)}">Try again</button>`;
    if (!r.folders.length) return `<div class="launch-msg">No folders in ${esc(r.root)} on ${esc(r.host)}.</div>`;
    return `<div class="places-remote">${r.folders
      .map(
        (f, i) => `<div class="launch-item places-rf">
          <div class="launch-text"><span class="launch-label">${f.running ? `<span class="places-live" title="tmux session running">●</span> ` : ""}${esc(f.name)}</span></div>
          ${(st.places.actions ?? [])
            .map((a) =>
              r.canOpen
                ? `<button class="btn${a.action === "pi" ? " primary" : ""} small" type="button" data-ssh-open="${i}" data-action="${esc(a.action)}" title="${esc(`${f.running ? "Rejoin" : "Open"} ${f.name} on ${r.host}${a.action === "pi" ? ", starting Pi" : ""}`)}">${esc(a.label)}</button>`
                : "",
            )
            .join("")}
          <button class="btn small" type="button" data-ssh-copy="${i}" title="Copy the line (Shift+click: the Pi line)">Copy</button>
        </div>`,
      )
      .join("")}</div>
      <div class="launch-msg places-note">● = a tmux session is running there; opening rejoins it as it is. Leave with Ctrl+b, then d.</div>`;
  }

  function render() {
    const p = st.places;
    if (!p) {
      menu.innerHTML = `<div class="launch-msg">Loading…</div>`;
      return;
    }
    menu.innerHTML = `
      <div class="launch-step">Folders on this computer</div>
      ${p.folders
        .map(
          (f) => `<div class="launch-item">
            <div class="launch-text"><span class="launch-label">${esc(base(f.path))}</span><code class="launch-cmd" title="${esc(f.path)}">${esc(f.path)}</code></div>
            <button class="row-term" type="button" data-launch-kind="folder" data-launch-id="${esc(f.id)}" aria-label="${esc(`Open a terminal or start a session in ${base(f.path)}`)}" title="Open a terminal or start a session here">${termIcon}</button>
            <button class="mini" type="button" data-remove="folder" data-id="${esc(f.id)}" aria-label="${esc(`Remove ${base(f.path)} from the list`)}" title="Remove from the list (the folder stays)">×</button>
          </div>`,
        )
        .join("")}
      ${
        st.adding === "folder"
          ? `<form class="places-add" data-add="folder"><input name="v" placeholder="Full path, e.g. C:\\work\\myapp" autocomplete="off" required><button class="btn primary small" type="submit">Add</button></form>`
          : `<button type="button" class="launch-path" data-adding="folder">+ Add a folder…</button>`
      }
      <div class="launch-step">SSH — folders in ${esc(p.root ?? "~/projects")}</div>
      ${p.hosts
        .map(
          (h) => `<div class="launch-item places-host">
            <button type="button" class="places-host-btn" data-host="${esc(h.id)}" aria-expanded="${st.open === h.id}">${st.open === h.id ? "▾" : "▸"} ${esc(h.host)}</button>
            <button class="mini" type="button" data-remove="host" data-id="${esc(h.id)}" aria-label="${esc(`Remove ${h.host}`)}" title="Remove from the list">×</button>
          </div>${st.open === h.id ? remoteHtml(h) : ""}`,
        )
        .join("")}
      ${
        st.adding === "host"
          ? `<form class="places-add" data-add="host"><input name="v" placeholder="What you type after ssh, e.g. aegis" autocomplete="off" required><button class="btn primary small" type="submit">Add</button></form>`
          : `<button type="button" class="launch-path" data-adding="host">+ Add an SSH computer…</button>`
      }
      <div class="launch-msg ${st.msgKind}" role="status">${esc(st.msg)}</div>`;
    menu.querySelector(".places-add input")?.focus();
  }

  function say(text, kind = "") {
    st.msg = text;
    st.msgKind = kind;
    const m = menu.querySelector('.launch-msg[role="status"]');
    if (m) {
      m.textContent = text;
      m.className = `launch-msg ${kind}`;
    }
  }

  async function loadRemote(id) {
    st.remote[id] = { loading: true };
    render();
    place();
    try {
      const res = await fetch(`/api/ssh/folders?host=${encodeURIComponent(id)}`, { cache: "no-store", headers: page });
      const out = await res.json().catch(() => ({}));
      st.remote[id] = res.ok ? out : { error: out.error || `HTTP ${res.status}` };
    } catch {
      st.remote[id] = { error: "Couldn't reach the companion server." };
    }
    if (!menu.hidden) {
      render();
      place();
    }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async function toggle() {
    if (!menu.hidden) return close();
    st.msg = "";
    menu.hidden = false;
    button.classList.add("open");
    button.setAttribute("aria-expanded", "true");
    render();
    place();
    await load();
    render();
    place();
  }

  button.addEventListener("click", (event) => {
    event.preventDefault();
    void toggle();
  });

  menu.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target.closest("[data-add]");
    if (!form) return;
    const kind = form.dataset.add;
    const value = form.querySelector("input").value;
    try {
      const res = await fetch("/api/places", {
        method: "POST",
        headers: json,
        body: JSON.stringify(kind === "folder" ? { kind, path: value } : { kind, host: value }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      st.places = out;
      st.adding = null;
      st.msg = kind === "folder" ? "Added. It's under Folders in the sidebar too." : "Added. Click it to see its folders.";
      st.msgKind = "ok";
      render();
      place();
    } catch (error) {
      say(error.message, "error");
    }
  });

  menu.addEventListener("click", async (event) => {
    const t = event.target;
    const adding = t.closest("[data-adding]");
    if (adding) {
      st.adding = adding.dataset.adding;
      st.msg = "";
      render();
      place();
      return;
    }
    const remove = t.closest("[data-remove]");
    if (remove) {
      try {
        const res = await fetch(`/api/places?kind=${encodeURIComponent(remove.dataset.remove)}&id=${encodeURIComponent(remove.dataset.id)}`, { method: "DELETE", headers: page });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
        st.places = out;
        if (st.open === remove.dataset.id) st.open = null;
        st.msg = "";
        render();
        place();
      } catch (error) {
        say(error.message, "error");
      }
      return;
    }
    const host = t.closest("[data-host]");
    if (host) {
      st.open = st.open === host.dataset.host ? null : host.dataset.host;
      if (st.open) void loadRemote(st.open);
      else {
        render();
        place();
      }
      return;
    }
    const reload = t.closest("[data-reload]");
    if (reload) return void loadRemote(reload.dataset.reload);
    const r = st.remote[st.open];
    const copyBtn = t.closest("[data-ssh-copy]");
    if (copyBtn && r?.folders) {
      const f = r.folders[Number(copyBtn.dataset.sshCopy)];
      const line = event.shiftKey ? f.copy.pi : f.copy.shell;
      say((await copy(line)) ? `Copied ✓ ${line}` : "Copy failed.", "ok");
      return;
    }
    const openBtn = t.closest("[data-ssh-open]");
    if (openBtn && r?.folders) {
      const f = r.folders[Number(openBtn.dataset.sshOpen)];
      openBtn.disabled = true;
      say("Opening…");
      try {
        const res = await fetch("/api/ssh/open", {
          method: "POST",
          headers: json,
          body: JSON.stringify({ host: st.open, folder: f.name, action: openBtn.dataset.action }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
        say(`${f.name} on ${r.host}: opened in a new terminal window ✓`, "ok");
        f.running = true;
      } catch (error) {
        say(error.message, "error");
      } finally {
        openBtn.disabled = false;
      }
    }
  });

  // Outside click closes it — but not a click in the terminal menu a folder's icon opened from here.
  document.addEventListener(
    "click",
    (event) => {
      if (menu.hidden) return;
      if (menu.contains(event.target) || button.contains(event.target) || event.target.closest?.(".launch-menu")) return;
      close();
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden && !document.querySelector(".launch-menu:not(.places-menu):not([hidden])")) close();
  });
  window.addEventListener("resize", close);
})();
