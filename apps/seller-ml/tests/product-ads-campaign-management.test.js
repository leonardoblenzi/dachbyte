const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ProductAdsService = require("../services/productAdsService");
const PublicidadeController = require("../controllers/PublicidadeController");

test("campaign update reports unsupported capability without calling Mercado Livre", async () => {
  const result = await ProductAdsService.atualizarCampanha("123", {
    status: "paused",
  });

  assert.deepEqual(result, {
    success: false,
    code: "CAMPAIGN_MANAGEMENT_UNSUPPORTED",
    error: "O Mercado Livre nao permite editar campanhas Product Ads por integracao.",
  });
});

test("campaign update maps unsupported management to HTTP 409", async () => {
  const res = {
    locals: {},
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  await PublicidadeController.atualizarCampanha(
    { params: { id: "123" }, body: {} },
    res
  );

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "CAMPAIGN_MANAGEMENT_UNSUPPORTED");
});

test("campaign modal presents external management without a save action", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "../views/publicidade.html"),
    "utf8"
  );
  const script = fs.readFileSync(
    path.join(__dirname, "../public/js/product-ads.js"),
    "utf8"
  );

  assert.match(html, /id="campaignManageExternalBtn"/);
  assert.match(html, /id="focusCampaignToggle"[^>]*>Gerenciar<\/button>/);
  assert.doesNotMatch(html, /id="campaignEditSaveBtn"/);
  assert.match(script, /openMercadoLivreAdvertising/);
  assert.doesNotMatch(script, /async function saveCampaignEdit/);
  assert.doesNotMatch(script, /fetch\(\s*withBase\(`\/api\/publicidade\/product-ads\/campaigns/);
});

test("publicidade KPI layout marks executive metrics as a decision group", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "../views/publicidade.html"),
    "utf8"
  );
  const css = fs.readFileSync(
    path.join(__dirname, "../public/css/product-ads.css"),
    "utf8"
  );

  assert.match(html, /ads-premium__kpis ads-premium__kpis--decision/);
  assert.match(css, /\.ads-premium__kpis--decision > \.kpi:nth-child\(1\)/);
  assert.match(css, /\.ads-premium__kpis--decision > \.kpi:nth-child\(n\+5\)/);
  assert.match(css, /@media \(max-width:1180px\)/);
});

test("publicidade serves versioned assets for the safe management release", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "../views/publicidade.html"),
    "utf8"
  );

  assert.match(html, /product-ads\.css\?v=2026092301/);
  assert.match(html, /product-ads\.js\?v=2026092301/);
});
