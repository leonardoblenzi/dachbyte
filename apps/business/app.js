"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const createVoltCoreApp = require("./core");
const { createSupportWidgetInjector } = require("../../lib/supportWidgetInjector");
const { proxyVoltChatApi } = require("./lib/voltChatProxy");
const { DACHBYTE_BRAND } = require("../../lib/dachbyteBrand");

async function createBusinessApp() {
  const app = express();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // Public DACHBYTE Business URLs forward to stable module paths until each
  // application can own a new base path without breaking internal links.
  const { registerCanonicalRoutes } = require("../../platform/gateway");
  registerCanonicalRoutes(app, "business");

  app.get(["/health", "/healthz"], (_req, res) => {
    res.json({
      ok: true,
      app: "volt-corp",
      brand: DACHBYTE_BRAND.business,
      products: ["core", "voltstock", "voltchat", "voltprice"],
    });
  });

  try {
    const sacSupportRoutes = require("../../routes/sacSupportRoutes");
    app.use("/api/sac", sacSupportRoutes);
    app.use(
      "/support",
      express.static(path.join(__dirname, "..", "..", "public", "support"), {
        immutable: false,
        maxAge: "5m",
      }),
    );
    app.get(["/sacdavantti", "/sacdavantti/"], (_req, res) => {
      res.sendFile(path.join(__dirname, "..", "..", "public", "support", "sac-admin.html"));
    });
    app.use(createSupportWidgetInjector());
  } catch (error) {
    console.warn("[volt-corp] SAC Davantti indisponivel neste ambiente:", error.message);
  }

  app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "landing.html"));
  });

  app.get("/price", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "price.html"));
  });

  app.get("/favicon.ico", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "favicon.ico"));
  });

  app.get("/version.json", (_req, res) => {
    const buildVersion = path.join(__dirname, "chat", "sordchat-frontend", "build", "version.json");
    const publicVersion = path.join(__dirname, "chat", "sordchat-frontend", "public", "version.json");
    res.sendFile(fs.existsSync(buildVersion) ? buildVersion : publicVersion);
  });

  // The DACHBYTE master assets are shared without changing any public module URL.
  app.use("/brand/dachbyte", express.static(path.join(__dirname, "..", "..", "public", "brand", "dachbyte"), {
    immutable: true,
    maxAge: "7d",
  }));

  app.use("/brand", express.static(path.join(__dirname, "public", "brand"), {
    immutable: true,
    maxAge: "7d",
  }));

  app.get(["/icon.png", "/logo-volt-chat.png"], (req, res) => {
    const file = req.path === "/icon.png" ? "icon.png" : "logo-volt-chat.png";
    const iconPath = path.join(__dirname, "stock", "apps", "web", "public", file);
    if (!fs.existsSync(iconPath)) {
      return res.status(404).json({ success: false, error: "Icone nao disponivel neste ambiente." });
    }
    return res.sendFile(iconPath);
  });

  app.use("/chat-api", proxyVoltChatApi);

  app.get("/stock", (_req, res) => {
    res.redirect(302, "/voltstock");
  });

  app.use(["/voltchat", "/volt_chat"], (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const targetPath = req.path === "/" ? "" : req.path;
    res.redirect(302, `/chat${targetPath}`);
  });

  app.post("/api/auth/logout", (_req, res) => {
    res
      .clearCookie("suite_auth_token")
      .clearCookie("volt_core_session")
      .status(204)
      .end();
  });

  try {
    const createVoltPriceApp = require("./price");
    const voltPriceApp = createVoltPriceApp();
    app.use("/volt-price", voltPriceApp);
  } catch (error) {
    console.warn("[volt-corp] VoltPrice indisponivel; mantendo Volt Corp ativo:", error.message);
    app.use("/volt-price", (_req, res) => {
      res.status(503).json({ success: false, error: "VoltPrice indisponivel neste ambiente." });
    });
  }

  try {
    const createVoltStockApp = require("./stock");
    const voltStockApp = await createVoltStockApp();
    app.use("/voltstock", voltStockApp);
  } catch (error) {
    console.warn("[volt-corp] Volt Stock indisponivel; mantendo Volt Corp ativo:", error.message);
    app.use("/voltstock", (_req, res) => {
      res.status(503).json({
        success: false,
        error: "Volt Stock indisponivel neste ambiente.",
      });
    });
  }

  try {
    const createVoltChatApp = require("./chat");
    const voltChatApp = createVoltChatApp();
    app.use("/chat", voltChatApp);
  } catch (error) {
    console.warn("[volt-corp] Volt Chat indisponivel; mantendo Volt Corp ativo:", error.message);
    app.use("/chat", (_req, res) => {
      res.status(503).json({
        success: false,
        error: "Volt Chat indisponivel neste ambiente.",
      });
    });
  }

  const voltCoreApp = await createVoltCoreApp();
  app.use(voltCoreApp);

  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: "Rota nao encontrada (volt-corp)",
      path: req.originalUrl,
      method: req.method,
    });
  });

  return app;
}

module.exports = createBusinessApp;
