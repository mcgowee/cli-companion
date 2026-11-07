// Suggested replies in the composer: when the running session you're viewing finishes a turn, ask
// the server (which asks a local Ollama model, set in Settings) for a few replies, and show them as
// buttons above the text box. Clicking one puts its text in the composer; you still send it.
// If the CLI asked you to choose, the buttons are those choices. Off unless switched on in Settings.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = window.escapeHtml;
  const row = $("suggest-row");
  const chips = $("suggest-chips");
  const note = $("suggest-note");

  let enabled = true; // until the server says otherwise
  let shownKey = ""; // session id + message id the row is showing (or loading)
  let request = 0;

  function hide() {
    shownKey = "";
    request++;
    row.hidden = true;
  }

  function show(html, text = "") {
    chips.innerHTML = html;
    note.textContent = text;
    row.hidden = false;
  }

  /** The last text the CLI wrote after your last message (same rule as the server). */
  function lastReplyId(items) {
    if (!Array.isArray(items)) return null;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.kind === "user" && String(item.text ?? "").trim()) return null;
      if (item?.kind === "assistant" && String(item.text ?? "").trim()) return String(item.id ?? i);
    }
    return null;
  }

  async function load(id, key) {
    const mine = ++request;
    shownKey = key;
    show("", "Thinking of replies…");
    let data;
    try {
      const res = await fetch(`/api/suggest?id=${encodeURIComponent(id)}`, {
        cache: "no-store",
        headers: { "x-pi-companion-page": "1" },
      });
      data = await res.json().catch(() => ({}));
    } catch {
      data = { error: "Couldn't reach the companion server." };
    }
    if (mine !== request) return;
    if (data.enabled === false) {
      enabled = false;
      hide();
      return;
    }
    if (data.error) {
      show("", `No suggested replies: ${data.error}`);
      shownKey = ""; // try again on the next change
      return;
    }
    const list = Array.isArray(data.suggestions) ? data.suggestions : [];
    if (!list.length) {
      hide();
      return;
    }
    show(
      list
        .map((text, i) => `<button class="suggest-chip" type="button" data-i="${i}" title="Put this in the composer">${esc(text)}</button>`)
        .join(""),
      "",
    );
    chips.dataset.list = JSON.stringify(list);
  }

  chips.addEventListener("click", (event) => {
    const button = event.target.closest(".suggest-chip");
    if (!button) return;
    const list = JSON.parse(chips.dataset.list || "[]");
    const text = list[Number(button.dataset.i)];
    if (text) window.composer?.insert(text);
  });

  window.suggest = {
    /**
     * The view changed: `id` is the selected session, `items` its transcript, `running` whether it
     * is open in a CLI, `working` whether it's in the middle of a turn.
     */
    consider({ id, items, running, working }) {
      if (!enabled || !id || !running || working) return hide();
      const replyId = lastReplyId(items);
      if (!replyId) return hide();
      const key = `${id} ${replyId}`;
      if (key !== shownKey) void load(id, key);
    },
    /** Settings changed: ask again. */
    reset() {
      enabled = true;
      hide();
    },
  };
})();
