// @ts-check
"use strict";

const crypto = require("node:crypto");

const PREFIX = "enc::v1::";

/**
 * Chave de 32 bytes a partir do ambiente: base64 ou hex de 32 bytes; qualquer
 * outro texto é derivado com SHA-256 (mesmo cuidado do DACH ML com tokens).
 * @param {string} raw
 */
function deriveKey(raw) {
  const value = String(raw || "").trim();
  if (!value) throw Object.assign(new Error("HUB_TOKEN_ENCRYPTION_KEY não configurada."), { status: 503 });
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  const b64 = Buffer.from(value, "base64");
  if (b64.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return b64;
  return crypto.createHash("sha256").update(value).digest();
}

/**
 * Cifra AES-256-GCM para tokens dos marketplaces. Formato: enc::v1::iv.tag.dado (base64url).
 * @param {string} rawKey
 */
function createCipher(rawKey) {
  const key = deriveKey(rawKey);
  return {
    /** @param {string} plain */
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${data.toString("base64url")}`;
    },
    /** @param {string} sealed */
    decrypt(sealed) {
      const text = String(sealed || "");
      if (!text.startsWith(PREFIX)) throw new Error("Token em formato desconhecido.");
      const [iv, tag, data] = text.slice(PREFIX.length).split(".");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

/** Texto aleatório seguro para uso em URL. @param {number} [bytes] */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** @param {string} value */
function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

/** @param {string} key @param {string} message */
function hmacSha256Hex(key, message) {
  return crypto.createHmac("sha256", String(key)).update(String(message)).digest("hex");
}

module.exports = { createCipher, randomToken, sha256, hmacSha256Hex, PREFIX };
