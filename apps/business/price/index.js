"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const cookieParser = require("cookie-parser");
const { ensureBootstrapMaster } = require("./src/auth");
const { query } = require("./src/db");
const { authRouter } = require("./src/routes/auth.routes");
const { dashboardRouter } = require("./src/routes/dashboard.routes");
const { integrationsRouter } = require("./src/routes/integrations.routes");
const { ordersRouter } = require("./src/routes/orders.routes");
const { commissionsRouter } = require("./src/routes/commissions.routes");
const { adminRouter } = require("./src/routes/admin.routes");
const { appDataRouter } = require("./src/routes/appData.routes");
const { usersRouter } = require("./src/routes/users.routes");
const { financeRouter } = require("./src/routes/finance.routes");
const { marketingRouter } = require("./src/routes/marketing.routes");
const { marketRouter } = require("./src/routes/market.routes");
const { decisionRouter } = require("./src/routes/decision.routes");
const { domainRouter } = require("./src/routes/domain.routes");
const { secureHeaders } = require("./src/security");
const { startTokenMaintenance } = require("./src/integrations/maintenance");

function createVoltPriceApp() {
  startTokenMaintenance();
  const router = express.Router();
  router.disable?.("x-powered-by");
  router.use(secureHeaders);
  router.use(cookieParser());
  router.use(express.json({ limit: "2mb" }));
  router.use(express.urlencoded({ extended: true, limit: "2mb" }));

  router.get("/health", async (_req, res) => {
    try {
      await query("SELECT 1");
      res.json({ ok: true, service: "volt-price", version: "0.1.0", database: "ready" });
    } catch (_error) {
      res.status(503).json({
        ok: false,
        service: "volt-price",
        version: "0.1.0",
        database: "unavailable",
      });
    }
  });

  router.use("/api/auth", authRouter);
  router.use("/api/dashboard", dashboardRouter);
  router.use("/api/integrations", integrationsRouter);
  router.use("/api", financeRouter);
  router.use("/api", marketingRouter);
  router.use("/api", marketRouter);
  router.use("/api", decisionRouter);
  router.use("/api/orders", ordersRouter);
  router.use("/api/commissions", commissionsRouter);
  router.use("/api/admin", adminRouter);
  router.use("/api/users", usersRouter);
  router.use("/api", domainRouter);
  router.use("/api", appDataRouter);

  const publicDir = path.join(__dirname, "public");
  router.use(express.static(publicDir, { index: false, maxAge: "5m" }));
  const indexPath = path.join(publicDir, "index.html");
  if (fs.existsSync(indexPath)) {
    router.get("/", (_req, res) => res.sendFile(indexPath));
    router.get("/login", (_req, res) => res.sendFile(indexPath));
    router.get(/^\/app(?:\/.*)?$/, (_req, res) => res.sendFile(indexPath));
  }

  router.use((error, req, res, _next) => {
    const status = Number(error.statusCode || error.status || 500);
    if (status >= 500) console.error("[volt-price]", error);
    res.status(status).json({
      success: false,
      error: error.code || "internal_error",
      message: status >= 500 ? "Erro interno do VoltPrice." : error.message,
      requestId: req.headers["x-request-id"] || null,
    });
  });

  ensureBootstrapMaster().catch((error) => {
    console.error("[volt-price] Falha ao preparar admin master:", error.message);
  });

  return router;
}

module.exports = createVoltPriceApp;
