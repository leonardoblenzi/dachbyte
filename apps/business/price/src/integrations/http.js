"use strict";

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 25_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { Accept: "application/json", ...(options.headers || {}) } });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const error = new Error(data?.message || data?.error_description || data?.error || `HTTP ${response.status}`);
      error.statusCode = response.status >= 500 ? 502 : 400;
      error.upstreamStatus = response.status; error.upstreamBody = data; throw error;
    }
    return data;
  } finally { clearTimeout(timeout); }
}

function formBody(values) {
  const body = new URLSearchParams();
  Object.entries(values).forEach(([k,v]) => { if (v !== undefined && v !== null) body.set(k, String(v)); });
  return body;
}

module.exports = { fetchJson, formBody };
