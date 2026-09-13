"use strict";

const crypto = require("crypto");

function appUserId(user = {}) {
  const raw = user.uid ?? user.id ?? user.usuario_id ?? user.user_id;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function requestContext(req, res) {
  const creds = res.locals?.mlCreds || {};
  const meliContaId = Number(creds.meli_conta_id);
  const sellerId = Number(creds.meli_user_id);
  const empresaId = Number(res.locals?.empresa?.id ?? res.locals?.empresaId ?? res.locals?.empresa_id ?? creds.empresa_id);
  return {
    accessToken: req.ml?.accessToken || res.locals?.accessToken || creds.access_token || null,
    meliContaId: Number.isFinite(meliContaId) && meliContaId > 0 ? meliContaId : null,
    sellerId: Number.isFinite(sellerId) && sellerId > 0 ? sellerId : null,
    siteId: String(creds.site_id || "MLB").trim().toUpperCase() || "MLB",
    empresaId: Number.isFinite(empresaId) && empresaId > 0 ? empresaId : null,
    userId: appUserId(req.user),
    accountKey: res.locals?.accountKey || null,
  };
}

function httpError(message, status = 400, details = null, code = null) {
  const err = new Error(message);
  err.status = status;
  if (details != null) err.details = details;
  if (code) err.code = code;
  return err;
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = stableSort(value[key]);
      return acc;
    }, {});
}

function payloadHash(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(stableSort(payload))).digest("hex");
}

function normalizeText(value, max = 5000) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeItemId(value) {
  const raw = normalizeText(value, 500).toUpperCase();
  const match = raw.match(/\b(MLB)[-_]?(\d{6,})\b/i);
  return match ? `${match[1].toUpperCase()}${match[2]}` : null;
}

function sourceLabel(sourceType) {
  return {
    blank: "Criado do zero",
    own_item: "Meu anúncio",
    own_family: "Minha família",
    external_item: "Referência externa",
    draft_copy: "Cópia de rascunho",
  }[sourceType] || sourceType;
}

module.exports = {
  appUserId,
  requestContext,
  httpError,
  payloadHash,
  normalizeText,
  normalizeItemId,
  sourceLabel,
};
