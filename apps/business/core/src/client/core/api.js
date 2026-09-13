const DEFAULT_API_BASE_PATH = "/api/core";

function normalizeBasePath(value, fallback) {
  const raw = String(value || fallback || "").trim();
  if (!raw || raw === "/") return "";
  return `/${raw.replace(/^\/+|\/+$/g, "")}`;
}

const apiBasePath = normalizeBasePath(
  import.meta.env.VITE_VOLT_CORE_API_BASE ||
    (typeof window !== "undefined" ? window.__VOLT_CORE_API_BASE__ : ""),
  DEFAULT_API_BASE_PATH,
);

function apiUrl(url) {
  const target = String(url || "");
  if (/^https?:\/\//i.test(target)) return target;
  if (target === "/core") return apiBasePath;
  if (target.startsWith("/core/")) return `${apiBasePath}${target.slice("/core".length)}`;
  return target;
}

async function apiFetch(url, options = {}) {
  const response = await fetch(apiUrl(url), {
    credentials: "include",
    ...options,
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => "");

  if (!response.ok) {
    const requestId = payload?.error?.requestId || response.headers.get("x-request-id") || null;
    const baseMessage = payload?.error?.message || payload?.message || `Falha HTTP ${response.status}`;
    const message = response.status >= 500 && requestId ? `${baseMessage} (ID: ${requestId})` : baseMessage;
    const error = new Error(message);
    error.status = response.status;
    error.code = payload?.error?.code;
    error.requestId = requestId;
    throw error;
  }

  return payload;
}

export {
  apiBasePath,
  apiFetch,
  apiUrl,
  normalizeBasePath,
};
