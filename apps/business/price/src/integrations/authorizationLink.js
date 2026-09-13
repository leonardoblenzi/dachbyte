"use strict";

const { randomToken, sha256 } = require("../crypto");

const LINK_TTL_MS = 15 * 60_000;

function createLinkToken(now = new Date()) {
  const token = randomToken(32);
  return {
    token,
    tokenHash: sha256(token),
    expiresAt: new Date(new Date(now).getTime() + LINK_TTL_MS),
  };
}

function publicLinkState(link, now = new Date()) {
  if (!link || link.cancelled_at) return { status: "cancelled" };
  if (link.used_at) return { status: "used" };
  if (!link.expires_at || new Date(link.expires_at).getTime() <= new Date(now).getTime()) return { status: "expired" };
  if (link.opened_at) return { status: "in_progress" };
  return { status: "ready" };
}

function isLinkUsable(link, now = new Date()) {
  return publicLinkState(link, now).status === "ready";
}

function authorizationLinkRecord({ tokenHash, tenantId, channel, userId, expiresAt, supportReason = null }) {
  return {
    token_hash: tokenHash,
    tenant_id: tenantId,
    channel,
    created_by_user_id: userId,
    expires_at: expiresAt,
    support_reason: supportReason,
  };
}

async function createAuthorizationLink(client, { tenantId, channel, userId, supportReason = null, now = new Date() }) {
  const { token, tokenHash, expiresAt } = createLinkToken(now);
  const record = authorizationLinkRecord({ tokenHash, tenantId, channel, userId, expiresAt, supportReason });
  const link = (await client.query(
    `INSERT INTO volt_price.integration_authorization_links
      (token_hash,tenant_id,channel,created_by_user_id,expires_at,support_reason)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id,tenant_id,channel,created_by_user_id,expires_at,opened_at,used_at,cancelled_at,connection_id,created_at`,
    [record.token_hash, record.tenant_id, record.channel, record.created_by_user_id, record.expires_at, record.support_reason],
  )).rows[0];
  return { token, link };
}

async function findAuthorizationLink(client, token, { forUpdate = false } = {}) {
  const suffix = forUpdate ? " FOR UPDATE" : "";
  return (await client.query(
    `SELECT l.*,t.name AS tenant_name
     FROM volt_price.integration_authorization_links l
     JOIN volt_price.tenants t ON t.id=l.tenant_id
     WHERE l.token_hash=$1${suffix}`,
    [sha256(String(token || ""))],
  )).rows[0] || null;
}

module.exports = { LINK_TTL_MS, createLinkToken, isLinkUsable, publicLinkState, authorizationLinkRecord, createAuthorizationLink, findAuthorizationLink };
