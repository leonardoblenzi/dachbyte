const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('worker tenta liquidar falhas terminais e reconcilia saldos pendentes', () => {
  const queue = fs.readFileSync(path.join(__dirname, '../services/bulkSkuQueueService.js'), 'utf8');
  assert.match(queue, /settleJobCredits\(job\.data\.jobId/);
  assert.match(queue, /credit_settlement->>'status'/);
});

test('jobs aguardando fila são reenfileirados com o mesmo ID', async () => {
  const { reconcileQueuedApplications } = require('../services/bulkSkuQueueService');
  const enqueued = [];
  const db = { query: async (sql) => {
    assert.match(sql, /status = 'queued'/);
    return { rows: [{ id: 'job-1' }, { id: 'job-2' }] };
  } };
  await reconcileQueuedApplications(db, async (id) => { enqueued.push(id); });
  assert.deepEqual(enqueued, ['job-1', 'job-2']);
});
