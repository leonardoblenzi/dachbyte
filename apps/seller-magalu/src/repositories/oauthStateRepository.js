"use strict";

const db = require("../config/postgres");

async function createState({ stateHash, dachTenantId, dachUserId, redirectAfter, expiresAt, requestedScopes, flowMode = "tenant", targetAccountId = null, expectedMagaluTenantId = null }) {
  const { rows } = await db.query(
    `insert into magalu.oauth_states
       (state_hash, dach_tenant_id, dach_user_id, redirect_after, expires_at, requested_scopes, flow_mode, target_account_id, expected_magalu_tenant_id)
     values ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9)
     returning id, state_hash, dach_tenant_id, dach_user_id, redirect_after, expires_at, requested_scopes, flow_mode, target_account_id, expected_magalu_tenant_id, created_at`,
    [
      String(stateHash),
      String(dachTenantId),
      String(dachUserId),
      redirectAfter || null,
      expiresAt,
      Array.isArray(requestedScopes) ? requestedScopes : [],
      String(flowMode || "tenant"),
      targetAccountId == null ? null : Number(targetAccountId),
      expectedMagaluTenantId == null ? null : String(expectedMagaluTenantId),
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
                expires_at, used_at, requested_scopes, flow_mode, target_account_id, expected_magalu_tenant_id, created_at`,
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
