"use strict";

/**
 * Domain-migration planning only.
 *
 * This is deliberately not imported by a server, auth middleware, OAuth
 * client, mailer, or redirect handler. Until a real DACHBYTE domain is
 * approved and rollout is explicitly enabled, all runtime contracts retain
 * their current origins, callback URLs and cookie names.
 */

const CANONICAL_PATHS = Object.freeze({
  seller: "/seller",
  business: "/business",
});

const OAUTH_ROLLOUT_STAGES = Object.freeze([
  "not-configured",
  "provider-registration",
  "dual-callback-validation",
  "canonical-preferred",
  "legacy-retirement",
]);

const COOKIE_ROLLOUT_STAGES = Object.freeze([
  "legacy-only",
  "dual-read",
  "dual-write",
  "canonical-preferred",
  "legacy-retirement",
]);

function normalizeOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("A domain migration origin must use http or https.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("A domain migration origin cannot include a path, query or hash.");
  }
  return parsed.origin;
}

function normalizeOrigins(values) {
  const seen = new Set();
  return Object.freeze(
    (Array.isArray(values) ? values : [])
      .map(normalizeOrigin)
      .filter(Boolean)
      .filter((origin) => {
        if (seen.has(origin)) return false;
        seen.add(origin);
        return true;
      }),
  );
}

function joinOriginPath(origin, pathname) {
  return origin ? `${origin}${pathname}` : null;
}

/**
 * Builds an inert, serializable migration plan.
 * `canonicalOrigin` is null by default because DACHBYTE does not have a
 * purchased domain yet. Supplying a value only describes a future rollout;
 * it never changes process environment, cookies, OAuth callbacks or links.
 */
function createDomainMigrationPlan(options = {}) {
  const canonicalOrigin = normalizeOrigin(options.canonicalOrigin);
  const legacyOrigins = normalizeOrigins(options.legacyOrigins);

  if (canonicalOrigin && legacyOrigins.includes(canonicalOrigin)) {
    throw new Error("The canonical origin must not also be listed as legacy.");
  }

  const configured = Boolean(canonicalOrigin);
  return Object.freeze({
    configured,
    canonicalOrigin,
    legacyOrigins,
    publicUrls: Object.freeze({
      seller: joinOriginPath(canonicalOrigin, CANONICAL_PATHS.seller),
      business: joinOriginPath(canonicalOrigin, CANONICAL_PATHS.business),
    }),
    oauth: Object.freeze({
      stage: configured ? "provider-registration" : "not-configured",
      legacyCallbacksRemainActive: true,
      canonicalCallbacksRequireProviderRegistration: true,
      requiredStages: OAUTH_ROLLOUT_STAGES,
    }),
    cookies: Object.freeze({
      stage: "legacy-only",
      existingNamesUnchanged: true,
      requiredStages: COOKIE_ROLLOUT_STAGES,
    }),
  });
}

const DOMAIN_MIGRATION_PLAN = createDomainMigrationPlan();

module.exports = {
  CANONICAL_PATHS,
  COOKIE_ROLLOUT_STAGES,
  DOMAIN_MIGRATION_PLAN,
  OAUTH_ROLLOUT_STAGES,
  createDomainMigrationPlan,
  normalizeOrigin,
};
