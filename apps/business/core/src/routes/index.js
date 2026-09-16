const express = require("express");
const healthRoutes = require("./health.routes");
const coreRoutes = require("./core.routes");

const router = express.Router();

function normalizeBasePath(value, fallback) {
  const raw = String(value || fallback || "").trim();
  if (!raw || raw === "/") return "";
  return `/${raw.replace(/^\/+|\/+$/g, "")}`;
}

const canonicalApiBasePath = normalizeBasePath(
  process.env.VOLT_CORE_API_BASE_PATH,
  "/business/core/api",
);
const legacyApiBasePath = "/api/core";

router.use(healthRoutes);
router.use(canonicalApiBasePath, coreRoutes);
if (canonicalApiBasePath !== legacyApiBasePath) {
  router.use(legacyApiBasePath, coreRoutes);
}

module.exports = router;
