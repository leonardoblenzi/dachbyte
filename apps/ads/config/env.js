"use strict";

const normalize = (value) => String(value || "").trim();
const int = (value, fallback, min = 0) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
};

const env = Object.freeze({
  nodeEnv: normalize(process.env.NODE_ENV) || "development",
  port: Number(process.env.PORT || 3000),
  databaseUrl: normalize(process.env.DATABASE_URL),
  workerDatabaseUrl: normalize(process.env.ADS_WORKER_DATABASE_URL || process.env.DATABASE_URL),
  authMode: normalize(process.env.ADS_AUTH_MODE || "hub").toLowerCase(),
  suiteJwtSecret: normalize(process.env.SUITE_JWT_SECRET || process.env.JWT_SECRET),
  hubBaseUrl: normalize(process.env.HUB_BASE_URL).replace(/\/+$/, ""),
  hubInternalToken: normalize(process.env.HUB_INTERNAL_TOKEN),
  hubRequestTimeoutMs: int(process.env.HUB_REQUEST_TIMEOUT_MS, 8000, 1000),
  hubAdsModule: normalize(process.env.ADS_HUB_MODULE || "dach_ads").toLowerCase(),
  devTenantId: normalize(process.env.ADS_DEV_TENANT_ID || "tenant-dev"),
  devUserId: normalize(process.env.ADS_DEV_USER_ID || "user-dev"),
  devUserEmail: normalize(process.env.ADS_DEV_USER_EMAIL || "dev@dachbyte.local"),
  devUserName: normalize(process.env.ADS_DEV_USER_NAME || "DACH Ads Dev"),
  redisUrl: normalize(process.env.REDIS_URL),
  workerHeartbeatKey: normalize(process.env.ADS_WORKER_HEARTBEAT_KEY || "ads:worker:heartbeat"),
  workerHeartbeatTtlSeconds: int(process.env.ADS_WORKER_HEARTBEAT_TTL_SECONDS, 60, 30),
  tokenEncryptionKey: normalize(process.env.ADS_TOKEN_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY),
  googleAdsClientId: normalize(process.env.GOOGLE_ADS_CLIENT_ID),
  googleAdsClientSecret: normalize(process.env.GOOGLE_ADS_CLIENT_SECRET),
  googleAdsRedirectUri: normalize(process.env.GOOGLE_ADS_REDIRECT_URI),
  googleAdsApiVersion: normalize(process.env.GOOGLE_ADS_API_VERSION || "v25"),
  // Since 2026-09-09 Google Ads API developer tokens are sunset. The header is
  // retained only as an optional compatibility knob for older projects/proxies.
  googleAdsDeveloperToken: normalize(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
  googleOAuthStateTtlSeconds: int(process.env.GOOGLE_OAUTH_STATE_TTL_SECONDS, 600, 120),
  googleInitialLookbackDays: int(process.env.ADS_GOOGLE_INITIAL_LOOKBACK_DAYS, 90, 7),
  googleRecentLookbackDays: int(process.env.ADS_GOOGLE_RECENT_LOOKBACK_DAYS, 14, 3),
  googleSyncIntervalMinutes: int(process.env.ADS_GOOGLE_SYNC_INTERVAL_MINUTES, 120, 15),
  metaAppId: normalize(process.env.META_APP_ID),
  metaAppSecret: normalize(process.env.META_APP_SECRET),
  metaRedirectUri: normalize(process.env.META_REDIRECT_URI),
  metaGraphApiVersion: normalize(process.env.META_GRAPH_API_VERSION || "v26.0"),
  metaOAuthScopes: normalize(process.env.META_OAUTH_SCOPES || "ads_read,business_management"),
  metaOAuthStateTtlSeconds: int(process.env.META_OAUTH_STATE_TTL_SECONDS, 600, 120),
  metaInitialLookbackDays: int(process.env.ADS_META_INITIAL_LOOKBACK_DAYS, 90, 7),
  metaRecentLookbackDays: int(process.env.ADS_META_RECENT_LOOKBACK_DAYS, 14, 3),
  metaSyncIntervalMinutes: int(process.env.ADS_META_SYNC_INTERVAL_MINUTES, 120, 15),
  syncWorkerPollMs: int(process.env.ADS_SYNC_WORKER_POLL_MS, 10_000, 1_000),
  syncJobLockMinutes: int(process.env.ADS_SYNC_JOB_LOCK_MINUTES, 30, 5),
});

module.exports = { env };
