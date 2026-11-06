// @ts-check
"use strict";

const crypto = require("node:crypto");

/**
 * Classifica o erro de uma escrita no canal:
 * - 429 (limite de requisições): não foi gravado, pode tentar de novo depois;
 * - sem resposta, 408 ou 5xx: incerto (pode ter gravado). Confere relendo, nunca reenvia às cegas;
 * - outros 4xx: falhou (dado inválido, anúncio fechado...), não adianta repetir.
 * @param {any} error @returns {{ ok: false, retryable: boolean, uncertain: boolean, error: string }}
 */
function classifyWriteError(error) {
  const status = Number(error?.status) || 0;
  const message = String(error?.message || error || "erro desconhecido").slice(0, 300);
  if (status === 429) return { ok: false, retryable: true, uncertain: false, error: `limite de requisições do canal: ${message}` };
  if (!status || status === 408 || status === 504 || status >= 500) return { ok: false, retryable: false, uncertain: true, error: `resposta incerta do canal: ${message}` };
  return { ok: false, retryable: false, uncertain: false, error: message };
}

/** Comparação de assinaturas em tempo constante (hex). @param {string} expected @param {string} received */
function safeEqualHex(expected, received) {
  const a = Buffer.from(String(expected || ""), "utf8");
  const b = Buffer.from(String(received || "").trim().toLowerCase(), "utf8");
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** @param {string} message */
const unauthorized = (message) => Object.assign(new Error(message), { status: 401, code: "invalid_webhook" });

/** Soma itens repetidos do mesmo anúncio/variação no pedido. @param {Array<{ lineKey: string, quantity: number }>} lines */
function mergeLines(lines) {
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const line of lines) {
    if (!(Number(line.quantity) > 0)) continue;
    const cur = map.get(line.lineKey);
    if (cur) cur.quantity += Number(line.quantity);
    else map.set(line.lineKey, { ...line, quantity: Number(line.quantity) });
  }
  return [...map.values()];
}

module.exports = { classifyWriteError, safeEqualHex, unauthorized, mergeLines };
