"use strict";

const crypto = require("node:crypto");

function canonicalizeDatabaseTarget(rawUrl) {
  const parsed = new URL(String(rawUrl || "").trim());
  const host = parsed.hostname.toLowerCase().replace(/-pooler(?=\.)/, "");
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const schema = parsed.searchParams.get("schema") || "public";
  const identity = `${host}|${database}|${schema}`;
  return {
    host,
    database,
    schema,
    fingerprint: crypto.createHash("sha256").update(identity).digest("hex").slice(0, 12),
  };
}

function assertDistinctDatabaseTargets(shopeeUrl, avantrackingUrl) {
  if (!shopeeUrl) return;
  if (canonicalizeDatabaseTarget(shopeeUrl).fingerprint === canonicalizeDatabaseTarget(avantrackingUrl).fingerprint) {
    throw new Error("AVANTRACKING_DATABASE_URL aponta para o mesmo banco de DATABASE_URL.");
  }
}

function resolveAvantrackingDatabaseUrl(env = process.env) {
  const specific = String(env.AVANTRACKING_DATABASE_URL || "").trim();
  if (!specific) throw new Error("AVANTRACKING_DATABASE_URL nao configurada.");
  assertDistinctDatabaseTargets(env.DATABASE_URL, specific);
  return specific;
}

module.exports = { canonicalizeDatabaseTarget, assertDistinctDatabaseTargets, resolveAvantrackingDatabaseUrl };
