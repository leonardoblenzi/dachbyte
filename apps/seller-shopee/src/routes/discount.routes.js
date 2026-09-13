const express = require("express");
const router = express.Router();
const discountController = require("../controllers/DiscountController");
const { requireAuth } = require("../middlewares/sessionAuth");
const asyncHandler = require("../utils/asyncHandler");
const { chargeOperation } = require("../middlewares/shopeeCreditBilling");

// Todas as rotas de desconto precisam de autenticação
router.use(requireAuth);

// Listar campanhas
router.get(
  "/",
  asyncHandler(discountController.listCampaigns.bind(discountController)),
);

// Criar nova campanha
router.post(
  "/",
  chargeOperation("shopee.discounts.write"),
  asyncHandler(discountController.createCampaign.bind(discountController)),
);

// Exportar campanhas (antes de /:id para evitar conflito de rota)
router.get(
  "/export/file",
  asyncHandler(discountController.exportCampaigns.bind(discountController)),
);

// Importar campanhas
router.post(
  "/import/file",
  chargeOperation("shopee.discounts.write"),
  asyncHandler(discountController.importCampaigns.bind(discountController)),
);

// Obter detalhes da campanha
router.get(
  "/:id",
  asyncHandler(discountController.getCampaign.bind(discountController)),
);

// Atualizar campanha
router.post(
  "/:id",
  chargeOperation("shopee.discounts.write"),
  asyncHandler(discountController.updateCampaign.bind(discountController)),
);

// Duplicar campanha
router.post(
  "/:id/duplicate",
  chargeOperation("shopee.discounts.write"),
  asyncHandler(discountController.duplicateCampaign.bind(discountController)),
);

// Adicionar itens à campanha
router.post(
  "/:id/items",
  chargeOperation("shopee.discounts.write"),
  asyncHandler(discountController.addItems.bind(discountController)),
);

// Atualizar item da campanha
router.post(
  "/:campaignId/items/:itemId/update",
  chargeOperation("shopee.discounts.write"),
  asyncHandler(discountController.updateItem.bind(discountController)),
);

// Remover item da campanha
router.post(
  "/:campaignId/items/:itemId/delete",
  chargeOperation("shopee.discounts.write"),
  asyncHandler(discountController.removeItem.bind(discountController)),
);

// Publicar/Sincronizar campanha com Shopee
router.post(
  "/:id/publish",
  chargeOperation("shopee.discounts.publish"),
  asyncHandler(discountController.publishCampaign.bind(discountController)),
);

// Encerrar campanha
router.post(
  "/:id/end",
  chargeOperation("shopee.discounts.close"),
  asyncHandler(discountController.endCampaign.bind(discountController)),
);

// Deletar campanha
router.post(
  "/:id/delete",
  chargeOperation("shopee.discounts.close"),
  asyncHandler(discountController.deleteCampaign.bind(discountController)),
);

module.exports = router;
