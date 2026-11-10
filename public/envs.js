// Environments (like the Claude Code desktop app's environment picker): the bar at the bottom
// of the sidebar shows the picked one, with New session to start Pi there. Clicking the bar, or
// the "Workspaces" box at the top, opens the picker: search, Local and SSH groups, a check on the
// picked one, × to remove one, and + New environment — a dialog with Local / SSH tabs, a name,
// (SSH) the computer, and a folder: + Add opens a list to search, with your recent folders (or the
// ones in ~/projects over SSH) and Choose…: this computer's own folder window, or for SSH a
// "Select remote folder" window that lists the folders there one level at a time.
// The page names an environment id; the server builds what runs (server/envs.mjs). Never from
// the phone.
(function () {
  const esc = window.escapeHtml;
  const bar = document.getElementById("env-bar");
  const pickBtn = document.getElementById("env-pick");
  const newBtn = document.getElementById("env-new-session");
  const msgEl = document.getElementById("env-msg");
  const topBtn = document.querySelector('.nav-item[data-view="workspaces"]');
  if (!bar || !pickBtn || !newBtn) return;

  const page = { "x-pi-companion-page": "1" };
  const json = { "content-type": "application/json", ...page };
  const st = { data: null, q: "" };

  const current = () => st.data?.envs.find((e) => e.id === st.data.current);
  const sub = (e) => (e.kind === "ssh" ? `${e.host}${e.path === "~" ? "" : ` · ${e.path}`}` : e.path);
  const folderIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>`;

  async function send(url, method, body) {
    const res = await fetch(url, { method, headers: body ? json : page, body: body ? JSON.stringify(body) : undefined });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    return out;
  }

  /* ── the bar ── */

  function renderBar() {
    const e = current();
    pickBtn.querySelector(".env-name").textContent = e ? e.name : "This computer";
    pickBtn.querySelector(".env-kind").textContent = e?.kind === "ssh" ? "SSH" : "Local";
    pickBtn.title = e ? `${e.name}: ${sub(e)}\nClick to pick another environment` : "Pick an environment";
    newBtn.title = e ? `Start Pi in ${e.name} (${sub(e)})${e.kind === "ssh" ? ", in a tmux session there" : ""}` : "Start Pi";
    newBtn.disabled = st.data?.canOpen === false;
  }

  async function load() {
    try {
      const res = await fetch("/api/envs", { cache: "no-store" });
      if (res.ok) st.data = await res.json();
    } catch {
      // Server restarting: the "envs" message or the next click loads it.
    }
    renderBar();
    if (!picker.hidden) renderPicker();
  }

  function say(text, kind = "") {
    msgEl.textContent = text;
    msgEl.className = `env-msg ${kind}`;
    clearTimeout(say.timer);
    if (text && kind !== "error") say.timer = setTimeout(() => say(""), 6000);
  }

  newBtn.addEventListener("click", async () => {
    const e = current();
    if (!e) return;
    newBtn.disabled = true;
    say(`Starting Pi in ${e.name}…`);
    try {
      await send("/api/envs/start", "POST", { id: e.id });
      say(`Pi started in ${e.name}, in a new terminal window ✓`, "ok");
    } catch (error) {
      say(error.message, "error");
    } finally {
      newBtn.disabled = st.data?.canOpen === false;
    }
  });

  /* ── the picker ── */

  const picker = document.createElement("div");
  picker.className = "launch-menu env-menu";
  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-label", "Environments");
  picker.hidden = true;
  document.body.append(picker);
  let anchor = pickBtn;

  function placePicker() {
    const r = anchor.getBoundingClientRect();
    picker.style.left = "0px";
    picker.style.top = "0px";
    const w = picker.offsetWidth;
    const h = picker.offsetHeight;
    const top = anchor === pickBtn ? r.top - h - 6 : r.bottom + 4; // above the bar; below the box
    picker.style.left = `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`;
    picker.style.top = `${Math.max(8, Math.min(top, innerHeight - h - 8))}px`;
  }

  function itemHtml(e) {
    const picked = e.id === st.data.current;
    return `<div class="env-item${picked ? " picked" : ""}">
      <button type="button" class="env-choose" data-pick="${esc(e.id)}" role="option" aria-selected="${picked}">
        <span class="env-text"><span class="env-iname">${esc(e.name)}</span><span class="env-sub">${esc(sub(e))}</span></span>
        ${picked ? `<svg class="env-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>` : ""}
      </button>
      ${e.id === "local" ? "" : `<button type="button" class="mini env-remove" data-remove="${esc(e.id)}" aria-label="${esc(`Remove ${e.name}`)}" title="Remove (nothing on disk is touched)">×</button>`}
    </div>`;
  }

  function renderPicker() {
    if (!st.data) {
      picker.innerHTML = `<div class="launch-msg">Loading…</div>`;
      return;
    }
    const q = st.q.trim().toLowerCase();
    const match = (e) => !q || `${e.name} ${sub(e)}`.toLowerCase().includes(q);
    const local = st.data.envs.filter((e) => e.kind === "local" && match(e));
    const ssh = st.data.envs.filter((e) => e.kind === "ssh" && match(e));
    picker.innerHTML = `<input class="env-search" type="search" value="${esc(st.q)}" placeholder="Search environments" aria-label="Search environments" spellcheck="false">
      <div class="env-list" role="listbox" aria-label="Environments">
        ${local.length ? `<div class="env-group">Local</div>${local.map(itemHtml).join("")}` : ""}
        ${ssh.length ? `<div class="env-group">SSH</div>${ssh.map(itemHtml).join("")}` : ""}
        ${!local.length && !ssh.length ? `<div class="launch-msg">No environment matches.</div>` : ""}
      </div>
      <button type="button" class="env-add" data-new>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg> New environment
      </button>`;
  }

  function openPicker(from) {
    anchor = from;
    st.q = "";
    picker.hidden = false;
    from.classList.add("open");
    renderPicker();
    placePicker();
    picker.querySelector(".env-search")?.focus();
    void load().then(() => {
      if (!picker.hidden) {
        renderPicker();
        placePicker();
        picker.querySelector(".env-search")?.focus();
      }
    });
  }

  function closePicker() {
    picker.hidden = true;
    pickBtn.classList.remove("open");
    topBtn?.classList.remove("open");
  }

  pickBtn.addEventListener("click", () => (picker.hidden || anchor !== pickBtn ? openPicker(pickBtn) : closePicker()));
  topBtn?.setAttribute("aria-haspopup", "dialog");
  if (topBtn) topBtn.title = "Environments: pick where New session starts Pi, or add one";
  topBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    if (picker.hidden || anchor !== topBtn) openPicker(topBtn);
    else closePicker();
  });

  picker.addEventListener("input", (event) => {
    if (!event.target.classList.contains("env-search")) return;
    st.q = event.target.value;
    const caret = event.target.selectionStart;
    renderPicker();
    placePicker();
    const box = picker.querySelector(".env-search");
    box.focus();
    box.setSelectionRange(caret, caret);
  });
  picker.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.classList.contains("env-search")) {
      event.preventDefault();
      picker.querySelector("[data-pick]")?.click();
    }
  });
  picker.addEventListener("click", async (event) => {
    const t = event.target;
    if (t.closest("[data-new]")) {
      closePicker();
      openDialog();
      return;
    }
    const pick = t.closest("[data-pick]");
    if (pick) {
      try {
        st.data = await send("/api/envs/current", "PUT", { id: pick.dataset.pick });
        renderBar();
        closePicker();
      } catch (error) {
        say(error.message, "error");
      }
      return;
    }
    const remove = t.closest("[data-remove]");
    if (remove) {
      try {
        st.data = await send(`/api/envs?id=${encodeURIComponent(remove.dataset.remove)}`, "DELETE");
        renderBar();
        renderPicker();
        placePicker();
      } catch (error) {
        say(error.message, "error");
      }
    }
  });

  /* ── + New environment: a dialog ── */

  const overlay = document.createElement("div");
  overlay.className = "env-overlay";
  overlay.hidden = true;
  document.body.append(overlay);
  // f: the form's values; drop: the folder list under + Add.
  let f = { kind: "local", name: "", host: "", path: "" };
  let error = "";
  let busy = false;
  const drop = { open: false, q: "", items: null, loading: false, error: "", canChoose: true, seq: 0, timer: 0 };

  /** The SSH computers already used by saved environments, in the order first saved. */
  const savedHosts = () => [...new Set((st.data?.envs ?? []).filter((e) => e.kind === "ssh").map((e) => e.host))];
  let newHost = false; // "New computer…" picked: type one in

  function hostHtml() {
    const hosts = savedHosts();
    const typing = newHost || !hosts.length;
    const select = hosts.length
      ? `<select name="hostpick" aria-label="Computer">
          ${hosts.map((h) => `<option value="${esc(h)}"${!typing && h === f.host ? " selected" : ""}>${esc(h)}</option>`).join("")}
          <option value=""${typing ? " selected" : ""}>New computer…</option>
        </select>`
      : "";
    const input = typing ? `<input name="host" value="${esc(f.host)}" placeholder="What you type after ssh, e.g. aegis">` : "";
    return `<label class="env-field"><span>Computer</span>${select}${input}</label>`;
  }

  function folderBoxHtml() {
    if (!f.path) {
      return `<div class="env-folder-box empty">${f.kind === "ssh" ? "Optional: the folder there Pi works in. None = your home folder (~)." : "Optional: the folder Pi works in. None = your home folder."}</div>`;
    }
    return `<div class="env-folder-box">${folderIcon}<span class="env-folder-path" title="${esc(f.path)}">${esc(f.path)}</span>
      <button type="button" class="mini" data-clear-folder aria-label="Remove this folder" title="Remove">×</button></div>`;
  }

  function dropHtml() {
    if (!drop.open) return "";
    let list;
    if (f.kind === "ssh" && !f.host.trim()) list = `<div class="env-suggest-msg">Fill in Computer first; the list comes from there.</div>`;
    else if (drop.loading) list = `<div class="env-suggest-msg">${f.kind === "ssh" ? `Looking on ${esc(f.host.trim())}…` : "Looking…"}</div>`;
    else if (drop.error) list = `<div class="env-suggest-msg error">${esc(drop.error)}</div>`;
    else if (drop.items?.length) {
      list = drop.items
        .map(
          (x, i) => `<button type="button" class="env-drop-item" data-use="${i}" title="${esc(x.path)}">
            <span class="env-iname">${esc(x.name)}</span><span class="env-sub">${esc(x.path)}</span></button>`,
        )
        .join("");
    } else if (drop.items) {
      list = `<div class="env-suggest-msg">${drop.q.trim() ? `No folder named like “${esc(drop.q.trim())}”.` : "No folders yet — search, or Choose…"}</div>`;
    } else list = "";
    const choose = (f.kind === "ssh" ? f.host.trim() : drop.canChoose) ? `<div class="env-drop-sep"></div><button type="button" class="env-drop-item env-drop-choose" data-choose>${folderIcon}<span>Choose…</span></button>` : "";
    return `<div class="env-drop" role="dialog" aria-label="Pick a folder">
      <input class="env-drop-search" type="search" value="${esc(drop.q)}" placeholder="${f.kind === "ssh" ? "Search folders there, or type ~/path" : "Search folders, or paste a full path"}" aria-label="Search folders" spellcheck="false" autocomplete="off">
      <div class="env-drop-list">${list}</div>${choose}
    </div>`;
  }

  function renderDialog() {
    overlay.innerHTML = `<div class="env-dialog" role="dialog" aria-modal="true" aria-labelledby="env-dlg-title">
      <div class="env-dlg-head"><h2 id="env-dlg-title">New environment</h2>
        <button type="button" class="icon-btn env-dlg-x" data-close aria-label="Close" title="Close">✕</button></div>
      <div class="env-tabs" role="tablist">
        <button type="button" role="tab" data-tab="local" aria-selected="${f.kind === "local"}">Local</button>
        <button type="button" role="tab" data-tab="ssh" aria-selected="${f.kind === "ssh"}">SSH</button>
      </div>
      <form class="env-dlg-form" data-env-form autocomplete="off">
        <label class="env-field"><span>Name</span><input name="name" maxlength="60" value="${esc(f.name)}" placeholder="${f.kind === "ssh" ? "Aegis SSH charloop" : "My app"}"></label>
        ${
          f.kind === "ssh"
            ? hostHtml()
            : ""
        }
        <div class="env-folder">
          <div class="env-folder-head"><span><b>Folder</b> <span class="env-opt">(optional)</span></span>
            <button type="button" class="btn small" data-add-folder aria-expanded="${drop.open}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg> ${f.kind === "ssh" ? "Choose…" : f.path ? "Change" : "Add"}</button></div>
          ${folderBoxHtml()}
          ${dropHtml()}
        </div>
        ${f.kind === "ssh" ? `<p class="env-hint">It must log in without asking for a password. New session opens Pi in a tmux session named after the folder.</p>` : ""}
        <p class="env-form-msg" role="status">${esc(error)}</p>
        <div class="env-dlg-foot">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary"${busy ? " disabled" : ""}>Create environment</button>
        </div>
      </form>
    </div>`;
  }

  /** Re-render, keeping focus (and the caret) in the field that had it. */
  function rerender() {
    const active = document.activeElement;
    const which = overlay.contains(active) ? (active.name ? `[name="${active.name}"]` : active.classList.contains("env-drop-search") ? ".env-drop-search" : null) : null;
    const caret = which && typeof active.selectionStart === "number" ? active.selectionStart : null;
    renderDialog();
    if (which) {
      const again = overlay.querySelector(which);
      again?.focus();
      if (again && caret !== null) again.setSelectionRange(caret, caret);
    }
  }

  function readFields() {
    const form = overlay.querySelector("[data-env-form]");
    if (!form) return;
    f.name = form.querySelector('[name="name"]')?.value ?? f.name;
    const host = form.querySelector('[name="host"]');
    if (host) f.host = host.value;
  }

  function openDialog() {
    f = { kind: "local", name: "", host: "", path: "" };
    newHost = false;
    error = "";
    busy = false;
    Object.assign(drop, { open: false, q: "", items: null, loading: false, error: "" });
    overlay.hidden = false;
    renderDialog();
    overlay.querySelector('[name="name"]')?.focus();
  }

  function closeDialog() {
    overlay.hidden = true;
    overlay.innerHTML = "";
    drop.open = false;
  }

  async function loadDrop() {
    clearTimeout(drop.timer);
    const seq = ++drop.seq;
    const q = drop.q.trim();
    // A path typed or pasted: offer it as is.
    if (q && (f.kind === "ssh" ? /^(~|\/)/.test(q) : /^([A-Za-z]:[\\/]|\\\\|\/)/.test(q))) {
      drop.items = [{ path: q, name: "Use this path" }];
      drop.loading = false;
      drop.error = "";
      rerender();
      return;
    }
    if (q && !/^[\w.-]{2,60}$/.test(q)) {
      drop.items = [];
      drop.loading = false;
      drop.error = q.length < 2 ? "" : "Search for part of a folder name: letters, digits, . _ -";
      rerender();
      return;
    }
    if (f.kind === "ssh" && !f.host.trim()) {
      drop.items = null;
      rerender();
      return;
    }
    drop.loading = true;
    drop.error = "";
    rerender();
    try {
      const params = new URLSearchParams({ kind: f.kind, ...(q ? { q } : {}), ...(f.kind === "ssh" ? { host: f.host.trim() } : {}) });
      const res = await fetch(`/api/envs/folders?${params}`, { cache: "no-store", headers: page });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      if (seq !== drop.seq) return;
      drop.items = out.folders;
      drop.canChoose = out.canChoose !== false;
    } catch (err) {
      if (seq !== drop.seq) return;
      drop.items = null;
      drop.error = err.message;
    }
    drop.loading = false;
    if (!overlay.hidden && drop.open) rerender();
  }

  function useFolder(path, name) {
    f.path = path;
    if (!f.name.trim()) f.name = f.kind === "ssh" && path === "~" ? f.host.trim() : name && name !== "Use this path" ? name : path.split(/[\\/]/).filter(Boolean).pop() || path;
    drop.open = false;
    error = "";
    renderDialog();
    overlay.querySelector('button[type="submit"]')?.focus();
  }

  overlay.addEventListener("input", (event) => {
    if (event.target.classList.contains("env-drop-search")) {
      drop.q = event.target.value;
      clearTimeout(drop.timer);
      drop.timer = setTimeout(() => void loadDrop(), 300);
      return;
    }
    if (event.target.name === "host") {
      f.host = event.target.value;
      if (drop.open) {
        clearTimeout(drop.timer);
        drop.timer = setTimeout(() => void loadDrop(), 600);
      }
    }
    if (event.target.name === "name") f.name = event.target.value;
    if (event.target.name === "hostpick") {
      readFields();
      newHost = !event.target.value;
      f.host = event.target.value;
      f.path = ""; // a folder from the other computer doesn't apply
      renderDialog();
      overlay.querySelector(newHost ? '[name="host"]' : '[name="hostpick"]')?.focus();
    }
  });

  overlay.addEventListener("keydown", (event) => {
    if (event.target.classList.contains("env-drop-search")) {
      const first = overlay.querySelector("[data-use]");
      if (event.key === "Enter") {
        event.preventDefault();
        first?.click();
      } else if (event.key === "ArrowDown" && first) {
        event.preventDefault();
        first.focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        drop.open = false;
        rerender();
        overlay.querySelector("[data-add-folder]")?.focus();
      }
      return;
    }
    if (event.target.classList.contains("env-drop-item") && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const items = [...overlay.querySelectorAll(".env-drop-item")];
      const i = items.indexOf(event.target) + (event.key === "ArrowDown" ? 1 : -1);
      (items[i] ?? (i < 0 ? overlay.querySelector(".env-drop-search") : null))?.focus();
    }
  });

  overlay.addEventListener("click", async (event) => {
    const t = event.target;
    if (t === overlay || t.closest("[data-close]")) {
      closeDialog();
      return;
    }
    const tab = t.closest("[data-tab]");
    if (tab && tab.dataset.tab !== f.kind) {
      readFields();
      f.kind = tab.dataset.tab;
      if (f.kind === "ssh" && !f.host && !newHost) f.host = savedHosts()[0] ?? "";
      f.path = "";
      error = "";
      Object.assign(drop, { open: false, q: "", items: null, error: "" });
      renderDialog();
      overlay.querySelector(f.kind === "ssh" ? '[name="host"], [name="hostpick"]' : '[name="name"]')?.focus();
      return;
    }
    if (t.closest("[data-add-folder]") && f.kind === "ssh") {
      // SSH: straight to Select remote folder — click through the folders there, no typing.
      readFields();
      drop.open = false;
      if (!f.host.trim()) {
        error = "Fill in Computer first; the folders come from there.";
        rerender();
        overlay.querySelector('[name="host"], [name="hostpick"]')?.focus();
        return;
      }
      error = "";
      rerender();
      openBrowser();
      return;
    }
    if (t.closest("[data-add-folder]")) {
      readFields();
      drop.open = !drop.open;
      if (drop.open) {
        drop.q = "";
        drop.items = null;
        renderDialog();
        overlay.querySelector(".env-drop-search")?.focus();
        void loadDrop();
      } else rerender();
      return;
    }
    if (t.closest("[data-clear-folder]")) {
      f.path = "";
      renderDialog();
      return;
    }
    const use = t.closest("[data-use]");
    if (use) {
      readFields();
      const x = drop.items?.[Number(use.dataset.use)];
      if (x) useFolder(x.path, x.name);
      return;
    }
    if (t.closest("[data-choose]") && f.kind === "ssh") {
      readFields();
      drop.open = false;
      rerender();
      openBrowser();
      return;
    }
    if (t.closest("[data-choose]")) {
      readFields();
      const btn = t.closest("[data-choose]");
      btn.disabled = true;
      btn.querySelector("span").textContent = "A folder window is open — it may be behind this one…";
      try {
        const out = await send("/api/envs/choose-folder", "POST", { start: f.path || "" });
        if (out.path) useFolder(out.path, out.path.split(/[\\/]/).filter(Boolean).pop());
        else rerender();
      } catch (err) {
        drop.error = err.message;
        rerender();
      }
      return;
    }
    // A click elsewhere in the dialog closes the folder list.
    if (drop.open && !t.closest(".env-drop")) {
      readFields();
      drop.open = false;
      rerender();
    }
  });

  overlay.addEventListener("submit", async (event) => {
    event.preventDefault();
    readFields();
    if (!f.name.trim()) {
      error = "Give it a name.";
      rerender();
      overlay.querySelector('[name="name"]')?.focus();
      return;
    }
    busy = true;
    error = "";
    rerender();
    try {
      st.data = await send("/api/envs", "POST", { kind: f.kind, name: f.name, host: f.host, path: f.path });
      closeDialog();
      renderBar();
      say(`Picked ${current()?.name}. New session starts Pi there.`, "ok");
    } catch (err) {
      busy = false;
      error = err.message;
      rerender();
    }
  });

  /* ── Select remote folder (Choose… on the SSH tab) ── */

  const rbEl = document.createElement("div");
  rbEl.className = "env-overlay env-rb-overlay";
  rbEl.hidden = true;
  document.body.append(rbEl);
  // path: the folder shown (absolute once listed); tilde: the same with ~; input: the path box.
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
    if (rb.loading) list = `<div class="env-suggest-msg">Looking on ${esc(rb.host)}…</div>`;
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
      <div class="env-dlg-head"><h2 id="env-rb-title">Select remote folder</h2>
        <button type="button" class="icon-btn env-dlg-x" data-rb-close aria-label="Close" title="Close">✕</button></div>
      <form class="env-rb-pathrow" data-rb-form>
        <input class="env-drop-search env-rb-path" name="rbpath" value="${esc(rb.input)}" aria-label="Folder path on ${esc(rb.host)}" spellcheck="false" autocomplete="off">
        <button type="submit" class="btn">Go</button>
      </form>
      ${crumbsHtml()}
      <input class="env-drop-search env-rb-filter" type="search" value="${esc(rb.filter)}" placeholder="Filter folders" aria-label="Filter folders" spellcheck="false" autocomplete="off">
      ${rb.error ? `<p class="env-form-msg">${esc(rb.error)}</p>` : ""}
      <div class="env-drop-list env-rb-list">${list}</div>
      <div class="env-dlg-foot">
        <button type="button" class="btn" data-rb-close>Cancel</button>
        <button type="button" class="btn primary" data-rb-select${rb.loading || !rb.tilde ? " disabled" : ""}>Select folder</button>
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
      const params = new URLSearchParams({ host: rb.host, path });
      const res = await fetch(`/api/envs/remote-dir?${params}`, { cache: "no-store", headers: page });
      const out = await res.json().catch(() => ({}));
      if (seq !== rb.seq) return;
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
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

  function openBrowser() {
    Object.assign(rb, { host: f.host.trim(), path: "~", tilde: "", home: "", input: f.path || "~", folders: [], filter: "", error: "" });
    rbEl.hidden = false;
    void browse(f.path || "~");
  }

  function closeBrowser() {
    rb.seq++;
    rb.loading = false;
    rbEl.hidden = true;
    rbEl.innerHTML = "";
    overlay.querySelector("[data-add-folder]")?.focus();
  }

  rbEl.addEventListener("click", (event) => {
    const t = event.target;
    if (t === rbEl || t.closest("[data-rb-close]")) {
      closeBrowser();
      return;
    }
    const go = t.closest("[data-rb-go]");
    if (go && !rb.loading) {
      void browse(go.dataset.rbGo);
      return;
    }
    if (t.closest("[data-rb-select]") && rb.tilde) {
      const path = rb.tilde;
      closeBrowser();
      useFolder(path, path === "~" ? "" : path.split("/").pop());
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
    // Enter in the filter opens the first folder that matches.
    if (event.key === "Enter" && event.target.classList.contains("env-rb-filter")) {
      event.preventDefault();
      if (rb.filter.trim()) rbEl.querySelector(".env-rb-item")?.click();
    }
  });

  /* ── closing ── */

  document.addEventListener(
    "click",
    (event) => {
      if (picker.hidden) return;
      if (picker.contains(event.target) || pickBtn.contains(event.target) || topBtn?.contains(event.target)) return;
      closePicker();
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!rbEl.hidden) closeBrowser();
    else if (!overlay.hidden) {
      if (drop.open) {
        drop.open = false;
        rerender();
      } else closeDialog();
    } else if (!picker.hidden) closePicker();
  });
  window.addEventListener("resize", closePicker);
  // Changed here or in another window (app.js forwards the server's "envs" message).
  window.addEventListener("companion-envs", () => void load());

  load();
})();
