"use strict";

const express = require("express");
const path = require("node:path");
const { createIdentityProvider } = require("./infrastructure/identity/createIdentityProvider");
const { requireIdentity } = require("./http/middleware/requireIdentity");
const { createGoogleAdsRouter } = require("./http/routes/googleAdsRoutes");
const { createAnalyticsRouter } = require("./http/routes/analyticsRoutes");
const { createMetaAdsRouter } = require("./http/routes/metaAdsRoutes");
const { createIntelligenceRouter } = require("./http/routes/intelligenceRoutes");
const { createDiagnosticsRouter } = require("./http/routes/diagnosticsRoutes");

const appRoot = __dirname;
const publicRoot = path.join(appRoot, "public");
const sharedBrandRoot = path.resolve(appRoot, "..", "..", "public", "brand", "dachbyte");

function setSecurityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
}

function errorStatus(error) {
  if (error?.status && Number.isInteger(error.status)) return error.status;
  const code = String(error?.code || "");
  if (code.includes("NOT_FOUND")) return 404;
  if (code.includes("NOT_SELECTED") || code.includes("NOT_SYNCABLE")) return 409;
  if (code.includes("NOT_CONFIGURED") || code.includes("INVALID") || code.includes("MISSING")) return 400;
  return 500;
}

function createAdsApp() {
  const app = express();
  const identityProvider = createIdentityProvider();
  const protectedRoute = requireIdentity(identityProvider);

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(setSecurityHeaders);
  app.use(express.json({ limit: "1mb" }));

  app.get(["/healthz", "/ads/healthz"], (_req, res) => {
    res.json({
      ok: true,
      app: "dach-ads",
      product: "dach_ads",
      authBoundary: "hub-enforced",
      googleAds: "stage-2",
      analytics: "stage-3",
      metaAds: "stage-4",
      multichannel: "stage-5",
      fzRules: "stage-5",
      hubAccess: "stage-6",
    });
  });

  app.use(
    "/brand/dachbyte",
    express.static(sharedBrandRoot, { immutable: true, maxAge: "7d" }),
  );
  app.use(
    "/ads/assets",
    express.static(publicRoot, { immutable: true, maxAge: "1h" }),
  );

  app.get(["/", "/ads", "/ads/"], (_req, res) => {
    res.sendFile(path.join(publicRoot, "landing.html"));
  });

  app.get("/ads/api/session", protectedRoute, (req, res) => {
    res.json({ success: true, identity: req.adsIdentity });
  });

  app.use("/ads/api/google", protectedRoute, createGoogleAdsRouter());
  app.use("/ads/api/meta", protectedRoute, createMetaAdsRouter());
  app.use("/ads/api/analytics", protectedRoute, createAnalyticsRouter());
  app.use("/ads/api/intelligence", protectedRoute, createIntelligenceRouter());
  app.use("/ads/api/diagnostics", protectedRoute, createDiagnosticsRouter());

  app.get(["/ads/app", "/ads/app/", "/ads/app/*"], protectedRoute, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(publicRoot, "app.html"));
  });

  app.use((error, _req, res, _next) => {
    console.error("[dach-ads] unhandled request error", error);
    res.status(errorStatus(error)).json({
      success: false,
      error: error.code || "internal_error",
      message: errorStatus(error) >= 500 ? "Falha interna no DACH Ads" : error.message,
    });
  });

  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: "not_found",
      path: req.originalUrl,
      method: req.method,
    });
  });

  return app;
}

module.exports = { createAdsApp };
