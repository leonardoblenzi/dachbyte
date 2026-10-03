"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../services/promoJobsService");

test("fingerprint promocional identifica a operacao logica e ignora operationId", () => {
  const base = {
    accountKey: "seller-123",
    action: "apply",
    promotion: { id: "DEAL-1", type: "DEAL" },
    price_policy: "min",
    filters: {
      status: "candidate",
      maxDesc: 20,
      mlbs: ["MLB3", "MLB1", "MLB2"],
    },
    selectionItems: [
      { id: "MLB2", offer_id: "O2" },
      { id: "MLB1", offer_id: "O1" },
    ],
    options: {
      dryRun: false,
      prevalidated_selection: true,
      selection_count: 3,
      operation_id: "OP-A",
    },
  };

  const sameLogicalRequest = {
    ...base,
    filters: {
      ...base.filters,
      mlbs: ["MLB2", "MLB3", "MLB1"],
    },
    selectionItems: [
      { id: "MLB1", offer_id: "O1" },
      { id: "MLB2", offer_id: "O2" },
    ],
    options: {
      ...base.options,
      operation_id: "OP-B",
    },
  };

  assert.equal(
    _test.buildPromoRequestFingerprint(base),
    _test.buildPromoRequestFingerprint(sameLogicalRequest),
  );
});

test("fingerprint promocional separa contas, campanhas e acoes", () => {
  const base = {
    accountKey: "seller-123",
    action: "apply",
    promotion: { id: "DEAL-1", type: "DEAL" },
    filters: { mlbs: ["MLB1"] },
    options: { prevalidated_selection: true, selection_count: 1 },
  };

  const fingerprint = _test.buildPromoRequestFingerprint(base);
  assert.notEqual(
    fingerprint,
    _test.buildPromoRequestFingerprint({ ...base, accountKey: "seller-456" }),
  );
  assert.notEqual(
    fingerprint,
    _test.buildPromoRequestFingerprint({ ...base, action: "remove" }),
  );
  assert.notEqual(
    fingerprint,
    _test.buildPromoRequestFingerprint({
      ...base,
      promotion: { id: "DEAL-2", type: "DEAL" },
    }),
  );
});

test("idempotencia de billing usa operationId e nunca o fingerprint", () => {
  const fingerprint = "same-logical-fingerprint";

  const first = _test.promotionBillingIdempotencyKey("OP-1");
  const second = _test.promotionBillingIdempotencyKey("OP-2");

  assert.equal(first, "promotions:OP-1");
  assert.equal(second, "promotions:OP-2");
  assert.notEqual(first, second);
  assert.equal(first.includes(fingerprint), false);
  assert.equal(second.includes(fingerprint), false);
  assert.equal(
    _test.promotionBillingIdempotencyKey("VAL-1", { validation: true }),
    "promotions-validate:VAL-1",
  );
});

test("reaplicacao usa tarifa propria somente dentro do cooldown", () => {
  assert.equal(_test.promotionBillingOperationKey("apply", false), "promotions.apply");
  assert.equal(_test.promotionBillingOperationKey("apply", true), "promotions.reapply_recent");
  assert.equal(_test.promotionBillingOperationKey("remove", true), "promotions.remove");
});

test("historico recente distingue cooldown de 6h e janela de 24h", () => {
  const now = Date.UTC(2026, 9, 2, 21, 0, 0);

  const fiveHoursAgo = _test.classifyRecentPromotionExecution({
    finished_at_ms: now - 5 * 60 * 60 * 1000,
  }, now);
  assert.equal(fiveHoursAgo.within_cooldown, true);
  assert.equal(fiveHoursAgo.within_history, true);

  const eightHoursAgo = _test.classifyRecentPromotionExecution({
    finished_at_ms: now - 8 * 60 * 60 * 1000,
  }, now);
  assert.equal(eightHoursAgo.within_cooldown, false);
  assert.equal(eightHoursAgo.within_history, true);

  const twentyFiveHoursAgo = _test.classifyRecentPromotionExecution({
    finished_at_ms: now - 25 * 60 * 60 * 1000,
  }, now);
  assert.equal(twentyFiveHoursAgo.within_cooldown, false);
  assert.equal(twentyFiveHoursAgo.within_history, false);
});

test("contador de chamadas ML acumula apenas o delta ainda nao reportado", () => {
  const runtime = { mlApiCalls: 5, reportedMlApiCalls: 0 };

  const first = _test.consumePromoMlApiCalls(0, runtime);
  assert.equal(first, 5);
  assert.equal(runtime.reportedMlApiCalls, 5);

  const second = _test.consumePromoMlApiCalls(first, runtime);
  assert.equal(second, 5);

  runtime.mlApiCalls = 8;
  const third = _test.consumePromoMlApiCalls(second, runtime);
  assert.equal(third, 8);
  assert.equal(runtime.reportedMlApiCalls, 8);
});

test("telemetria shadow preserva identidade, quantidades e custo estimado", () => {
  const data = {
    operationId: "OP-TELEMETRY",
    requestFingerprint: "fingerprint-1",
    recentRepeat: true,
    billingOperationKey: "promotions.reapply_recent",
    createdAt: Date.now() - 1500,
    options: {
      selection_count: 100,
      expected_total: 100,
      dryRun: false,
    },
    creditReservation: {
      bypass: true,
      shadow: true,
      reserved_credits: 0,
      quote: {
        operation_key: "promotions.reapply_recent",
        estimated_credits: 2,
      },
    },
  };

  const telemetry = _test.buildPromotionBillingTelemetry(data, {
    total: 80,
    processed: 70,
    success: 65,
    failed: 5,
    results: [
      { transient_retries: 1 },
      { transient_retries: 2 },
    ],
    finished: true,
  });

  assert.equal(telemetry.billing_mode, "shadow");
  assert.equal(telemetry.operation_key, "promotions.reapply_recent");
  assert.equal(telemetry.operation_id, "OP-TELEMETRY");
  assert.equal(telemetry.request_fingerprint, "fingerprint-1");
  assert.equal(telemetry.recent_repeat, true);
  assert.equal(telemetry.selected, 100);
  assert.equal(telemetry.eligible, 80);
  assert.equal(telemetry.processed, 70);
  assert.equal(telemetry.altered, 65);
  assert.equal(telemetry.ignored, 20);
  assert.equal(telemetry.errors, 5);
  assert.equal(telemetry.retries, 3);
  assert.equal(telemetry.estimated_credits, 2);
  assert.ok(telemetry.duration_ms >= 1000);
  assert.ok(telemetry.finished_at);
});
