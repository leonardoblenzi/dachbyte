"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const orderController_1 = require("../controllers/orderController");
const router = (0, express_1.Router)();
// POST /api/orders/clear - Limpar banco de dados
router.post('/clear', orderController_1.clearOrdersDatabase);
// POST /api/orders/import - Importar planilha
router.post('/import', orderController_1.importOrders);
// GET /api/orders - Listar todos os pedidos
router.get('/', orderController_1.getOrders);
// GET /api/orders/custom-statuses - Listar status personalizados salvos
router.get('/custom-statuses', orderController_1.listCustomOrderStatuses);
// POST /api/orders/custom-statuses - Criar status personalizado reutilizavel
router.post('/custom-statuses', orderController_1.createCustomOrderStatus);
// POST /api/orders/search-external - Buscar pedido/NF/XML em provedores externos
router.post('/search-external', orderController_1.searchExternalOrder);
// GET /api/orders/:id/open-tracking - Abrir link direto de rastreio
router.get('/:id/open-tracking', orderController_1.openOrderTracking);
// PATCH /api/orders/:id/freight-type - Atualizar transportadora manualmente
router.patch('/:id/freight-type', orderController_1.updateOrderFreightType);
// PATCH /api/orders/:id/manual-data - Atualizar dados manuais do pedido
router.patch('/:id/manual-data', orderController_1.updateOrderManualData);
// PATCH /api/orders/:id/mark-delivered - Alterar status do pedido para entregue manualmente
router.patch('/:id/mark-delivered', orderController_1.markOrderDeliveredManually);
// PATCH /api/orders/:id/archive - Arquivar pedido
router.patch('/:id/archive', orderController_1.archiveOrder);
// PATCH /api/orders/:id/unarchive - Retirar pedido do arquivo
router.patch('/:id/unarchive', orderController_1.unarchiveOrder);
// GET /api/orders/:id - Detalhes de um pedido
router.get('/:id', orderController_1.getOrderById);
// POST /api/orders/:id/sync - Sincronizar rastreio de um pedido
router.post('/:id/sync', orderController_1.syncSingleOrder);
// POST /api/orders/sync-all - Sincronizar todos os pedidos ativos
router.post('/sync-all', orderController_1.syncAllOrders);
router.post('/sync-all/start', orderController_1.startSyncAllOrders);
router.get('/sync-all/status', orderController_1.getSyncAllStatus);
router.post('/sync-all/cancel', orderController_1.cancelSyncAllOrders);
exports.default = router;
