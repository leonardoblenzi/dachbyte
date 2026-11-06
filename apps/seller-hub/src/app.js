// @ts-check
"use strict";

const express = require("express");
const path = require("node:path");
const { createAuthMiddleware, requireAdmin } = require("./platform/auth");
const { createContainer } = require("./container");
const { PAGES, renderPage } = require("./web/pages");

/** @param {any} req */
function identity(req) { return req.hubIdentity; }

/** @param {unknown} value @param {number} fallback */
function int(value, fallback) { const n = Number.parseInt(String(value ?? ""), 10); return Number.isFinite(n) ? n : fallback; }

/**
 * Cria o app do DACH Hub (montado em /hub pelo startExpressApp).
 * Dependências injetáveis para testes.
 * @param {Parameters<typeof createContainer>[0]} [deps]
 */
async function createApp(deps = {}) {
  const { config, catalog, connectors, accounts, imports } = createContainer(deps);

  const app = express();
  app.set("trust proxy", 1);
  app.set("etag", false);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Dachbyte-Product", "seller-hub");
    res.setHeader("Cache-Control", /^\/(assets|ui)\//.test(req.path) ? "public, max-age=3600" : "no-store");
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use("/assets", express.static(path.resolve(__dirname, "../public"), { maxAge: "1h" }));
  app.use("/ui", express.static(path.resolve(__dirname, "../../shared/seller-ui"), { maxAge: "1h" }));

  app.use(createAuthMiddleware(config));

  // Páginas (o shell monta o menu e a barra superior no navegador).
  for (const pagePath of /** @type {(keyof typeof PAGES)[]} */ (Object.keys(PAGES))) {
    app.get(pagePath, (req, res) => {
      res.type("html").send(renderPage(pagePath, identity(req)));
    });
  }

  // Conectar conta: só o administrador da empresa inicia; o retorno volta para Contas conectadas.
  app.get("/auth/:channel/start", async (req, res) => {
    if (!identity(req).isAdmin) return res.redirect(302, "/hub/contas?erro=admin_required");
    try {
      res.redirect(302, await accounts.startConnect({ identity: identity(req), channel: req.params.channel }));
    } catch (error) {
      res.redirect(302, `/hub/contas?erro=${encodeURIComponent(/** @type {any} */ (error).code || "connect_failed")}`);
    }
  });
  app.get("/auth/:channel/callback", async (req, res) => {
    try {
      const account = await accounts.finishConnect({ identity: identity(req), channel: req.params.channel, query: req.query });
      await startFirstImport(identity(req), account);
      res.redirect(302, `/hub/contas?conectado=${encodeURIComponent(req.params.channel)}`);
    } catch (error) {
      if (Number(/** @type {any} */ (error).status) >= 500) console.error("[seller-hub] callback", error);
      res.redirect(302, `/hub/contas?erro=${encodeURIComponent(/** @type {any} */ (error).code || "connect_failed")}`);
    }
  });

  /**
   * Primeira importação logo depois de conectar. Falha aqui não desfaz a conexão:
   * o seller pode importar depois pelo botão.
   * @param {any} who @param {any} account
   */
  async function startFirstImport(who, account) {
    try {
      await imports.requestImport({ identity: who, accountId: Number(account.id), trigger: "connect" });
    } catch (error) {
      console.error("[seller-hub] primeira importação não iniciada", account?.id, /** @type {any} */ (error)?.message);
    }
  }

  const api = express.Router();
  api.get("/session", (req, res) => {
    const who = identity(req);
    res.json({ ok: true, user: { name: who.name, email: who.email, isAdmin: who.isAdmin } });
  });
  api.get("/overview", async (req, res, next) => {
    try { res.json({ ok: true, overview: await catalog.overview(identity(req).tenantId) }); } catch (error) { next(error); }
  });
  api.get("/items", async (req, res, next) => {
    try {
      const items = await catalog.listItems(identity(req).tenantId, { q: String(req.query.q || ""), limit: int(req.query.limit, 50), offset: int(req.query.offset, 0) });
      res.json({ ok: true, items });
    } catch (error) { next(error); }
  });
  api.get("/pending", async (req, res, next) => {
    try {
      const listings = await catalog.listPending(identity(req).tenantId, { limit: int(req.query.limit, 50), offset: int(req.query.offset, 0) });
      res.json({ ok: true, listings });
    } catch (error) { next(error); }
  });
  api.post("/listings/:listingId/link", requireAdmin, async (req, res, next) => {
    try {
      const listingId = int(req.params.listingId, 0), itemId = int(req.body?.itemId, 0);
      if (!listingId || !itemId) return res.status(400).json({ ok: false, error: "invalid_input", message: "Informe o anúncio e o produto." });
      res.json({ ok: true, link: await catalog.linkListing(identity(req).tenantId, listingId, itemId) });
    } catch (error) { next(error); }
  });
  api.get("/channels", (_req, res) => {
    // "available" = app do DACH Hub configurado para aquele canal; "kind" separa marketplaces de lojas virtuais.
    res.json({ ok: true, channels: connectors.list() });
  });
  api.post("/channels/:channel/connect", requireAdmin, async (req, res, next) => {
    // Lojas virtuais que conectam por formulário (chave de API / URL da loja).
    try {
      const account = await accounts.connectWithCredentials({ identity: identity(req), channel: String(req.params.channel), fields: req.body || {} });
      await startFirstImport(identity(req), account);
      res.json({ ok: true, account });
    } catch (error) { next(error); }
  });
  api.get("/accounts", async (req, res, next) => {
    try { res.json({ ok: true, accounts: await accounts.listAccounts(identity(req).tenantId) }); } catch (error) { next(error); }
  });
  api.post("/accounts/:accountId/disconnect", requireAdmin, async (req, res, next) => {
    try { res.json({ ok: true, account: await accounts.disconnect({ identity: identity(req), accountId: int(req.params.accountId, 0) }) }); } catch (error) { next(error); }
  });
  // Importação de anúncios em segundo plano; a tela acompanha pelo status da execução.
  api.post("/accounts/:accountId/import", requireAdmin, async (req, res, next) => {
    try {
      const { run, created } = await imports.requestImport({ identity: identity(req), accountId: int(req.params.accountId, 0), trigger: "manual" });
      res.status(created ? 202 : 200).json({ ok: true, run, alreadyRunning: !created });
    } catch (error) { next(error); }
  });
  api.get("/imports/:runId", async (req, res, next) => {
    try { res.json({ ok: true, run: await imports.getRun(identity(req).tenantId, int(req.params.runId, 0)) }); } catch (error) { next(error); }
  });
  app.use("/api", api);

  app.use((req, res) => {
    if (String(req.headers.accept || "").includes("text/html")) return res.redirect(302, "/hub/");
    return res.status(404).json({ ok: false, error: "not_found" });
  });
  /** @type {import("express").ErrorRequestHandler} */
  const onError = (error, _req, res, _next) => {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[seller-hub]", error);
    res.status(status).json({ ok: false, error: status >= 500 ? "internal_error" : "request_error", message: status >= 500 ? "Não foi possível concluir agora." : error.message });
  };
  app.use(onError);
  return app;
}

module.exports = { createApp };
