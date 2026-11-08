// Right panel ("workbench", like pi-gui's): Files and Review for the selected session's folder,
// and Apps: web addresses and .html files in the session's last exchange (reply and your message), to open here or pin to
// Dashboards. Read-only except New folder in Files. The server resolves the folder from the
// session id, never from a full path we send.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = window.escapeHtml;
  const md = window.renderMarkdown;
  const appEl = document.querySelector(".app");

  const ICON = {
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
    folderOpen:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 17.5V7.5a2 2 0 0 1 2-2h3.6l2 2h6.4a2 2 0 0 1 2 2v1"/><path d="M3.5 17.5l2.3-5.6a2 2 0 0 1 1.9-1.3H21a1 1 0 0 1 .9 1.4l-2.2 5.3a2 2 0 0 1-1.9 1.2H5.5a2 2 0 0 1-2-1z"/></svg>',
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/></svg>',
    folderPlus:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/></svg>',
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

  const wb = {
    open: loadPref("pi-companion.wbOpen", false) === true,
    tool: loadPref("pi-companion.wbTool", "files"),
    width: loadPref("pi-companion.wbWidth", 460),
    sessionId: null,
    cwd: null,
    history: null,
    // Files
    dirs: new Map(), // rel path -> entries | "loading" | { error }
    expanded: new Set([""]),
    file: null, // { path, data, mode }
    newFolder: null, // { parent, error, busy } while the name box is open
    // Review
    scope: "uncommitted",
    review: null,
    diff: null, // { path, text }
    reviewLoading: false,
    // Apps (from the last exchange)
    apps: null, // { for, apps } | { error }
    appsKey: "", // "<session> <reply id> <length>" the list is for (or loading)
    appView: null, // the app shown in the panel
    pinned: new Set(), // dashboard URLs
    seenApps: new Set(), // keys whose apps you've looked at (no dot)
  };

  function api(path, params) {
    const q = new URLSearchParams({ id: wb.sessionId, ...params });
    return fetch(`${path}?${q}`, { cache: "no-store" }).then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body;
    });
  }

  /* ── open / close / resize ───────────────────────────── */

  function applyLayout() {
    appEl.classList.toggle("bench-open", wb.open && Boolean(wb.sessionId));
    appEl.style.setProperty("--bench-size", `${wb.width}px`);
    $("workbench").hidden = !(wb.open && wb.sessionId);
    $("wb-toggle")?.classList.toggle("on", wb.open);
  }

  function setOpen(open) {
    wb.open = open;
    savePref("pi-companion.wbOpen", open);
    applyLayout();
    if (open) refreshTool();
  }

  $("wb-toggle").addEventListener("click", () => setOpen(!wb.open));
  $("wb-close").addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "b") {
      event.preventDefault();
      setOpen(!wb.open);
    }
  });

  const BENCH_DEFAULT = 460;
  // Keep at least 360 px for the transcript between the two panels.
  const clampBench = (w) => {
    const side = document.querySelector(".sidebar");
    const sideWidth = side && !appEl.classList.contains("sidebar-hidden") ? side.offsetWidth : 0;
    const max = Math.max(300, window.innerWidth - sideWidth - 360);
    return Math.round(Math.min(Math.max(w, 300), max));
  };
  function setBenchWidth(w, save = true) {
    wb.width = clampBench(w);
    appEl.style.setProperty("--bench-size", `${wb.width}px`);
    $("wb-resize").setAttribute("aria-valuenow", String(wb.width));
    if (save) savePref("pi-companion.wbWidth", wb.width);
  }
  setBenchWidth(Number(wb.width) || BENCH_DEFAULT, false);
  window.makeResizeHandle($("wb-resize"), {
    get: () => wb.width,
    set: setBenchWidth,
    direction: -1,
    reset: () => setBenchWidth(BENCH_DEFAULT),
  });

  for (const tab of document.querySelectorAll(".wb-tab")) {
    tab.addEventListener("click", () => {
      wb.tool = tab.dataset.tool;
      savePref("pi-companion.wbTool", wb.tool);
      renderTabs();
      refreshTool();
    });
  }

  function renderTabs() {
    for (const tab of document.querySelectorAll(".wb-tab")) {
      const active = tab.dataset.tool === wb.tool;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    }
    $("wb-files").hidden = wb.tool !== "files";
    $("wb-review").hidden = wb.tool !== "review";
    $("wb-apps").hidden = wb.tool !== "apps";
    renderAppsDot();
  }

  function refreshTool() {
    if (!wb.open || !wb.sessionId) return;
    if (wb.tool === "files") {
      if (!wb.dirs.has("")) loadDir("");
      renderFiles();
    } else if (wb.tool === "apps") {
      if (wb.appsKey) wb.seenApps.add(wb.appsKey);
      void loadPinned();
      renderApps();
      renderAppsDot();
    } else {
      loadReview();
    }
  }

  /* ── Files ───────────────────────────────────────────── */

  async function loadDir(path) {
    wb.dirs.set(path, "loading");
    renderFiles();
    try {
      const data = await api("/api/files", { path });
      wb.dirs.set(path, data.entries);
    } catch (error) {
      wb.dirs.set(path, { error: error.message });
    }
    renderFiles();
  }

  /** The name box for a new folder, shown first inside its parent. */
  function newFolderHtml(depth) {
    const nf = wb.newFolder;
    return `<form class="ft-new" style="--d:${depth}" data-new-folder>
        ${ICON.folder}<input name="name" placeholder="New folder name" aria-label="New folder name" spellcheck="false" autocomplete="off" ${nf.busy ? "disabled" : ""}>
      </form>${nf.error ? `<div class="ft-row error" style="--d:${depth}">${esc(nf.error)}</div>` : ""}`;
  }

  function treeHtml(path, depth) {
    const entries = wb.dirs.get(path);
    if (entries === "loading" || entries === undefined) return `<div class="ft-row muted" style="--d:${depth}">Loading…</div>`;
    if (entries.error) return `<div class="ft-row error" style="--d:${depth}">${esc(entries.error)}</div>`;
    const box = wb.newFolder?.parent === path ? newFolderHtml(depth) : "";
    if (!entries.length) return box || `<div class="ft-row muted" style="--d:${depth}">(empty)</div>`;
    return box + entries
      .map((entry) => {
        const rel = path ? `${path}/${entry.name}` : entry.name;
        if (entry.kind === "dir") {
          const open = wb.expanded.has(rel);
          return `<div class="ft-dir"><button class="ft-row dir" style="--d:${depth}" data-dir="${esc(rel)}" aria-expanded="${open}">${open ? ICON.folderOpen : ICON.folder}<span>${esc(entry.name)}</span></button><button class="ft-add" type="button" data-add-in="${esc(rel)}" title="New folder in ${esc(entry.name)}" aria-label="New folder in ${esc(entry.name)}">${ICON.folderPlus}</button></div>${open ? treeHtml(rel, depth + 1) : ""}`;
        }
        const active = wb.file?.path === rel ? " active" : "";
        return `<button class="ft-row file${active}" style="--d:${depth}" data-file="${esc(rel)}">${ICON.file}<span>${esc(entry.name)}</span></button>`;
      })
      .join("");
  }

  function renderFiles() {
    const el = $("wb-files");
    if (wb.file) {
      el.innerHTML = fileViewHtml();
      el.querySelector("[data-back]")?.addEventListener("click", () => {
        wb.file = null;
        renderFiles();
      });
      el.querySelector("[data-mode]")?.addEventListener("click", (e) => {
        wb.file.mode = e.currentTarget.dataset.mode;
        renderFiles();
      });
      return;
    }
    el.innerHTML = `<div class="wb-bar"><span class="wb-root" title="${esc(wb.cwd ?? "")}">${esc(wb.cwd ?? "")}</span>
        <button class="icon-btn small ft-newbtn" data-add-in="" title="New folder here" aria-label="New folder in the session folder">${ICON.folderPlus}</button>
        <button class="icon-btn small" data-refresh title="Refresh" aria-label="Refresh files">⟳</button></div>
      <div class="file-tree">${treeHtml("", 0)}</div>`;
    el.querySelector("[data-refresh]").addEventListener("click", () => {
      const open = [...wb.expanded];
      wb.dirs.clear();
      for (const p of open) loadDir(p);
    });
    for (const row of el.querySelectorAll("[data-dir]")) {
      row.addEventListener("click", () => {
        const p = row.dataset.dir;
        if (wb.expanded.has(p)) wb.expanded.delete(p);
        else {
          wb.expanded.add(p);
          if (!wb.dirs.has(p)) loadDir(p);
        }
        renderFiles();
      });
    }
    for (const row of el.querySelectorAll("[data-file]")) row.addEventListener("click", () => openFile(row.dataset.file));
    for (const button of el.querySelectorAll("[data-add-in]")) {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        startNewFolder(button.dataset.addIn);
      });
    }
    const form = el.querySelector("[data-new-folder]");
    if (form) {
      const input = form.querySelector("input");
      input.value = wb.newFolder.draft ?? "";
      if (!wb.newFolder.busy) input.focus();
      input.addEventListener("input", () => (wb.newFolder.draft = input.value));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          wb.newFolder = null;
          renderFiles();
        }
      });
      input.addEventListener("blur", () => {
        // Clicking away with nothing typed closes the box.
        setTimeout(() => {
          if (wb.newFolder && !wb.newFolder.busy && !input.value.trim() && document.activeElement !== input) {
            wb.newFolder = null;
            renderFiles();
          }
        }, 150);
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void createFolder(input.value);
      });
    }
  }

  function startNewFolder(parent) {
    wb.newFolder = { parent, draft: "", error: "", busy: false };
    if (parent) wb.expanded.add(parent);
    if (!wb.dirs.has(parent)) loadDir(parent);
    renderFiles();
  }

  async function createFolder(name) {
    const nf = wb.newFolder;
    if (!nf || nf.busy) return;
    if (!name.trim()) {
      wb.newFolder = null;
      renderFiles();
      return;
    }
    nf.busy = true;
    nf.error = "";
    renderFiles();
    try {
      const res = await fetch(`/api/folder?id=${encodeURIComponent(wb.sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-companion-page": "1" },
        body: JSON.stringify({ parent: nf.parent, name }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      wb.newFolder = null;
      await loadDir(nf.parent);
    } catch (error) {
      nf.busy = false;
      nf.error = error.message;
      nf.draft = name;
      renderFiles();
    }
  }

  async function openFile(path) {
    wb.tool = "files";
    renderTabs();
    wb.file = { path, data: null, mode: /\.(md|markdown)$/i.test(path) ? "preview" : "source" };
    renderFiles();
    try {
      wb.file.data = await api("/api/file", { path });
    } catch (error) {
      wb.file.data = { kind: "error", error: error.message };
    }
    if (wb.file?.path === path) renderFiles();
  }

  function fileViewHtml() {
    const f = wb.file;
    const isMd = /\.(md|markdown)$/i.test(f.path);
    const head = `<div class="wb-bar"><button class="icon-btn small" data-back title="Back to files" aria-label="Back to files">←</button>
      <span class="wb-path" title="${esc(f.path)}">${esc(f.path)}</span>
      ${isMd && f.data?.kind === "text" ? `<button class="chip" data-mode="${f.mode === "preview" ? "source" : "preview"}">${f.mode === "preview" ? "Source" : "Preview"}</button>` : ""}
      ${f.data?.kind === "text" ? composerChips(`file:${f.path}`, f.data.text, () => `\`${f.path}\`:\n${window.composer.fenced(f.data.text, langFor(f.path))}`) : ""}</div>`;
    const d = f.data;
    if (!d) return `${head}<div class="wb-empty">Loading…</div>`;
    if (d.kind === "error") return `${head}<div class="wb-empty error">${esc(d.error)}</div>`;
    if (d.kind === "image") {
      const src = `/api/file?${new URLSearchParams({ id: wb.sessionId, path: f.path, raw: "1" })}`;
      return `${head}<div class="img-view"><img src="${src}" alt="${esc(f.path)}"></div>`;
    }
    if (d.kind === "binary") return `${head}<div class="wb-empty">Binary file (${fmtSize(d.size)}).</div>`;
    if (d.kind === "too-big") return `${head}<div class="wb-empty">Too large to show here (${fmtSize(d.size)}).</div>`;
    if (isMd && f.mode === "preview") return `${head}<div class="md-view prose">${md(d.text)}</div>`;
    const lines = d.text.replace(/\n$/, "").split("\n");
    return `${head}<div class="code-view"><pre class="gutter">${lines.map((_, i) => i + 1).join("\n")}</pre><pre class="code">${esc(d.text)}</pre></div>`;
  }

  /** Copy (raw text) and Add (formatted for Pi) chips; texts are kept in composer.textRefs. */
  function composerChips(key, rawText, addText) {
    if (!window.composer) return "";
    window.composer.textRefs.set(`${key}#copy`, rawText);
    window.composer.textRefs.set(`${key}#add`, addText());
    return `<button class="chip" data-copy data-ref="${esc(`${key}#copy`)}">Copy</button><button class="chip" data-add data-ref="${esc(`${key}#add`)}" title="Add to the composer">Add</button>`;
  }

  function langFor(path) {
    const ext = (path.split(".").pop() ?? "").toLowerCase();
    const map = { js: "js", mjs: "js", cjs: "js", ts: "ts", tsx: "tsx", jsx: "jsx", py: "python", ps1: "powershell", sh: "bash", md: "markdown", json: "json", yml: "yaml", yaml: "yaml", css: "css", html: "html", rs: "rust", go: "go", java: "java", cs: "csharp", sql: "sql", toml: "toml" };
    return map[ext] ?? "";
  }

  function fmtSize(n) {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
  }

  /* ── Review ──────────────────────────────────────────── */

  async function loadReview() {
    if (wb.reviewLoading) return;
    wb.reviewLoading = true;
    if (!wb.review) renderReview();
    try {
      wb.review = await api("/api/review", { scope: wb.scope });
    } catch (error) {
      wb.review = { error: error.message };
    } finally {
      wb.reviewLoading = false;
    }
    renderReview();
    if (wb.diff) loadDiff(wb.diff.path, true);
  }

  async function loadDiff(path, quiet = false) {
    if (!quiet) {
      wb.diff = { path, text: null };
      renderReview();
    }
    try {
      const { text } = await api("/api/review/diff", { scope: wb.scope, path });
      if (wb.diff?.path === path) wb.diff.text = text;
    } catch (error) {
      if (wb.diff?.path === path) wb.diff.text = `Could not load diff: ${error.message}`;
    }
    renderReview();
  }

  /** Files Pi edited or wrote in this session, relative to the workspace when inside it. */
  function sessionChanges() {
    const out = new Map();
    const root = (wb.cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    for (const item of wb.history?.items ?? []) {
      for (const call of item.toolCalls ?? []) {
        if (!/^(edit|write|multi_?edit|apply_?patch|create)$/i.test(call.name)) continue;
        const m = String(call.args ?? "").match(/"(?:path|file_path|filePath)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (!m) continue;
        let p;
        try {
          p = JSON.parse(`"${m[1]}"`);
        } catch {
          p = m[1];
        }
        let rel = p.replace(/\\/g, "/");
        if (root && rel.toLowerCase().startsWith(`${root.toLowerCase()}/`)) rel = rel.slice(root.length + 1);
        const entry = out.get(rel) ?? { path: rel, count: 0, inside: !/^([a-zA-Z]:|\/)/.test(rel) };
        entry.count += 1;
        out.set(rel, entry);
      }
    }
    return [...out.values()];
  }

  function diffHtml(text) {
    return text
      .split("\n")
      .map((line) => {
        let cls = "";
        if (line.startsWith("@@")) cls = "hunk";
        else if (line.startsWith("+++") || line.startsWith("---") || /^(diff|index|new file|deleted file|similarity|rename) /.test(line)) cls = "meta";
        else if (line.startsWith("+")) cls = "add";
        else if (line.startsWith("-")) cls = "del";
        return `<span class="dl ${cls}">${esc(line) || " "}</span>`;
      })
      .join("");
  }

  const STATUS = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", "?": "Untracked", T: "Type changed", U: "Conflict" };

  function renderReview() {
    const el = $("wb-review");
    if (wb.diff) {
      el.innerHTML = `<div class="wb-bar"><button class="icon-btn small" data-back title="Back to changes" aria-label="Back to changes">←</button>
          <span class="wb-path" title="${esc(wb.diff.path)}">${esc(wb.diff.path)}</span>
          ${wb.diff.text ? composerChips(`diff:${wb.diff.path}`, wb.diff.text, () => `Changes in \`${wb.diff.path}\`:\n${window.composer.fenced(wb.diff.text, "diff")}`) : ""}
          <button class="chip" data-open-file>Open file</button></div>
        ${wb.diff.text === null ? `<div class="wb-empty">Loading…</div>` : `<pre class="diff-view">${diffHtml(wb.diff.text)}</pre>`}`;
      el.querySelector("[data-back]").addEventListener("click", () => {
        wb.diff = null;
        renderReview();
      });
      el.querySelector("[data-open-file]").addEventListener("click", () => {
        const prefix = wb.review?.prefix ? `${wb.review.prefix}/` : "";
        const p = wb.diff.path.startsWith(prefix) ? wb.diff.path.slice(prefix.length) : wb.diff.path;
        openFile(p);
      });
      return;
    }

    const r = wb.review;
    const scopeBar = `<div class="wb-bar">
        <div class="seg" role="radiogroup" aria-label="Compare">
          <button class="${wb.scope === "uncommitted" ? "on" : ""}" data-scope="uncommitted" role="radio" aria-checked="${wb.scope === "uncommitted"}">Uncommitted</button>
          <button class="${wb.scope === "branch" ? "on" : ""}" data-scope="branch" role="radio" aria-checked="${wb.scope === "branch"}">Branch</button>
        </div>
        <span class="wb-root">${r?.git ? `${esc(r.branch ?? "")}${r.base ? ` vs ${esc(r.base)}` : ""}` : ""}</span>
        <button class="icon-btn small" data-refresh title="Refresh" aria-label="Refresh changes">⟳</button>
      </div>`;

    let body;
    if (!r) body = `<div class="wb-empty">Loading…</div>`;
    else if (r.error) body = `<div class="wb-empty error">${esc(r.error)}</div>`;
    else if (!r.git) body = `<div class="wb-empty">This folder is not a git repository.</div>`;
    else if (r.note && !r.files.length) body = `<div class="wb-empty">${esc(r.note)}</div>`;
    else if (!r.files.length) body = `<div class="wb-empty">No changes.</div>`;
    else {
      body = `<div class="review-list">${r.files
        .map((f) => {
          const name = f.path.split("/").pop();
          const dir = f.path.slice(0, f.path.length - name.length);
          const counts =
            f.added === undefined || f.added === null
              ? ""
              : `<span class="cnt"><span class="plus">+${f.added}</span> <span class="minus">−${f.removed}</span></span>`;
          return `<button class="rv-row" data-path="${esc(f.path)}" title="${esc(STATUS[f.status] ?? f.status)}: ${esc(f.path)}">
              <span class="st st-${f.status === "?" ? "u" : esc(f.status.toLowerCase())}">${f.status === "?" ? "U" : esc(f.status)}</span>
              <span class="rv-name">${esc(name)}<span class="rv-dir">${esc(dir)}</span></span>${counts}</button>`;
        })
        .join("")}</div>`;
    }

    const changes = sessionChanges();
    const sessionBlock = changes.length
      ? `<div class="wb-section">Changed in this session</div><div class="review-list">${changes
          .map(
            (c) => `<button class="rv-row" data-session-path="${esc(c.path)}" ${c.inside ? "" : "disabled"} title="${esc(c.path)}">
              <span class="st st-s">${c.count}×</span><span class="rv-name">${esc(c.path)}</span></button>`,
          )
          .join("")}</div>`
      : "";

    el.innerHTML = `${scopeBar}${body}${sessionBlock}`;
    for (const b of el.querySelectorAll("[data-scope]")) {
      b.addEventListener("click", () => {
        wb.scope = b.dataset.scope;
        wb.review = null;
        loadReview();
      });
    }
    el.querySelector("[data-refresh]").addEventListener("click", () => loadReview());
    for (const row of el.querySelectorAll("[data-path]")) row.addEventListener("click", () => loadDiff(row.dataset.path));
    for (const row of el.querySelectorAll("[data-session-path]")) {
      row.addEventListener("click", () => {
        const p = row.dataset.sessionPath;
        const prefix = wb.review?.prefix ? `${wb.review.prefix}/` : "";
        const inReview = wb.review?.files?.find((f) => f.path === `${prefix}${p}` || f.path === p);
        if (inReview) loadDiff(inReview.path);
        else openFile(p);
      });
    }
  }

  /* ── Apps ────────────────────────────────────────────── */

  /** The CLI's last text after your last message (same rule as the server): its key, or "". */
  function finalReplyKey(sessionId, items) {
    if (!Array.isArray(items)) return "";
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      const text = String(item?.text ?? "").trim();
      if (item?.kind === "user" && text) return "";
      if (item?.kind === "assistant" && text) return `${sessionId} ${item.id ?? i} ${text.length}`;
    }
    return "";
  }

  async function loadApps(key) {
    wb.appsKey = key;
    wb.apps = null;
    if (wb.tool === "apps" && wb.open) wb.seenApps.add(key);
    renderApps();
    let data;
    try {
      const res = await fetch(`/api/apps?id=${encodeURIComponent(wb.sessionId)}`, {
        cache: "no-store",
        headers: { "x-pi-companion-page": "1" },
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok) data = { error: data.error || `HTTP ${res.status}` };
    } catch {
      data = { error: "Couldn't reach the companion server." };
    }
    if (key !== wb.appsKey) return;
    wb.apps = data;
    if (wb.appView && !wb.appView.fromLink && !data.apps?.some((a) => a.url === wb.appView.url)) wb.appView = null;
    renderApps();
    renderAppsDot();
  }

  async function loadPinned() {
    try {
      const res = await fetch("/api/dashboards", { cache: "no-store" });
      const data = await res.json();
      wb.pinned = new Set((data.dashboards ?? []).map((d) => d.url));
      renderApps();
    } catch {
      // keep what we had
    }
  }

  const absUrl = (app) => new URL(app.url, location.origin).href;

  async function pinApp(app, button) {
    button.disabled = true;
    try {
      const res = await fetch("/api/dashboards", {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-companion-page": "1" },
        body: JSON.stringify({ name: app.name.slice(0, 80), url: absUrl(app), description: wb.cwd ? `From ${wb.cwd}` : "" }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      wb.pinned.add(out.url);
    } catch (error) {
      button.title = error.message;
    }
    renderApps();
  }

  function renderAppsDot() {
    const list = wb.apps?.apps ?? [];
    const fresh = list.length > 0 && Boolean(wb.appsKey) && !wb.seenApps.has(wb.appsKey);
    $("apps-dot").hidden = !fresh;
    $("wb-toggle")?.classList.toggle("has-apps", fresh && !wb.open);
  }

  const TYPE_LABEL = { html: "HTML file", image: "Image", video: "Video", audio: "Audio", pdf: "PDF", text: "Text" };

  /** What an opened item shows: web pages sandboxed; media in players; text as text. */
  function appViewer(app) {
    const src = esc(app.url);
    const title = esc(app.name);
    switch (app.kind === "url" ? "url" : app.type) {
      case "image":
        return `<div class="app-media"><img src="${src}" alt="${title}"></div>`;
      case "video":
        return `<div class="app-media"><video src="${src}" controls preload="metadata" title="${title}"></video></div>`;
      case "audio":
        return `<div class="app-media"><audio src="${src}" controls preload="metadata" title="${title}"></audio></div>`;
      case "pdf":
        return `<iframe class="app-frame" src="${src}" title="${title}"></iframe>`;
      case "text":
        return `<div class="app-text">Loading…</div>`;
      default:
        return `<iframe class="app-frame" src="${src}" title="${title}"
          sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads${app.kind === "url" ? " allow-same-origin" : ""}"></iframe>`;
    }
  }

  async function loadAppText(app, box) {
    try {
      const res = await fetch(app.url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let text = await res.text();
      const cut = text.length > 400_000;
      if (cut) text = text.slice(0, 400_000);
      if (!box.isConnected) return;
      box.innerHTML = /.md$/i.test(app.path ?? "")
        ? `<div class="prose">${window.renderMarkdown(text)}</div>`
        : `<pre>${esc(text)}</pre>`;
      if (cut) box.insertAdjacentHTML("beforeend", `<p class="wb-note">Only the first 400 KB is shown.</p>`);
    } catch (error) {
      if (box.isConnected) box.innerHTML = `<p class="wb-empty error">Couldn't load it: ${esc(error.message)}</p>`;
    }
  }

  function renderApps() {
    const el = $("wb-apps");
    if (wb.tool !== "apps") return;
    if (wb.appView) {
      const app = wb.appView;
      el.innerHTML = `<div class="app-bar">
          <button class="app-back" type="button">← Apps</button>
          <span class="app-title" title="${esc(app.name)}">${esc(app.name)}</span>
          <a class="btn small" href="${esc(app.url)}" target="_blank" rel="noopener">Open in browser</a>
        </div>
        ${appViewer(app)}`;
      if (app.type === "text") void loadAppText(app, el.querySelector(".app-text"));
      el.querySelector(".app-back").addEventListener("click", () => {
        wb.appView = null;
        renderApps();
      });
      return;
    }
    if (!wb.appsKey) {
      el.innerHTML = `<p class="wb-empty">Apps and files appear here when the session's last reply mentions one: a local
        web address (like http://localhost:5173), or a page, image, video, audio, PDF or text file in its folder.</p>`;
      return;
    }
    if (!wb.apps) {
      el.innerHTML = `<p class="wb-empty">Looking at the last reply…</p>`;
      return;
    }
    if (wb.apps.error) {
      el.innerHTML = `<p class="wb-empty error">${esc(wb.apps.error)}</p>`;
      return;
    }
    const list = wb.apps.apps ?? [];
    if (!list.length) {
      el.innerHTML = `<p class="wb-empty">Nothing in the last reply. When it mentions a local web address, or a page,
        image, video, audio, PDF or text file in this folder, it shows up here.</p>`;
      return;
    }
    el.innerHTML = `<p class="wb-note">From the session's last reply.</p><div class="app-list">${list
      .map((app, i) => {
        const pinned = wb.pinned.has(absUrl(app));
        const state =
          app.kind === "file"
            ? `<span class="app-kind">${esc(TYPE_LABEL[app.type] ?? "File")}</span>`
            : app.online === false
              ? `<span class="app-kind off">Not running</span>`
              : `<span class="app-kind on">Running</span>`;
        return `<div class="app-row">
          <button class="app-open" type="button" data-i="${i}" title="Open ${esc(app.name)} here">
            <span class="app-name">${esc(app.name)}</span>${state}
          </button>
          <a class="app-ext" href="${esc(app.url)}" target="_blank" rel="noopener" title="Open in browser" aria-label="Open ${esc(app.name)} in browser">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>
          </a>
          ${
            app.kind === "url" || app.type === "html"
              ? `<button class="btn small app-pin" type="button" data-i="${i}" ${pinned ? "disabled" : ""}>${pinned ? "Pinned ✓" : "Pin to Dashboards"}</button>`
              : ""
          }
        </div>`;
      })
      .join("")}</div>`;
    for (const button of el.querySelectorAll(".app-open")) {
      button.addEventListener("click", () => {
        wb.appView = list[Number(button.dataset.i)];
        renderApps();
      });
    }
    for (const button of el.querySelectorAll(".app-pin")) {
      button.addEventListener("click", () => void pinApp(list[Number(button.dataset.i)], button));
    }
  }

  /** A turn finished: look for apps in its final reply (once per reply). */
  function considerApps(history, working) {
    if (!wb.sessionId) return;
    const key = working ? "" : finalReplyKey(wb.sessionId, history?.items);
    if (key === wb.appsKey) return;
    if (!key) {
      // Working, or the session ends on your message: keep this session's last list.
      if (!wb.appsKey.startsWith(`${wb.sessionId} `)) {
        wb.appsKey = "";
        wb.apps = null;
        wb.appView = null;
        renderApps();
        renderAppsDot();
      }
      return;
    }
    void loadApps(key);
  }

  /* ── file links in the transcript ────────────────────── */

  async function openFileLink(link) {
    if (!wb.sessionId) return;
    const path = link.dataset.filePath;
    try {
      const file = await api("/api/app-file", { path });
      if (!wb.open) setOpen(true);
      if (file.type) {
        wb.tool = "apps";
        wb.appView = { ...file, fromLink: true };
        renderTabs();
        renderApps();
      } else {
        await openFile(file.path);
      }
    } catch (error) {
      link.classList.add("missing");
      link.title = error.message;
    }
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a.file-link");
    if (!link) return;
    event.preventDefault();
    void openFileLink(link);
  });

  /* ── hooks from app.js ───────────────────────────────── */

  window.workbench = {
    /** The selected session changed (or its history reloaded). */
    update({ sessionId, cwd, history, historyChanged, working = false }) {
      const workspaceChanged = (cwd ?? "").toLowerCase() !== (wb.cwd ?? "").toLowerCase();
      const sessionChanged = sessionId !== wb.sessionId;
      wb.sessionId = sessionId;
      wb.cwd = cwd ?? wb.cwd;
      wb.history = history;
      if (workspaceChanged) {
        wb.newFolder = null;
        wb.dirs.clear();
        wb.expanded = new Set([""]);
        wb.file = null;
        wb.review = null;
        wb.diff = null;
      }
      if (sessionChanged) wb.appView = null;
      considerApps(history, working);
      applyLayout();
      renderAppsDot();
      if (!wb.open || !sessionId) return;
      if (workspaceChanged || sessionChanged) refreshTool();
      else if (historyChanged && wb.tool === "review") loadReview();
      else if (wb.tool === "review") renderReview();
    },
  };

  renderTabs();
  applyLayout();
})();
