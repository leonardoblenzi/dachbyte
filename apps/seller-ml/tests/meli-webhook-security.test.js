"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPromotionResourceUrl,
  isSupportedTopic,
  normalizeResourceForTopic,
  validateWebhookNotification,
} = require("../services/meliWebhookSecurity");

test("aceita resource oficial de public_offers", () => {
  const result = normalizeResourceForTopic(
    "/seller-promotions/offers/OFFER-MLB1234567890-12345",
    "public_offers",
  );
  assert.equal(result.ok, true);
  assert.equal(result.resource, "/seller-promotions/offers/OFFER-MLB1234567890-12345");
});

test("aceita resource oficial de public_candidates", () => {
  const result = normalizeResourceForTopic(
    "/seller-promotions/candidates/CANDIDATE-MLB1234567890-12345",
    "public_candidates",
  );
  assert.equal(result.ok, true);
});

test("identifica apenas os topicos de promocao suportados", () => {
  assert.equal(isSupportedTopic("public_offers"), true);
  assert.equal(isSupportedTopic("PUBLIC_CANDIDATES"), true);
  assert.equal(isSupportedTopic("orders_v2"), false);
  assert.equal(isSupportedTopic("items"), false);
});

test("bloqueia URL absoluta externa antes de anexar token", () => {
  const result = normalizeResourceForTopic("https://attacker.example/collect", "public_offers");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "resource_origin_not_allowed");
});

test("bloqueia URL scheme-relative", () => {
  const result = normalizeResourceForTopic(
    "//attacker.example/seller-promotions/offers/123",
    "public_offers",
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "resource_scheme_relative_not_allowed");
});

test("bloqueia localhost e enderecos internos", () => {
  for (const url of [
    "http://127.0.0.1:3000/seller-promotions/offers/123",
    "http://localhost/seller-promotions/offers/123",
    "http://169.254.169.254/seller-promotions/offers/123",
  ]) {
    const result = normalizeResourceForTopic(url, "public_offers");
    assert.equal(result.ok, false, url);
  }
});

test("bloqueia troca de endpoint entre topicos", () => {
  const result = normalizeResourceForTopic(
    "/seller-promotions/candidates/CANDIDATE-MLB1-1",
    "public_offers",
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "resource_path_not_allowed");
});

test("bloqueia query e hash fornecidos pelo webhook", () => {
  const withQuery = normalizeResourceForTopic(
    "/seller-promotions/offers/123?foo=bar",
    "public_offers",
  );
  const withHash = normalizeResourceForTopic(
    "/seller-promotions/offers/123#x",
    "public_offers",
  );
  assert.equal(withQuery.ok, false);
  assert.equal(withHash.ok, false);
});

test("monta URL autenticada apenas no host oficial e adiciona app_version", () => {
  const url = buildPromotionResourceUrl(
    "/seller-promotions/offers/123",
    "public_offers",
  );
  assert.equal(
    url,
    "https://api.mercadolibre.com/seller-promotions/offers/123?app_version=v2",
  );
});

test("valida application_id quando configurado", () => {
  const ok = validateWebhookNotification(
    {
      topic: "public_offers",
      resource: "/seller-promotions/offers/123",
      user_id: 999,
      application_id: 456,
    },
    { expectedApplicationId: 456, requireApplicationId: true },
  );
  const bad = validateWebhookNotification(
    {
      topic: "public_offers",
      resource: "/seller-promotions/offers/123",
      user_id: 999,
      application_id: 999,
    },
    { expectedApplicationId: 456, requireApplicationId: true },
  );

  assert.equal(ok.ok, true);
  assert.equal(ok.ignored, false);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "application_id_mismatch");
});

test("mantem rejeicao estrita de topico nao suportado no processamento interno", () => {
  const result = validateWebhookNotification({
    topic: "orders_v2",
    resource: "/orders/123",
    user_id: 999,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "topic_not_supported");
});

test("permite ACK seguro de topico nao suportado no receptor publico", () => {
  const result = validateWebhookNotification(
    {
      topic: "orders_v2",
      resource: "http://127.0.0.1:3000/admin",
      user_id: 999,
      application_id: 456,
    },
    { allowUnsupportedTopic: true },
  );

  assert.equal(result.ok, true);
  assert.equal(result.ignored, true);
  assert.equal(result.reason, "topic_not_supported");
  assert.equal(result.notification.topic, "orders_v2");
  assert.equal(Object.prototype.hasOwnProperty.call(result.notification, "resource"), false);
});

test("allowUnsupportedTopic nao enfraquece a allowlist dos topicos suportados", () => {
  const result = validateWebhookNotification(
    {
      topic: "public_offers",
      resource: "https://attacker.example/seller-promotions/offers/123",
      user_id: 999,
    },
    { allowUnsupportedTopic: true },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "resource_origin_not_allowed");
});

test("payload sem topic continua invalido", () => {
  const result = validateWebhookNotification(
    {
      resource: "/orders/123",
      user_id: 999,
    },
    { allowUnsupportedTopic: true },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "topic_missing");
});
