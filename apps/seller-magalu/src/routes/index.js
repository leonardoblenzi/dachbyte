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

const router = express.Router();
const appView = path.resolve(__dirname, "../../views/app.html");
const skuManagementView = path.resolve(__dirname, "../../views/gestao-skus.html");

router.get("/auth/start", oauthController.start);

// Painel Master independente da operação normal. Toda a árvore é Hub-first e
// exige platform_admin ou module_master explícito do módulo Magalu.
router.get("/master", requireMagaluMaster, masterController.page);
router.use("/api/master", requireMagaluMaster, masterRoutes);

router.use("/api", apiRoutes);

router.get("/gestao-skus", async (req, res, next) => {
  try {
    const accounts = await accountRepository.listAccountsForTenant(req.magaluIdentity.dachTenantId);
    const redirect = resolveEntryRedirect({ accounts, returnPath: "/magalu/gestao-skus", oauth: { status:req.query?.oauth, reason:req.query?.reason } });
    if (redirect) return res.redirect(302, redirect);
    return res.sendFile(skuManagementView);
  } catch (error) { return next(error); }
});

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
for (const route of ["/", "/catalogo", "/estoque", "/precos", "/integracoes", "/contas", "/usuarios", "/plano", "/ajuda"]) {
  const returnPath = route === "/" ? "/magalu/" : `/magalu${route}`;
  router.get(route, (req, res, next) => {
    if (accountPagesWithoutProvider.has(route)) return res.sendFile(appView);
    return renderAppEntry(req, res, next, returnPath);
  });
}
router.get("/sincronizacao", (_req, res) => res.redirect(302, "/magalu/integracoes"));

module.exports = router;
