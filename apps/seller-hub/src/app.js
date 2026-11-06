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
  const { config, catalog, connectors, accounts, imports, stock, orders, sync, syncQueues, reconcile, billing, automations, expedition, labels } = createContainer(deps);

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
  // Planilha e foto do pacote vêm em base64: limite maior só nessas rotas.
  app.use((req, res, next) => ((req.path.startsWith("/api/stock/spreadsheet/") || /^\/api\/expedition\/orders\/\d+\/pack$/.test(req.path)) ? sheetJson : smallJson)(req, res, next));
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
    accountId: req.query.accountId ? int(req.query.accountId, 0) : null, onlyChanges: req.query.onlyChanges === "1", zeroInChannel: req.query.zeroInChannel === "1",
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
  // Só mexe no que veio no corpo: pausa geral e/ou limite de estoque baixo.
  api.put("/stock/settings", requireAdmin, handle(async (req) => {
    let settings = null;
    if (req.body && "paused" in req.body) settings = await sync.setPaused({ identity: who(req), paused: req.body.paused === true });
    if (req.body && "lowStockThreshold" in req.body) settings = await sync.setLowStockThreshold({ identity: who(req), threshold: Number(req.body.lowStockThreshold) });
    return { settings: settings || await sync.getSettings(identity(req).tenantId) };
  }));
  api.get("/overview/attention", handle(async (req) => {
    const [attention, notificationsUnread] = await Promise.all([stock.attention(identity(req).tenantId), automations.unreadCount(identity(req).tenantId)]);
    return { attention: { ...attention, notificationsUnread } };
  }));
  api.get("/stock/pushes", handle(async (req) => sync.listPushes(identity(req).tenantId, {
    state: String(req.query.state || ""), accountId: req.query.accountId ? int(req.query.accountId, 0) : null, limit: int(req.query.limit, 50), offset: int(req.query.offset, 0),
  })));
  api.post("/stock/pushes/:pushId/retry", requireAdmin, handle(async (req) => ({ push: await sync.retryPush({ identity: who(req), pushId: int(req.params.pushId, 0) }) })));
  // Reconciliação e saúde (E4).
  api.get("/health/accounts", handle(async (req) => {
    const tenantId = identity(req).tenantId;
    const [accountsHealth, settings, attention, notificationsUnread] = await Promise.all([
      reconcile.health(tenantId), sync.getSettings(tenantId), stock.attention(tenantId), automations.unreadCount(tenantId)]);
    return { accounts: accountsHealth, settings, attention: { ...attention, notificationsUnread } };
  }));
  api.post("/accounts/:accountId/reconcile", requireAdmin, async (req, res, next) => {
    try {
      const { run, created } = await reconcile.requestReconcile({ identity: who(req), accountId: int(req.params.accountId, 0) });
      res.status(created ? 202 : 200).json({ ok: true, run, alreadyRunning: !created });
    } catch (error) { next(error); }
  });
  api.put("/accounts/:accountId/divergence-policy", requireAdmin, handle(async (req) => ({ account: await reconcile.setPolicy({
    identity: who(req), accountId: int(req.params.accountId, 0), policy: String(req.body?.policy || ""),
  }) })));
  api.get("/divergences", handle(async (req) => ({ divergences: await reconcile.listDivergences(identity(req).tenantId, {
    status: req.query.status == null ? "open" : String(req.query.status), accountId: req.query.accountId ? int(req.query.accountId, 0) : null,
    limit: int(req.query.limit, 50), offset: int(req.query.offset, 0),
  }) })));
  api.post("/divergences/:id/resolve", requireAdmin, handle(async (req) => ({ divergence: await reconcile.resolve({
    identity: who(req), id: int(req.params.id, 0), action: /** @type {any} */ (String(req.body?.action || "")),
  }) })));
  api.post("/accounts/:accountId/divergences/ignore-all", requireAdmin, handle(async (req) => reconcile.ignoreAll({ identity: who(req), accountId: int(req.params.accountId, 0) })));
  // Central de pedidos (Fase 3): lista com filtros, detalhe, exportação.
  /** @param {any} query */
  const orderFilters = (query) => ({
    stage: String(query.stage || ""), accountId: query.accountId ? int(query.accountId, 0) : null,
    from: query.from ? String(query.from) : null, to: query.to ? String(query.to) : null, q: String(query.q || ""),
    due: /** @type {any} */ (["late", "today"].includes(String(query.due)) ? String(query.due) : ""), pendingOnly: query.pending === "1",
    customStatus: String(query.customStatus || ""), tag: String(query.tag || ""),
    limit: int(query.limit, 50), offset: int(query.offset, 0),
  });
  api.get("/orders", handle(async (req) => orders.search(identity(req).tenantId, orderFilters(req.query))));
  api.get("/orders/export.csv", async (req, res, next) => {
    try {
      const csv = await orders.exportCsv(identity(req).tenantId, orderFilters(req.query));
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="pedidos-dach-hub-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } catch (error) { next(error); }
  });
  api.get("/orders/:orderId", handle(async (req) => ({ order: await orders.detail(identity(req).tenantId, int(req.params.orderId, 0)) })));
  // Status internos, etiquetas e automações (Fase 3 / P2).
  /** @param {any} body */
  const idList = (body) => (Array.isArray(body?.orderIds) ? body.orderIds.map(Number).filter(Boolean) : []);
  api.post("/orders/status", requireAdmin, handle(async (req) => automations.setStatus({
    identity: who(req), orderIds: idList(req.body), statusId: req.body?.statusId ? Number(req.body.statusId) : null,
  })));
  api.post("/orders/tags", requireAdmin, handle(async (req) => automations.changeTags({
    identity: who(req), orderIds: idList(req.body), add: Array.isArray(req.body?.add) ? req.body.add : [], remove: Array.isArray(req.body?.remove) ? req.body.remove : [],
  })));
  api.get("/automations/statuses", handle(async (req) => ({ statuses: await automations.listStatuses(identity(req).tenantId) })));
  api.post("/automations/statuses", requireAdmin, handle(async (req) => ({ status: await automations.saveStatus({ identity: who(req), name: req.body?.name, color: req.body?.color }) })));
  api.put("/automations/statuses/:id", requireAdmin, handle(async (req) => ({ status: await automations.saveStatus({ identity: who(req), id: int(req.params.id, 0), name: req.body?.name, color: req.body?.color }) })));
  api.delete("/automations/statuses/:id", requireAdmin, handle(async (req) => ({ status: await automations.deleteStatus({ identity: who(req), id: int(req.params.id, 0) }) })));
  api.get("/automations/rules", handle(async (req) => ({ rules: await automations.listRules(identity(req).tenantId) })));
  api.post("/automations/rules", requireAdmin, handle(async (req) => ({ rule: await automations.saveRule({ identity: who(req), input: req.body || {} }) })));
  api.put("/automations/rules/:id", requireAdmin, handle(async (req) => ({ rule: await automations.saveRule({ identity: who(req), id: int(req.params.id, 0), input: req.body || {} }) })));
  api.put("/automations/rules/:id/active", requireAdmin, handle(async (req) => ({ rule: await automations.setActive({ identity: who(req), id: int(req.params.id, 0), active: req.body?.active === true }) })));
  api.delete("/automations/rules/:id", requireAdmin, handle(async (req) => ({ rule: await automations.deleteRule({ identity: who(req), id: int(req.params.id, 0) }) })));
  api.get("/automations/rules/:id/runs", handle(async (req) => ({ runs: await automations.listRuns(identity(req).tenantId, int(req.params.id, 0)) })));
  api.post("/automations/rules/:id/run", requireAdmin, handle(async (req) => automations.runNow({ identity: who(req), ruleId: int(req.params.id, 0), orderIds: idList(req.body) })));
  api.get("/automations/webhook-secret", requireAdmin, handle(async (req) => ({ secret: await automations.webhookSecret(identity(req).tenantId) })));
  api.post("/automations/webhook-secret/rotate", requireAdmin, handle(async (req) => ({ secret: await automations.rotateWebhookSecret(who(req)) })));
  api.get("/notifications", handle(async (req) => ({
    notifications: await automations.listNotifications(identity(req).tenantId, { unreadOnly: req.query.unread === "1", limit: int(req.query.limit, 50), offset: int(req.query.offset, 0) }),
    unread: await automations.unreadCount(identity(req).tenantId),
  })));
  api.post("/notifications/read", handle(async (req) => ({ marked: await automations.markRead(identity(req).tenantId, req.body?.id ? Number(req.body.id) : null) })));
  // Expedição (Fase 3 / P3): quem opera o depósito usa sem ser administrador; desfazer conferência exige administrador.
  api.get("/expedition/summary", handle(async (req) => ({ summary: await expedition.summary(identity(req).tenantId) })));
  api.get("/expedition/queue", handle(async (req) => ({ orders: await expedition.queue(identity(req).tenantId, {
    accountId: req.query.accountId ? int(req.query.accountId, 0) : null, due: ["late", "today"].includes(String(req.query.due)) ? String(req.query.due) : "",
  }) })));
  api.get("/expedition/batches", handle(async (req) => ({ batches: await expedition.listBatches(identity(req).tenantId) })));
  api.post("/expedition/batches", handle(async (req) => ({ batch: await expedition.createBatch({ identity: who(req), orderIds: idList(req.body) }) })));
  api.get("/expedition/batches/:id", handle(async (req) => ({ batch: await expedition.getBatch(identity(req).tenantId, int(req.params.id, 0)) })));
  api.post("/expedition/batches/:id/close", handle(async (req) => ({ batch: await expedition.closeBatch(identity(req).tenantId, int(req.params.id, 0)) })));
  api.get("/expedition/lookup", handle(async (req) => expedition.lookup(identity(req).tenantId, String(req.query.code || ""))));
  api.get("/expedition/product", handle(async (req) => expedition.nextForProduct(identity(req).tenantId, String(req.query.code || ""), req.query.batchId ? int(req.query.batchId, 0) : null)));
  api.get("/expedition/orders/:id", handle(async (req) => expedition.checkout(identity(req).tenantId, int(req.params.id, 0))));
  api.post("/expedition/orders/:id/match", handle(async (req) => ({ unit: await expedition.matchUnit(identity(req).tenantId, int(req.params.id, 0), String(req.body?.code || "")) })));
  api.post("/expedition/orders/:id/pack", handle(async (req) => ({ packed: await expedition.pack({
    identity: who(req), orderId: int(req.params.id, 0), checks: Array.isArray(req.body?.checks) ? req.body.checks : [], photoBase64: req.body?.photoBase64 || null,
  }) })));
  api.post("/expedition/orders/:id/issue", handle(async (req) => ({ order: await expedition.reportIssue({ identity: who(req), orderId: int(req.params.id, 0), note: String(req.body?.note || "") }) })));
  api.post("/expedition/orders/:id/unpack", requireAdmin, handle(async (req) => ({ order: await expedition.unpack({ identity: who(req), orderId: int(req.params.id, 0) }) })));
  api.get("/expedition/photos/:photoId", async (req, res, next) => {
    try {
      const photo = await expedition.photo(identity(req).tenantId, int(req.params.photoId, 0));
      res.setHeader("Content-Type", photo.mime);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.send(photo.content);
    } catch (error) { next(error); }
  });
  api.get("/expedition/pickups", handle(async (req) => ({ pickups: await expedition.listPickups(identity(req).tenantId) })));
  api.post("/expedition/pickups", handle(async (req) => ({ pickup: await expedition.createPickup({ identity: who(req), carrier: req.body?.carrier, scheduledFor: req.body?.scheduledFor }) })));
  api.get("/expedition/pickups/:id", handle(async (req) => ({ pickup: await expedition.getPickup(identity(req).tenantId, int(req.params.id, 0)) })));
  api.post("/expedition/pickups/:id/scan", handle(async (req) => expedition.scanToPickup({ identity: who(req), pickupId: int(req.params.id, 0), code: String(req.body?.code || "") })));
  api.delete("/expedition/pickups/:id/orders/:orderId", handle(async (req) => ({ order: await expedition.removeFromPickup({ identity: who(req), pickupId: int(req.params.id, 0), orderId: int(req.params.orderId, 0) }) })));
  api.post("/expedition/pickups/:id/close", handle(async (req) => ({ pickup: await expedition.closePickup({ identity: who(req), pickupId: int(req.params.id, 0) }) })));
  // Etiquetas de envio (Fase 3 / P4): um arquivo por conta; PDF abre no navegador para imprimir.
  api.get("/expedition/labels", handle(async (req) => ({ batches: await labels.listBatches(identity(req).tenantId) })));
  api.post("/expedition/labels", handle(async (req) => ({ batch: await labels.print({ identity: who(req), orderIds: idList(req.body), format: String(req.body?.format || "pdf") }) })));
  api.get("/expedition/label-files/:id", async (req, res, next) => {
    try {
      const f = await labels.file(identity(req).tenantId, int(req.params.id, 0));
      const inline = /pdf/i.test(f.contentType);
      res.setHeader("Content-Type", f.contentType);
      res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${String(f.filename).replace(/[^A-Za-z0-9._-]/g, "_")}"`);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.send(f.content);
    } catch (error) { next(error); }
  });
  // Vendas medidas para a cobrança (% sobre vendas) e extrato pedido a pedido.
  api.get("/billing/month", handle(async (req) => ({ month: await billing.month(identity(req).tenantId, req.query.month ? String(req.query.month) : undefined) })));
  api.get("/billing/statement", handle(async (req) => ({ statement: await billing.statement(identity(req).tenantId, String(req.query.month || billing.currentMonth()), {
    limit: int(req.query.limit, 100), offset: int(req.query.offset, 0),
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
