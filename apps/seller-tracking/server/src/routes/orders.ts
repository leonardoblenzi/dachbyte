import { Router } from 'express';
import {
  importOrders,
  getOrders,
  getOrderById,
  syncSingleOrder,
  syncAllOrders,
  startSyncAllOrders,
  getSyncAllStatus,
  cancelSyncAllOrders,
  clearOrdersDatabase,
  openOrderTracking,
  searchExternalOrder,
  updateOrderFreightType,
  updateOrderManualData,
  markOrderDeliveredManually,
  archiveOrder,
  unarchiveOrder,
  listCustomOrderStatuses,
  createCustomOrderStatus,
} from '../controllers/orderController';

const router = Router();

// POST /api/orders/clear - Limpar banco de dados
router.post('/clear', clearOrdersDatabase);

// POST /api/orders/import - Importar planilha
router.post('/import', importOrders);

// GET /api/orders - Listar todos os pedidos
router.get('/', getOrders);

// GET /api/orders/custom-statuses - Listar status personalizados salvos
router.get('/custom-statuses', listCustomOrderStatuses);

// POST /api/orders/custom-statuses - Criar status personalizado reutilizavel
router.post('/custom-statuses', createCustomOrderStatus);

// POST /api/orders/search-external - Buscar pedido/NF/XML em provedores externos
router.post('/search-external', searchExternalOrder);

// GET /api/orders/:id/open-tracking - Abrir link direto de rastreio
router.get('/:id/open-tracking', openOrderTracking);

// PATCH /api/orders/:id/freight-type - Atualizar transportadora manualmente
router.patch('/:id/freight-type', updateOrderFreightType);

// PATCH /api/orders/:id/manual-data - Atualizar dados manuais do pedido
router.patch('/:id/manual-data', updateOrderManualData);

// PATCH /api/orders/:id/mark-delivered - Alterar status do pedido para entregue manualmente
router.patch('/:id/mark-delivered', markOrderDeliveredManually);

// PATCH /api/orders/:id/archive - Arquivar pedido
router.patch('/:id/archive', archiveOrder);

// PATCH /api/orders/:id/unarchive - Retirar pedido do arquivo
router.patch('/:id/unarchive', unarchiveOrder);

// GET /api/orders/:id - Detalhes de um pedido
router.get('/:id', getOrderById);

// POST /api/orders/:id/sync - Sincronizar rastreio de um pedido
router.post('/:id/sync', syncSingleOrder);

// POST /api/orders/sync-all - Sincronizar todos os pedidos ativos
router.post('/sync-all', syncAllOrders);
router.post('/sync-all/start', startSyncAllOrders);
router.get('/sync-all/status', getSyncAllStatus);
router.post('/sync-all/cancel', cancelSyncAllOrders);

export default router;
