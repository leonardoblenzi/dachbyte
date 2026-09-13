"use strict";
const { randomToken, sha256 } = require("../crypto");
const { query } = require("../db");

async function createOAuthState(auth, channel, payload = {}, { client = null } = {}) {
  const tenantId = String(auth?.tenantId || "").trim();
  const userId = String(auth?.userId || "").trim();
  if (!tenantId || !userId) throw Object.assign(new Error("Selecione uma empresa antes de conectar um canal."), { statusCode: 409, code: "tenant_required" });
  const raw = randomToken(32);
  const db = client || { query };
  await db.query(`INSERT INTO volt_price.oauth_states (state_hash,tenant_id,user_id,channel,payload,expires_at) VALUES ($1,$2,$3,$4,$5::jsonb,now()+interval '15 minutes')`, [sha256(raw),tenantId,userId,channel,JSON.stringify(payload)]);
  return raw;
}

async function consumeOAuthState(raw, channel) {
  const result = await query(
    `UPDATE volt_price.oauth_states SET used_at=now() WHERE state_hash=$1 AND channel=$2 AND used_at IS NULL AND expires_at>now()
     RETURNING tenant_id,user_id,payload`, [sha256(raw),channel]);
  return result.rows[0] || null;
}
module.exports={createOAuthState,consumeOAuthState};
