"use strict";

const db = require("../config/postgres");

async function createState({ stateHash, dachTenantId, dachUserId, redirectAfter, expiresAt, requestedScopes }) {
  const { rows } = await db.query(
    `insert into magalu.oauth_states
       (state_hash, dach_tenant_id, dach_user_id, redirect_after, expires_at, requested_scopes)
     values ($1, $2, $3, $4, $5, $6::text[])
     returning id, state_hash, dach_tenant_id, dach_user_id, redirect_after, expires_at, requested_scopes, created_at`,
    [
      String(stateHash),
      String(dachTenantId),
      String(dachUserId),
      redirectAfter || null,
      expiresAt,
      Array.isArray(requestedScopes) ? requestedScopes : [],
    ],
  );
  return rows[0] || null;
}

async function consumeState(stateHash) {
  const { rows } = await db.query(
    `update magalu.oauth_states
        set used_at = now()
      where state_hash = $1
        and used_at is null
        and expires_at > now()
      returning id, state_hash, dach_tenant_id, dach_user_id, redirect_after,
                expires_at, used_at, requested_scopes, created_at`,
    [String(stateHash)],
  );
  return rows[0] || null;
}

async function deleteExpiredStates() {
  const result = await db.query(
    `delete from magalu.oauth_states
      where expires_at < now() - interval '1 day'
         or used_at < now() - interval '1 day'`,
  );
  return result.rowCount || 0;
}

module.exports = { createState, consumeState, deleteExpiredStates };
