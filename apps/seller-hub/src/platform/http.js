// @ts-check
"use strict";

/**
 * Chamada HTTP com tempo limite e erro padronizado (status, code, payload).
 * `fetchImpl` é injetável para testes.
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: any, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 */
async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method, headers: { accept: "application/json", ...headers }, body, signal: controller.signal });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch (_error) { payload = { raw }; }
    if (!response.ok) {
      const p = /** @type {any} */ (payload);
      throw Object.assign(new Error(p.error_description || p.message || p.error || `HTTP ${response.status}`), {
        status: response.status, code: p.error || `http_${response.status}`, payload,
      });
    }
    return /** @type {any} */ (payload);
  } catch (error) {
    if (/** @type {any} */ (error)?.name === "AbortError") throw Object.assign(new Error("Tempo esgotado ao falar com o marketplace."), { status: 504, code: "timeout" });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { requestJson };
