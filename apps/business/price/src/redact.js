"use strict";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /^(password|password_hash|access_token|refresh_token|token|secret|authorization|cookie|cpf|cnpj|rg|document|document_number|email|phone|telephone|mobile|card|card_number|credit_card_number|recipient_address|billing_address|shipping_address|address|buyer|customer)$/i;
const PARTIAL_SENSITIVE_KEY = /(password|access.?token|refresh.?token|client.?secret|partner.?key|authorization|cookie|credit.?card|card.?number)/i;

function redactForStorage(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactForStorage(item, seen));

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || PARTIAL_SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactForStorage(child, seen);
  }
  return out;
}

module.exports = { redactForStorage, REDACTED };
