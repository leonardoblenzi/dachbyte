"use strict";

const { createAdsApp } = require("./app");
const { env } = require("./config/env");

const app = createAdsApp();
const server = app.listen(env.port, "0.0.0.0", () => {
  console.log(`[dach-ads] API listening on port ${env.port}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[dach-ads] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
