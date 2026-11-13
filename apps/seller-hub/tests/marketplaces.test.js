"use strict";

// Painel por marketplace (fase 1): serviço com repositório em memória e as rotas do app.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createMarketplacesService } = require("../src/modules/marketplaces/service");
const { createApp } = require("../src/app");
const { loadConfig } = require("../src/platform/config");

const CHANNELS = [
  { id: "mercadolivre", label: "Mercado Livre", kind: "marketplace", available: true },
  { id: "magalu", label: "Magalu", kind: "marketplace", available: false },
  { id: "loja", label: "Loja X", kind: "store", available: true },
];

/** Repositório em memória com o que o serviço usa. */
function fakeRepository() {
  const calls = [];
  return {
    calls,
    channelSummaries: async () => [{ channel: "mercadolivre", accounts: 2, reconnect: 1, listings: 40, unlinked: 3 }],
    listings: async (tenantId, filters) => {
      calls.push(["listings", tenantId, filters]);
      return [
        { id: 1, accountId: 7, accountLabel: "LOJA A", accountMode: "observe", listingId: "MLB1", variationId: "", channelSku: "SOFA", title: "Sofá",
          status: "active", statusGroup: "active", fulfillment: false, channelStock: 3, channelPrice: 199.9, syncEnabled: true,
          itemId: 10, sku: "SOFA", itemName: "Sofá", itemKind: "simple",
          accountStockRule: { mode: "percent", value: 50, cap: null, min_lock: 0, safety_reserve: 1 }, listingStockRule: null,
          accountPriceRule: { base: "sale", adjust: "pct", value: "12", rounding: "90", show_from: "sale", min_price: null }, listingPriceRule: null, totalCount: 2 },
        { id: 2, accountId: 7, accountLabel: "LOJA A", accountMode: "observe", listingId: "MLB2", variationId: "", channelSku: null, title: "Mesa",
          status: "paused", statusGroup: "paused", fulfillment: false, channelStock: 0, channelPrice: 99, syncEnabled: true,
          itemId: null, sku: null, itemName: null, itemKind: null, accountStockRule: null, listingStockRule: null,
          accountPriceRule: null, listingPriceRule: { base: "sale", adjust: "fixed", value: "89.9", rounding: "none", show_from: "none", min_price: null }, totalCount: 2 },
      ];
    },
    listingsSummary: async () => ({ total: 2, active: 1, paused: 1, other: 0, unlinked: 1, ownPriceRule: 1, fulfillment: 0 }),
    accountRules: async () => [{ id: 7, label: "LOJA A", status: "connected", mode: "observe", stockRule: null,
      priceRule: { base: "promo_or_sale", adjust: "amount", value: "4", rounding: "none", show_from: "sale", min_price: null }, listings: 2, linked: 1, listingPriceRules: 1, listingStockRules: 0 }],
    savePriceRule: async (tenantId, input) => {
      calls.push(["save", tenantId, input]);
      if (input.targetId === 404) return null;
      return { scope: input.scope, targetId: input.targetId, channel: "mercadolivre", rule: input.rule ? { ...input.rule, show_from: input.rule.showFrom, min_price: input.rule.minPrice } : null };
    },
    audit: async (event) => { calls.push(["audit", event.action, event.details]); },
  };
}

function service(repository = fakeRepository()) {
  const stockRepository = {
    availabilityInputs: async (_tenantId, itemIds) => ({ items: itemIds.map((id) => ({ id, kind: "simple" })), balances: [{ itemId: 10, onHand: 21, reserved: 0 }], components: [] }),
  };
  return { repository, marketplaces: createMarketplacesService({ repository, stockRepository, channels: () => CHANNELS }) };
}

test("visão geral: um cartão por marketplace (loja virtual fica de fora), com números da empresa", async () => {
  const { marketplaces } = service();
  const cards = await marketplaces.overview("t1");
  assert.deepEqual(cards.map((c) => c.id), ["mercadolivre", "magalu"]);
  assert.deepEqual(cards[0], { id: "mercadolivre", label: "Mercado Livre", available: true, accounts: 2, reconnect: 1, listings: 40, unlinked: 3 });
  assert.equal(cards[1].accounts, 0, "canal sem conta aparece zerado");
});

test("anúncios: estoque que o Hub enviaria pela regra da conta e regra de preço efetiva", async () => {
  const { marketplaces, repository } = service();
  const { rows, summary, total } = await marketplaces.listings("t1", "mercadolivre", { status: "ativo?", link: "unlinked", priceRule: "listing", q: "sofa" });
  assert.equal(total, 2);
  assert.equal(summary.unlinked, 1);
  const filters = repository.calls.find((c) => c[0] === "listings")[2];
  assert.deepEqual([filters.status, filters.link, filters.priceRule, filters.q], ["", "unlinked", "listing", "sofa"], "filtro inválido vira vazio");
  const [sofa, mesa] = rows;
  assert.deepEqual([sofa.stock.available, sofa.stock.desired, sofa.stock.state, sofa.stock.ruleSource], [21, 9, "increase", "account"], "50% de 21 = 10, menos 1 de reserva");
  assert.deepEqual([sofa.price.ruleSource, sofa.price.ruleText], ["account", "Preço de venda + 12% · final ,90"]);
  assert.equal(mesa.item, null);
  assert.equal(mesa.stock.state, "unlinked", "sem vínculo o Hub não calcula estoque");
  assert.deepEqual([mesa.price.ruleSource, mesa.price.ruleText], ["listing", "Preço fixo R$ 89,90"]);
});

test("canal que não é marketplace (ou não existe) responde 404", async () => {
  const { marketplaces } = service();
  await assert.rejects(marketplaces.listings("t1", "loja"), (e) => e.status === 404 && e.code === "unknown_marketplace");
  await assert.rejects(marketplaces.rules("t1", "amazon"), (e) => e.status === 404);
});

test("regras da conta: regra de preço com texto pronto", async () => {
  const { marketplaces } = service();
  const [account] = await marketplaces.rules("t1", "mercadolivre");
  assert.equal(account.priceRuleText, "Preço promocional (se houver) + R$ 4,00");
  assert.equal(account.stockRule, null);
});

test("salvar regra de preço: valida, grava, audita; null remove; alvo de outra empresa = 404", async () => {
  const { marketplaces, repository } = service();
  const identity = { tenantId: "t1", userId: "u1" };
  const saved = await marketplaces.savePriceRule({ identity, scope: "account", targetId: 7, rule: { base: "sale", adjust: "pct", value: "12,5", rounding: "99" } });
  assert.equal(saved.ruleText, "Preço de venda + 12,5% · final ,99");
  assert.deepEqual(repository.calls.find((c) => c[0] === "audit").slice(0, 2), ["audit", "price_rule_saved"]);
  await assert.rejects(marketplaces.savePriceRule({ identity, scope: "account", targetId: 7, rule: { adjust: "fixed", value: "0" } }), (e) => e.status === 400 && e.code === "invalid_price_rule");
  await assert.rejects(marketplaces.savePriceRule({ identity, scope: "item", targetId: 7, rule: null }), (e) => e.code === "invalid_scope");
  await assert.rejects(marketplaces.savePriceRule({ identity, scope: "listing", targetId: 404, rule: null }), (e) => e.status === 404);
  const removed = await marketplaces.savePriceRule({ identity, scope: "listing", targetId: 2, rule: null });
  assert.deepEqual([removed.rule, removed.ruleText], [null, null]);
});

test("simulação com preço de exemplo não grava nada", () => {
  const { marketplaces, repository } = service();
  const { result, ruleText } = marketplaces.previewPrice({ rule: { base: "promo_or_sale", adjust: "pct", value: "10" }, sample: { salePrice: "200,00", promoPrice: "150" } });
  assert.deepEqual([result.price, result.fromPrice], [165, 220]);
  assert.equal(ruleText, "Preço promocional (se houver) + 10%");
  assert.equal(repository.calls.length, 0);
  assert.throws(() => marketplaces.previewPrice({ rule: { adjust: "pct", value: "-200" }, sample: {} }), (e) => e.status === 400);
});

/* ───────────── Rotas ───────────── */

const SECRET = "segredo-de-teste";
const token = (payload = {}) => jwt.sign({ tenant_id: "t1", user_id: "u1", email: "ana@empresa.com", name: "Ana", ...payload }, SECRET);
const get = (url, cookie, accept = "application/json") => fetch(url, { headers: { accept, cookie: `suite_auth_token=${cookie}` }, redirect: "manual" });

async function withServer(run) {
  const config = loadConfig({ SUITE_JWT_SECRET: SECRET, HUB_ALLOWED_TENANTS: "t1" });
  const calls = [];
  const marketplaces = {
    overview: async (tenantId) => { calls.push(["overview", tenantId]); return []; },
    listings: async (tenantId, channel, filters) => { calls.push(["listings", tenantId, channel, filters]); return { summary: {}, total: 0, rows: [] }; },
    rules: async (tenantId, channel) => { calls.push(["rules", tenantId, channel]); return []; },
    savePriceRule: async (input) => { calls.push(["save", input.scope, input.targetId, input.rule, input.identity.tenantId]); return { rule: input.rule }; },
    previewPrice: ({ rule, sample }) => { calls.push(["preview", rule, sample]); return { result: { price: 1 } }; },
  };
  const app = await createApp({ config, db: {}, marketplaces, imports: { requestImport: async () => ({}) } });
  const server = app.listen(0);
  try { await run(`http://127.0.0.1:${server.address().port}`, calls); } finally { server.close(); }
}

test("páginas de cada marketplace: abas Anúncios, Contas e Regras; canal desconhecido volta ao painel", async () => {
  await withServer(async (base) => {
    const listings = await (await get(`${base}/marketplaces/mercado-livre`, token(), "text/html")).text();
    assert.match(listings, /data-view="mpListings"/);
    assert.match(listings, /data-channel="mercadolivre"/);
    assert.match(listings, /<h1>Mercado Livre<\/h1>/);
    assert.match(listings, /<a class="hub-tab" href="\/hub\/marketplaces\/mercado-livre" aria-current="page">Anúncios<\/a>/);
    assert.match(listings, /hub-marketplaces\.js/);
    assert.match(listings, /data-marketplaces="\[\{&quot;id&quot;:&quot;mercadolivre&quot;,&quot;label&quot;:&quot;Mercado Livre&quot;,&quot;slug&quot;:&quot;mercado-livre&quot;\}/);
    const accounts = await (await get(`${base}/marketplaces/shopee/configuracoes`, token(), "text/html")).text();
    assert.match(accounts, /data-view="accounts"/);
    assert.match(accounts, /Contas da Shopee conectadas/);
    assert.match(accounts, /<title>Shopee · Contas · DACH Hub<\/title>/);
    const rules = await (await get(`${base}/marketplaces/magalu/configuracoes/regras`, token(), "text/html")).text();
    assert.match(rules, /data-view="mpRules"/);
    assert.match(rules, /aria-current="page">Regras de preço e estoque/);
    const overview = await (await get(`${base}/marketplaces`, token(), "text/html")).text();
    assert.match(overview, /data-view="marketplaces"/);
    const unknown = await get(`${base}/marketplaces/amazon`, token(), "text/html");
    assert.equal(unknown.status, 302);
    assert.equal(unknown.headers.get("location"), "/hub/");
  });
});

test("Contas conectadas com retorno de marketplace segue para a aba Contas do canal", async () => {
  await withServer(async (base) => {
    const back = await get(`${base}/contas?conectado=shopee`, token(), "text/html");
    assert.equal(back.status, 302);
    assert.equal(back.headers.get("location"), "/hub/marketplaces/shopee/configuracoes?conectado=shopee");
    assert.equal((await get(`${base}/contas`, token(), "text/html")).status, 200, "sem retorno, a página continua");
  });
});

test("API: anúncios repassam os filtros; regra de preço exige administrador; simulação aberta a quem vê", async () => {
  await withServer(async (base, calls) => {
    await get(`${base}/api/marketplaces/mercadolivre/listings?accountId=7&q=sofa&status=paused&link=unlinked&priceRule=listing&offset=50`, token());
    assert.deepEqual(calls.at(-1), ["listings", "t1", "mercadolivre", { accountId: 7, q: "sofa", status: "paused", link: "unlinked", priceRule: "listing", limit: 50, offset: 50 }]);
    await get(`${base}/api/marketplaces/magalu/rules`, token());
    assert.deepEqual(calls.at(-1), ["rules", "t1", "magalu"]);
    const put = (path, cookie, body) => fetch(`${base}/api${path}`, { method: "PUT", headers: { "content-type": "application/json", cookie: `suite_auth_token=${cookie}` }, body: JSON.stringify(body) });
    assert.equal((await put("/marketplaces/accounts/7/price-rule", token({ company_role: "operator" }), { rule: { value: 1 } })).status, 403);
    assert.equal((await put("/marketplaces/accounts/7/price-rule", token({ company_role: "admin" }), { rule: { value: 1 } })).status, 200);
    assert.deepEqual(calls.at(-1), ["save", "account", 7, { value: 1 }, "t1"]);
    await put("/marketplaces/listings/9/price-rule", token({ company_role: "admin" }), {});
    assert.deepEqual(calls.at(-1), ["save", "listing", 9, null, "t1"], "sem regra no corpo = remover");
    const preview = await fetch(`${base}/api/marketplaces/price-preview`, { method: "POST", headers: { "content-type": "application/json", cookie: `suite_auth_token=${token({ company_role: "operator" })}` }, body: JSON.stringify({ rule: { value: 2 }, sample: { salePrice: "10" } }) });
    assert.equal(preview.status, 200);
    assert.deepEqual(calls.at(-1), ["preview", { value: 2 }, { salePrice: "10" }]);
  });
});
