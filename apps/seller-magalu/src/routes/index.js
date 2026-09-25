"use strict";

const express = require("express");
const path = require("node:path");
const apiRoutes = require("./api.routes");
const oauthController = require("../controllers/oauthController");
const accountRepository = require("../repositories/accountRepository");
const { resolveEntryRedirect } = require("../services/entryGate");

const router = express.Router();
const appView = path.resolve(__dirname, "../../views/app.html");

router.get("/auth/start", oauthController.start);
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
for (const route of ["/", "/catalogo", "/estoque", "/precos", "/integracoes", "/contas", "/usuarios", "/plano", "/ajuda"]) {
  const returnPath = route === "/" ? "/magalu/" : `/magalu${route}`;
  router.get(route, (req, res, next) => {
    if (accountPagesWithoutProvider.has(route)) return res.sendFile(appView);
    return renderAppEntry(req, res, next, returnPath);
  });
}
router.get("/sincronizacao", (_req, res) => res.redirect(302, "/magalu/integracoes"));

module.exports = router;
