"use strict";

/**
 * Versioned inventory of externally observable contracts that pre-date the
 * DACHBYTE name. This is intentionally data only: importing it cannot mount a
 * route, set a cookie, or alter an OAuth flow.
 *
 * An item can move to `retired` only in a separately reviewed release after
 * the cleanup evidence described in docs/architecture/migration-dachbyte.md.
 */
const LEGACY_SURFACE_REGISTRY = Object.freeze({
  version: 1,
  status: "pre-canonical-domain",
  removalBlockedUntil: "A DACHBYTE canonical domain is configured and post-rollout telemetry is approved.",
  routes: Object.freeze([
    "/ml", "/shopee", "/madeiramadeira", "/avantracking", "/davanttilog", "/skuleader",
    "/volt-price", "/voltstock", "/chat", "/voltchat", "/volt_chat", "/stock",
    "/sacdavantti",
  ]),
  cookies: Object.freeze([
    "suite_auth_token", "auth_token", "sid", "skuleader_auth_token", "davanttilog_token",
    "volt_core_session", "volt_price_session", "vp_tray_oauth_state", "vp_shopee_oauth_state",
  ]),
  oauthCallbacks: Object.freeze([
    "/api/meli/oauth/callback", "/ml/api/meli/oauth/callback", "/shopee/auth/callback",
    "/volt-price/api/integrations/meli/callback",
    "/volt-price/api/integrations/shopee/callback",
    "/volt-price/api/integrations/tray/callback",
  ]),
});

function listLegacySurface() {
  return Object.freeze({
    routes: [...LEGACY_SURFACE_REGISTRY.routes],
    cookies: [...LEGACY_SURFACE_REGISTRY.cookies],
    oauthCallbacks: [...LEGACY_SURFACE_REGISTRY.oauthCallbacks],
  });
}

module.exports = { LEGACY_SURFACE_REGISTRY, listLegacySurface };
