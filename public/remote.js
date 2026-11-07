// Phone access (server/remote.mjs). Asks the server whether this page is open on the phone (over
// Tailscale) and, if so, marks <html> with .remote-view (and .remote-reply when replies to Pi are
// allowed) so CSS hides what only works on the computer: terminals, handoff to a CLI, settings,
// favorites, dashboards, new folders, restart. The server refuses those anyway; this just keeps
// dead buttons off the screen. Others read window.companionRemote and listen for "remote-ready".
(function () {
  window.companionRemote = { you: { remote: false } };
  fetch("/api/remote", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data) return;
      window.companionRemote = data;
      const root = document.documentElement;
      root.classList.toggle("remote-view", data.you?.remote === true);
      root.classList.toggle("remote-reply", data.you?.remote === true && data.reply === true);
      window.dispatchEvent(new Event("remote-ready"));
    })
    .catch(() => {});
})();
