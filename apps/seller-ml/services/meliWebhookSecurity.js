"use strict";

const ML_API_ORIGIN = "https://api.mercadolibre.com";
const SUPPORTED_TOPICS = new Set(["public_offers", "public_candidates"]);
const TOPIC_PATH_PREFIX = {
  public_offers: "/seller-promotions/offers/",
  public_candidates: "/seller-promotions/candidates/",
};

function toPositiveInteger(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function normalizeTopic(value) {
  return String(value || "").trim().toLowerCase();
}

function isSupportedTopic(value) {
  return SUPPORTED_TOPICS.has(normalizeTopic(value));
}

function normalizeResourceForTopic(resource, topic) {
  const cleanTopic = normalizeTopic(topic);
  const prefix = TOPIC_PATH_PREFIX[cleanTopic];
  const raw = String(resource || "").trim();

  if (!prefix || !raw) {
    return { ok: false, reason: !prefix ? "topic_not_supported" : "resource_missing" };
  }

  if (raw.startsWith("//")) {
    return { ok: false, reason: "resource_scheme_relative_not_allowed" };
  }

  let url;
  try {
    url = /^https?:\/\//i.test(raw)
      ? new URL(raw)
      : new URL(raw.startsWith("/") ? raw : `/${raw}`, ML_API_ORIGIN);
  } catch {
    return { ok: false, reason: "resource_invalid_url" };
  }

  if (url.protocol !== "https:" || url.origin !== ML_API_ORIGIN) {
    return { ok: false, reason: "resource_origin_not_allowed" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "resource_credentials_not_allowed" };
  }
  if (url.port && url.port !== "443") {
    return { ok: false, reason: "resource_port_not_allowed" };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: "resource_query_or_hash_not_allowed" };
  }

  const pathname = String(url.pathname || "");
  if (!pathname.startsWith(prefix)) {
    return { ok: false, reason: "resource_path_not_allowed" };
  }

  const resourceId = pathname.slice(prefix.length);
  if (!resourceId || resourceId.includes("/") || resourceId.length > 200) {
    return { ok: false, reason: "resource_id_invalid" };
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(resourceId)) {
    return { ok: false, reason: "resource_id_invalid" };
  }

  return {
    ok: true,
    topic: cleanTopic,
    resource: `${prefix}${resourceId}`,
    resource_id: resourceId,
    url: `${ML_API_ORIGIN}${prefix}${resourceId}`,
  };
}

function ignoredNotification(notification = {}, topic) {
  return {
    _id: String(notification._id || "").trim().slice(0, 160) || null,
    topic: String(topic || "").slice(0, 100),
    user_id: toPositiveInteger(notification.user_id),
    application_id: toPositiveInteger(notification.application_id),
    attempts: Math.max(0, Math.min(1000, Number(notification.attempts) || 0)),
    sent: String(notification.sent || "").trim().slice(0, 100) || null,
    received:
      String(notification.received || notification.recieved || "")
        .trim()
        .slice(0, 100) || null,
  };
}

function validateWebhookNotification(notification = {}, options = {}) {
  const topic = normalizeTopic(notification.topic);

  if (!topic) {
    return { ok: false, reason: "topic_missing" };
  }

  if (!SUPPORTED_TOPICS.has(topic)) {
    if (options.allowUnsupportedTopic === true) {
      // Topicos ignorados nunca propagam `resource`: preserva SSRF/token safety.
      return {
        ok: true,
        ignored: true,
        reason: "topic_not_supported",
        notification: ignoredNotification(notification, topic),
      };
    }

    return { ok: false, reason: "topic_not_supported" };
  }

  const userId = toPositiveInteger(notification.user_id);
  if (!userId) {
    return { ok: false, reason: "user_id_invalid" };
  }

  const resourceResult = normalizeResourceForTopic(notification.resource, topic);
  if (!resourceResult.ok) return resourceResult;

  const expectedApplicationId = toPositiveInteger(options.expectedApplicationId);
  const applicationId = toPositiveInteger(notification.application_id);
  const requireApplicationId = options.requireApplicationId === true;

  if (requireApplicationId && expectedApplicationId && !applicationId) {
    return { ok: false, reason: "application_id_missing" };
  }
  if (expectedApplicationId && applicationId && applicationId !== expectedApplicationId) {
    return { ok: false, reason: "application_id_mismatch" };
  }

  return {
    ok: true,
    ignored: false,
    notification: {
      _id: String(notification._id || "").trim().slice(0, 160) || null,
      topic,
      resource: resourceResult.resource,
      user_id: userId,
      application_id: applicationId,
      attempts: Math.max(0, Math.min(1000, Number(notification.attempts) || 0)),
      sent: String(notification.sent || "").trim().slice(0, 100) || null,
      received:
        String(notification.received || notification.recieved || "")
          .trim()
          .slice(0, 100) || null,
    },
  };
}

function buildPromotionResourceUrl(resource, topic) {
  const result = normalizeResourceForTopic(resource, topic);
  if (!result.ok) {
    const error = new Error(`Recurso de webhook Mercado Livre rejeitado: ${result.reason}`);
    error.code = "ML_WEBHOOK_RESOURCE_REJECTED";
    error.reason = result.reason;
    throw error;
  }

  const url = new URL(result.url);
  url.searchParams.set("app_version", "v2");
  return url.toString();
}

module.exports = {
  ML_API_ORIGIN,
  SUPPORTED_TOPICS,
  buildPromotionResourceUrl,
  isSupportedTopic,
  normalizeResourceForTopic,
  validateWebhookNotification,
};
