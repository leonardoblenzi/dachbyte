"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const view = (...segments) => path.join(root, "apps", "seller-ml", "views", ...segments);

test("Seller public landings share the Business typography contract", () => {
  const stylesheet = fs.readFileSync(path.join(root, "apps", "seller-ml", "public", "seller-landing.css"), "utf8");

  for (const font of ["Exo+2", "Rajdhani", "Share+Tech+Mono"]) {
    assert.equal(stylesheet.includes(font), true, font);
  }
  assert.match(stylesheet, /--seller-primary:\s*#ff8a3f/i);
  assert.match(stylesheet, /--seller-success:\s*#2dd9a8/i);
});

test("Seller exposes a compact general landing and three module landings", () => {
  const expectedPages = [
    ["landing-general.html", "DACHBYTE Seller"],
    ["landing-mercado-livre.html", "DACHBYTE Mercado Livre"],
    ["landing-shopee.html", "DACHBYTE Shopee"],
    ["landing-tracking.html", "DACHBYTE Tracking"],
  ];

  for (const [fileName, heading] of expectedPages) {
    const source = fs.readFileSync(view(fileName), "utf8");
    assert.match(source, new RegExp(heading));
    assert.match(source, /seller-landing\.css/);
    assert.match(source, /seller-landing\.js/);
  }

  const generalLanding = fs.readFileSync(view("landing-general.html"), "utf8");
  for (const destination of ["/seller/mercado-livre", "/seller/shopee", "/seller/rastreio"]) {
    assert.match(generalLanding, new RegExp(destination.replaceAll("/", "\\/")));
  }
});

test("Seller navigation separates visual chapters from dedicated module landings", () => {
  const generalHtml = fs.readFileSync(view("landing-general.html"), "utf8");
  assert.match(generalHtml, /aria-label="Módulos Seller"/);
  for (const chapter of ["#mercado-livre", "#shopee", "#rastreio"]) {
    assert.match(generalHtml, new RegExp(`href="${chapter}"`));
  }

  const modulePages = [
    "landing-mercado-livre.html",
    "landing-shopee.html",
    "landing-tracking.html",
  ];
  const moduleRoutes = [
    "/seller/mercado-livre",
    "/seller/shopee",
    "/seller/rastreio",
  ];

  for (const pageName of modulePages) {
    const html = fs.readFileSync(view(pageName), "utf8");
    assert.match(html, /aria-label="Módulos Seller"/);
    for (const route of moduleRoutes) {
      assert.match(html, new RegExp(`href="${route}"`));
    }
  }
});

test("general Seller landing keeps useful comparison depth", () => {
  const html = fs.readFileSync(view("landing-general.html"), "utf8");
  assert.equal((html.match(/seller-card__features/g) || []).length, 3);
  assert.equal((html.match(/data-seller-demo>/g) || []).length, 3);
  assert.equal((html.match(/data-seller-demo-tab=/g) || []).length, 9);
  assert.equal((html.match(/>Conhecer mais</g) || []).length, 3);
  for (const appEntry of ["/ml/login", "/shopee", "/avantracking"]) {
    assert.match(html, new RegExp(`href="${appEntry}"`));
  }
  assert.match(html, /seller-ticker/);
});

test("Business visual chapters offer learn-more and product-entry actions", () => {
  const html = fs.readFileSync(path.join(root, "apps", "business", "public", "landing.html"), "utf8");
  for (const destination of ["/business/stock", "/business/stock/login", "/business/chat", "/business/core", "/business/core/app"]) {
    assert.match(html, new RegExp(`href="${destination.replaceAll("/", "\\/")}"`));
  }
  assert.ok((html.match(/>Conhecer mais</g) || []).length >= 3);
});

test("gateway serves marketing routes before redirecting nested product paths", () => {
  const source = fs.readFileSync(path.join(root, "apps", "gateway", "server.js"), "utf8");
  const landingRoute = source.indexOf('"/seller/mercado-livre"');
  const canonicalRegistration = source.indexOf('registerCanonicalRoutes(app, "seller")');

  assert.ok(landingRoute >= 0);
  assert.ok(canonicalRegistration > landingRoute);
  assert.match(source, /"\/seller-assets"/);
  assert.match(source, /"\/seller\/rastreio"/);
  assert.match(source, /"\/seller\/tracking"/);
});
