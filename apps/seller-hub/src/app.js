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
  const { config, catalog, connectors, accounts, imports, stock, orders, sync, syncQueues } = createContainer(deps);

  const app = express();
  app.set("trust proxy", 1);
  app.set("etag", false);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Dachbyte-Product", "seller-hub");
    res.setHeader("Cache-Control", /^\/(assets|ui)\//.test(req.path) ? "public, max-age=3600" : "no-store");
    next();
  });
  // Notificações dos canais: públicas (sem login), com corpo bruto para conferir a assinatura.
  // Responde rápido; o processamento vai para a fila. Erro nosso devolve 5xx para o canal reenviar.
  app.post("/webhooks/:channel", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    const channel = String(req.params.channel);
    try {
      if (!connectors.has(channel)) return res.status(404).json({ ok: false, error: "unknown_channel" });
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
      const { received, ids } = await orders.receiveWebhook({ channel, headers: req.headers, rawBody, url: `${config.publicBaseUrl}/webhooks/${channel}` });
      for (const id of ids) await syncQueues.enqueueWebhook(id);
      res.status(200).json({ ok: true, received });
    } catch (error) {
      const status = Number(/** @type {any} */ (error)?.status) || 500;
      if (status >= 500) console.error("[seller-hub] webhook", channel, /** @type {any} */ (error)?.message);
      res.status(status === 401 ? 401 : status >= 500 ? 503 : status).json({ ok: false, error: /** @type {any} */ (error)?.code || "webhook_error" });
    }
  });

  // Planilha de estoque vem em base64 no corpo: limite maior só nessas rotas.
  const smallJson = express.json({ limit: "1mb" });
  const sheetJson = express.json({ limit: "15mb" });
  app.use((req, res, next) => (req.path.startsWith("/api/stock/spreadsheet/") ? sheetJson : smallJson)(req, res, next));
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
      const tenantId = identity(req).tenantId;
      const link = await catalog.linkListing(tenantId, listingId, itemId);
      // Vendas que esperavam este vínculo baixam agora; contas ativas recalculam o envio do produto.
      const pending = await orders.applyPendingForListing(tenantId, listingId);
      await sync.onItemsChanged(tenantId, [itemId], "anúncio vinculado");
      res.json({ ok: true, link, pendingSales: pending });
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
  // Estoque mestre (E2): calcula e mostra; nada é escrito nos canais.
  const who = (/** @type {any} */ req) => ({ tenantId: identity(req).tenantId, userId: identity(req).userId });
  /** @param {(req: any) => Promise<any>} work */
  const handle = (work) => async (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
    try { res.json({ ok: true, ...(await work(req)) }); } catch (error) { next(error); }
  };
  api.get("/stock", handle(async (req) => stock.listStock(identity(req).tenantId, {
    q: String(req.query.q || ""), filter: String(req.query.filter || "all"), limit: int(req.query.limit, 50), offset: int(req.query.offset, 0),
  })));
  api.get("/stock/export.csv", async (req, res, next) => {
    try {
      const csv = await stock.exportCsv(identity(req).tenantId);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="estoque-dach-hub-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } catch (error) { next(error); }
  });
  api.get("/stock/movements", handle(async (req) => ({ movements: await stock.listMovements(identity(req).tenantId, {
    itemId: req.query.itemId ? int(req.query.itemId, 0) : null, limit: int(req.query.limit, 50), offset: int(req.query.offset, 0),
  }) })));
  api.get("/stock/plan", handle(async (req) => stock.plan(identity(req).tenantId, {
    accountId: req.query.accountId ? int(req.query.accountId, 0) : null, onlyChanges: req.query.onlyChanges === "1",
    q: String(req.query.q || ""), limit: int(req.query.limit, 100), offset: int(req.query.offset, 0),
  })));
  api.get("/stock/rules", handle(async (req) => ({ accounts: await stock.listAccountRules(identity(req).tenantId) })));
  api.get("/stock/items/:itemId", handle(async (req) => ({ item: await stock.getItem(identity(req).tenantId, int(req.params.itemId, 0)) })));
  api.post("/stock/items/:itemId/adjust", requireAdmin, handle(async (req) => stock.adjust({
    identity: who(req), itemId: int(req.params.itemId, 0), op: req.body?.op, quantity: Number(req.body?.quantity), note: String(req.body?.note || ""),
  })));
  api.put("/stock/items/:itemId/kit", requireAdmin, handle(async (req) => ({ item: await stock.setKit({
    identity: who(req), itemId: int(req.params.itemId, 0), components: req.body?.components || [],
  }) })));
  api.post("/stock/spreadsheet/preview", requireAdmin, handle(async (req) => stock.previewSpreadsheet({
    identity: who(req), mode: req.body?.mode, file: { fileName: String(req.body?.fileName || ""), contentBase64: String(req.body?.contentBase64 || "") },
  })));
  api.post("/stock/spreadsheet/apply", requireAdmin, handle(async (req) => stock.applySpreadsheet({
    identity: who(req), mode: req.body?.mode, file: { fileName: String(req.body?.fileName || ""), contentBase64: String(req.body?.contentBase64 || "") },
  })));
  api.post("/stock/initial", requireAdmin, handle(async (req) => stock.initialFromChannels({
    identity: who(req), source: req.body?.source, accountId: req.body?.accountId ? Number(req.body.accountId) : null,
    onlyMissing: req.body?.onlyMissing !== false, apply: req.body?.apply === true,
  })));
  api.put("/stock/accounts/:accountId/mode", requireAdmin, handle(async (req) => {
    const accountId = int(req.params.accountId, 0), mode = String(req.body?.mode || "");
    // Ativo = escrever nos canais (exige confirmação). Desligado/Observação cancelam envios pendentes.
    if (mode === "active") return sync.activateAccount({ identity: who(req), accountId, confirm: req.body?.confirm === true });
    const account = await stock.setAccountMode({ identity: who(req), accountId, mode });
    const skipped = await sync.skipPending(accountId, "conta saiu do modo ativo");
    return { account, skipped };
  }));
  // Pausa geral e fila de envios.
  api.get("/stock/settings", handle(async (req) => ({ settings: await sync.getSettings(identity(req).tenantId) })));
  api.put("/stock/settings", requireAdmin, handle(async (req) => ({ settings: await sync.setPaused({ identity: who(req), paused: req.body?.paused === true }) })));
  api.get("/stock/pushes", handle(async (req) => sync.listPushes(identity(req).tenantId, {
    state: String(req.query.state || ""), accountId: req.query.accountId ? int(req.query.accountId, 0) : null, limit: int(req.query.limit, 50), offset: int(req.query.offset, 0),
  })));
  api.post("/stock/pushes/:pushId/retry", requireAdmin, handle(async (req) => ({ push: await sync.retryPush({ identity: who(req), pushId: int(req.params.pushId, 0) }) })));
  api.get("/orders", handle(async (req) => ({ orders: await orders.listOrders(identity(req).tenantId, {
    pendingOnly: req.query.pending === "1", limit: int(req.query.limit, 50), offset: int(req.query.offset, 0),
  }) })));
  api.put("/stock/accounts/:accountId/rule", requireAdmin, handle(async (req) => stock.saveRule({
    identity: who(req), scope: "account", targetId: int(req.params.accountId, 0), rule: req.body?.rule ?? null,
  })));
  api.put("/stock/listings/:listingId/rule", requireAdmin, handle(async (req) => stock.saveRule({
    identity: who(req), scope: "listing", targetId: int(req.params.listingId, 0), rule: req.body?.rule ?? null,
  })));
  api.put("/stock/listings/:listingId/sync", requireAdmin, handle(async (req) => ({ listing: await stock.setListingSync({
    identity: who(req), listingId: int(req.params.listingId, 0), enabled: req.body?.enabled === true,
  }) })));
  app.use("/api", api);

  app.use((req, res) => {
    if (String(req.headers.accept || "").includes("text/html")) return res.redirect(302, "/hub/");
    return res.status(404).json({ ok: false, error: "not_found" });
  });
  /** @type {import("express").ErrorRequestHandler} */
  const onError = (error, _req, res, _next) => {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[seller-hub]", error);
    if (status >= 500) return res.status(status).json({ ok: false, error: "internal_error", message: "Não foi possível concluir agora." });
    if (error?.type === "entity.too.large") return res.status(413).json({ ok: false, error: "too_large", message: "Arquivo grande demais (máx. 10 MB)." });
    res.status(status).json({ ok: false, error: error.code || "request_error", message: error.message, ...(error.details ? { details: error.details } : {}) });
  };
  app.use(onError);
  return app;
}

module.exports = { createApp };
