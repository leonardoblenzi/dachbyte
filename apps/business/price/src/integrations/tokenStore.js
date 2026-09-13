"use strict";

const { encrypt, decrypt } = require("../crypto");
const { withTenant } = require("../db");

function connectionStatus(connection, now = Date.now()) {
  const status = String(connection?.status || "").toLowerCase();
  if (status === "disconnected") return "disconnected";
  if (status === "revoked") return "revoked";
  if (connection?.last_error === "reauthorization_required") return "reauthorization_required";
  if (connection?.last_error) return "error";
  const refreshExpiresAt = connection?.refresh_expires_at ? new Date(connection.refresh_expires_at).getTime() : null;
  if (refreshExpiresAt && refreshExpiresAt <= now) return "reauthorization_required";
  const tokenExpiresAt = connection?.token_expires_at ? new Date(connection.token_expires_at).getTime() : null;
  if (tokenExpiresAt && tokenExpiresAt <= now + 45 * 60_000) return "expiring";
  return status === "active" ? "connected" : status || "pending";
}

async function listConnections(auth) {
  const rows = await withTenant(auth.tenantId, auth.userId, async (client) => (await client.query(
    `SELECT id,channel,status,display_name,external_account_id,api_base_url,token_expires_at,refresh_expires_at,last_refresh_at,last_sync_at,last_error,metadata,created_at,updated_at
     FROM volt_price.integration_connections ORDER BY channel,updated_at DESC`,
  )).rows);
  return rows.map((connection) => ({
    ...connection,
    connection_status: connectionStatus(connection),
  }));
}

function selectionError(code, message) {
  return Object.assign(new Error(message), { statusCode: 409, code });
}

function selectConnectionId(connectionId, rows = []) {
  const requested = String(connectionId || "").trim();
  if (requested) return rows.some((row) => String(row.id) === requested) ? requested : null;
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0].id;
  throw selectionError("connection_selection_required", "Selecione a conta vinculada para continuar.");
}

async function getConnection(auth, channel, connectionId = null, { forUpdate = false, client = null } = {}) {
  const run = async (db) => {
    const rows = (await db.query(
      `SELECT * FROM volt_price.integration_connections
       WHERE channel=$1 AND status='active'
       ORDER BY updated_at DESC${forUpdate ? " FOR UPDATE" : ""}`,
      [channel],
    )).rows;
    const id = selectConnectionId(connectionId, rows);
    return rows.find((row) => String(row.id) === String(id)) || null;
  };
  return client ? run(client) : withTenant(auth.tenantId, auth.userId, run);
}

async function getConnectionByExternalAccount(auth, channel, externalAccountId, { forUpdate = false, client = null } = {}) {
  const run = async (db) => {
    const sql = `SELECT * FROM volt_price.integration_connections
      WHERE channel=$1 AND external_account_id=$2 AND status<>'disconnected'
      ORDER BY updated_at DESC LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`;
    return (await db.query(sql, [channel, String(externalAccountId)])).rows[0] || null;
  };
  return client ? run(client) : withTenant(auth.tenantId, auth.userId, run);
}

async function upsertConnection(client, tenantId, channel, data) {
  const tokenCipher = data.accessToken !== undefined ? encrypt(data.accessToken) : null;
  const refreshCipher = data.refreshToken !== undefined ? encrypt(data.refreshToken) : null;
  const result = await client.query(
    `INSERT INTO volt_price.integration_connections
      (tenant_id,channel,status,display_name,external_account_id,api_base_url,token_cipher,refresh_token_cipher,token_expires_at,refresh_expires_at,metadata,last_refresh_at,last_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,NULL)
     ON CONFLICT (tenant_id,channel,external_account_id)
     DO UPDATE SET status=EXCLUDED.status,display_name=EXCLUDED.display_name,api_base_url=EXCLUDED.api_base_url,
       token_cipher=COALESCE(EXCLUDED.token_cipher,volt_price.integration_connections.token_cipher),
       refresh_token_cipher=COALESCE(EXCLUDED.refresh_token_cipher,volt_price.integration_connections.refresh_token_cipher),
       token_expires_at=COALESCE(EXCLUDED.token_expires_at,volt_price.integration_connections.token_expires_at),
       refresh_expires_at=COALESCE(EXCLUDED.refresh_expires_at,volt_price.integration_connections.refresh_expires_at),
       metadata=volt_price.integration_connections.metadata || EXCLUDED.metadata,last_refresh_at=COALESCE(EXCLUDED.last_refresh_at,volt_price.integration_connections.last_refresh_at),last_error=NULL,updated_at=now()
     RETURNING *`,
    [tenantId,channel,data.status||"active",data.displayName||channel,data.externalAccountId||"default",data.apiBaseUrl||null,tokenCipher,refreshCipher,data.tokenExpiresAt||null,data.refreshExpiresAt||null,JSON.stringify(data.metadata||{}),data.lastRefreshAt||null],
  );
  return result.rows[0];
}

function tokenValues(row) {
  if (!row) return null;
  return { accessToken: decrypt(row.token_cipher), refreshToken: decrypt(row.refresh_token_cipher) };
}

async function markConnectionError(auth, id, message) {
  return withTenant(auth.tenantId,auth.userId,(client)=>client.query("UPDATE volt_price.integration_connections SET last_error=$2,updated_at=now() WHERE id=$1",[id,String(message).slice(0,2000)]));
}

module.exports = {
  listConnections,
  getConnection,
  getConnectionByExternalAccount,
  upsertConnection,
  tokenValues,
  markConnectionError,
  connectionStatus,
  selectConnectionId,
};
