"use strict";

const fs = require("fs");
const path = require("path");

const MARKER = "data-ml-first-paint-guard";
const SNIPPET = `
<script data-ml-first-paint-guard>
  (function () {
    const root = document.documentElement;
    if (root.hasAttribute("${MARKER}")) return;

    root.setAttribute("${MARKER}", "1");
    root.style.opacity = "0";
    root.style.background = "#eef3f9";

    const release = () => {
      if (!root.hasAttribute("${MARKER}")) return;
      root.style.opacity = "";
      root.style.background = "";
      root.removeAttribute("${MARKER}");
    };

    window.__releaseMLFirstPaint = release;

    if (document.readyState === "complete") {
      window.requestAnimationFrame(release);
    } else {
      window.addEventListener("load", release, { once: true });
    }

    window.setTimeout(release, 2500);
  })();
</script>`;

function injectFirstPaintGuard(html) {
  if (typeof html !== "string" || !html.trim()) return html;
  if (html.includes(MARKER) || html.includes("window.__releaseMLFirstPaint")) {
    return html;
  }

  const viewportPattern = /<meta[^>]+name=["']viewport["'][^>]*>/i;
  if (viewportPattern.test(html)) {
    return html.replace(viewportPattern, (match) => `${match}\n${SNIPPET}`);
  }

  const headPattern = /<head[^>]*>/i;
  if (headPattern.test(html)) {
    return html.replace(headPattern, (match) => `${match}\n${SNIPPET}`);
  }

  return `${SNIPPET}\n${html}`;
}

function resolveSendFilePath(filePath, options) {
  const target = String(filePath || "").trim();
  if (!target) return null;
  if (path.isAbsolute(target)) return target;

  const root = String(options?.root || "").trim();
  if (!root) return null;

  return path.resolve(root, target);
}

function patchHtmlSendFile(res) {
  if (!res || res.__mlHtmlSendFilePatched) return;

  const originalSendFile = res.sendFile.bind(res);
  res.__mlHtmlSendFilePatched = true;

  res.sendFile = function patchedSendFile(filePath, options, callback) {
    const sendOptions = typeof options === "function" ? undefined : options;
    const done = typeof options === "function" ? options : callback;
    const resolvedPath = resolveSendFilePath(filePath, sendOptions);
    const extension = path.extname(resolvedPath || String(filePath || "")).toLowerCase();

    if (extension !== ".html") {
      return originalSendFile(filePath, sendOptions, done);
    }

    if (!resolvedPath) {
      return originalSendFile(filePath, sendOptions, done);
    }

    fs.readFile(resolvedPath, "utf8", (error, html) => {
      if (error) {
        return originalSendFile(filePath, sendOptions, done);
      }

      try {
        res.type("html");
        res.send(injectFirstPaintGuard(html));
        if (typeof done === "function") done();
      } catch (sendError) {
        if (typeof done === "function") {
          done(sendError);
          return;
        }
        if (!res.headersSent && !res.writableEnded) {
          originalSendFile(filePath, sendOptions, done);
        }
      }
    });
  };
}

module.exports = {
  injectFirstPaintGuard,
  patchHtmlSendFile,
};
