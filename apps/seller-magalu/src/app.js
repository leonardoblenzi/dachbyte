"use strict";

const express = require("express");
const path = require("node:path");
const publicRoutes = require("./routes/public.routes");
const protectedRoutes = require("./routes");
const { suiteAuth } = require("./middlewares/suiteAuth");
const { errorHandler } = require("./middlewares/errorHandler");

async function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.set("etag", false);
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.setHeader("X-Dachbyte-Product", "seller-magalu");
    res.setHeader("Cache-Control", req.path.startsWith("/assets/") ? "public, max-age=3600" : "no-store");
    next();
  });

  // Webhook v1 precisa receber os bytes exatos antes de express.json().
  app.use(publicRoutes);

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use("/assets", express.static(path.resolve(__dirname, "../public"), { maxAge: "1h", etag: true }));

  // Tudo abaixo daqui pertence ao produto autenticado e é fail-closed via Hub.
  app.use(suiteAuth);
  app.use(protectedRoutes);

  app.use((req, res) => {
    const accept = String(req.headers.accept || "").toLowerCase();
    if (accept.includes("text/html")) return res.redirect(302, "/magalu/");
    return res.status(404).json({ ok: false, error: "not_found", path: req.originalUrl });
  });
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
