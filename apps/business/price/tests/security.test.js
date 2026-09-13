"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { assertSafeHttpsUrl, assertAllowedHost } = require("../src/security");
const { redactForStorage } = require("../src/redact");

test("bloqueia http e redes privadas", () => {
  assert.throws(() => assertSafeHttpsUrl("http://example.com"));
  assert.throws(() => assertSafeHttpsUrl("https://127.0.0.1"));
  assert.throws(() => assertSafeHttpsUrl("https://192.168.1.2"));
  assert.doesNotThrow(() => assertSafeHttpsUrl("https://loja.commercesuite.com.br/web_api"));
});

test("allowlist Tray aceita suffix configurado", () => {
  const url = new URL("https://trayparceiros.commercesuite.com.br/web_api");
  assert.doesNotThrow(() => assertAllowedHost(url,[".commercesuite.com.br"],"Tray"));
  assert.throws(() => assertAllowedHost(new URL("https://evil.example/web_api"),[".commercesuite.com.br"],"Tray"));
});

test("redacao remove tokens e PII obvia antes de persistir", () => {
  const value = redactForStorage({ order_id: 1, buyer:{email:"a@b.com"}, access_token:"secret", nested:{phone:"123", sku:"ABC"} });
  assert.equal(value.order_id,1);
  assert.equal(value.buyer,"[REDACTED]");
  assert.equal(value.access_token,"[REDACTED]");
  assert.equal(value.nested.phone,"[REDACTED]");
  assert.equal(value.nested.sku,"ABC");
});
