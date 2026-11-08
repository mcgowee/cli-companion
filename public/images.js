// Images in the composer: paste (Ctrl+V), drop onto the composer, or the image button. Each one
// is saved into the selected session's folder (.cli-companion/images/, see server/uploads.mjs)
// and its path goes into the text where the cursor is, so the CLI can open it. A thumbnail row
// above the text shows the images the text mentions; × takes the path out of the text (the file
// stays, and is cleaned up after 30 days). Not on the phone.
(function () {
  const $ = (id) => document.getElementById(id);
  const textEl = $("composer-text");
  const rowEl = $("composer-images");
  const buttonEl = $("composer-image");
  const pickEl = $("composer-image-pick");
  const composerEl = $("composer");
  const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

  /** path in the text -> thumbnail address, for images added in this window. */
  const known = new Map();

  const onPhone = () => window.companionRemote?.you?.remote === true;
  const sessionId = () => window.composer?.selectedId ?? null;

  function say(text, kind = "") {
    window.composer?.setStatus?.(text, kind);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  /** Put `text` at the cursor, with a space either side where needed. */
  function insertAtCursor(text) {
    const value = textEl.value;
    const start = textEl.selectionStart ?? value.length;
    const end = textEl.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const pre = before && !/\s$/.test(before) ? " " : "";
    const post = after && !/^\s/.test(after) ? " " : after ? "" : " ";
    textEl.focus();
    textEl.setRangeText(`${pre}${text}${post}`, start, end, "end");
    textEl.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function upload(file) {
    const id = sessionId();
    if (!id) {
      say("Pick a session first: the image is saved in its folder.", "error");
      return;
    }
    if (!TYPES.includes(file.type)) {
      say("Only PNG, JPEG, GIF and WebP images can be added.", "error");
      return;
    }
    say(`Adding ${file.name || "image"}…`);
    try {
      const q = new URLSearchParams({ id, name: file.name || "pasted" });
      const res = await fetch(`/api/upload?${q}`, {
        method: "POST",
        headers: { "content-type": file.type, "x-pi-companion-page": "1" },
        body: file,
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      known.set(out.path, out.url);
      insertAtCursor(out.path);
      say(`Saved in the session's folder: ${out.path}`, "ok");
    } catch (error) {
      say(`Couldn't add the image: ${error.message}`, "error");
    }
    render();
  }

  async function uploadAll(files) {
    for (const file of files) await upload(file);
  }

  function render() {
    const text = textEl.value;
    const shown = [...known].filter(([path]) => text.includes(path));
    rowEl.hidden = shown.length === 0;
    rowEl.innerHTML = shown
      .map(
        ([path, url]) => `<span class="img-chip" title="${esc(path)}">
          <img src="${esc(url)}" alt="" loading="lazy">
          <button type="button" class="img-x" data-path="${esc(path)}" aria-label="Take ${esc(path)} out of the text">×</button>
        </span>`,
      )
      .join("");
  }

  rowEl.addEventListener("click", (event) => {
    const x = event.target.closest(".img-x");
    if (!x) return;
    const path = x.dataset.path;
    textEl.value = textEl.value.split(` ${path} `).join(" ").split(path).join("").replace(/[ \t]+\n/g, "\n");
    textEl.dispatchEvent(new Event("input", { bubbles: true }));
    render();
  });

  textEl.addEventListener("input", render);
  window.addEventListener("composer-session", render);

  textEl.addEventListener("paste", (event) => {
    if (onPhone()) return;
    const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return; // plain text: let it paste
    event.preventDefault();
    void uploadAll(files);
  });

  composerEl.addEventListener("dragover", (event) => {
    if (onPhone() || ![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
    event.preventDefault();
    composerEl.classList.add("drop-here");
  });
  composerEl.addEventListener("dragleave", (event) => {
    if (!composerEl.contains(event.relatedTarget)) composerEl.classList.remove("drop-here");
  });
  composerEl.addEventListener("drop", (event) => {
    composerEl.classList.remove("drop-here");
    const files = [...(event.dataTransfer?.files ?? [])];
    if (onPhone() || !files.length) return;
    event.preventDefault();
    void uploadAll(files.filter((f) => f.type.startsWith("image/")));
  });

  buttonEl.addEventListener("click", () => pickEl.click());
  pickEl.addEventListener("change", () => {
    const files = [...pickEl.files];
    pickEl.value = "";
    void uploadAll(files);
  });

  // The phone can't save files on the computer.
  function applyPhone() {
    buttonEl.hidden = onPhone();
  }
  window.addEventListener("remote-ready", applyPhone);
  applyPhone();
})();
