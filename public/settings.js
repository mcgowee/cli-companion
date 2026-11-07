// Settings page (#/settings): which CLIs to show and where their folders are, and which
// terminal Open uses. Saved by the server in ~/.cli-companion/settings.json.
(function () {
  const esc = window.escapeHtml;
  const root = document.getElementById("page-settings");
  let data = null; // GET /api/settings
  let status = { text: "", kind: "" };

  async function load() {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      data = res.ok ? await res.json() : null;
    } catch {
      data = null;
    }
  }

  function sourceCard(source) {
    const entry = data.settings.sources[source.id] ?? {};
    const on = entry.enabled !== false;
    const found = source.installed;
    const state = !on ? "Hidden" : found ? "Found" : "Not found";
    const where = source.folders[0]?.path;
    return `<fieldset class="set-card${on ? "" : " off"}" data-source="${esc(source.id)}">
      <legend class="sr-only">${esc(source.label)}</legend>
      <div class="set-card-head">
        <label class="switch"><input type="checkbox" name="enabled" ${on ? "checked" : ""}>
          <span class="set-name"><span class="src-dot" data-src="${esc(source.id)}"></span>${esc(source.label)}</span></label>
        <span class="set-state ${!on ? "muted" : found ? "ok" : "warn"}">${esc(state)}</span>
      </div>
      <p class="set-note">${
        on && where
          ? `${found ? "Reading" : "Looked in"} <code>${esc(where)}</code>${found ? "" : `. Start ${esc(source.label)} once, or set its folder below.`}`
          : on
            ? ""
            : `Its sessions and its entries in the terminal menu are hidden.`
      }</p>
      <label class="set-field">${esc(source.label)} folder
        <input name="folder" value="${esc(entry.folder ?? "")}" placeholder="${esc(source.home?.usual ?? "")} (usual place)" spellcheck="false" autocomplete="off">
      </label>
    </fieldset>`;
  }

  function render() {
    root.className = "page";
    if (!data) {
      root.innerHTML = `<div class="page-inner"><h1>Settings</h1><p class="page-lead">Couldn't load settings. Is the companion server running?</p></div>`;
      return;
    }
    const terminals = [{ id: "auto", label: autoLabel() }, ...data.terminals];
    root.innerHTML = `<div class="page-inner">
      <h1>Settings</h1>
      <p class="page-lead">Saved in <code>${esc(data.file)}</code>.</p>
      <form id="settings-form" autocomplete="off">
        <h2>CLIs</h2>
        <div class="set-cards">${data.sources.map(sourceCard).join("")}</div>
        <p class="set-hint">Leave a folder empty to use the usual place. Pi's live view comes from its extension and
          isn't affected by the folder.</p>

        <h2>Open in a terminal</h2>
        <label class="set-field narrow">Open uses
          <select name="terminal">${terminals
            .map((t) => `<option value="${esc(t.id)}" ${t.id === data.settings.terminal ? "selected" : ""}>${esc(t.label)}</option>`)
            .join("")}</select>
        </label>
        <p class="set-hint">For the terminal icon beside a workspace or session. Copy always works.</p>

        <div class="set-foot">
          <span class="set-status ${esc(status.kind)}" role="status">${esc(status.text)}</span>
          <button class="btn" type="button" id="settings-reset">Undo changes</button>
          <button class="btn primary" type="submit">Save</button>
        </div>
      </form>
    </div>`;
    root.querySelector("#settings-reset").addEventListener("click", () => {
      status = { text: "", kind: "" };
      render();
    });
    root.querySelector("#settings-form").addEventListener("change", (event) => {
      if (event.target.name === "enabled") event.target.closest(".set-card").classList.toggle("off", !event.target.checked);
    });
    root.querySelector("#settings-form").addEventListener("submit", save);
  }

  function autoLabel() {
    const first = data.terminals[0]?.label ?? "the first one found";
    return data.platform === "win32"
      ? "Automatic (Windows Terminal, else a PowerShell window)"
      : data.platform === "darwin"
        ? `Automatic (${first})`
        : "Automatic (the first one installed)";
  }

  async function save(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const sources = {};
    for (const card of form.querySelectorAll(".set-card")) {
      const enabled = card.querySelector('[name="enabled"]').checked;
      const folder = card.querySelector('[name="folder"]').value.trim();
      sources[card.dataset.source] = { ...(enabled ? {} : { enabled: false }), ...(folder ? { folder } : {}) };
    }
    const body = { sources, terminal: form.querySelector('[name="terminal"]').value };
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-companion-page": "1" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      data = out;
      status = { text: "Saved ✓", kind: "ok" };
    } catch (error) {
      status = { text: error.message, kind: "error" };
    }
    render();
  }

  window.settingsPage = {
    async show(active) {
      if (!active) return;
      status = { text: "", kind: "" };
      await load();
      render();
    },
  };
})();
