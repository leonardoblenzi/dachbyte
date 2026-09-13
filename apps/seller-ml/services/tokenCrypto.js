"use strict";

const crypto = require("crypto");
const { isProductionEnvironment } = require("../../../lib/runtimeEnv");

const TOKEN_PREFIX = "enc::v1::";

function getConfiguredKey() {
  const raw =
    process.env.ML_TOKEN_ENCRYPTION_KEY ||
    process.env.TOKEN_ENCRYPTION_KEY ||
    "";
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  if (/^[A-Fa-f0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    candidates.push(Buffer.from(trimmed, "hex"));
  }
  try {
    candidates.push(Buffer.from(trimmed, "base64"));
  } catch {}
  candidates.push(Buffer.from(trimmed, "utf8"));

  for (const candidate of candidates) {
    try {
      const buf = Buffer.isBuffer(candidate) ? candidate : Buffer.from(candidate);
      if (buf.length === 32) return buf;
    } catch {}
  }

  return null;
}

function getKey() {
  return getConfiguredKey();
}

function isTokenEncryptionRequired() {
  if (isProductionEnvironment()) return true;

  const raw = String(process.env.REQUIRE_TOKEN_ENCRYPTION || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function assertTokenEncryptionConfigured(context = "persistencia de tokens") {
  if (!isTokenEncryptionRequired()) return false;
  if (getKey()) return true;

  const error = new Error(
    `ML_TOKEN_ENCRYPTION_KEY/TOKEN_ENCRYPTION_KEY e obrigatoria em producao para ${context}.`,
  );
  error.code = "TOKEN_ENCRYPTION_REQUIRED";
  error.statusCode = 500;
  throw error;
}

function isEncryptedToken(value) {
  return String(value || "").startsWith(TOKEN_PREFIX);
}

function encryptToken(plainText) {
  const key = getKey();
  const value = String(plainText || "");
  if (!value) return value;
  if (!key) {
    assertTokenEncryptionConfigured("persistencia de tokens do Mercado Livre");
    return value;
  }
  if (isEncryptedToken(value)) return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${TOKEN_PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptToken(value) {
  const raw = String(value || "");
  if (!raw) return raw;
  if (!isEncryptedToken(raw)) return raw;

  const key = getKey();
  if (!key) {
    throw new Error(
      "ML_TOKEN_ENCRYPTION_KEY/TOKEN_ENCRYPTION_KEY não configurada para descriptografar tokens.",
    );
  }

  const encoded = raw.slice(TOKEN_PREFIX.length);
  const [ivPart, tagPart, cipherPart] = encoded.split(".");
  if (!ivPart || !tagPart || !cipherPart) {
    throw new Error("Formato de token criptografado inválido.");
  }

  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const encrypted = Buffer.from(cipherPart, "base64url");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plain.toString("utf8");
}

function canEncryptTokens() {
  return !!getKey();
}

module.exports = {
  assertTokenEncryptionConfigured,
  canEncryptTokens,
  decryptToken,
  encryptToken,
  isEncryptedToken,
  isTokenEncryptionRequired,
};
