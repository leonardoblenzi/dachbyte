"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hasUnlimitedAccess,
  reserveCredits,
} = require("../services/hubCreditsService");

test("identifica contas ilimitadas migradas ou de cortesia", () => {
  assert.equal(
    hasUnlimitedAccess({
      status: "internal_unlimited",
      billingMode: "internal",
      usagePolicy: "unlimited",
    }),
    true,
  );
  assert.equal(
    hasUnlimitedAccess({
      status: "courtesy_unlimited",
      billingMode: "courtesy",
      usagePolicy: "metered",
    }),
    true,
  );
  assert.equal(
    hasUnlimitedAccess({
      status: "legacy_active",
      billingMode: "legacy",
      usagePolicy: "metered",
    }),
    true,
  );
  assert.equal(
    hasUnlimitedAccess({
      status: "active",
      billingMode: "paid",
      usagePolicy: "metered",
    }),
    false,
  );
});

test("conta ilimitada nao chama Hub nem consome creditos no modo enforce", async () => {
  const previousMode = process.env.HUB_CREDITS_MODE;
  process.env.HUB_CREDITS_MODE = "enforce";

  try {
    const reservation = await reserveCredits({
      mlCreds: {
        meli_user_id: "123",
        tenant_id: "tenant_123",
        billing_status: "internal_unlimited",
        billing_mode: "internal",
        usage_policy: "unlimited",
      },
      operationKey: "promotions.apply",
      units: 10,
      idempotencyKey: "test:unlimited",
    });

    assert.equal(reservation.bypass, true);
    assert.equal(reservation.reason, "unlimited_account");
    assert.equal(reservation.reserved_credits, 0);
  } finally {
    if (previousMode === undefined) {
      delete process.env.HUB_CREDITS_MODE;
    } else {
      process.env.HUB_CREDITS_MODE = previousMode;
    }
  }
});
