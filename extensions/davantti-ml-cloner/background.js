"use strict";

const ALLOWED_ORIGINS = new Set([
  "https://www.davanttisuite.com.br",
  "https://davanttisuite.com.br",
  "https://davanttisuite-staging.onrender.com",
]);

function isAllowedUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    if (ALLOWED_ORIGINS.has(parsed.origin)) {
      return parsed.pathname.startsWith("/ml/api/extension/") || parsed.pathname.startsWith("/api/extension/");
    }
    if (/^https:\/\/(?:lista|www)\.mercadolivre\.com\.br$/i.test(parsed.origin)) {
      return parsed.pathname.length <= 420
        && !parsed.pathname.includes("..")
        && (
          parsed.hostname === "lista.mercadolivre.com.br"
          || parsed.pathname.startsWith("/jm/search")
          || parsed.pathname.startsWith("/search")
          || /^\/[a-z0-9][a-z0-9/_-]*$/i.test(parsed.pathname)
        );
    }
    return false;
  } catch {
    return false;
  }
}

async function safeParseJson(response) {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 1200) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "DVTI_PROXY_FETCH") return;

  const url = String(message.url || "");
  if (!isAllowedUrl(url)) {
    sendResponse({ ok: false, status: 0, error: "URL nao permitida para proxy da extensao." });
    return;
  }

  const method = String(message.method || "GET").toUpperCase();
  const headers = message.headers && typeof message.headers === "object" ? message.headers : {};
  const body = typeof message.body === "string" ? message.body : undefined;
  const responseType = String(message.responseType || "json").toLowerCase();

  fetch(url, { method, headers, body, credentials: "include", redirect: "follow" })
    .then(async (response) => {
      if (responseType === "text") {
        const text = await response.text().catch(() => "");
        sendResponse({
          ok: response.ok,
          status: response.status,
          text,
          url: response.url,
        });
        return;
      }
      const payload = await safeParseJson(response);
      sendResponse({
        ok: response.ok,
        status: response.status,
        payload,
      });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        status: 0,
        error: error?.message || "Falha de rede no proxy da extensao.",
      });
    });

  return true;
});
