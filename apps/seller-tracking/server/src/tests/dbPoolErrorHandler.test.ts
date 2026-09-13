import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

test('keeps the process alive when PostgreSQL closes an idle pool connection', async () => {
  process.env.AVANTRACKING_DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

  const { attachPoolErrorHandler } = await import('../lib/db.js');
  const pool = new EventEmitter();
  attachPoolErrorHandler(pool as any);

  assert.doesNotThrow(() => {
    pool.emit('error', Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    }));
  });
});
