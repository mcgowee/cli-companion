// Settings page (#/settings): which CLIs to show and where their folders are, which terminal
// Open uses, and suggested replies (a local Ollama model). Saved by the server in
// ~/.cli-companion/settings.json. Also the Shortcut buttons (Start menu / desktop), which act at once.
(function () {
  const esc = window.escapeHtml;
  const root = document.getElementById("page-settings");
  let data = null; // GET /api/settings
  let models = null; // GET /api/suggest/models: { url, models } or { error }
  let status = { text: "", kind: "" };
  let shortcut = null; // GET /api/shortcut

  async function load() {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      data = res.ok ? await res.json() : null;
    } catch {
      data = null;
    }
    try {
      const res = await fetch("/api/suggest/models", { cache: "no-store", headers: { "x-pi-companion-page": "1" } });
      models = await res.json();
    } catch {
      models = { error: "Couldn't ask the companion server." };
    }
    try {
      const res = await fetch("/api/shortcut", { cache: "no-store" });
      shortcut = res.ok ? await res.json() : null;
    } catch {
      shortcut = null;
    }
  }

  // Shortcut: buttons that act at once (not part of Save).
  function shortcutHtml() {
    if (!shortcut) return "";
    if (!shortcut.supported) return `<h2>Shortcut</h2><p class="set-hint">Shortcuts aren't supported on this system yet.</p>`;
    const names = { start: data.platform === "win32" ? "Start menu" : "Applications menu", desktop: "Desktop" };
    const rows = Object.entries(shortcut.places)
      .map(
        ([place, p]) => `<div class="sc-row">
          <span><b>${esc(names[place] ?? place)}</b> <small>${p.exists ? "added" : "not added"}</small></span>
          <button class="btn small" type="button" data-shortcut="${esc(place)}" data-on="${p.exists ? "0" : "1"}">${p.exists ? "Remove" : "Add"}</button>
        </div>`,
      )
      .join("");
    return `<h2>Shortcut</h2>
      <p class="set-hint">A <b>CLI Companion</b> shortcut starts the companion if it isn't running and opens this window, with no
        terminal. Pin it to the taskbar or Start from its right-click menu. Takes effect at once.</p>
      <div class="sc-list">${rows}</div>
      <p class="set-status sc-status" role="status"></p>`;
  }

  async function toggleShortcut(button) {
    button.disabled = true;
    const note = root.querySelector(".sc-status");
    try {
      const res = await fetch("/api/shortcut", {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-companion-page": "1" },
        body: JSON.stringify({ place: button.dataset.shortcut, on: button.dataset.on === "1" }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      shortcut = out;
      render();
    } catch (error) {
      button.disabled = false;
      if (note) {
        note.textContent = error.message;
        note.className = "set-status sc-status error";
      }
    }
  }

  function appearanceHtml() {
    const look = { theme: "system", showCost: true, showGit: true, clock: "auto", ...(data.settings.appearance ?? {}) };
    const themes = [
      ["system", "Match this computer"],
      ["light", "Light"],
      ["dark", "Dark"],
    ];
    const sample = (clock) => new Date(2026, 0, 1, 15, 30).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...(clock === "12" ? { hour12: true } : clock === "24" ? { hourCycle: "h23" } : {}) });
    const clocks = [
      ["auto", `Match this computer (${sample("auto")})`],
      ["12", `12-hour (${sample("12")})`],
      ["24", `24-hour (${sample("24")})`],
    ];
    return `<label class="set-field narrow">Theme
        <select name="theme">${themes.map(([id, label]) => `<option value="${id}" ${id === look.theme ? "selected" : ""}>${label}</option>`).join("")}</select>
      </label>
      <label class="set-field narrow">Times
        <select name="clock">${clocks.map(([id, label]) => `<option value="${id}" ${id === look.clock ? "selected" : ""}>${label}</option>`).join("")}</select>
      </label>
      <label class="switch set-check"><input type="checkbox" name="show-cost" ${look.showCost ? "checked" : ""}>
        <span>Show cost estimates</span></label>
      <p class="set-hint">In the session header and Usage overview. Token counts always show. Turn off if you're on a
        subscription and the API-price estimates are just noise.</p>
      <label class="switch set-check"><input type="checkbox" name="show-git" ${look.showGit ? "checked" : ""}>
        <span>Show git branch and changes</span></label>
      <p class="set-hint">On Active and Favorites rows and in the session header (runs <code>git status</code> in those folders every 20 seconds).
        Text size: use your browser's zoom (Ctrl + plus / minus).</p>`;
  }

  function suggestCard() {
    const current = data.settings.suggest ?? { enabled: false, model: "" };
    const list = models?.models ?? [];
    const known = list.some((m) => m.name === current.model);
    const options = [
      `<option value="">${list.length ? "Choose a model…" : "No local models found"}</option>`,
      ...(current.model && !known ? [`<option value="${esc(current.model)}" selected>${esc(current.model)} (not found)</option>`] : []),
      ...list.map(
        (m) =>
          `<option value="${esc(m.name)}" ${m.name === current.model ? "selected" : ""}>${esc(m.name)}${m.parameters ? ` · ${esc(m.parameters)}` : ""} · ${(m.size / 1e9).toFixed(1)} GB</option>`,
      ),
    ].join("");
    return `<fieldset class="set-card${current.enabled ? "" : " off"}" id="suggest-card">
      <legend class="sr-only">Suggested replies</legend>
      <div class="set-card-head">
        <label class="switch"><input type="checkbox" name="suggest-enabled" ${current.enabled ? "checked" : ""}>
          <span class="set-name">Suggested replies</span></label>
        <span class="set-state ${models?.error ? "warn" : "muted"}">${models?.error ? "Ollama not found" : `Ollama at ${esc(models?.url ?? "")}`}</span>
      </div>
      <p class="set-note">When a running session you're viewing finishes, a model on this computer's Ollama
        suggests replies above the composer text. If the CLI asked you to choose, they're the choices. Click one to
        put it in the composer. Only local models are listed: the conversation never leaves this computer.</p>
      ${models?.error ? `<p class="set-note warn">${esc(models.error)}</p>` : ""}
      <label class="set-field">Model
        <select name="suggest-model">${options}</select>
      </label>
      <p class="set-hint">A small model answers fastest. The first suggestion after a while waits for the model to load
        (seconds to a minute); after that it's about a second.</p>
    </fieldset>`;
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
        <h2>Appearance</h2>
        ${appearanceHtml()}

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

        <h2>Composer</h2>
        <div class="set-cards">${suggestCard()}</div>

        <div class="set-foot">
          <span class="set-status ${esc(status.kind)}" role="status">${esc(status.text)}</span>
          <button class="btn" type="button" id="settings-reset">Undo changes</button>
          <button class="btn primary" type="submit">Save</button>
        </div>
      </form>
      ${shortcutHtml()}
    </div>`;
    for (const b of root.querySelectorAll("[data-shortcut]")) b.addEventListener("click", () => toggleShortcut(b));
    root.querySelector("#settings-reset").addEventListener("click", () => {
      status = { text: "", kind: "" };
      render();
    });
    root.querySelector("#settings-form").addEventListener("change", (event) => {
      if (event.target.name === "enabled" || event.target.name === "suggest-enabled") {
        event.target.closest(".set-card").classList.toggle("off", !event.target.checked);
      }
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
    for (const card of form.querySelectorAll(".set-card[data-source]")) {
      const enabled = card.querySelector('[name="enabled"]').checked;
      const folder = card.querySelector('[name="folder"]').value.trim();
      sources[card.dataset.source] = { ...(enabled ? {} : { enabled: false }), ...(folder ? { folder } : {}) };
    }
    const body = {
      sources,
      terminal: form.querySelector('[name="terminal"]').value,
      appearance: {
        theme: form.querySelector('[name="theme"]').value,
        showCost: form.querySelector('[name="show-cost"]').checked,
        showGit: form.querySelector('[name="show-git"]').checked,
        clock: form.querySelector('[name="clock"]').value,
      },
      suggest: {
        enabled: form.querySelector('[name="suggest-enabled"]').checked,
        model: form.querySelector('[name="suggest-model"]').value,
      },
    };
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
      window.applyPrefs?.(out.settings?.appearance);
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
