"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const modal = require("../public/js/credit-operation-modal.js");

test("normaliza quote pré-pago com saldo projetado", () => {
  const view = modal.normalizeQuote({
    estimated_credits: 12,
    available_credits: 100,
    sufficient: true,
    unlimited: false,
  });

  assert.equal(view.mode, "prepaid");
  assert.equal(view.projectedCredits, 88);
  assert.equal(view.canConfirm, true);
});

test("quote ilimitado confirma sem custo artificial", () => {
  const view = modal.normalizeQuote({ unlimited: true, estimated_credits: 12 });

  assert.equal(view.mode, "unlimited");
  assert.equal(view.canConfirm, true);
  assert.equal(view.estimatedCredits, null);
});

test("quote insuficiente bloqueia confirmação", () => {
  const view = modal.normalizeQuote({
    estimated_credits: 12,
    available_credits: 4,
    sufficient: false,
  });

  assert.equal(view.mode, "insufficient");
  assert.equal(view.projectedCredits, 0);
  assert.equal(view.canConfirm, false);
});

test("quote ausente fica indisponível", () => {
  assert.deepEqual(modal.normalizeQuote(null), {
    mode: "unavailable",
    canConfirm: false,
    estimatedCredits: null,
    availableCredits: null,
    projectedCredits: null,
  });
});

test("quote insuficiente não expõe ação de confirmação", () => {
  const html = modal.render(
    { mode: "insufficient", canConfirm: false, estimatedCredits: 12, availableCredits: 4 },
    { quantity: 5, unitLabel: "anúncios" },
  );

  assert.match(html, /Saldo insuficiente/);
  assert.doesNotMatch(html, /data-credit-confirm/);
});

test("cotação sem estimativa não apresenta zero como custo confirmado", () => {
  const view = modal.normalizeQuote({ estimated_credits: null, available_credits: 100 });
  assert.equal(view.mode, "unavailable");
  assert.equal(view.canConfirm, false);
});

test("cotação diferida exibe mínimo e avisa que valor final depende da descoberta", () => {
  const view = modal.normalizeQuote({
    deferred: true,
    estimated_credits: null,
    minimum_estimated_credits: 1,
    available_credits: 100,
  });
  assert.equal(view.mode, "deferred");
  assert.equal(view.canConfirm, true);
  const html = modal.render(view, { quantity: 0, unitLabel: "anúncios" });
  assert.match(html, /Estimativa mínima/);
  assert.match(html, /quantidade real/);
  assert.doesNotMatch(html, /0 anúncios/);
});

test("descoberta diferida sem mínimo pode iniciar, mas não promete crédito zero", () => {
  const view = modal.normalizeQuote({
    deferred: true,
    estimated_credits: null,
    available_credits: null,
  });
  assert.equal(view.mode, "deferred");
  assert.equal(view.canConfirm, true);
  const html = modal.render(view, { quantity: 0, unitLabel: "anúncios" });
  assert.match(html, /custo final será confirmado na reserva/);
  assert.doesNotMatch(html, /0 c/);
});
