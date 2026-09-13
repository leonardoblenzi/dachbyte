import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAnymarketQueryWindows } from '../services/anymarketSyncService.js';
import { normalizeAnymarketStatusValue } from '../services/integrationOrderStatusService.js';

test('consulta pedidos novos e alterados em janelas independentes quando solicitado', () => {
  const windows = resolveAnymarketQueryWindows(2, true);

  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((window) => window.windowType), ['created', 'updated']);
  assert.ok(windows[0].createdAfter);
  assert.equal(windows[0].updatedAfter, undefined);
  assert.ok(windows[1].updatedAfter);
  assert.equal(windows[1].createdAfter, undefined);
});

test('mantem uma unica janela de alteracoes para sincronizacoes sem busca dupla', () => {
  const windows = resolveAnymarketQueryWindows(2);

  assert.equal(windows.length, 1);
  assert.equal(windows[0].windowType, 'updated');
});
test('converte rotulos ANYMARKET legados para os codigos aceitos pela API', () => {
  assert.equal(normalizeAnymarketStatusValue('Pago Aguardando Envio'), 'PAID_WAITING_SHIP');
  assert.equal(normalizeAnymarketStatusValue('Enviado'), 'PAID_WAITING_DELIVERY');
  assert.equal(normalizeAnymarketStatusValue('Concluido / Entregue'), 'CONCLUDED');
});