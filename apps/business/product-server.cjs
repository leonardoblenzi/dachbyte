"use strict";
const express = require("express");
const path = require("node:path");
const fs = require("node:fs");

// Load only the selected product in each container. Canonical paths are the
// runtime contract. Legacy mounts remain only while Caddy still proxies legacy
// API clients; legacy UI traffic is redirected at the edge.
const PRODUCT_PATHS = Object.freeze({
  portal: { canonical: "/business", legacy: [] },
  core: { canonical: "/business/core", legacy: ["/core"] },
  stock: { canonical: "/business/stock", legacy: ["/voltstock"] },
  chat: { canonical: "/business/chat", legacy: ["/chat"] },
  price: { canonical: "/business/price", legacy: ["/volt-price"] },
});

function mountWithLegacy(app, router, canonical, legacy = []) {
  app.use(canonical, router);
  for (const alias of legacy) {
    if (alias !== canonical) app.use(alias, router);
  }
}

function registerHealthRoutes(app, product) {
  const paths = PRODUCT_PATHS[product];
  const healthPaths = [`${paths.canonical}/healthz`, ...paths.legacy.map((base) => `${base}/healthz`)];
  app.get(healthPaths, (_req, res) => res.json({ ok: true, app: `business-${product}` }));
}

async function createProductApp(product) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use("/brand", express.static(path.resolve(__dirname, "../../public/brand")));
  // Register health endpoints before SPA/Next catch-alls can consume them.
  registerHealthRoutes(app, product);

  if (product === "portal") {
    app.get(["/business", "/business/"], (_req, res) => res.sendFile(path.join(__dirname, "public/landing.html")));
    // Kept only as a portal fallback. Caddy gives the dedicated Price container
    // precedence for the canonical /business/price product path.
    app.get(["/business/price", "/business/price/"], (_req, res) => res.sendFile(path.join(__dirname, "public/price.html")));
    for (const [alias, target] of [["/voltchat", "/business/chat"], ["/volt_chat", "/business/chat"], ["/stock", "/business/stock"]]) {
      app.use(alias, (req, res, next) => {
        if (!["GET", "HEAD"].includes(req.method)) return next();
        res.redirect(308, target + (req.url === "/" ? "" : req.url));
      });
    }
    app.use(require("../../platform/gateway/canonicalRoutes").createCanonicalRedirectHandler("business"));
  } else if (product === "core") {
    // Core registers canonical and legacy UI/API prefixes internally because its
    // API and SPA are served by the same Express application.
    app.use(await require("./core")());
  } else if (product === "stock") {
    app.get(["/icon.png", "/logo-volt-chat.png"], (req, res) => res.sendFile(path.join(__dirname, "stock/apps/web/public", req.path.slice(1))));
    const stockApp = await require("./stock")();
    mountWithLegacy(app, stockApp, PRODUCT_PATHS.stock.canonical, PRODUCT_PATHS.stock.legacy);
  } else if (product === "price") {
    const priceApp = require("./price")();
    mountWithLegacy(app, priceApp, PRODUCT_PATHS.price.canonical, PRODUCT_PATHS.price.legacy);
  } else if (product === "chat") {
    if (!fs.existsSync(path.join(__dirname, "chat/sordchat-frontend/build/index.html"))) throw new Error("DACHBYTE Chat build missing");
    const chatApp = require("./chat")();
    mountWithLegacy(app, chatApp, PRODUCT_PATHS.chat.canonical, PRODUCT_PATHS.chat.legacy);
    app.get(["/version.json", "/business/chat/version.json", "/chat/version.json"], (_req, res) =>
      res.sendFile(path.join(__dirname, "chat/sordchat-frontend/build/version.json")),
    );
  } else {
    throw new Error(`Unknown Business product: ${product}`);
  }

  return app;
}

async function start() {
  const product = process.env.DACHBYTE_PRODUCT;
  if (!PRODUCT_PATHS[product]) throw new Error(`Unknown Business product: ${product}`);
  const productApp = await createProductApp(product);
  const app = express();
  app.use(productApp);
  const server = app.listen(Number(process.env.PORT || 3000), "0.0.0.0");
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return server;
}
if (require.main === module) start().catch((error) => { console.error(error); process.exit(1); });
module.exports = { PRODUCT_PATHS, createProductApp, mountWithLegacy, start };
