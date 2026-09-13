"use strict";

const { httpError } = require("./helpers");

const API_BASE = "https://api.mercadolibre.com";
const nativeFetch = globalThis.fetch;

async function safeBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(payload, status) {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  return payload?.message || payload?.error_description || payload?.error || `Mercado Livre respondeu HTTP ${status}`;
}

async function request(path, { accessToken, method = "GET", query, body, headers = {} } = {}) {
  if (!accessToken) throw httpError("Token Mercado Livre indisponível para a conta selecionada.", 401);
  if (typeof nativeFetch !== "function") throw httpError("Runtime sem suporte a fetch nativo. Use Node.js 20 ou superior.", 500);
  const url = new URL(path.startsWith("http") ? path : `${API_BASE}${path}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });

  const response = await nativeFetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await safeBody(response);
  if (!response.ok) {
    const err = httpError(errorMessage(payload, response.status), response.status, payload, payload?.error || "ML_API_ERROR");
    err.mlPayload = payload;
    throw err;
  }
  return { status: response.status, payload, headers: response.headers };
}

async function get(path, options = {}) {
  return (await request(path, { ...options, method: "GET" })).payload;
}

async function post(path, body, options = {}) {
  return request(path, { ...options, method: "POST", body });
}

module.exports = { API_BASE, request, get, post };
