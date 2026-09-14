"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");

test("margin simulator explains revenue, fees, profit and break-even", () => {
  const { margin } = require("../public/brand/dachbyte/landing-experience.js");
  const result = margin(100, 0, 8);

  assert.deepEqual(result, {
    revenue: 100,
    fees: 16,
    profit: 19,
    margin: 19,
    breakEven: 77.38,
  });
  assert.equal(margin(100, 30, 20).profit, -18.2);
});

test("interactive progress never advances beyond the last stage", () => {
  const { nextStep } = require("../public/brand/dachbyte/landing-experience.js");
  assert.equal(nextStep(0, 4), 1);
  assert.equal(nextStep(3, 4), 3);
  assert.equal(nextStep(0, 0), 0);
});

test("all public Business landings load the shared navigation experience", () => {
  const pages = [
    ["apps", "business", "public", "landing.html"],
    ["apps", "business", "core", "public", "landing.html"],
    ["apps", "business", "stock", "apps", "web", "public", "landing.html"],
  ];

  for (const page of pages) {
    const html = read(...page);
    assert.match(html, /landing-experience\.css/, page.join("/"));
    assert.match(html, /landing-experience\.js/, page.join("/"));
    assert.match(html, /data-dx-shell=/, page.join("/"));
  }
  const chatDocument = read("apps", "business", "chat", "sordchat-frontend", "public", "index.html");
  const chatLanding = read("apps", "business", "chat", "sordchat-frontend", "src", "pages", "Landing.js");
  assert.match(chatDocument, /landing-experience\.css/);
  assert.match(chatDocument, /landing-experience\.js/);
  assert.match(chatLanding, /data-dx-shell="business"/);
});

test("Seller shared assets map every public route to a distinct decision demo", () => {
  const js = read("apps", "seller-ml", "public", "seller-landing.js");
  const css = read("apps", "seller-ml", "public", "seller-landing.css");
  for (const [route, experience] of [["/seller", "seller"], ["/seller/mercado-livre", "ml"], ["/seller/shopee", "shopee"], ["/seller/rastreio", "tracking"]]) {
    assert.match(js, new RegExp(`'${route.replaceAll("/", "\\/")}'\\s*:\\s*'${experience}'`));
  }
  assert.match(js, /landing-experience\.js/);
  assert.match(css, /landing-experience\.css/);
});

test("Business gains an integrated scenario and a public Price landing", () => {
  const business = read("apps", "business", "public", "landing.html");
  const price = read("apps", "business", "public", "price.html");
  const app = read("apps", "business", "app.js");

  assert.match(business, /data-dx-experience="business"/);
  assert.match(business, /href="\/business\/price"/);
  assert.doesNotMatch(business, /href="#"/);
  assert.match(price, /data-dx-shell="business"/);
  assert.match(price, /DACHBYTE Price/);
  assert.match(price, /href="\/volt-price"/);
  assert.match(app, /["']\/price["']/);
  assert.match(app, /req\.originalUrl/);
  assert.match(app, /["']\/business\/price["']/);
  assert.match(app, /endsWith\(["']\/price["']\)/);
  assert.ok(
    app.indexOf("const priceLandingPaths") < app.indexOf('registerCanonicalRoutes(app, "business")'),
    "the public Price landing must be registered before legacy canonical redirects",
  );
});
