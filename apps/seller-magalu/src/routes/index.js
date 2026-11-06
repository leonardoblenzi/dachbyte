"use strict";

const express = require("express");
const path = require("node:path");
const apiRoutes = require("./api.routes");
const masterRoutes = require("./master.routes");
const oauthController = require("../controllers/oauthController");
const masterController = require("../controllers/masterController");
const accountRepository = require("../repositories/accountRepository");
const { requireMagaluMaster } = require("../middlewares/masterAuth");
const { resolveEntryRedirect } = require("../services/entryGate");
const userAccess = require("../services/userAccessService");

const router = express.Router();
const appView = path.resolve(__dirname, "../../views/app.html");

router.get("/auth/start", userAccess.requireAccountLinker, oauthController.start);
router.get("/auth/accounts/:accountId/reconnect", userAccess.requireAccountLinker, oauthController.reconnectStart);

// Painel Master independente da operação normal. Toda a árvore é Hub-first e
// exige platform_admin ou module_master explícito do módulo Magalu.
router.get("/master", requireMagaluMaster, masterController.page);
router.use("/api/master", requireMagaluMaster, masterRoutes);

router.use("/api", apiRoutes);

async function renderAppEntry(req, res, next, returnPath) {
  try {
    const accounts = await accountRepository.listAccountsForTenant(req.magaluIdentity.dachTenantId);
    const redirect = resolveEntryRedirect({
      accounts,
      returnPath,
      oauth: { status: req.query?.oauth, reason: req.query?.reason },
    });
    if (redirect) return res.redirect(302, redirect);
    return res.sendFile(appView);
  } catch (error) {
    return next(error);
  }
}

const accountPagesWithoutProvider = new Set(["/contas", "/usuarios", "/plano", "/ajuda"]);
router.get("/catalogo", (_req, res) => res.redirect(302, "/magalu/gestao-skus"));
router.get("/custos", (_req, res) => res.redirect(302, "/magalu/margem?aba=costs"));
router.get("/promocoes-em-massa", (_req, res) => res.redirect(302, "/magalu/promocoes?aba=precificacao"));
router.get("/precificacao-promocional", (_req, res) => res.redirect(302, "/magalu/promocoes?aba=precificacao"));
for (const route of ["/", "/pedidos", "/gestao-skus", "/estoque", "/precos", "/promocoes", "/margem", "/calculadora", "/integracoes", "/contas", "/usuarios", "/plano", "/ajuda", "/ranking"]) {
  const returnPath = route === "/" ? "/magalu/" : `/magalu${route}`;
  router.get(route, async (req, res, next) => {
    try {
      // Mesma regra das APIs: Conta so para admin; operacao pela caixa Acessar.
      if (route !== "/" && !(await userAccess.canOpenPage(req, route))) {
        return res.redirect(302, "/magalu/?acesso=negado");
      }
    } catch (error) {
      return next(error);
    }
    if (accountPagesWithoutProvider.has(route)) return res.sendFile(appView);
    return renderAppEntry(req, res, next, returnPath);
  });
}
router.get("/sincronizacao", (_req, res) => res.redirect(302, "/magalu/integracoes"));

module.exports = router;
