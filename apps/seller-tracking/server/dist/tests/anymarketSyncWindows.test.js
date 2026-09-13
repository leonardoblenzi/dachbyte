"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const anymarketSyncService_js_1 = require("../services/anymarketSyncService.js");
const integrationOrderStatusService_js_1 = require("../services/integrationOrderStatusService.js");
(0, node_test_1.default)('consulta pedidos novos e alterados em janelas independentes quando solicitado', () => {
    const windows = (0, anymarketSyncService_js_1.resolveAnymarketQueryWindows)(2, true);
    strict_1.default.equal(windows.length, 2);
    strict_1.default.deepEqual(windows.map((window) => window.windowType), ['created', 'updated']);
    strict_1.default.ok(windows[0].createdAfter);
    strict_1.default.equal(windows[0].updatedAfter, undefined);
    strict_1.default.ok(windows[1].updatedAfter);
    strict_1.default.equal(windows[1].createdAfter, undefined);
});
(0, node_test_1.default)('mantem uma unica janela de alteracoes para sincronizacoes sem busca dupla', () => {
    const windows = (0, anymarketSyncService_js_1.resolveAnymarketQueryWindows)(2);
    strict_1.default.equal(windows.length, 1);
    strict_1.default.equal(windows[0].windowType, 'updated');
});
(0, node_test_1.default)('converte rotulos ANYMARKET legados para os codigos aceitos pela API', () => {
    strict_1.default.equal((0, integrationOrderStatusService_js_1.normalizeAnymarketStatusValue)('Pago Aguardando Envio'), 'PAID_WAITING_SHIP');
    strict_1.default.equal((0, integrationOrderStatusService_js_1.normalizeAnymarketStatusValue)('Enviado'), 'PAID_WAITING_DELIVERY');
    strict_1.default.equal((0, integrationOrderStatusService_js_1.normalizeAnymarketStatusValue)('Concluido / Entregue'), 'CONCLUDED');
});
