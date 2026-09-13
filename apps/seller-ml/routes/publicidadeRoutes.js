// routes/publicidadeRoutes.js
const express = require("express");
const router = express.Router();

const PublicidadeController = require("../controllers/PublicidadeController");

// ==========================================
// Product Ads – Campanhas, Itens, CSV, Gráfico
// Prefixo no index.js: app.use('/api/publicidade', publicidadeRoutes);
// ==========================================

// Campanhas + métricas agregadas
// GET /api/publicidade/product-ads/campaigns?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
router.get("/product-ads/campaigns", PublicidadeController.listarCampanhas);

// Detalhe de campanha
router.get("/product-ads/campaigns/:id", PublicidadeController.obterCampanha);

// Editar campanha (nome, orçamento, ROAS, status)
router.patch("/product-ads/campaigns/:id", PublicidadeController.atualizarCampanha);

// Ad Groups / anuncios patrocinados (fluxo atual do Product Ads)
router.get("/product-ads/ad-groups", PublicidadeController.listarAdGroups);

// Resumo consolidado do período
// GET /api/publicidade/product-ads/summary?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
router.get("/product-ads/summary", PublicidadeController.obterResumoCampanhas);

// Exportar CSV (NOVO) — a partir da tabela de anúncios da campanha
// GET /api/publicidade/product-ads/campaigns/:id/items/export.csv?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
// -> deve baixar um CSV com colunas: mlb, campanha
router.get(
  "/product-ads/campaigns/:id/items/export.csv",
  PublicidadeController.exportarItensCampanhaCsv
);

// Itens (anúncios) de uma campanha específica
// GET /api/publicidade/product-ads/campaigns/:id/items?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
router.get(
  "/product-ads/campaigns/:id/items",
  PublicidadeController.listarItensCampanha
);

// Métricas diárias por campanha
router.get(
  "/product-ads/campaigns/:id/metrics/daily",
  PublicidadeController.metricasDiariasCampanha
);

// Itens disponíveis para adicionar na campanha
router.get(
  "/product-ads/campaigns/:id/available-items",
  PublicidadeController.listarItensDisponiveisCampanha
);

// Adicionar anúncios na campanha existente
router.post(
  "/product-ads/campaigns/:id/items",
  PublicidadeController.adicionarItensCampanha
);

// Remover anúncio da campanha
router.delete(
  "/product-ads/campaigns/:id/items/:itemId",
  PublicidadeController.removerItemCampanha
);

// Atualizar status do anúncio dentro da campanha
router.patch(
  "/product-ads/campaigns/:id/items/:itemId",
  PublicidadeController.atualizarItemCampanha
);

// Exportar itens da campanha em CSV (LEGADO - compatibilidade)
// GET /api/publicidade/product-ads/campaigns/:id/export?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
router.get(
  "/product-ads/campaigns/:id/export",
  PublicidadeController.exportarItensCampanhaCsv
);

// Métricas diárias (para o gráfico de linha)
// GET /api/publicidade/product-ads/metrics/daily?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
router.get("/product-ads/metrics/daily", PublicidadeController.metricasDiarias);

// ======================================================
// Wizard de criação de campanha (2 passos)
// ======================================================
// Passo 1 - listar anúncios com campanha atual e vendas 30d
// GET /api/publicidade/product-ads/campaign-wizard/items?query=&status=&page=&limit=
router.get(
  "/product-ads/campaign-wizard/items",
  PublicidadeController.listarItensWizardCriacao
);

// Passo 2 - criar campanha e vincular anúncios selecionados
// POST /api/publicidade/product-ads/campaigns
// body: { name, roas_target, daily_budget, item_ids[] }
router.post(
  "/product-ads/campaigns",
  PublicidadeController.criarCampanhaComItens
);

module.exports = router;
