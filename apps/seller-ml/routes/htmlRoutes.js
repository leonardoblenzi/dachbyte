// routes/htmlRoutes.js
"use strict";

const express = require("express");
const path = require("path");

// ✅ gate de permissão (padrao/admin/master)
const ensurePermission = require("../middleware/ensurePermission");
const companyAccess = require("../services/companyAccessService");

let HtmlController;
try {
  HtmlController = require("../controllers/HtmlController");
} catch (error) {
  console.error("❌ Erro ao carregar HtmlController:", error.message);
  throw error;
}

const router = express.Router();
const allowLegacyUntilConfigured = (moduleKey) =>
  companyAccess.requireModuleAccess(moduleKey, { defaultAllowIfUnconfigured: true });

// (Opcional) Evita cache das páginas HTML
function noCache(_req, res, next) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
  });
  next();
}

/**
 * ✅ IMPORTANTE:
 * Rotas públicas (login/cadastro/selecao-plataforma) ficam no index.js.
 * Aqui deixamos apenas páginas do app (já protegidas pelo authGate).
 */

// Painel / Projeção Mensal
router.get("/painel", noCache, HtmlController.servirPainel);
router.get("/projecao-mensal", noCache, HtmlController.servirProjecaoMensal);
router.get("/dashboard", noCache, (req, res) => {
  return res.redirect(`${req.baseUrl || ""}/projecao-mensal`);
});

// Páginas existentes
router.get("/remover-promocao", noCache, allowLegacyUntilConfigured("ml.promocoes.remover"), HtmlController.servirRemoverPromocao);
router.get("/criar-promocao", noCache, allowLegacyUntilConfigured("ml.promocoes.criar"), HtmlController.criarPromocao);

router.get(
  "/atacado",
  noCache,
  companyAccess.requireModuleAccess("ml.operacao.atacado"),
  (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "views", "atacado.html"));
  }
);

router.get(
  "/modelo-massa",
  noCache,
  companyAccess.requireModuleAccess("ml.operacao.modelo_massa"),
  (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "views", "modelo-massa.html"));
  }
);

// ✅ Prazo (HTML)
router.get(
  "/caracteristicas",
  noCache,
  companyAccess.requireModuleAccess("ml.operacao.caracteristicas"),
  (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "views", "caracteristicas.html"));
  }
);

router.get("/prazo", noCache, allowLegacyUntilConfigured("ml.operacao.prazo"), (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "prazo.html"));
});

// Utilitários de geração/diagnóstico
router.get("/criar-projecao-exemplo", noCache, HtmlController.criarDashboard);
router.get("/criar-dashboard", noCache, HtmlController.criarDashboard);
// Teste simples
router.get("/test", (_req, res) => {
  res.send("Servidor Node.js com Express está rodando!");
});

// ✅ Exclusão de Anúncios (HTML) — ADMIN|MASTER (sensível)
router.get(
  "/gestao-anuncios",
  noCache,
  companyAccess.requireModuleAccess("ml.operacao.excluir_massa"),
  (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "views", "excluir-anuncio.html"));
  }
);

router.get("/excluir-anuncio", noCache, (req, res) => {
  res.redirect(`${req.baseUrl || ""}/gestao-anuncios`);
});

// Filtro Avançado de Anúncios (HTML)
router.get("/analise-mercado", noCache, allowLegacyUntilConfigured("ml.inteligencia.analise_mercado"), (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "analise-mercado.html"));
});

router.get("/filtro-anuncios", noCache, allowLegacyUntilConfigured("ml.anuncios.consulta"), (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "filtro-anuncios.html"));
});

router.get("/anuncios/cadastro", noCache, allowLegacyUntilConfigured("ml.anuncios.cadastro"), (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "anuncio-cadastro.html"));
});

router.get("/ranking-anuncios", noCache, allowLegacyUntilConfigured("ml.anuncios.ranking"), (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "ranking-anuncios.html"));
});

router.get("/full", noCache, allowLegacyUntilConfigured("ml.anuncios.full"), (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "full.html"));
});

router.get("/estrategicos", noCache, allowLegacyUntilConfigured("ml.anuncios.estrategicos"), (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "estrategicos.html"));
});

router.get("/estoque", noCache, allowLegacyUntilConfigured("ml.anuncios.estoque"), (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "estoque-alerta.html"));
});

router.get("/clonar-anuncio", noCache, (req, res) => {
  return res.redirect(`${req.baseUrl || ""}/filtro-anuncios`);
});

// ===========================
// ✅ Páginas HTML que antes colidiam com rotas de API (agora separadas)
// ===========================

// Publicidade (HTML)
const servePublicidadeProductAds = (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "publicidade.html"));
};
router.get("/publicidade", noCache, allowLegacyUntilConfigured("ml.publicidade.product_ads"), servePublicidadeProductAds);
router.get("/publicidade/product-ads", noCache, allowLegacyUntilConfigured("ml.publicidade.product_ads"), servePublicidadeProductAds);
router.get("/publicidade/campanha/:id", noCache, allowLegacyUntilConfigured("ml.publicidade.product_ads"), servePublicidadeProductAds);
router.get("/publicidade/product-ads/campanhas/:id", noCache, allowLegacyUntilConfigured("ml.publicidade.product_ads"), servePublicidadeProductAds);

// Validar Dimensões (HTML)
router.get("/validar-dimensoes", noCache, allowLegacyUntilConfigured("ml.operacao.validar_dimensoes"), (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "validar-dimensoes.html"));
});

// Curva ABC (HTML)
router.get("/ia-analytics/curva-abc", noCache, allowLegacyUntilConfigured("ml.inteligencia.curva_abc"), (_req, res) => {
  res.sendFile(
    path.join(__dirname, "..", "views", "ia-analytics", "curva-abc.html")
  );
});

router.get("/financeiro/custos-mercado-livre", noCache, allowLegacyUntilConfigured("ml.precificacao.custos"), (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "financeiro-ml-custos.html"));
});

router.get("/financeiro/margem-venda-mercado-livre", noCache, allowLegacyUntilConfigured("ml.precificacao.margem"), (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "financeiro-ml-margem.html"));
});

// A Calculadora reutiliza a mesma permissão de Margem de venda nesta primeira
// versão. Assim clientes que já têm Precificação liberada não perdem acesso por
// depender de uma nova chave de política ainda não cadastrada no Hub.
router.get("/financeiro/calculadora", noCache, allowLegacyUntilConfigured("ml.precificacao.margem"), (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "financeiro-ml-calculadora.html"));
});

router.get("/ajuda", noCache, (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "ajuda.html"));
});

router.get(
  "/conta/contas",
  noCache,
  companyAccess.requireNivelAdmin(),
  (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "views", "conta-contas.html"));
  },
);

router.get(
  "/conta/usuarios",
  noCache,
  companyAccess.requireNivelAdmin(),
  (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "views", "conta-usuarios.html"));
  },
);

router.get(
  "/conta/integracoes",
  noCache,
  companyAccess.requireNivelAdmin(),
  (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "views", "conta-integracoes.html"));
  },
);

router.get(
  "/conta/creditos",
  noCache,
  companyAccess.requireNivelAdmin(),
  (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "views", "conta-creditos.html"));
  },
);

router.get("/conta/regularizar", noCache, (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "conta-regularizar.html"));
});

router.get(
  "/conta/automacoes",
  noCache,
  companyAccess.requireNivelAdmin(),
  (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "views", "conta-automacoes.html"));
  },
);

// Reputação (HTML)
router.get("/reputacao", noCache, (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "reputacao.html"));
});

router.get("/logistica", noCache, allowLegacyUntilConfigured("ml.pedidos.logistica"), (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "fiscal-vendas.html"));
});

router.get("/fiscal/vendas", noCache, (req, res) => {
  res.redirect(`${req.baseUrl || ""}/logistica`);
});

// ===========================
// ✅ Painel Admin (HTML)
// (as APIs ficam em /api/admin/*; aqui são só as telas)
// ===========================
router.get(
  "/admin/dashboard",
  noCache,
  ensurePermission.requireMaster(),
  (_req, res) => res.sendFile(path.join(__dirname, "..", "views", "admin-dashboard.html"))
);

router.get(
  "/admin/usuarios",
  noCache,
  ensurePermission.requireMaster(),
  (_req, res) => res.sendFile(path.join(__dirname, "..", "views", "admin-usuarios.html"))
);

router.get(
  "/admin/empresas",
  noCache,
  ensurePermission.requireMaster(),
  (_req, res) => res.sendFile(path.join(__dirname, "..", "views", "admin-empresas.html"))
);

router.get(
  "/admin/vinculos",
  noCache,
  ensurePermission.requireMaster(),
  (_req, res) => res.sendFile(path.join(__dirname, "..", "views", "admin-vinculos.html"))
);

// Aliases “contas-ml / tokens-ml” (pra compat com seus links)
router.get(
  "/admin/contas-ml",
  noCache,
  ensurePermission.requireMaster(),
  (_req, res) => res.sendFile(path.join(__dirname, "..", "views", "admin-meli-contas.html"))
);

router.get(
  "/admin/tokens-ml",
  noCache,
  ensurePermission.requireMaster(),
  (_req, res) => res.sendFile(path.join(__dirname, "..", "views", "admin-meli-tokens.html"))
);

// (Opcional) aliases mais “técnicos”
router.get(
  "/admin/meli-contas",
  noCache,
  ensurePermission.requireMaster(),
  (_req, res) => res.sendFile(path.join(__dirname, "..", "views", "admin-meli-contas.html"))
);

router.get(
  "/admin/meli-tokens",
  noCache,
  ensurePermission.requireMaster(),
  (_req, res) => res.sendFile(path.join(__dirname, "..", "views", "admin-meli-tokens.html"))
);

router.get(
  "/admin/oauth-states",
  noCache,
  ensurePermission.requireMaster(),
  (_req, res) => res.sendFile(path.join(__dirname, "..", "views", "admin-oauth-states.html"))
);

router.get(
  "/admin/migracoes",
  noCache,
  ensurePermission.requireMaster(),
  (_req, res) => res.sendFile(path.join(__dirname, "..", "views", "admin-migracoes.html"))
);

router.get(
  "/admin/auditoria",
  noCache,
  ensurePermission.requireMaster(),
  (_req, res) => res.sendFile(path.join(__dirname, "..", "views", "admin-auditoria.html"))
);

router.get(
  "/admin/backup",
  noCache,
  ensurePermission.requireMaster(),
  (_req, res) => res.sendFile(path.join(__dirname, "..", "views", "admin-backup.html"))
);

router.get(
  "/admin/patch-notes",
  noCache,
  ensurePermission.requireMaster(),
  (_req, res) => res.sendFile(path.join(__dirname, "..", "views", "admin-patch-notes.html"))
);

router.get(
  "/admin/jobs",
  noCache,
  ensurePermission.requireMaster(),
  (_req, res) => res.sendFile(path.join(__dirname, "..", "views", "admin-jobs.html"))
);

module.exports = router;

