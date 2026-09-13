"use strict";

const HTML_ASSET_EXTENSIONS = new Set(["", ".html", ".htm"]);
const SKIP_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".map",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".zip",
  ".csv",
  ".mp4",
  ".webm",
]);

function extensionFromPath(pathname) {
  const clean = String(pathname || "").split("?")[0].split("#")[0];
  const slash = clean.lastIndexOf("/");
  const dot = clean.lastIndexOf(".");
  if (dot <= slash) return "";
  return clean.slice(dot).toLowerCase();
}

function wantsHtml(req) {
  const accept = String(req.headers?.accept || "").toLowerCase();
  return accept.includes("text/html") || accept.includes("application/xhtml+xml") || accept === "*/*";
}

function shouldSkipPath(pathname) {
  const path = String(pathname || "");
  if (path.startsWith("/api/")) return true;
  if (path.startsWith("/chat-api/")) return true;
  if (path.startsWith("/support/")) return true;
  if (path === "/sacdavantti" || path.startsWith("/sacdavantti/")) return true;
  if (path.startsWith("/_next/")) return true;
  if (path.startsWith("/assets/")) return true;
  if (path === "/support-widget.js" || path === "/support-widget.css") return true;
  const ext = extensionFromPath(path);
  if (SKIP_EXTENSIONS.has(ext)) return true;
  return ext && !HTML_ASSET_EXTENSIONS.has(ext);
}

function buildSnippet({ cssPath, scriptPath }) {
  return [
    '<link rel="stylesheet" href="' + cssPath + '" data-davantti-sac-widget>',
    '<script src="' + scriptPath + '" defer data-davantti-sac-widget></script>',
  ].join("");
}

function versionedAssetPath(assetPath, version) {
  const cleanPath = String(assetPath || "");
  const cleanVersion = String(version || "").trim();
  if (!cleanPath || !cleanVersion || cleanPath.includes("?v=") || cleanPath.includes("&v=")) {
    return cleanPath;
  }
  return cleanPath + (cleanPath.includes("?") ? "&" : "?") + "v=" + encodeURIComponent(cleanVersion);
}

function injectHtml(html, snippet) {
  if (!html || html.includes("data-davantti-sac-widget")) return html;
  if (!/<\/body>/i.test(html)) return html + snippet;
  return html.replace(/<\/body>/i, snippet + "</body>");
}

function createSupportWidgetInjector(options = {}) {
  const assetVersion = options.assetVersion || process.env.SAC_WIDGET_VERSION || "20260703-4";
  const cssPath = versionedAssetPath(
    options.cssPath || "/support/davantti-support-widget.css",
    assetVersion,
  );
  const scriptPath = versionedAssetPath(
    options.scriptPath || "/support/davantti-support-widget.js",
    assetVersion,
  );
  const snippet = buildSnippet({ cssPath, scriptPath });

  return function supportWidgetInjector(req, res, next) {
    if (!["GET", "HEAD"].includes(req.method)) return next();
    if (!wantsHtml(req)) return next();
    if (shouldSkipPath(req.path || req.url)) return next();

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const chunks = [];

    res.write = function patchedWrite(chunk, encoding, callback) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      if (typeof callback === "function") callback();
      return true;
    };

    res.end = function patchedEnd(chunk, encoding, callback) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }

      if (res.statusCode < 200 || res.statusCode >= 300 || !chunks.length) {
        return originalEnd(Buffer.concat(chunks), callback);
      }

      const body = Buffer.concat(chunks);
      const contentType = String(res.getHeader("content-type") || "").toLowerCase();
      const text = body.toString("utf8");
      const looksHtml =
        contentType.includes("text/html") ||
        (text.includes("<html") && text.includes("</body>"));

      if (!looksHtml) {
        return originalEnd(body, callback);
      }

      const nextHtml = injectHtml(text, snippet);
      const output = Buffer.from(nextHtml, "utf8");
      res.removeHeader("transfer-encoding");
      res.setHeader("content-length", String(output.length));
      if (!contentType) {
        res.setHeader("content-type", "text/html; charset=utf-8");
      }
      return originalEnd(output, callback);
    };

    return next();
  };
}

module.exports = {
  createSupportWidgetInjector,
};
