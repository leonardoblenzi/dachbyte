const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const cookieParser = require("cookie-parser");
const debugRoutes = require("./routes/debug.routes");
const requestLogger = require("./middlewares/requestLogger");
const processActionTracker = require("./middlewares/processActionTracker");
const errorHandler = require("./middlewares/errorHandler");
const routes = require("./routes");
const env = require("./config/env");
const { startHubUsageReporter } = require("./services/hubUsageReporter");

// BigInt -> JSON (uma vez só)
BigInt.prototype.toJSON = function () {
  return this.toString();
};

function isProduction() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function resolveSessionSecret() {
  const configured = String(process.env.SESSION_SECRET || "").trim();
  if (configured) return configured;
  if (isProduction()) {
    throw new Error("SESSION_SECRET is required in production.");
  }
  return "local-development-session-secret";
}

function configuredCorsOrigins() {
  return new Set(
    String(process.env.SHOPEE_CORS_ORIGINS || process.env.CORS_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function isSameOriginRequest(req, origin) {
  try {
    const parsed = new URL(origin);
    const forwardedHost = String(req.get("x-forwarded-host") || "").split(",")[0].trim();
    const requestHost = forwardedHost || String(req.get("host") || "").trim();
    return Boolean(requestHost) && parsed.host === requestHost;
  } catch (_error) {
    return false;
  }
}

function corsOptions(req, callback) {
  const origin = String(req.get("origin") || "").trim();
  if (!origin) {
    callback(null, { origin: false, credentials: true });
    return;
  }
  const allowed = isSameOriginRequest(req, origin) || configuredCorsOrigins().has(origin);
  callback(null, { origin: allowed, credentials: allowed });
}

function debugRoutesEnabled() {
  if (!isProduction()) return true;
  return String(process.env.SHOPEE_DEBUG_ROUTES || "").trim().toLowerCase() === "true";
}

function createApp() {
  const app = express();
  startHubUsageReporter();

  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "script-src": [
            "'self'",
            "https://cdn.jsdelivr.net",
            "https://unpkg.com",
          ],
          "style-src": ["'self'", "'unsafe-inline'", "https://unpkg.com"],
          "img-src": ["'self'", "data:", "https:", "https://*.tile.openstreetmap.org"],
          "media-src": ["'self'", "blob:", "https:"],
          "connect-src": [
            "'self'",
            "https://*.tile.openstreetmap.org",
            "https://cdn.jsdelivr.net",
            "https://unpkg.com",
          ],
        },
      },
      referrerPolicy: { policy: "origin" },
    }),
  );

  app.use(cors(corsOptions));
  app.use(cookieParser(resolveSessionSecret()));

  app.use(express.json({ limit: "12mb" }));
  app.use(express.urlencoded({ extended: true, limit: "12mb" }));
  app.use(requestLogger());
  app.use(processActionTracker());

  if (debugRoutesEnabled()) {
    app.use(debugRoutes);
  }

  // Static (sem index automático: / e /login serão rotas controladas)
  app.use(
    express.static(path.join(__dirname, "..", "public"), { index: false }),
  );

  app.get("/status", (req, res) => {
    res.json({
      name: "DAVANTTI Shopee API",
      apiBaseUrl: env.API_BASE_URL,
      status: "running",
    });
  });

  app.use(routes);

  app.use(errorHandler);

  return app;
}

module.exports = createApp;
