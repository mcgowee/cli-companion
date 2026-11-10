// The Workspaces menu: click the "Workspaces" box at the top of the sidebar.
//   Search  — type part of a folder name: matches on this computer (Add puts one under Folders)
//             and on each SSH computer under ~/projects (Terminal / Pi / Copy), all at once.
//   Folders — folders you added. Each opens the usual terminal menu (Terminal here, or start
//             Pi / Claude Code / Codex there); they also show in the sidebar under Folders.
//   SSH     — computers you reach with ssh. Pick one to list the folders in ~/projects there;
//             Terminal or Pi opens a terminal on this computer, ssh'd into that folder's tmux
//             session (it rejoins the session if it's already running). Copy gives the line.
// The page names a saved host id, a folder name and an action; the server builds the command
// (server/places.mjs). Never from the phone.
(function () {
  const esc = window.escapeHtml;
  const button = document.querySelector('.nav-item[data-view="workspaces"]');
  if (!button) return;
  button.setAttribute("aria-haspopup", "menu");
  button.title = "Find folders here and over SSH, add folders, start sessions";

  const menu = document.createElement("div");
  menu.className = "launch-menu places-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.append(menu);

  const st = { places: null, open: null, remote: {}, adding: null, msg: "", msgKind: "", q: "", search: null, searchSeq: 0 };
  // Remote rows on screen, by key, so a click knows its host and folder.
  let rows = new Map();
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

  /** One remote folder row: Terminal / Pi (or only Copy where Open can't work). */
  function remoteRow(hostId, host, f, canOpen, showPath) {
    const key = `${hostId}|${f.name}`;
    rows.set(key, { hostId, host, f });
    const label = showPath ? f.name : base(f.name);
    return `<div class="launch-item places-rf">
      <div class="launch-text"><span class="launch-label">${f.running ? `<span class="places-live" title="tmux session running">●</span> ` : ""}${esc(label)}</span></div>
      ${(st.places?.actions ?? [])
        .map((a) =>
          canOpen
            ? `<button class="btn${a.action === "pi" ? " primary" : ""} small" type="button" data-ssh-open="${esc(key)}" data-action="${esc(a.action)}" title="${esc(`${f.running ? "Rejoin" : "Open"} ${f.name} on ${host}${a.action === "pi" ? ", starting Pi" : ""}`)}">${esc(a.label)}</button>`
            : "",
        )
        .join("")}
      <button class="btn small" type="button" data-ssh-copy="${esc(key)}" title="Copy the line (Shift+click: the Pi line)">Copy</button>
    </div>`;
  }

  function hostListHtml(h) {
    const r = st.remote[h.id];
    if (!r || r.loading) return `<div class="launch-msg">Looking at ${esc(h.host)}…</div>`;
    if (r.error) return `<div class="launch-msg error">${esc(r.error)}</div><button type="button" class="launch-path" data-reload="${esc(h.id)}">Try again</button>`;
    if (!r.folders.length) return `<div class="launch-msg">No folders in ${esc(r.root)} on ${esc(r.host)}.</div>`;
    return `<div class="places-remote">${r.folders.map((f) => remoteRow(h.id, r.host, f, r.canOpen, true)).join("")}</div>`;
  }

  function localRow(f) {
    const added = (st.places?.folders ?? []).find((x) => x.path.toLowerCase() === f.path.toLowerCase());
    return `<div class="launch-item">
      <div class="launch-text"><span class="launch-label">${esc(f.name)}</span><code class="launch-cmd" title="${esc(f.path)}">${esc(f.path)}</code></div>
      ${
        added
          ? `<button class="row-term" type="button" data-launch-kind="folder" data-launch-id="${esc(added.id)}" aria-label="${esc(`Open a terminal or start a session in ${f.name}`)}" title="Open a terminal or start a session here">${termIcon}</button>`
          : `<button class="btn small" type="button" data-add-path="${esc(f.path)}" title="Add to Folders in the sidebar">Add</button>`
      }
    </div>`;
  }

  function searchHtml() {
    const s = st.search;
    if (!st.q || st.q.length < 2) return "";
    if (!s || s.loading) return `<div class="launch-msg">Searching…</div>`;
    if (s.error) return `<div class="launch-msg error">${esc(s.error)}</div>`;
    const local = s.local.folders.length
      ? s.local.folders.map(localRow).join("")
      : `<div class="launch-msg">No folder named like “${esc(s.q)}”${s.local.partial ? " (stopped early: a long way to look)" : ""}.</div>`;
    const remotes = s.remotes
      .map(
        (r) => `<div class="launch-step">${esc(r.host)} — ${esc(st.places?.root ?? "~/projects")}</div>
        ${
          r.error
            ? `<div class="launch-msg error">${esc(r.error)}</div>`
            : r.folders.length
              ? `<div class="places-remote">${r.folders.map((f) => remoteRow(r.id, r.host, f, s.canOpen, true)).join("")}</div>`
              : `<div class="launch-msg">No folder named like “${esc(s.q)}”.</div>`
        }`,
      )
      .join("");
    return `<div class="places-results">
      <div class="launch-step">This computer</div>${local}
      ${remotes}
      ${s.remotes.some((r) => r.folders?.some((f) => f.running)) ? `<div class="launch-msg places-note">● = a tmux session is running there; opening rejoins it as it is. Leave with Ctrl+b, then d.</div>` : ""}
    </div>`;
  }

  function render() {
    rows = new Map();
    const p = st.places;
    const head = `<form class="places-search" data-search role="search">
      <input type="search" name="q" value="${esc(st.q)}" placeholder="Find a folder here${p?.hosts?.length ? ` and on ${esc(p.hosts.map((h) => h.host).join(", "))}` : ""}…" aria-label="Find a folder" autocomplete="off" spellcheck="false">
    </form>`;
    if (!p) {
      menu.innerHTML = `${head}<div class="launch-msg">Loading…</div>`;
      return;
    }
    const results = searchHtml();
    menu.innerHTML = `${head}${results}
      ${results ? `<details class="places-more"${st.moreOpen ? " open" : ""}><summary>Folders and SSH computers</summary>` : ""}
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
          : `<button type="button" class="launch-path" data-adding="folder">+ Add a folder by path…</button>`
      }
      <div class="launch-step">SSH — folders in ${esc(p.root ?? "~/projects")}</div>
      ${p.hosts
        .map(
          (h) => `<div class="launch-item places-host">
            <button type="button" class="places-host-btn" data-host="${esc(h.id)}" aria-expanded="${st.open === h.id}">${st.open === h.id ? "▾" : "▸"} ${esc(h.host)}</button>
            <button class="mini" type="button" data-remove="host" data-id="${esc(h.id)}" aria-label="${esc(`Remove ${h.host}`)}" title="Remove from the list">×</button>
          </div>${st.open === h.id ? hostListHtml(h) : ""}`,
        )
        .join("")}
      ${
        st.adding === "host"
          ? `<form class="places-add" data-add="host"><input name="v" placeholder="What you type after ssh, e.g. aegis" autocomplete="off" required><button class="btn primary small" type="submit">Add</button></form>`
          : `<button type="button" class="launch-path" data-adding="host">+ Add an SSH computer…</button>`
      }
      ${results ? `</details>` : ""}
      <div class="launch-msg ${st.msgKind}" role="status">${esc(st.msg)}</div>`;
    const addInput = menu.querySelector(".places-add input");
    if (addInput) addInput.focus();
  }

  /** Re-render, keeping the search box focused with the caret where it was. */
  function rerender() {
    const box = menu.querySelector(".places-search input");
    const had = box && document.activeElement === box;
    const caret = had ? box.selectionStart : null;
    render();
    place();
    if (had && !st.adding) {
      const again = menu.querySelector(".places-search input");
      again.focus();
      if (caret !== null) again.setSelectionRange(caret, caret);
    }
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

  let searchTimer;
  function scheduleSearch() {
    clearTimeout(searchTimer);
    const q = st.q.trim();
    if (q.length < 2) {
      st.search = null;
      rerender();
      return;
    }
    if (!/^[\w.-]+$/.test(q)) {
      st.search = { q, error: "Search for part of a folder name: letters, digits, . _ -" };
      rerender();
      return;
    }
    searchTimer = setTimeout(() => void runSearch(q), 350);
  }

  async function runSearch(q) {
    const seq = ++st.searchSeq;
    st.search = { q, loading: true };
    rerender();
    let out;
    try {
      const res = await fetch(`/api/ssh/search?q=${encodeURIComponent(q)}`, { cache: "no-store", headers: page });
      const data = await res.json().catch(() => ({}));
      out = res.ok ? data : { q, error: data.error || `HTTP ${res.status}` };
    } catch {
      out = { q, error: "Couldn't reach the companion server." };
    }
    if (seq !== st.searchSeq || menu.hidden) return; // a newer search, or closed
    st.search = out;
    rerender();
  }

  async function loadRemote(id) {
    st.remote[id] = { loading: true };
    rerender();
    try {
      const res = await fetch(`/api/ssh/folders?host=${encodeURIComponent(id)}`, { cache: "no-store", headers: page });
      const out = await res.json().catch(() => ({}));
      st.remote[id] = res.ok ? out : { error: out.error || `HTTP ${res.status}` };
    } catch {
      st.remote[id] = { error: "Couldn't reach the companion server." };
    }
    if (!menu.hidden) rerender();
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async function addFolder(path) {
    const res = await fetch("/api/places", { method: "POST", headers: json, body: JSON.stringify({ kind: "folder", path }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    st.places = out;
  }

  async function toggle() {
    if (!menu.hidden) return close();
    st.msg = "";
    menu.hidden = false;
    button.classList.add("open");
    button.setAttribute("aria-expanded", "true");
    render();
    place();
    menu.querySelector(".places-search input")?.focus();
    await load();
    rerender();
    menu.querySelector(".places-search input")?.focus();
  }

  button.addEventListener("click", (event) => {
    event.preventDefault();
    void toggle();
  });

  menu.addEventListener(
    "toggle",
    (event) => {
      if (event.target.classList?.contains("places-more")) st.moreOpen = event.target.open;
    },
    true,
  );

  menu.addEventListener("input", (event) => {
    if (!event.target.closest(".places-search")) return;
    st.q = event.target.value;
    scheduleSearch();
  });

  menu.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.target.closest("[data-search]")) {
      clearTimeout(searchTimer);
      if (st.q.trim().length >= 2 && /^[\w.-]+$/.test(st.q.trim())) void runSearch(st.q.trim());
      return;
    }
    const form = event.target.closest("[data-add]");
    if (!form) return;
    const kind = form.dataset.add;
    const value = form.querySelector("input").value;
    try {
      if (kind === "folder") await addFolder(value);
      else {
        const res = await fetch("/api/places", { method: "POST", headers: json, body: JSON.stringify({ kind, host: value }) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
        st.places = out;
      }
      st.adding = null;
      st.msg = kind === "folder" ? "Added. It's under Folders in the sidebar too." : "Added. Click it to see its folders; search looks there too.";
      st.msgKind = "ok";
      rerender();
    } catch (error) {
      say(error.message, "error");
    }
  });

  menu.addEventListener("click", async (event) => {
    const t = event.target;
    const addPath = t.closest("[data-add-path]");
    if (addPath) {
      try {
        await addFolder(addPath.dataset.addPath);
        st.msg = `Added ${base(addPath.dataset.addPath)} under Folders. Its terminal icon starts a session there.`;
        st.msgKind = "ok";
        rerender();
      } catch (error) {
        say(error.message, "error");
      }
      return;
    }
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
        rerender();
      } catch (error) {
        say(error.message, "error");
      }
      return;
    }
    const host = t.closest("[data-host]");
    if (host) {
      st.open = st.open === host.dataset.host ? null : host.dataset.host;
      if (st.open) void loadRemote(st.open);
      else rerender();
      return;
    }
    const reload = t.closest("[data-reload]");
    if (reload) return void loadRemote(reload.dataset.reload);
    const copyBtn = t.closest("[data-ssh-copy]");
    if (copyBtn) {
      const row = rows.get(copyBtn.dataset.sshCopy);
      if (!row) return;
      const line = event.shiftKey ? row.f.copy.pi : row.f.copy.shell;
      say((await copy(line)) ? `Copied ✓ ${line}` : "Copy failed.", "ok");
      return;
    }
    const openBtn = t.closest("[data-ssh-open]");
    if (openBtn) {
      const row = rows.get(openBtn.dataset.sshOpen);
      if (!row) return;
      openBtn.disabled = true;
      say("Opening…");
      try {
        const res = await fetch("/api/ssh/open", {
          method: "POST",
          headers: json,
          body: JSON.stringify({ host: row.hostId, folder: row.f.name, action: openBtn.dataset.action }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
        say(`${row.f.name} on ${row.host}: opened in a new terminal window ✓`, "ok");
        row.f.running = true;
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
