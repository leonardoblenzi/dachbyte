"use strict";

const {
  registerMlApiCooldown,
  withMlApiPermit,
} = require("./mlApiRateLimiter");

const ML_API_ORIGIN = "https://api.mercadolibre.com";
const INSTALL_MARK = Symbol.for("dachbyte.mlApiRequestGovernor.installed");

function headerValue(headers, wantedName) {
  if (!headers) return null;
  const wanted = String(wantedName || "").toLowerCase();

  if (typeof headers.get === "function") {
    const value = headers.get(wantedName) ?? headers.get(wanted);
    return value == null ? null : String(value);
  }

  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      if (String(pair[0] || "").toLowerCase() === wanted) {
        return String(pair[1] ?? "");
      }
    }
    return null;
  }

  if (typeof headers === "object") {
    for (const [name, value] of Object.entries(headers)) {
      if (String(name).toLowerCase() === wanted) {
        return value == null ? null : String(value);
      }
    }
  }

  return null;
}

function extractBearerToken(input, init = {}) {
  const fromInit = headerValue(init?.headers, "authorization");
  const fromInput = headerValue(input?.headers, "authorization");
  const raw = String(fromInit || fromInput || "").trim();
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || "").trim() || null : null;
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input.url === "string") return input.url;
  return String(input || "");
}

function isMercadoLivreApiUrl(input) {
  try {
    const url = new URL(requestUrl(input));
    return url.protocol === "https:" && url.origin === ML_API_ORIGIN;
  } catch {
    return false;
  }
}

function shouldGovernRequest(input, init = {}) {
  return isMercadoLivreApiUrl(input) && Boolean(extractBearerToken(input, init));
}

function parseRetryAfterMs(response) {
  const raw = response?.headers?.get?.("retry-after");
  if (raw == null || String(raw).trim() === "") return 1_000;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1_000, Math.trunc(seconds * 1000));
  }

  const when = Date.parse(String(raw));
  if (Number.isFinite(when)) {
    return Math.max(1_000, when - Date.now());
  }
  return 1_000;
}

function wrapFetch(originalFetch) {
  if (typeof originalFetch !== "function") return originalFetch;

  const governedFetch = async function governedMercadoLivreFetch(input, init = {}) {
    if (!shouldGovernRequest(input, init)) {
      return originalFetch(input, init);
    }

    const accessToken = extractBearerToken(input, init);
    const response = await withMlApiPermit(
      { accessToken },
      () => originalFetch(input, init),
    );

    if (Number(response?.status) === 429) {
      await registerMlApiCooldown(
        { accessToken },
        parseRetryAfterMs(response),
      ).catch(() => {});
    }
    return response;
  };

  try {
    Object.assign(governedFetch, originalFetch);
  } catch {}
  return governedFetch;
}

function installNodeFetchGovernor() {
  let resolved;
  try {
    resolved = require.resolve("node-fetch");
  } catch {
    return false;
  }

  const original = require(resolved);
  if (original?.[INSTALL_MARK]) return true;
  const wrapped = wrapFetch(original);
  Object.defineProperty(wrapped, INSTALL_MARK, {
    value: true,
    enumerable: false,
  });
  if (require.cache[resolved]) {
    require.cache[resolved].exports = wrapped;
  }
  return true;
}

function installNativeFetchGovernor() {
  if (typeof globalThis.fetch !== "function") return false;
  if (globalThis.fetch?.[INSTALL_MARK]) return true;

  const wrapped = wrapFetch(globalThis.fetch.bind(globalThis));
  Object.defineProperty(wrapped, INSTALL_MARK, {
    value: true,
    enumerable: false,
  });
  globalThis.fetch = wrapped;
  return true;
}

function installMlApiRequestGovernor() {
  const nativeInstalled = installNativeFetchGovernor();
  const nodeFetchInstalled = installNodeFetchGovernor();
  if (nativeInstalled || nodeFetchInstalled) {
    console.log(
      `[ML API Governor] ativo (native=${nativeInstalled}, node-fetch=${nodeFetchInstalled}).`,
    );
  }
  return { nativeInstalled, nodeFetchInstalled };
}

module.exports = {
  installMlApiRequestGovernor,
  _test: {
    extractBearerToken,
    isMercadoLivreApiUrl,
    parseRetryAfterMs,
    requestUrl,
    shouldGovernRequest,
  },
};
