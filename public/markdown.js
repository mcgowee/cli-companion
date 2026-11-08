// Small, safe Markdown renderer: everything is HTML-escaped first, then a
// limited set of constructs is turned into tags. No external libraries.
(function () {
  function escapeHtml(text) {
    // Coerce first: callers sometimes pass a number (e.g. a port) or null, and a bare
    // .replace on a non-string throws — which, mid-template, would blank the whole page.
    return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function inline(text) {
    const codes = [];
    let out = text.replace(/`([^`\n]+)`/g, (_, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });
    out = escapeHtml(out);
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    // [text](C:/path/file.html), [text](./out/x.png), [text](file:///…): a file on this computer.
    // The right panel opens it (only if it's inside the session's folder; the server checks).
    out = out.replace(/\[([^\]]+)\]\(&lt;(.+?)&gt;\)|\[([^\]]+)\]\(((?:file:\/\/|[A-Za-z]:[\\/]|\.{0,2}\/|~\/|[\w.-]+[\\/])[^\s)]*|[\w.-]+\.\w{1,5})\)/g, (all, t1, p1, t2, p2) => {
      const text = t1 ?? t2;
      const path = p1 ?? p2;
      if (/^[a-z][\w+.-]*:(?![\\/])/i.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return all; // another scheme
      return `<a href="#" class="file-link" data-file-path="${path}" title="Open ${path} in the side panel">${text}</a>`;
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
    return out;
  }

  function render(source) {
    const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)/);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
        i++;
        html.push(codeBlock(body.join("\n"), fence[2]));
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = Math.min(heading[1].length + 1, 6);
        html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        i++;
        continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        html.push("<hr>");
        i++;
        continue;
      }

      if (/^\s*>/.test(line)) {
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
        html.push(`<blockquote>${render(body.join("\n"))}</blockquote>`);
        continue;
      }

      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        html.push(
          `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`,
        );
        continue;
      }

      const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
      if (listMatch) {
        const ordered = /\d/.test(listMatch[2]);
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (m) {
            items.push(m[3]);
            i++;
          } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
            items[items.length - 1] += `\n${lines[i].trim()}`;
            i++;
          } else break;
        }
        const tag = ordered ? "ol" : "ul";
        html.push(`<${tag}>${items.map((it) => `<li>${inline(it).replace(/\n/g, "<br>")}</li>`).join("")}</${tag}>`);
        continue;
      }

      if (!line.trim()) {
        i++;
        continue;
      }

      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,6})\s|^\s*(```|~~~)|^\s*>|^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])
      ) {
        para.push(lines[i++]);
      }
      html.push(`<p>${para.map(inline).join("<br>")}</p>`);
    }
    return html.join("");
  }

  /** A code block with Copy / Add-to-composer buttons (handled by composer.js). */
  function codeBlock(code, lang = "") {
    const langTag = lang ? `<span class="lang">${escapeHtml(lang)}</span>` : "";
    // Shell code gets a Terminal button (shown only when Settings → Terminal is on): it puts the
    // command in the right panel's Terminal tab; you still press Run.
    const shell = /^(powershell|ps|ps1|pwsh|shell|sh|bash|zsh|console|cmd|bat|batch|terminal|shell-session)$/i.test(lang);
    const termBtn = shell ? `<button type="button" class="mini term-btn" data-term title="Put this in the Terminal tab (you press Run)">▶ Terminal</button>` : "";
    return `<div class="code-wrap" data-lang="${escapeHtml(lang)}"><div class="code-tools">${langTag}${termBtn}<button type="button" class="mini" data-copy>Copy</button><button type="button" class="mini" data-add title="Add to the composer">Add</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
  }

  window.renderMarkdown = render;
  window.escapeHtml = escapeHtml;
  window.codeBlock = codeBlock;
})();
