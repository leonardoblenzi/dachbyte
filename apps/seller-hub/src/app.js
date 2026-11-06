// @ts-check
"use strict";

const express = require("express");
const path = require("node:path");
const { loadConfig } = require("./platform/config");
const { createDb } = require("./platform/db");
const { createAuthMiddleware, requireAdmin } = require("./platform/auth");
const { createCatalogRepository } = require("./modules/catalog/repository");
const { createCatalogService } = require("./modules/catalog/service");
const { CHANNELS } = require("./connectors/contract");
const { PAGES, renderPage } = require("./web/pages");

const CHANNEL_LABELS = { mercadolivre: "Mercado Livre", magalu: "Magalu", shopee: "Shopee" };

/** @param {any} req */
function identity(req) { return req.hubIdentity; }

/** @param {unknown} value @param {number} fallback */
function int(value, fallback) { const n = Number.parseInt(String(value ?? ""), 10); return Number.isFinite(n) ? n : fallback; }

/**
 * Cria o app do DACH Hub (montado em /hub pelo startExpressApp).
 * Dependências injetáveis para testes.
 * @param {{ config?: ReturnType<typeof loadConfig>, db?: ReturnType<typeof createDb>, catalog?: ReturnType<typeof createCatalogService> }} [deps]
 */
async function createApp(deps = {}) {
  const config = deps.config || loadConfig();
  const db = deps.db || createDb(config);
  const catalog = deps.catalog || createCatalogService({ repository: createCatalogRepository(db) });

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
    // Conexão por OAuth chega quando os apps de cada marketplace estiverem criados.
    res.json({ ok: true, channels: CHANNELS.map((id) => ({ id, label: CHANNEL_LABELS[/** @type {keyof typeof CHANNEL_LABELS} */ (id)], available: false })) });
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
