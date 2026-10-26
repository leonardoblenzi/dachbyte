"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const portal = readFileSync(path.join(__dirname, "..", "views", "selecao-plataforma.html"), "utf8");
const { createSellerPortalService } = require("../../gateway/services/sellerPortalService");

test("ML and Shopee contracting has no editable plan, range or sales count", () => {
  assert.doesNotMatch(portal, /id="purchase-(?:plan|range|orders)"/);
  assert.match(portal, /Aguardando apuração/);
  assert.match(portal, /Pedidos apurados/);
  assert.match(portal, /Mais de 3\.000 pedidos/);
  assert.match(portal, /measurement_status/);
  assert.match(portal, /measured_period_start/);
});

test("browser checkout cannot declare ML or Shopee plan, range or orders", () => {
  const start = portal.indexOf("async function confirmPurchase()");
  const end = portal.indexOf("async function renew(", start);
  const checkout = portal.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(checkout, /\["ml","shopee"\]\.includes\(module\.slug\)\?\{\}:\{/);
  assert.doesNotMatch(checkout, /declared_orders:/);
});

test("gateway drops client pricing fields for ML while preserving other module checkout", async () => {
  const posted = [];
  const service = createSellerPortalService({ baseUrl: "https://hub.test", internalToken: "token",
    fetchImpl: async (_url, options) => { posted.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) }; } });
  const identity = { tenant_id: "tenant", user_id: "user" };
  const input = { resource_key: "ml:123", plan_code: "fake", range_code: "up_to_30", declared_orders: 1,
    payment_method: "pix" };
  await service.checkout(identity, { ...input, module: "ml" });
  assert.equal(posted[0].plan_code, undefined);
  assert.equal(posted[0].range_code, undefined);
  assert.equal(posted[0].declared_orders, undefined);
  await service.checkout(identity, { ...input, module: "magalu" });
  assert.equal(posted[1].plan_code, "fake");
});

test("gateway postpaid quote and acceptance use trusted identity and omit browser pricing", async () => {
  const posted = [];
  const service = createSellerPortalService({ baseUrl: "https://hub.test", internalToken: "token",
    fetchImpl: async (url, options) => { posted.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) }; } });
  const identity = { tenant_id: "tenant", user_id: "user" };
  await service.postpaidQuote(identity, { resource_key: "ml:123", monthly_price_cents: 1 });
  await service.acceptPostpaidQuote(identity, { quote_id: "pq-1", payment_method: "pix", range_code: "fake" });
  assert.deepEqual(posted, [
    { url: "https://hub.test/v1/internal/postpaid/quote",
      body: { tenant_id: "tenant", user_id: "user", resource_key: "ml:123" } },
    { url: "https://hub.test/v1/internal/postpaid/accept",
      body: { tenant_id: "tenant", user_id: "user", quote_id: "pq-1", payment_method: "pix" } }
  ]);
});

test("gateway schedules postpaid deactivation with trusted identity only", async () => {
  const posted = [];
  const service = createSellerPortalService({ baseUrl: "https://hub.test", internalToken: "token",
    fetchImpl: async (url, options) => { posted.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) }; } });
  await service.deactivatePostpaidAccount({ tenant_id: "tenant", user_id: "user" }, {
    resource_key: "shopee:456", ends_on: "2026-10-01"
  });
  assert.deepEqual(posted, [{ url: "https://hub.test/v1/internal/postpaid/deactivate",
    body: { tenant_id: "tenant", user_id: "user", resource_key: "shopee:456" } }]);
});

test("gateway updates an account label with trusted identity and no billing fields", async () => {
  const posted = [];
  const service = createSellerPortalService({ baseUrl: "https://hub.test", internalToken: "token",
    fetchImpl: async (url, options) => { posted.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) }; } });
  await service.renameAccount({ tenant_id: "tenant", user_id: "user" }, {
    resource_key: "ml:123", label: "Loja principal", monthly_price_cents: 1
  });
  assert.deepEqual(posted, [{ url: "https://hub.test/v1/internal/portal/accounts/label",
    body: { tenant_id: "tenant", user_id: "user", resource_key: "ml:123", label: "Loja principal" } }]);
});

test("ML and Shopee show a Hub proposal before accepting postpaid access", () => {
  assert.match(portal, /\/api\/portal\/postpaid\/quote/);
  assert.match(portal, /\/api\/portal\/postpaid\/accept/);
  assert.match(portal, /Revisar proposta/);
  assert.match(portal, /Aceitar e ativar/);
});

test("account drawer keeps postpaid deactivation separate from unlinking", () => {
  assert.match(portal, /Desativar no fim do ciclo/);
  assert.match(portal, /\/api\/portal\/postpaid\/deactivate/);
  assert.match(portal, /postpaid_lifecycle/);
});

test("account drawer edits only the account label through the trusted portal endpoint", () => {
  assert.match(portal, /id="account-alias-editor"/);
  assert.match(portal, /id="account-alias-input"/);
  assert.match(portal, /\/api\/portal\/accounts\/label/);
  assert.match(portal, /Renomear conta/);
});

test("unmeasured marketplace accounts are presented as range validation, not inactive access", () => {
  assert.match(portal, /function accountStatus\(resource\)/);
  assert.match(portal, /Validando faixa/);
  assert.match(portal, /Falha na apuração/);
});

test("inactive postpaid account is presented as a reactivation, not a new trial", () => {
  assert.match(portal, /Reativar conta/);
});

test("company view lists postpaid invoices and only renders a payment link supplied by the Hub", () => {
  assert.match(portal, /id="company-invoices"/);
  assert.match(portal, /\/api\/portal\/postpaid\/invoices/);
  assert.match(portal, /function safePaymentUrl/);
  assert.match(portal, /Faturas e cobranças/);
});
