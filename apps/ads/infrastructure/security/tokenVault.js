"use strict";

const crypto = require("node:crypto");
const { env } = require("../../config/env");

const PREFIX = "dach::ads::v1::";

function parseKey(rawValue = env.tokenEncryptionKey) {
  const raw = String(rawValue || "").trim();
  if (!raw) return null;

  const candidates = [];
  if (/^[A-Fa-f0-9]{64}$/.test(raw)) candidates.push(Buffer.from(raw, "hex"));
  try { candidates.push(Buffer.from(raw, "base64")); } catch {}
  candidates.push(Buffer.from(raw, "utf8"));
  return candidates.find((buffer) => buffer.length === 32) || null;
}

function assertConfigured() {
  if (!parseKey()) {
    const error = new Error("ADS_TOKEN_ENCRYPTION_KEY must contain exactly 32 bytes (base64, hex or raw).");
    error.code = "ADS_TOKEN_ENCRYPTION_KEY_INVALID";
    throw error;
  }
}

function encrypt(value) {
  const plain = String(value || "");
  if (!plain) return null;
  const key = parseKey();
  if (!key) throw new Error("ADS_TOKEN_ENCRYPTION_KEY is not configured");
  if (plain.startsWith(PREFIX)) return plain;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decrypt(value) {
  const raw = String(value || "");
  if (!raw) return null;
  if (!raw.startsWith(PREFIX)) throw new Error("Refusing to decrypt a plaintext DACH Ads credential");
  const key = parseKey();
  if (!key) throw new Error("ADS_TOKEN_ENCRYPTION_KEY is not configured");

  const [ivPart, tagPart, ciphertextPart] = raw.slice(PREFIX.length).split(".");
  if (!ivPart || !tagPart || !ciphertextPart) throw new Error("Invalid encrypted credential format");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

module.exports = { assertConfigured, encrypt, decrypt, parseKey };
