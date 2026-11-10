// Start Pi: the button at the bottom of the sidebar. It opens a popover: which computer (This
// computer, your SSH computers, + to add one), a search box, your pinned and recent folders there
// (click one to start Pi in it; ⧉ copies the command instead; ☆ pins it), and Browse… (this
// computer's folder window, or a "Select remote folder" window over SSH). Add computer asks for
// the name you type after ssh, with a Test that checks what Pi needs there.
// The page names a computer and a folder; the server builds what runs (server/envs.mjs). Never
// from the phone.
(function () {
  const esc = window.escapeHtml;
  const btn = document.getElementById("start-pi");
  const whereEl = document.getElementById("start-where");
  const msgEl = document.getElementById("env-msg");
  if (!btn) return;

  const page = { "x-pi-companion-page": "1" };
  const json = { "content-type": "application/json", ...page };
  const st = { data: null, view: null, q: "", folders: new Map(), loading: false, results: null, searching: false, error: "", seq: 0, timer: 0 };

  const LOCAL = "local";
  const folderIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>`;
  const copyIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>`;
  const starIcon = (on) => `<svg viewBox="0 0 24 24" aria-hidden="true" class="${on ? "on" : ""}"><path d="M12 4.5l2.3 4.7 5.2.8-3.8 3.6.9 5.1-4.6-2.4-4.6 2.4.9-5.1-3.8-3.6 5.2-.8z"/></svg>`;
  const gearIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/></svg>`;

  async function send(url, method, body) {
    const res = await fetch(url, { method, headers: body ? json : page, body: body ? JSON.stringify(body) : undefined });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    return out;
  }

  const computerName = (id) => st.data?.computers.find((c) => c.id === id)?.name ?? id;
  const isRemote = () => st.view && st.view !== LOCAL;

  function say(text, kind = "") {
    msgEl.textContent = text;
    msgEl.className = `env-msg ${kind}`;
    clearTimeout(say.timer);
    if (text && kind !== "error") say.timer = setTimeout(() => say(""), 6000);
  }

  /* ── the button ── */

  function renderButton() {
    const cur = st.data?.current ?? LOCAL;
    whereEl.textContent = cur === LOCAL ? "This computer" : computerName(cur);
    btn.title = `Start Pi on ${cur === LOCAL ? "this computer" : computerName(cur)}: pick a folder`;
    btn.disabled = st.data?.canOpen === false;
  }

  async function load() {
    try {
      const res = await fetch("/api/start", { cache: "no-store", headers: page });
      if (res.ok) st.data = await res.json();
    } catch {
      // Server restarting: the next click loads it.
    }
    if (st.view && !st.data?.computers.some((c) => c.id === st.view)) st.view = st.data?.current ?? LOCAL;
    renderButton();
    if (!pop.hidden) renderPop();
  }

  /* ── the popover ── */

  const pop = document.createElement("div");
  pop.className = "launch-menu sp-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Start Pi");
  pop.hidden = true;
  document.body.append(pop);

  function place() {
    const r = btn.getBoundingClientRect();
    pop.style.left = "0px";
    pop.style.top = "0px";
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    pop.style.left = `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`;
    pop.style.top = `${Math.max(8, r.top - h - 6)}px`;
  }

  function rowHtml(f, { pinned = false, kind = "" } = {}) {
    const where = isRemote() ? ` on ${computerName(st.view)}` : "";
    return `<div class="sp-row">
      <button type="button" class="sp-go" data-go="${esc(f.path)}" title="${esc(`Start Pi in ${f.path}${where}`)}">${folderIcon}
        <span class="sp-text"><span class="sp-name">${esc(f.name)}</span><span class="sp-path">${esc(f.path)}</span></span></button>
      ${kind === "use" ? "" : `<button type="button" class="mini sp-act" data-copy="${esc(f.path)}" title="Copy the command, to paste into a terminal yourself" aria-label="${esc(`Copy the command for ${f.name}`)}">${copyIcon}</button>
      <button type="button" class="mini sp-act sp-pin${pinned ? " on" : ""}" data-pin="${esc(f.path)}" data-pinned="${pinned}" title="${pinned ? "Unpin" : "Pin to the top"}" aria-label="${esc(`${pinned ? "Unpin" : "Pin"} ${f.name}`)}">${starIcon(pinned)}</button>`}
    </div>`;
  }

  function looksLikePath(q) {
    return isRemote() ? /^(~|\/)/.test(q) : /^([A-Za-z]:[\\/]|\\\\|\/)/.test(q);
  }

  function listHtml() {
    const q = st.q.trim();
    if (q && looksLikePath(q)) return rowHtml({ path: q, name: "Use this path" }, { kind: "use" });
    if (q) {
      if (q.length < 2) return `<div class="sp-msg">Keep typing…</div>`;
      if (st.searching) return `<div class="sp-msg">Searching${isRemote() ? ` on ${esc(computerName(st.view))}` : ""}…</div>`;
      if (st.error) return `<div class="sp-msg error">${esc(st.error)}</div>`;
      if (!st.results?.length) return `<div class="sp-msg">No folder named like “${esc(q)}”.</div>`;
      return st.results.map((f) => rowHtml(f)).join("");
    }
    const f = st.folders.get(st.view);
    if (!f) return `<div class="sp-msg">${isRemote() ? `Looking on ${esc(computerName(st.view))}…` : "Loading…"}</div>`;
    const parts = [];
    if (f.pinned.length) parts.push(`<div class="sp-group">Pinned</div>${f.pinned.map((x) => rowHtml(x, { pinned: true })).join("")}`);
    if (f.recent.length) parts.push(`<div class="sp-group">Recent${st.loading ? ` <span class="sp-busy">…</span>` : ""}</div>${f.recent.map((x) => rowHtml(x)).join("")}`);
    if (f.error) parts.push(`<div class="sp-msg error">${esc(f.error)}</div>`);
    if (!f.pinned.length && !f.recent.length && !f.error) parts.push(`<div class="sp-msg">No folders yet. Search, or Browse….</div>`);
    const home = f.home ?? "~";
    if (![...f.pinned, ...f.recent].some((x) => x.path === home)) parts.push(`<div class="sp-sep"></div>${rowHtml({ path: home, name: "Home folder" })}`);
    return parts.join("");
  }

  function renderPop() {
    if (!st.data) {
      pop.innerHTML = `<div class="sp-msg">Loading…</div>`;
      return;
    }
    const chips = st.data.computers
      .map((c) => `<button type="button" class="sp-chip${c.id === st.view ? " on" : ""}" data-computer="${esc(c.id)}" role="tab" aria-selected="${c.id === st.view}">${esc(c.name)}</button>`)
      .join("");
    pop.innerHTML = `<div class="sp-head"><span class="sp-title">Start Pi on</span>
        <div class="sp-chips" role="tablist" aria-label="Computer">${chips}
          <button type="button" class="sp-chip sp-add" data-add-computer title="Add an SSH computer" aria-label="Add an SSH computer">+</button></div>
        ${isRemote() ? `<button type="button" class="icon-btn small sp-manage" data-manage title="${esc(`${computerName(st.view)}: test the connection, or remove it`)}" aria-label="Manage this computer">${gearIcon}</button>` : ""}
      </div>
      <input class="sp-search" type="search" value="${esc(st.q)}" placeholder="Search folders${isRemote() ? ` on ${esc(computerName(st.view))}` : ""}, or paste a path" aria-label="Search folders" spellcheck="false" autocomplete="off">
      <div class="sp-list">${listHtml()}</div>
      <div class="sp-foot"><button type="button" class="sp-browse" data-browse>${folderIcon}<span>Browse…</span></button></div>`;
  }

  function rerenderPop() {
    const box = pop.querySelector(".sp-search");
    const focused = document.activeElement === box;
    const caret = box?.selectionStart ?? 0;
    const scroll = pop.querySelector(".sp-list")?.scrollTop ?? 0;
    renderPop();
    place();
    const list = pop.querySelector(".sp-list");
    if (list) list.scrollTop = scroll;
    if (focused) {
      const again = pop.querySelector(".sp-search");
      again.focus();
      again.setSelectionRange(caret, caret);
    }
  }

  async function loadFolders(view = st.view) {
    const seq = ++st.seq;
    st.loading = true;
    rerenderPop();
    try {
      const out = await send(`/api/start/folders?${new URLSearchParams({ computer: view })}`, "GET");
      st.folders.set(view, out);
    } catch (error) {
      if (!st.folders.has(view)) st.folders.set(view, { pinned: [], recent: [], error: error.message });
    }
    if (seq === st.seq) st.loading = false;
    if (!pop.hidden && view === st.view) rerenderPop();
  }

  async function search() {
    const q = st.q.trim();
    if (!q || q.length < 2 || looksLikePath(q)) return rerenderPop();
    const seq = ++st.seq;
    st.searching = true;
    st.error = "";
    rerenderPop();
    try {
      const out = await send(`/api/start/folders?${new URLSearchParams({ computer: st.view, q })}`, "GET");
      if (seq !== st.seq) return;
      st.results = out.results;
    } catch (error) {
      if (seq !== st.seq) return;
      st.results = [];
      st.error = error.message;
    }
    st.searching = false;
    if (!pop.hidden) rerenderPop();
  }

  async function openPop() {
    pop.hidden = false;
    btn.classList.add("open");
    st.q = "";
    st.results = null;
    if (!st.data) await load();
    st.view = st.data?.current ?? LOCAL;
    renderPop();
    place();
    pop.querySelector(".sp-search")?.focus();
    void loadFolders();
  }

  function closePop() {
    pop.hidden = true;
    btn.classList.remove("open");
  }

  btn.addEventListener("click", () => (pop.hidden ? void openPop() : closePop()));

  async function switchTo(view) {
    st.view = view;
    st.q = "";
    st.results = null;
    rerenderPop();
    pop.querySelector(".sp-search")?.focus();
    // Remember the pick (the button shows it); the list loads meanwhile.
    void send("/api/start/computer", "PUT", { computer: view }).then((d) => {
      st.data = d;
      renderButton();
    }, () => {});
    void loadFolders(view);
  }

  async function start(path, computer = st.view) {
    closePop();
    const where = computer === LOCAL ? "" : ` on ${computerName(computer)}`;
    say(`Starting Pi in ${path}${where}…`);
    try {
      await send("/api/start/run", "POST", { computer, path });
      say(`Pi started in ${path}${where}, in a new terminal window ✓`, "ok");
      st.folders.delete(computer); // recent changed
    } catch (error) {
      say(error.message, "error");
    }
  }

  async function copy(path, computer = st.view) {
    try {
      if (computer !== LOCAL) say(`Getting ${computerName(computer)} ready…`);
      const { copy: line } = await send("/api/start/copy", "POST", { computer, path });
      try {
        await navigator.clipboard.writeText(line);
        say(`Copied. Paste it into a terminal to start Pi in ${path}${computer === LOCAL ? "" : ` on ${computerName(computer)}`}.`, "ok");
      } catch {
        say(line); // couldn't reach the clipboard: show it to copy by hand
      }
    } catch (error) {
      say(error.message, "error");
    }
  }

  pop.addEventListener("input", (event) => {
    if (!event.target.classList.contains("sp-search")) return;
    st.q = event.target.value;
    st.results = null;
    st.error = "";
    clearTimeout(st.timer);
    rerenderPop();
    st.timer = setTimeout(() => void search(), 300);
  });

  pop.addEventListener("keydown", (event) => {
    if (event.target.classList.contains("sp-search")) {
      const first = pop.querySelector("[data-go]");
      if (event.key === "Enter") {
        event.preventDefault();
        first?.click();
      } else if (event.key === "ArrowDown" && first) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.target.classList.contains("sp-go") && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const rows = [...pop.querySelectorAll(".sp-go")];
      const i = rows.indexOf(event.target) + (event.key === "ArrowDown" ? 1 : -1);
      (rows[i] ?? (i < 0 ? pop.querySelector(".sp-search") : null))?.focus();
    }
  });

  pop.addEventListener("click", async (event) => {
    const t = event.target;
    const chip = t.closest("[data-computer]");
    if (chip) {
      if (chip.dataset.computer !== st.view) void switchTo(chip.dataset.computer);
      return;
    }
    if (t.closest("[data-add-computer]")) {
      closePop();
      openComputer("");
      return;
    }
    if (t.closest("[data-manage]")) {
      const host = st.view;
      closePop();
      openComputer(host);
      return;
    }
    const go = t.closest("[data-go]");
    if (go) return void start(go.dataset.go);
    const cp = t.closest("[data-copy]");
    if (cp) {
      closePop();
      return void copy(cp.dataset.copy);
    }
    const pin = t.closest("[data-pin]");
    if (pin) {
      try {
        await send("/api/start/pin", "POST", { computer: st.view, path: pin.dataset.pin, pinned: pin.dataset.pinned !== "true" });
        st.q = "";
        await loadFolders();
      } catch (error) {
        say(error.message, "error");
      }
      return;
    }
    if (t.closest("[data-browse]")) {
      const view = st.view;
      closePop();
      if (view === LOCAL) {
        say("A folder window is open — it may be behind this one…");
        try {
          const out = await send("/api/start/choose-folder", "POST", {});
          say("");
          if (out.path) void start(out.path, LOCAL);
        } catch (error) {
          say(error.message, "error");
        }
      } else openBrowser(view);
    }
  });

  /* ── Browse… over SSH: Select remote folder ── */

  const rbEl = document.createElement("div");
  rbEl.className = "env-overlay env-rb-overlay";
  rbEl.hidden = true;
  document.body.append(rbEl);
  const rb = { host: "", path: "~", tilde: "", home: "", input: "", folders: [], filter: "", loading: false, error: "", seq: 0 };
  const homeIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5 12 5l8 6.5M6.5 10v9h11v-9"/></svg>`;
  const parentOf = (p) => (p === "/" ? "" : p.replace(/\/[^/]+$/, "") || "/");

  function crumbsHtml() {
    if (!rb.path.startsWith("/")) return "";
    const parts = rb.path.split("/").filter(Boolean);
    const links = parts.map((name, i) => {
      const to = `/${parts.slice(0, i + 1).join("/")}`;
      return i === parts.length - 1 ? `<span class="env-rb-here">${esc(name)}</span>` : `<button type="button" class="env-rb-crumb" data-rb-go="${esc(to)}">${esc(name)}</button>`;
    });
    return `<nav class="env-rb-crumbs" aria-label="Where you are">
      <button type="button" class="env-rb-crumb env-rb-home" data-rb-go="~" title="Home folder (${esc(rb.home || "~")})" aria-label="Home folder">${homeIcon}</button>
      <button type="button" class="env-rb-crumb" data-rb-go="/" title="/">/</button>${links.map((l) => `<span class="env-rb-sep">›</span>${l}`).join("")}</nav>`;
  }

  function renderBrowser() {
    const q = rb.filter.trim().toLowerCase();
    const shown = rb.folders.filter((n) => !q || n.toLowerCase().includes(q));
    const up = parentOf(rb.path);
    let list;
    if (rb.loading) list = `<div class="env-suggest-msg">Looking on ${esc(computerName(rb.host))}…</div>`;
    else {
      const rows = [];
      if (up && rb.path.startsWith("/") && !q) rows.push(`<button type="button" class="env-drop-item env-rb-item" data-rb-go="${esc(up)}">${folderIcon}<span>..</span></button>`);
      for (const n of shown) {
        const to = `${rb.path === "/" ? "" : rb.path}/${n}`;
        rows.push(`<button type="button" class="env-drop-item env-rb-item" data-rb-go="${esc(to)}" title="Open ${esc(n)}">${folderIcon}<span>${esc(n)}</span></button>`);
      }
      if (!shown.length && !rb.error) rows.push(`<div class="env-suggest-msg">${q ? "No folder here matches." : "No folders in here."}</div>`);
      list = rows.join("");
    }
    rbEl.innerHTML = `<div class="env-dialog env-rb" role="dialog" aria-modal="true" aria-labelledby="env-rb-title">
      <div class="env-dlg-head"><h2 id="env-rb-title">Start Pi on ${esc(computerName(rb.host))}: pick a folder</h2>
        <button type="button" class="icon-btn env-dlg-x" data-rb-close aria-label="Close" title="Close">✕</button></div>
      <form class="env-rb-pathrow" data-rb-form>
        <input class="env-drop-search env-rb-path" value="${esc(rb.input)}" aria-label="Folder path on ${esc(rb.host)}" spellcheck="false" autocomplete="off">
        <button type="submit" class="btn">Go</button>
      </form>
      ${crumbsHtml()}
      <input class="env-drop-search env-rb-filter" type="search" value="${esc(rb.filter)}" placeholder="Filter folders" aria-label="Filter folders" spellcheck="false" autocomplete="off">
      ${rb.error ? `<p class="env-form-msg">${esc(rb.error)}</p>` : ""}
      <div class="env-drop-list env-rb-list">${list}</div>
      <div class="env-dlg-foot">
        <button type="button" class="btn" data-rb-close>Cancel</button>
        <button type="button" class="btn" data-rb-copy${rb.loading || !rb.tilde ? " disabled" : ""} title="Copy the command for this folder instead">Copy command</button>
        <button type="button" class="btn primary" data-rb-start${rb.loading || !rb.tilde ? " disabled" : ""}>Start Pi here</button>
      </div>
    </div>`;
  }

  async function browse(path) {
    const seq = ++rb.seq;
    rb.loading = true;
    rb.error = "";
    rb.filter = "";
    renderBrowser();
    rbEl.querySelector(".env-rb-filter")?.focus();
    try {
      const out = await send(`/api/start/remote-dir?${new URLSearchParams({ host: rb.host, path })}`, "GET");
      if (seq !== rb.seq) return;
      Object.assign(rb, { path: out.path, tilde: out.tilde, home: out.home, input: out.path, folders: out.folders });
    } catch (err) {
      if (seq !== rb.seq) return;
      rb.error = err.message; // keep showing the last good folder
      rb.input = path;
    }
    rb.loading = false;
    if (!rbEl.hidden) {
      renderBrowser();
      rbEl.querySelector(".env-rb-filter")?.focus();
    }
  }

  function openBrowser(host) {
    Object.assign(rb, { host, path: "~", tilde: "", home: "", input: "~", folders: [], filter: "", error: "" });
    rbEl.hidden = false;
    void browse("~/projects");
  }

  function closeBrowser() {
    rb.seq++;
    rb.loading = false;
    rbEl.hidden = true;
    rbEl.innerHTML = "";
  }

  rbEl.addEventListener("click", (event) => {
    const t = event.target;
    if (t === rbEl || t.closest("[data-rb-close]")) return closeBrowser();
    const go = t.closest("[data-rb-go]");
    if (go && !rb.loading) return void browse(go.dataset.rbGo);
    if (t.closest("[data-rb-start]") && rb.tilde) {
      const { host, tilde } = rb;
      closeBrowser();
      void start(tilde, host);
    }
    if (t.closest("[data-rb-copy]") && rb.tilde) {
      const { host, tilde } = rb;
      closeBrowser();
      void copy(tilde, host);
    }
  });
  rbEl.addEventListener("submit", (event) => {
    event.preventDefault();
    const v = rbEl.querySelector(".env-rb-path")?.value.trim();
    if (v) void browse(v);
  });
  rbEl.addEventListener("input", (event) => {
    if (event.target.classList.contains("env-rb-path")) rb.input = event.target.value;
    if (!event.target.classList.contains("env-rb-filter")) return;
    rb.filter = event.target.value;
    const caret = event.target.selectionStart;
    renderBrowser();
    const box = rbEl.querySelector(".env-rb-filter");
    box.focus();
    box.setSelectionRange(caret, caret);
  });
  rbEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.classList.contains("env-rb-filter")) {
      event.preventDefault();
      if (rb.filter.trim()) rbEl.querySelector(".env-rb-item")?.click();
    }
  });

  /* ── Add computer / manage one: name, Test, Add (or Remove) ── */

  const cdEl = document.createElement("div");
  cdEl.className = "env-overlay";
  cdEl.hidden = true;
  document.body.append(cdEl);
  const cd = { host: "", existing: false, checks: null, testing: false, error: "", busy: false };

  function renderComputer() {
    const checks = cd.checks
      ? `<ul class="sp-checks">${cd.checks
          .map((c) => `<li class="${c.ok ? "ok" : "bad"}"><span class="sp-mark">${c.ok ? "✓" : "✗"}</span><span>${esc(c.label)}${!c.ok && c.fix ? `<span class="sp-fix">${esc(c.fix)}</span>` : ""}</span></li>`)
          .join("")}</ul>`
      : "";
    cdEl.innerHTML = `<div class="env-dialog sp-cd" role="dialog" aria-modal="true" aria-labelledby="sp-cd-title">
      <div class="env-dlg-head"><h2 id="sp-cd-title">${cd.existing ? esc(cd.host) : "Add an SSH computer"}</h2>
        <button type="button" class="icon-btn env-dlg-x" data-cd-close aria-label="Close" title="Close">✕</button></div>
      <form class="env-dlg-form" data-cd-form autocomplete="off">
        ${
          cd.existing
            ? ""
            : `<label class="env-field"><span>Computer</span><input name="host" value="${esc(cd.host)}" placeholder="What you type after ssh, e.g. aegis" spellcheck="false"></label>
               <p class="env-hint">It must log in without asking for a password (an SSH key).</p>`
        }
        <div class="sp-test-row"><button type="button" class="btn" data-cd-test${cd.testing ? " disabled" : ""}>${cd.testing ? "Testing…" : "Test"}</button>
          <span class="env-hint">Checks: login, tmux, Pi, the companion in Pi there, the tunnel's port.</span></div>
        ${checks}
        <p class="env-form-msg" role="status">${esc(cd.error)}</p>
        <div class="env-dlg-foot">
          ${cd.existing ? `<button type="button" class="btn danger" data-cd-remove title="Take it off the list (nothing there is touched)">Remove</button><span class="sp-grow"></span>` : ""}
          <button type="button" class="btn" data-cd-close>${cd.existing ? "Close" : "Cancel"}</button>
          ${cd.existing ? "" : `<button type="submit" class="btn primary"${cd.busy ? " disabled" : ""}>Add computer</button>`}
        </div>
      </form>
    </div>`;
  }

  function openComputer(host) {
    Object.assign(cd, { host, existing: Boolean(host), checks: null, testing: false, error: "", busy: false });
    cdEl.hidden = false;
    renderComputer();
    (cdEl.querySelector('[name="host"]') ?? cdEl.querySelector("[data-cd-test]"))?.focus();
    if (host) void test();
  }

  function closeComputer() {
    cdEl.hidden = true;
    cdEl.innerHTML = "";
  }

  async function test() {
    cd.host = cdEl.querySelector('[name="host"]')?.value.trim() ?? cd.host;
    if (!cd.host) {
      cd.error = "Fill in the computer first.";
      return renderComputer();
    }
    cd.testing = true;
    cd.error = "";
    cd.checks = null;
    renderComputer();
    try {
      cd.checks = (await send("/api/start/test", "POST", { host: cd.host })).checks;
    } catch (error) {
      cd.error = error.message;
    }
    cd.testing = false;
    if (!cdEl.hidden) renderComputer();
  }

  cdEl.addEventListener("input", (event) => {
    if (event.target.name === "host") {
      cd.host = event.target.value;
      cd.checks = null;
    }
  });
  cdEl.addEventListener("click", async (event) => {
    const t = event.target;
    if (t === cdEl || t.closest("[data-cd-close]")) return closeComputer();
    if (t.closest("[data-cd-test]")) return void test();
    if (t.closest("[data-cd-remove]")) {
      try {
        st.data = await send(`/api/start/computer?${new URLSearchParams({ host: cd.host })}`, "DELETE");
        st.folders.delete(cd.host);
        renderButton();
        closeComputer();
        say(`Removed ${cd.host} from the list.`, "ok");
      } catch (error) {
        cd.error = error.message;
        renderComputer();
      }
    }
  });
  cdEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    cd.host = cdEl.querySelector('[name="host"]')?.value.trim() ?? cd.host;
    cd.busy = true;
    cd.error = "";
    renderComputer();
    try {
      st.data = await send("/api/start/computer", "POST", { host: cd.host });
      renderButton();
      closeComputer();
      void openPop();
    } catch (error) {
      cd.busy = false;
      cd.error = error.message;
      renderComputer();
    }
  });

  /* ── closing ── */

  document.addEventListener(
    "click",
    (event) => {
      if (pop.hidden) return;
      if (pop.contains(event.target) || btn.contains(event.target)) return;
      closePop();
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!rbEl.hidden) closeBrowser();
    else if (!cdEl.hidden) closeComputer();
    else if (!pop.hidden) closePop();
  });
  window.addEventListener("resize", closePop);
  // Changed here or in another window (app.js forwards the server's "envs" message).
  window.addEventListener("companion-envs", () => {
    st.folders.clear();
    void load();
  });

  load();
})();
