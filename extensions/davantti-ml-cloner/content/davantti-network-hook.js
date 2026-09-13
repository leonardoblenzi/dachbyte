(() => {
  "use strict";

  const EVENT_CAPTURE = "DAVANTTI_NETWORK_CAPTURE";
  const EVENT_CACHE_REQUEST = "DAVANTTI_NETWORK_CACHE_REQUEST";
  const EVENT_CACHE_RESPONSE = "DAVANTTI_NETWORK_CACHE_RESPONSE";
  const MAX_ENTRIES = 110;
  const MAX_BODY = 250000;

  const cache = [];

  function isRelevantUrl(url) {
    let value = String(url || "");
    try {
      value = new URL(value, location.href).href;
    } catch {
      // Mantem o valor original quando nao for uma URL valida.
    }
    return /mercadolivre\.com\.br\/(recommendations|p\/api|.*\/search|.*\/lista|.*\/noindex|.*\/frontend|.*\/pdp|.*\/product|.*\/reviews|.*\/questions|.*\/visits|.*\/seller|.*\/tracking|.*\/eshops|adn\/api)|api\.mercadolibre\.com\/(sites|items|products|catalog|visits|melidata|users|reviews)|produto\.mercadolivre\.com\.br\/(adn\/api|.*\/api)|shopee\.com\.br\/api\//i.test(value) ||
      (/mercadolivre\.com\.br/i.test(value) && /\bMLB\d{6,}\b/i.test(value));
  }

  function remember(entry) {
    if (!entry || !isRelevantUrl(entry.url)) return;
    cache.push({
      url: String(entry.url || ""),
      method: String(entry.method || "GET").toUpperCase(),
      status: Number(entry.status || 0),
      body: String(entry.body || entry.requestBody || "").slice(0, MAX_BODY),
      captured_at: Date.now(),
    });
    while (cache.length > MAX_ENTRIES) cache.shift();
    window.postMessage({ source: "davantti-extension", type: EVENT_CAPTURE, payload: cache[cache.length - 1] }, "*");
  }

  function readBody(response) {
    if (!response || typeof response.clone !== "function") return;
    const clone = response.clone();
    clone.text()
      .then((body) => remember({ url: response.url, method: "GET", status: response.status, body }))
      .catch(() => {});
  }

  function bodyToText(body) {
    try {
      if (typeof body === "string") return body;
      if (body instanceof URLSearchParams) return body.toString();
      if (body instanceof FormData) return Array.from(body.entries()).map(([key, value]) => `${key}=${value}`).join("&");
    } catch {
      return "";
    }
    return "";
  }

  function rememberRequestBody({ url, method = "POST", status = 0, body }) {
    const requestBody = bodyToText(body);
    if (requestBody) {
      remember({ url, method, status, requestBody });
      return;
    }
    try {
      if (body instanceof Blob) {
        body.text()
          .then((value) => {
            if (value) remember({ url, method, status, requestBody: value });
          })
          .catch(() => {});
      }
    } catch {
      // Ignora corpos nao serializaveis.
    }
  }

  function readXhrBody(xhr) {
    const responseType = String(xhr?.responseType || "");
    try {
      if (!responseType || responseType === "text") {
        return typeof xhr.responseText === "string" ? xhr.responseText : "";
      }
      if (responseType === "json") {
        return xhr.response == null ? "" : JSON.stringify(xhr.response);
      }
    } catch {
      return "";
    }
    return "";
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function" && !window.__davanttiFetchHooked) {
    window.__davanttiFetchHooked = true;
    window.fetch = async function davanttiFetchHook(input, init) {
      const response = await originalFetch.apply(this, arguments);
      const url = typeof input === "string" ? input : input?.url || response?.url || "";
      if (isRelevantUrl(url) || isRelevantUrl(response?.url)) rememberRequestBody({ url: response?.url || url, method: init?.method || "POST", status: response?.status || 0, body: init?.body });
      if (isRelevantUrl(url) || isRelevantUrl(response?.url)) readBody(response);
      return response;
    };
  }

  const OriginalXhr = window.XMLHttpRequest;
  if (typeof OriginalXhr === "function" && !window.__davanttiXhrHooked) {
    window.__davanttiXhrHooked = true;
    const originalOpen = OriginalXhr.prototype.open;
    const originalSend = OriginalXhr.prototype.send;

    OriginalXhr.prototype.open = function davanttiXhrOpen(method, url) {
      this.__davanttiRequest = { method, url };
      return originalOpen.apply(this, arguments);
    };

    OriginalXhr.prototype.send = function davanttiXhrSend(body) {
      this.addEventListener("load", function davanttiXhrLoad() {
        const url = this.__davanttiRequest?.url || "";
        if (!isRelevantUrl(url)) return;
        rememberRequestBody({ url, method: this.__davanttiRequest?.method || "POST", status: this.status, body });
        const responseBody = readXhrBody(this);
        remember({
          url,
          method: this.__davanttiRequest?.method || "GET",
          status: this.status,
          body: responseBody,
        });
      });
      return originalSend.apply(this, arguments);
    };
  }

  const originalSendBeacon = navigator.sendBeacon;
  if (typeof originalSendBeacon === "function" && !window.__davanttiBeaconHooked) {
    window.__davanttiBeaconHooked = true;
    navigator.sendBeacon = function davanttiSendBeaconHook(url, data) {
      if (isRelevantUrl(url)) rememberRequestBody({ url, method: "POST", status: 0, body: data });
      return originalSendBeacon.apply(this, arguments);
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "davantti-content") return;
    if (event.data?.type !== EVENT_CACHE_REQUEST) return;
    window.postMessage({ source: "davantti-extension", type: EVENT_CACHE_RESPONSE, payload: cache.slice(-MAX_ENTRIES) }, "*");
  });
})();
