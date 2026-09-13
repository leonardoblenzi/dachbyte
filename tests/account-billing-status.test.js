"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildAccountBillingPayload,
  canOperateAccount,
} = require("../apps/seller-ml/services/accountBillingStatus");

const futureGrace = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

test("carencia administrativa libera conta aguardando assinatura", () => {
  const account = {
    billing_status: "awaiting_subscription",
    billing_mode: "paid",
    usage_policy: "metered",
    billing_grace_expires_at: futureGrace,
  };

  assert.equal(canOperateAccount(account), true);
  assert.equal(buildAccountBillingPayload(account).can_operate, true);
  assert.equal(buildAccountBillingPayload(account).requires_regularization, false);
});

test("pagamento pendente respeita a carencia e bloqueia quando ela termina", () => {
  const inGrace = {
    billing_status: "suspended_by_payment",
    billing_grace_expires_at: futureGrace,
  };
  const expiredGrace = {
    billing_status: "suspended_by_payment",
    billing_grace_expires_at: "2020-01-01T00:00:00.000Z",
  };

  assert.equal(canOperateAccount(inGrace), true);
  assert.equal(canOperateAccount(expiredGrace), false);
});
