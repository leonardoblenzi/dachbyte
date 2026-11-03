"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildAnalysis,
  buildPdf,
  buildXlsx,
  getCustomPeriodRange,
  getPreviousPeriodRange,
  mlGetJson,
} = require("../services/adminMeliAccountPerformanceReportService");

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
  };
}

test("periodo personalizado cobre os dias completos no fuso do relatorio", () => {
  const range = getCustomPeriodRange("2025-04-01", "2025-04-30");

  assert.equal(range.days, 30);
  assert.equal(range.from.toISOString(), "2025-04-01T03:00:00.000Z");
  assert.equal(range.to.toISOString(), "2025-05-01T02:59:59.999Z");
});

test("periodo personalizado aceita um unico dia", () => {
  const range = getCustomPeriodRange("2025-04-15", "2025-04-15");
  assert.equal(range.days, 1);
});

test("periodo personalizado rejeita intervalo invertido ou maior que 180 dias", () => {
  assert.throws(
    () => getCustomPeriodRange("2025-04-30", "2025-04-01"),
    /data inicial deve ser anterior/i,
  );
  assert.throws(
    () => getCustomPeriodRange("2025-01-01", "2025-07-01"),
    /no maximo 180 dias/i,
  );
});

test("tela envia datas quando o usuario escolhe Personalizado", () => {
  const root = path.join(__dirname, "..");
  const view = fs.readFileSync(path.join(root, "views", "admin-meli-account-reports.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "public", "js", "admin-meli-account-reports.js"), "utf8");

  assert.match(view, /<option value="custom">Personalizado<\/option>/);
  assert.match(view, /id="period-from"[^>]+type="date"/);
  assert.match(view, /id="period-to"[^>]+type="date"/);
  assert.match(client, /return \{ periodFrom: from, periodTo: to \}/);
});

test("comparativo usa um periodo anterior completo de igual duracao", () => {
  const current = getCustomPeriodRange("2025-04-01", "2025-04-30");
  const previous = getPreviousPeriodRange(current.from, current.to);

  assert.equal(previous.from.toISOString(), "2025-03-02T03:00:00.000Z");
  assert.equal(previous.to.toISOString(), "2025-04-01T02:59:59.999Z");
});

test("consulta ML aguarda e repete quando recebe local_rate_limited", async () => {
  const responses = [
    jsonResponse(429, { error: "local_rate_limited" }, { "retry-after": "2" }),
    jsonResponse(200, { results: [1] }),
  ];
  const waits = [];
  let calls = 0;

  const result = await mlGetJson("https://api.mercadolibre.com/orders/search", "token", {
    maxAttempts: 3,
    fetchImpl: async () => {
      calls += 1;
      return responses.shift();
    },
    sleepFn: async (ms) => waits.push(ms),
  });

  assert.deepEqual(result, { results: [1] });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
});

test("consulta ML repete quando o governador local pede cooldown", async () => {
  let calls = 0;
  const waits = [];
  const result = await mlGetJson("https://api.mercadolibre.com/users/123", "token", {
    maxAttempts: 3,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("cooldown");
        error.code = "ML_API_COOLDOWN_ACTIVE";
        error.retryAfterMs = 1500;
        throw error;
      }
      return jsonResponse(200, { id: 123 });
    },
    sleepFn: async (ms) => waits.push(ms),
  });

  assert.deepEqual(result, { id: 123 });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1500]);
});

test("geradores completos produzem PDF e XLSX com vendas, comparativo e Ads", () => {
  const analysis = buildAnalysis({
    account: { id: 1, label: "Conta teste", apelido: "Teste", empresaNome: "Empresa", meliUserId: "123" },
    orders: [{ date_created: "2025-04-10T12:00:00Z", order_items: [{ quantity: 2, unit_price: 100, item: { id: "MLB1", title: "Produto A", seller_sku: "SKU-1" } }] }],
    previousOrders: [{ date_created: "2025-03-10T12:00:00Z", order_items: [{ quantity: 1, unit_price: 100, item: { id: "MLB1", title: "Produto A", seller_sku: "SKU-1" } }] }],
    cancelledOrders: [],
    previousCancelledOrders: [],
    visits: 100,
    previousVisits: 80,
    totalAvailable: 1,
    previousTotalAvailable: 1,
    warnings: [],
    periodFrom: "2025-04-01T03:00:00.000Z",
    periodTo: "2025-05-01T02:59:59.999Z",
    previousFrom: "2025-03-02T03:00:00.000Z",
    previousTo: "2025-04-01T02:59:59.999Z",
    sellerProfile: { id: "123", reputation: {} },
    ads: {
      available: true,
      warnings: [],
      previousSummary: { cost: 5, totalAmount: 50, roas: 10, acos: 10, prints: 500, clicks: 25, ctr: 5, cpc: 0.2, cvr: 4, unitsQuantity: 1 },
      summary: { cost: 10, totalAmount: 100, directAmount: 80, indirectAmount: 20, roas: 10, acos: 10, prints: 1000, clicks: 50, ctr: 5, cpc: 0.2, cvr: 4, unitsQuantity: 2 },
      campaigns: [{ id: "C1", name: "Campanha", status: "active", strategy: "PROFITABILITY", roasTarget: 8, adgroupsCount: 1, metrics: { cost: 10, totalAmount: 100, directAmount: 80, indirectAmount: 20, roas: 10, acos: 10, prints: 1000, clicks: 50, ctr: 5, cpc: 0.2, cvr: 4, unitsQuantity: 2, sov: 50 }, costChangePct: 100, revenueChangePct: 100, roasChangePct: 0 }],
      items: [{ campaignId: "C1", campaignName: "Campanha", itemId: "MLB1", sku: "SKU-1", title: "Produto A", status: "active", quality: 90, metrics: { cost: 10, totalAmount: 100, directAmount: 80, indirectAmount: 20, roas: 10, acos: 10, prints: 1000, clicks: 50, ctr: 5, cpc: 0.2, cvr: 4, unitsQuantity: 2 } }],
    },
  });
  const requestedOutputDir = String(process.env.ML_REPORT_TEST_OUTPUT_DIR || "").trim();
  const dir = requestedOutputDir || fs.mkdtempSync(path.join(os.tmpdir(), "ml-report-test-"));
  if (requestedOutputDir) fs.mkdirSync(dir, { recursive: true });
  const pdf = path.join(dir, "report.pdf");
  const xlsx = path.join(dir, "report.xlsx");
  try {
    buildPdf(analysis, pdf);
    buildXlsx(analysis, xlsx);
    assert.ok(fs.statSync(pdf).size > 1000);
    assert.ok(fs.statSync(xlsx).size > 1000);
    assert.equal(analysis.comparison.revenueChangePct, 100);
    assert.equal(analysis.kpis.conversionRatePct, 1);
    assert.equal(analysis.rankRevenue[0].ads.roas, 10);
    assert.equal(analysis.rankRevenue[0].revenueCentsAbc, "A");
  } finally {
    if (!requestedOutputDir) fs.rmSync(dir, { recursive: true, force: true });
  }
});
