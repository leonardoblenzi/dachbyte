const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const errorHandler = require("./middlewares/errorHandler");
const requestObservability = require("./middlewares/requestObservability");
const { registerBuiltInExtensions } = require("./extensions/registerBuiltIns");

function normalizeBasePath(value, fallback) {
  const raw = String(value || fallback || "").trim();
  if (!raw || raw === "/") return "";
  return `/${raw.replace(/^\/+|\/+$/g, "")}`;
}

function routePattern(basePath) {
  const escaped = String(basePath || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?:/.*)?$`);
}

const publicBasePath = normalizeBasePath(process.env.VOLT_CORE_PUBLIC_BASE_PATH, "/business/core");
const appBasePath = normalizeBasePath(process.env.VOLT_CORE_APP_BASE_PATH, `${publicBasePath}/app`);
const legacyPublicBasePath = "/core";
const legacyAppBasePath = "/core/app";
const appRoutePatterns = [routePattern(appBasePath)];
if (legacyAppBasePath !== appBasePath) appRoutePatterns.push(routePattern(legacyAppBasePath));

function createApp() {
  registerBuiltInExtensions();
  // Routes are loaded after extension registration so optional modules can
  // contribute their own endpoints without Core importing them directly.
  const routes = require("./routes");
  const app = express();
  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const allowedOrigins = new Set(
    String(process.env.VOLT_CORE_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  app.disable("x-powered-by");
  app.use("/brand/dachbyte", express.static(path.resolve(__dirname, "../../../../public/brand/dachbyte")));
  app.use((req, res, next) => {
    const incoming = String(req.get("x-request-id") || "").trim();
    const requestId = /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : crypto.randomUUID();
    req.id = requestId;
    res.setHeader("X-Request-Id", requestId);
    next();
  });
  app.use(requestObservability);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
          "script-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", "data:"],
        },
      },
    }),
  );
  app.use(cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      if (!isProduction && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return callback(null, true);
      return callback(null, false);
    },
  }));
  app.use(cookieParser());
  app.use(express.json({
    limit: "1mb",
    verify(req, _res, buffer) { req.rawBody = Buffer.from(buffer); },
  }));
  app.use(express.urlencoded({ extended: true }));

  app.get("/status", (req, res) => {
    res.json({
      name: "Volt Core API",
      status: "running",
    });
  });

  app.use(routes);

  const publicPath = path.join(__dirname, "..", "public");
  const landingPath = path.join(publicPath, "landing.html");
  if (fs.existsSync(landingPath)) {
    app.use(publicBasePath, express.static(publicPath, { index: false }));
    app.use(legacyPublicBasePath, express.static(publicPath, { index: false }));
    app.get([publicBasePath, `${publicBasePath}/`, legacyPublicBasePath, `${legacyPublicBasePath}/`], (_req, res) =>
      res.sendFile("landing.html", { root: publicPath }),
    );
    app.get("/landing", (_req, res) => res.sendFile("landing.html", { root: publicPath }));
  }

  const distPath = path.join(__dirname, "..", "dist");
  const indexPath = path.join(distPath, "index.html");
  if (fs.existsSync(indexPath)) {
    // Root static remains as a compatibility bridge for cached legacy Core builds
    // that still request /assets/*. New builds use /business/core/assets/*.
    app.use(express.static(distPath, { index: false }));
    app.use(publicBasePath, express.static(distPath, { index: false }));
    app.use(legacyPublicBasePath, express.static(distPath, { index: false }));
    for (const pattern of appRoutePatterns) {
      app.get(pattern, (_req, res) => {
        res.sendFile(indexPath);
      });
    }
    app.get(["/login", "/dashboard"], (_req, res) => {
      res.sendFile(indexPath);
    });
  }

  app.use(errorHandler);

  return app;
}

module.exports = createApp;
