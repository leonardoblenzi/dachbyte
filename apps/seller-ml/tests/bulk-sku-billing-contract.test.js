const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('SKU em lote tem preço por bloco e reserva persistida no job', () => {
  const costs = require('../services/mlCreditCosts');
  assert.equal(costs.calculateOperationCredits('listing.sku-update', { units: 1 }), 1);
  assert.equal(costs.calculateOperationCredits('listing.sku-update', { units: 1500 }), 1);
  assert.equal(costs.calculateOperationCredits('listing.sku-update', { units: 1501 }), 2);
  const migration = fs.readFileSync(path.join(__dirname, '../db/077_bulk_sku_credits.sql'), 'utf8');
  assert.match(migration, /credit_reservation jsonb/i);
  assert.match(migration, /credit_settlement jsonb/i);
});
