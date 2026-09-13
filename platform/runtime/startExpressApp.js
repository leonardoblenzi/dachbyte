"use strict";

const express = require("express");

function normalizeMountPath(mountPath) {
  const normalized = String(mountPath || "").trim().replace(/\/+$/, "");
  if (!normalized || normalized === "/" || !normalized.startsWith("/")) {
    throw new TypeError("mountPath must be a non-root path beginning with '/'");
  }
  return normalized;
}

async function createHostedExpressApp({ createApp, name, mountPath }) {
  if (typeof createApp !== "function") {
    throw new TypeError("createApp must be a function");
  }

  const normalizedMountPath = normalizeMountPath(mountPath);
  const productApp = await createApp();
  const hostApp = express();
  hostApp.use("/brand", express.static(require("node:path").resolve(__dirname, "../../public/brand")));

  // Register this before the product to keep orchestration health independent
  // from product authentication, static middleware, or terminal 404 handlers.
  hostApp.get(`${normalizedMountPath}/health`, (_req, res) => {
    res.json({ ok: true, app: name });
  });
  hostApp.use(normalizedMountPath, productApp);

  return hostApp;
}

/**
 * Starts an Express application created by a product factory. Keeping this
 * small bootstrap outside each product makes products independently runnable
 * without giving the gateway ownership of their lifecycle.
 */
async function startExpressApp({ createApp, name, mountPath, port = process.env.PORT || 3000 }) {
  if (typeof createApp !== "function") {
    throw new TypeError("createApp must be a function");
  }

  const app = mountPath
    ? await createHostedExpressApp({ createApp, name, mountPath })
    : await createApp();
  const server = app.listen(Number(port), "0.0.0.0", () => {
    console.log(`[${name}] running on port ${port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${name}] received ${signal}, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return { app, server, shutdown };
}

module.exports = { createHostedExpressApp, startExpressApp };
