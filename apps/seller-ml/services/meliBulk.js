"use strict";

function normalizeAttributes(attributes) {
  const values = Array.isArray(attributes)
    ? attributes
    : String(attributes || "").split(",");

  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => (value.startsWith("body.") ? value : `body.${value}`))
    .join(",");
}

function itemsBulkPath(ids, attributes = "", extraParams = {}) {
  const params = new URLSearchParams();
  params.set("ids", (ids || []).map(String).join(","));

  const normalizedAttributes = normalizeAttributes(attributes);
  if (normalizedAttributes) params.set("attributes", normalizedAttributes);

  for (const [key, value] of Object.entries(extraParams || {})) {
    if (value != null && value !== "") params.set(key, String(value));
  }

  return `/items/bulk?${params.toString()}`;
}

function normalizeBulkEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  if (entry.code != null || entry.status_code == null) return entry;
  return { ...entry, code: entry.status_code };
}

function normalizeBulkResponse(payload) {
  return Array.isArray(payload) ? payload.map(normalizeBulkEntry) : [];
}

module.exports = {
  itemsBulkPath,
  normalizeAttributes,
  normalizeBulkEntry,
  normalizeBulkResponse,
};
