"use strict";

const crypto = require("node:crypto");
const env = require("../config/env");

const VERSION = "v1";

function resolveKey() {
  const raw = String(env.MAGALU_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    const error = new Error("MAGALU_ENCRYPTION_KEY não configurada.");
    error.code = "MAGALU_ENCRYPTION_KEY_MISSING";
    throw error;
  }

  const candidates = [];
  try { candidates.push(Buffer.from(raw, "base64")); } catch (_error) {}
  if (/^[0-9a-f]{64}$/i.test(raw)) candidates.push(Buffer.from(raw, "hex"));
  candidates.push(Buffer.from(raw, "utf8"));

  const key = candidates.find((candidate) => candidate.length === 32);
  if (!key) {
    const error = new Error("MAGALU_ENCRYPTION_KEY deve representar exatamente 32 bytes (base64, hex ou texto). ");
    error.code = "MAGALU_ENCRYPTION_KEY_INVALID";
    throw error;
  }
  return key;
}

function encryptSecret(value) {
  const plaintext = String(value == null ? "" : value);
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", resolveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

function decryptSecret(payload) {
  const raw = String(payload || "").trim();
  if (!raw) return null;
  const [version, ivRaw, tagRaw, dataRaw] = raw.split(":");
  if (version !== VERSION || !ivRaw || !tagRaw || !dataRaw) {
    throw new Error("Segredo Magalu criptografado possui formato inválido.");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    resolveKey(),
    Buffer.from(ivRaw, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

module.exports = { encryptSecret, decryptSecret, _test: { resolveKey } };
