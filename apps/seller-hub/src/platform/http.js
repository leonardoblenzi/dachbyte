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

/**
 * Baixa um arquivo (PDF, ZPL, ZIP...). Erro HTTP vira exceção com status e a mensagem do corpo, se houver.
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: any, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ contentType: string, buffer: Buffer }>}
 */
async function requestBinary(url, { method = "GET", headers = {}, body, timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method, headers, body, signal: controller.signal });
    const contentType = String(response.headers?.get?.("content-type") || "application/octet-stream");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok || /json/i.test(contentType)) {
      let payload = {};
      try { payload = JSON.parse(buffer.toString("utf8")); } catch (_error) { payload = {}; }
      const p = /** @type {any} */ (payload);
      if (response.ok && !p.error && !p.message) return { contentType, buffer };
      throw Object.assign(new Error(p.message || p.error_description || p.error || `HTTP ${response.status}`), {
        status: response.ok ? 422 : response.status, code: p.error || `http_${response.status}`, payload,
      });
    }
    return { contentType, buffer };
  } catch (error) {
    if (/** @type {any} */ (error)?.name === "AbortError") throw Object.assign(new Error("Tempo esgotado ao baixar o arquivo do marketplace."), { status: 504, code: "timeout" });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Extensão pelo tipo do arquivo. @param {string} contentType @param {string} fallback */
function extensionFor(contentType, fallback) {
  if (/pdf/i.test(contentType)) return "pdf";
  if (/zip/i.test(contentType)) return "zip";
  if (/text|zpl/i.test(contentType)) return "zpl";
  return fallback;
}

module.exports = { requestJson, requestBinary, extensionFor };
