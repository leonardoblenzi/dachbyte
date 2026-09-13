"use strict";

const path = require("path");
const express = require(
  require.resolve("express", {
    paths: [process.cwd(), path.join(process.cwd(), "shopee"), __dirname],
  }),
);
const routes = require("./routes");
const { startHubUsageReporter } = require("./services/hubUsageReporter");

function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("etag", false);

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(
    express.static(path.join(__dirname, "..", "public"), { index: false }),
  );
  app.use(
    express.static(path.join(__dirname, "public"), { index: false }),
  );

  startHubUsageReporter();

  app.use(routes);

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const status = Number(error?.status) || 500;
    return res.status(status).json({
      ok: false,
      error: error?.message || "Erro interno do módulo MadeiraMadeira",
      details: error?.details || null,
      status,
      path: req.originalUrl,
      timestamp: new Date().toISOString(),
    });
  });

  app.use((req, res) => {
    return res.status(404).json({
      ok: false,
      error: "Rota não encontrada no módulo MadeiraMadeira",
      path: req.originalUrl,
      method: req.method,
    });
  });

  return app;
}

module.exports = createApp;
