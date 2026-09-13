"use strict";

const crypto = require("crypto");
const { config } = require("./config");

function keyMaterial() {
  const raw = String(config.encryptionKey || "").trim();
  if (!raw) {
    if (config.isProduction) {
      const error = new Error("VOLT_PRICE_ENCRYPTION_KEY obrigatoria em producao para armazenar tokens.");
      error.code = "encryption_key_missing";
      throw error;
    }
    return crypto.createHash("sha256").update("volt-price-local-development-only").digest();
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
  } catch (_) {}
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(value) {
  if (value === null || value === undefined || value === "") return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyMaterial(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decrypt(payload) {
  if (!payload) return null;
  const [version, ivB64, tagB64, dataB64] = String(payload).split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) throw new Error("Token criptografado invalido.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyMaterial(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("base64url"); }

module.exports = { encrypt, decrypt, sha256, randomToken };
