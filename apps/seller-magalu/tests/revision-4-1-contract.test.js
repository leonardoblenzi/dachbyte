"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const appRoot = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(appRoot, ...parts), "utf8");

test("seller profile failure is auxiliary and does not gate catalog SKU listing", () => {
  const source = read("src", "services", "catalogSyncService.js");
  const profileCall = source.indexOf("portfolioReadService.getSeller");
  const warning = source.indexOf("seller profile unavailable; continuing with catalog sync");
  const skuLoop = source.indexOf("portfolioReadService.listSkus");
  assert.ok(profileCall >= 0);
  assert.ok(warning > profileCall);
  assert.ok(skuLoop > warning);
  assert.match(source, /seller_profile:\s*sellerProfile/);
  assert.match(source, /failed_endpoint/);
  assert.match(source, /request_id/);
});

test("read-only diagnostics endpoint exists and does not expose authorization headers or tokens", () => {
  const service = read("src", "services", "catalogDiagnosticsService.js");
  const routes = read("src", "routes", "api.routes.js");
  assert.match(routes, /router\.post\("\/catalog\/test",\s*catalogController\.diagnostics\)/);
  assert.match(service, /listSkus/);
  assert.match(service, /getSeller/);
  assert.match(service, /getPrice/);
  assert.match(service, /getStock/);
  assert.doesNotMatch(service, /Authorization|Bearer|access_token|refresh_token/i);
});

test("Magalu shell mirrors ML interaction model without importing ML runtime", () => {
  const html = read("views", "app.html");
  const js = read("public", "js", "magalu-app.js");
  assert.match(html, /mg-sidebar-toggle/);
  assert.match(html, /data-group-toggle="overview"/);
  assert.match(html, /mg-account-menu-toggle/);
  assert.match(html, /href="\/magalu\/sincronizacao"/);
  assert.match(js, /magalu:shell:collapsed/);
  assert.match(js, /magalu:shell:groups/);
  assert.match(js, /openNavGroup/);
  assert.doesNotMatch(js, /seller-ml|ml-shell/i);
});

test("production UI no longer exposes implementation stage placeholders", () => {
  const html = read("views", "app.html");
  for (const forbidden of ["ETAPA 04", "protected write", "A Etapa 4", "Etapa 4 · Escritas protegidas"]) {
    assert.equal(html.includes(forbidden), false, forbidden);
  }
  assert.match(html, /Visão geral da operação/);
  assert.match(html, /Sincronização/);
  assert.match(html, /Testar conexão/);
});

test("revisioned Magalu assets cannot reuse the previous browser cache", () => {
  const html = read("views", "app.html");
  assert.match(html, /magalu-app\.css\?v=(?!2026092304)\d+/);
  assert.match(html, /magalu-app\.js\?v=(?!2026092304)\d+/);
});

test("protected write surfaces remain present", () => {
  const html = read("views", "app.html");
  const js = read("public", "js", "magalu-app.js");
  assert.match(html, /mg-price-preview-btn/);
  assert.match(html, /mg-stock-preview-btn/);
  assert.match(html, /mg-write-preview/);
  assert.match(js, /\/magalu\/api\/writes\/preview/);
  assert.match(js, /\/magalu\/api\/writes\/apply/);
  assert.match(js, /reverify/);
});

test("ML parity visual override is loaded after the Magalu base stylesheet", () => {
  const html = read("views", "app.html");
  const css = read("public", "css", "magalu-ml-parity.css");

  assert.match(html, /magalu-app\.css\?v=2026092501/);
  assert.match(html, /magalu-ml-parity\.css\?v=2026092502/);
  assert.ok(html.indexOf("magalu-app.css") < html.indexOf("magalu-ml-parity.css"));
  assert.match(css, /--mg-ml-sidebar-width:\s*262px/);
  assert.match(css, /--mg-ml-sidebar-collapsed-width:\s*92px/);
  assert.match(css, /--mg-ml-topbar-height:\s*68px/);
});
