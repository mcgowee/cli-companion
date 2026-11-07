// Right panel ("workbench", like pi-gui's): Files and Review for the selected session's folder.
// Read-only. The server resolves the folder from the session id, never from a path we send.
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
    // Review
    scope: "uncommitted",
    review: null,
    diff: null, // { path, text }
    reviewLoading: false,
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
  }

  function refreshTool() {
    if (!wb.open || !wb.sessionId) return;
    if (wb.tool === "files") {
      if (!wb.dirs.has("")) loadDir("");
      renderFiles();
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

  function treeHtml(path, depth) {
    const entries = wb.dirs.get(path);
    if (entries === "loading" || entries === undefined) return `<div class="ft-row muted" style="--d:${depth}">Loading…</div>`;
    if (entries.error) return `<div class="ft-row error" style="--d:${depth}">${esc(entries.error)}</div>`;
    if (!entries.length) return `<div class="ft-row muted" style="--d:${depth}">(empty)</div>`;
    return entries
      .map((entry) => {
        const rel = path ? `${path}/${entry.name}` : entry.name;
        if (entry.kind === "dir") {
          const open = wb.expanded.has(rel);
          return `<button class="ft-row dir" style="--d:${depth}" data-dir="${esc(rel)}" aria-expanded="${open}">${open ? ICON.folderOpen : ICON.folder}<span>${esc(entry.name)}</span></button>${open ? treeHtml(rel, depth + 1) : ""}`;
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

  /* ── hooks from app.js ───────────────────────────────── */

  window.workbench = {
    /** The selected session changed (or its history reloaded). */
    update({ sessionId, cwd, history, historyChanged }) {
      const workspaceChanged = (cwd ?? "").toLowerCase() !== (wb.cwd ?? "").toLowerCase();
      const sessionChanged = sessionId !== wb.sessionId;
      wb.sessionId = sessionId;
      wb.cwd = cwd ?? wb.cwd;
      wb.history = history;
      if (workspaceChanged) {
        wb.dirs.clear();
        wb.expanded = new Set([""]);
        wb.file = null;
        wb.review = null;
        wb.diff = null;
      }
      applyLayout();
      if (!wb.open || !sessionId) return;
      if (workspaceChanged || sessionChanged) refreshTool();
      else if (historyChanged && wb.tool === "review") loadReview();
      else if (wb.tool === "review") renderReview();
    },
  };

  renderTabs();
  applyLayout();
})();
