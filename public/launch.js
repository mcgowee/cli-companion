// Terminal menu: the small terminal icon on a workspace or saved session in the sidebar.
// Each option has Open (the server starts a terminal in that folder running it; which one is
// set in Settings) and Copy (the line to paste yourself). The page only names an action; the server
// builds the command from a fixed list (server/launch.mjs).
(function () {
  const esc = window.escapeHtml;
  const menu = document.createElement("div");
  menu.className = "launch-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.append(menu);
  let current = null; // { kind, id, button, data }

  function place(button) {
    const r = button.getBoundingClientRect();
    menu.style.left = "0px";
    menu.style.top = "0px";
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    const below = r.bottom + 4;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : below;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function close() {
    menu.hidden = true;
    current?.button.classList.remove("open");
    current = null;
  }

  function render() {
    const { data, kind } = current;
    if (data.error) {
      menu.innerHTML = `<div class="launch-msg error">${esc(data.error)}</div>`;
      return;
    }
    menu.innerHTML = `
      <div class="launch-head"><span>${kind === "workspace" || data.options?.some((o) => o.action === "terminal") ? "Open in a terminal" : "Resume in a terminal"}</span>
        <code title="${esc(data.cwd)}">${esc(data.cwd)}</code></div>
      ${data.note ? `<div class="launch-msg">${esc(data.note)}</div>` : ""}
      ${
        data.ssh
          ? `<div class="launch-step">Step 1 — open a terminal on this computer</div>
             <div class="launch-item" role="none">
               <div class="launch-text"><code class="launch-cmd">${esc(data.ssh)}</code></div>
               <button class="btn small" type="button" role="menuitem" data-copy-ssh>Copy</button>
             </div>
             <div class="launch-step">Step 2 — then run one of these there${data.tmux ? ` (tmux: ${esc(data.tmux)})` : ""}</div>`
          : ""
      }
      ${data.options
        .map(
          (o, i) => `<div class="launch-item${o.disabled ? " disabled" : ""}" role="none">
          <div class="launch-text"><span class="launch-label">${esc(o.label)}</span>
            ${o.copy ? `<code class="launch-cmd">${esc(o.copy)}</code>` : ""}
            ${o.disabled ? `<span class="launch-note">${esc(o.disabled)}</span>` : ""}</div>
          ${data.canOpen && !o.disabled ? `<button class="btn primary small" type="button" role="menuitem" data-open="${i}">Open</button>` : ""}
          ${o.copy ? `<button class="btn small" type="button" role="menuitem" data-copy-line="${i}">Copy</button>` : ""}
        </div>`,
        )
        .join("")}
      ${kind === "workspace" ? `<button class="launch-path" type="button" data-copy-path>Copy folder path</button>` : ""}
      <div class="launch-msg" role="status"></div>`;
  }

  function say(text, kind = "") {
    const msg = menu.querySelector(".launch-msg");
    if (!msg) return;
    msg.textContent = text;
    msg.className = `launch-msg ${kind}`;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    }
  }

  async function openFor(button) {
    const kind = button.dataset.launchKind;
    const id = button.dataset.launchId;
    if (current && current.button === button) return close();
    close();
    current = { kind, id, button, data: null };
    button.classList.add("open");
    menu.innerHTML = `<div class="launch-msg">Loading…</div>`;
    menu.hidden = false;
    place(button);
    try {
      const res = await fetch(`/api/launch?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (current?.button !== button) return;
      current.data = res.ok ? data : { error: data.error || `HTTP ${res.status}` };
    } catch {
      if (current?.button !== button) return;
      current.data = { error: "Couldn't reach the companion server." };
    }
    render();
    place(button);
  }

  menu.addEventListener("click", async (event) => {
    if (!current?.data) return;
    const openBtn = event.target.closest("[data-open]");
    const copyBtn = event.target.closest("[data-copy-line]");
    if (event.target.closest("[data-copy-path]")) {
      say((await copy(current.data.cwd)) ? "Folder path copied ✓" : "Copy failed.", "ok");
      return;
    }
    if (event.target.closest("[data-copy-ssh]")) {
      say((await copy(current.data.ssh)) ? "Copied ✓ Step 1 — run it in a terminal on another computer." : "Copy failed.", "ok");
      return;
    }
    if (copyBtn) {
      const o = current.data.options[Number(copyBtn.dataset.copyLine)];
      const where = current.data.platform === "win32" ? "PowerShell" : "your terminal";
      const ok = await copy(o.copy);
      // Running: resuming it in a second terminal would put it in two places at once.
      say(ok ? (o.disabled ? `Copied ✓ It's still running, so close that one before you paste it into ${where}.` : `Copied ✓ Paste it into ${where}.`) : "Copy failed.", "ok");
      return;
    }
    if (openBtn) {
      const o = current.data.options[Number(openBtn.dataset.open)];
      openBtn.disabled = true;
      say("Opening…");
      try {
        const res = await fetch("/api/launch", {
          method: "POST",
          headers: { "content-type": "application/json", "x-pi-companion-page": "1" },
          body: JSON.stringify({ kind: current.kind, id: current.id, action: o.action }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
        say(`${o.label}: opened in a new terminal window ✓`, "ok");
      } catch (error) {
        say(error.message, "error");
      } finally {
        openBtn.disabled = false;
      }
    }
  });

  // Capture phase: the icon sits next to a row, and its click must not reach anything else.
  document.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest?.("[data-launch-kind]");
      if (button) {
        event.preventDefault();
        event.stopPropagation();
        void openFor(button);
        return;
      }
      if (!menu.hidden && !menu.contains(event.target)) close();
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) close();
  });
  window.addEventListener("resize", close);
  document.getElementById("session-list")?.addEventListener("scroll", close, { passive: true });
  document.getElementById("sidebar")?.addEventListener("scroll", close, { passive: true });
})();
