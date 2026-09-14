"use strict";
const express = require("express");
const path = require("node:path");
const fs = require("node:fs");

// Load only the selected product in each container.
async function createProductApp(product) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use("/brand", express.static(path.resolve(__dirname, "../../public/brand")));
  if (product === "portal") {
    app.get(["/business", "/business/"], (_req, res) => res.sendFile(path.join(__dirname, "public/landing.html")));
    app.get(["/business/price", "/business/price/"], (_req, res) => res.sendFile(path.join(__dirname, "public/price.html")));
    for (const [alias, target] of [["/voltchat", "/chat"], ["/volt_chat", "/chat"], ["/stock", "/voltstock"]]) {
      app.use(alias, (req, res, next) => {
        if (!["GET", "HEAD"].includes(req.method)) return next();
        res.redirect(302, target + (req.url === "/" ? "" : req.url));
      });
    }
    app.use(require("../../platform/gateway/canonicalRoutes").createCanonicalRedirectHandler("business"));
  } else if (product === "core") {
    app.use(await require("./core")());
  } else if (product === "stock") {
    app.get(["/icon.png", "/logo-volt-chat.png"], (req, res) => res.sendFile(path.join(__dirname, "stock/apps/web/public", req.path.slice(1))));
    app.use("/voltstock", await require("./stock")());
  } else if (product === "price") {
    app.use("/volt-price", require("./price")());
  } else if (product === "chat") {
    if (!fs.existsSync(path.join(__dirname, "chat/sordchat-frontend/build/index.html"))) throw new Error("DACHBYTE Chat build missing");
    app.use("/chat", require("./chat")());
    app.get("/version.json", (_req, res) => res.sendFile(path.join(__dirname, "chat/sordchat-frontend/build/version.json")));
  } else {
    throw new Error(`Unknown Business product: ${product}`);
  }
  return app;
}

async function start() {
  const product = process.env.DACHBYTE_PRODUCT;
  const productApp = await createProductApp(product);
  const app = express();
  const prefix = { portal: "/business", core: "/core", stock: "/voltstock", chat: "/chat", price: "/volt-price" }[product];
  app.get(`${prefix}/healthz`, (_req, res) => res.json({ ok: true, app: `business-${product}` }));
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
module.exports = { createProductApp, start };
