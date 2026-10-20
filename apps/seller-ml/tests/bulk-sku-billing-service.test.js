const assert = require('node:assert/strict');
const test = require('node:test');
const billing = require('../services/bulkSkuBillingService');

test('reserva usa a quantidade de SKUs prontos e chave estável do job', async () => {
  let request;
  const result = await billing.reserveSkuCredits({ mlCreds: { meli_user_id: 123 }, jobId: 'job-1', units: 1501, reserve: async (value) => { request = value; return { reserved_credits: 2 }; } });
  assert.equal(request.operationKey, 'listing.sku-update');
  assert.equal(request.units, 1501);
  assert.match(request.idempotencyKey, /^listing\.sku-update:job-1:[0-9a-f-]{36}$/);
  assert.equal(result.reserved_credits, 2);
});

test('liquidação usa apenas linhas aplicadas e libera o resto', async () => {
  let options;
  const summary = await billing.settleSkuCredits({ reserved_credits: 2, reserved_credit_units: 200, credit_unit_scale: 100, idempotency_key: 'a' }, 1, async (_reservation, value) => {
    options = value;
    return { reserved_credits: 200, consumed_credits: 100, credit_unit_scale: 100 };
  });
  assert.deepEqual(options, { release: false, consumedUnits: 1 });
  assert.equal(summary.spent_credits, 1);
  assert.equal(summary.released_credits, 1);
  assert.equal(summary.status, 'confirmed');
});

test('nenhuma aplicação libera toda a reserva', async () => {
  let options;
  await billing.settleSkuCredits({ reserved_credits: 1, idempotency_key: 'a' }, 0, async (_reservation, value) => {
    options = value;
    return { reserved_credits: 100, consumed_credits: 0, credit_unit_scale: 100 };
  });
  assert.deepEqual(options, { release: true, consumedUnits: null });
});
