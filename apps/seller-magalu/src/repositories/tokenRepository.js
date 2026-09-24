"use strict";

const db = require("../config/postgres");
const { encryptSecret, decryptSecret } = require("../services/tokenCipher");

function text(value) {
  return String(value == null ? "" : value).trim();
}

async function saveTokens(client, accountId, tokenSet) {
  const accessToken = text(tokenSet.accessToken);
  const refreshToken = text(tokenSet.refreshToken);
  if (!accessToken || !refreshToken) {
    throw new Error("Conjunto de tokens Magalu incompleto.");
  }

  const { rows } = await client.query(
    `insert into magalu.tokens
       (account_id, access_token_ciphertext, refresh_token_ciphertext,
        access_expires_at, refresh_expires_at, token_type, token_version,
        last_refresh_at, last_refresh_attempt_at, last_refresh_error, updated_at)
     values ($1, $2, $3, $4, $5, $6, 1, $7, $7, null, now())
     on conflict (account_id)
     do update set
       access_token_ciphertext = excluded.access_token_ciphertext,
       refresh_token_ciphertext = excluded.refresh_token_ciphertext,
       access_expires_at = excluded.access_expires_at,
       refresh_expires_at = excluded.refresh_expires_at,
       token_type = excluded.token_type,
       token_version = magalu.tokens.token_version + 1,
       last_refresh_at = excluded.last_refresh_at,
       last_refresh_attempt_at = excluded.last_refresh_attempt_at,
       last_refresh_error = null,
       updated_at = now()
     returning id, account_id, access_expires_at, refresh_expires_at, token_type,
               token_version, last_refresh_at, last_refresh_error, updated_at`,
    [
      Number(accountId),
      encryptSecret(accessToken),
      encryptSecret(refreshToken),
      tokenSet.accessExpiresAt || null,
      tokenSet.refreshExpiresAt || null,
      text(tokenSet.tokenType || "Bearer") || "Bearer",
      tokenSet.refreshedAt || new Date(),
    ],
  );
  return rows[0] || null;
}

async function getTokenRecord(accountId) {
  const row = await db.queryOne(
    `select t.id, t.account_id, t.access_token_ciphertext, t.refresh_token_ciphertext,
            t.access_expires_at, t.refresh_expires_at, t.token_type, t.token_version,
            t.last_refresh_at, t.last_refresh_attempt_at, t.last_refresh_error,
            a.dach_tenant_id, a.magalu_tenant_id, a.status as account_status, a.scopes
       from magalu.tokens t
       join magalu.accounts a on a.id = t.account_id
      where t.account_id = $1
      limit 1`,
    [Number(accountId)],
  );
  if (!row) return null;
  return {
    ...row,
    access_token: decryptSecret(row.access_token_ciphertext),
    refresh_token: decryptSecret(row.refresh_token_ciphertext),
  };
}

async function markRefreshAttempt(accountId) {
  await db.query(
    `update magalu.tokens
        set last_refresh_attempt_at = now(), updated_at = now()
      where account_id = $1`,
    [Number(accountId)],
  );
}

async function markRefreshFailure(accountId, message, { permanent = false } = {}) {
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query(
        `update magalu.tokens
            set last_refresh_error = $2,
                last_refresh_attempt_at = now(),
                updated_at = now()
          where account_id = $1`,
        [Number(accountId), text(message).slice(0, 1000) || "Falha ao renovar token Magalu."],
      );
      if (permanent) {
        await client.query(
          `update magalu.accounts
              set status = 'error', updated_at = now()
            where id = $1`,
          [Number(accountId)],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function findAccountsNeedingRefresh({ before, limit = 100 } = {}) {
  const cutoff = before instanceof Date ? before : new Date(Date.now() + 15 * 60 * 1000);
  const { rows } = await db.query(
    `select t.account_id
       from magalu.tokens t
       join magalu.accounts a on a.id = t.account_id
      where a.status = 'active'
        and t.refresh_token_ciphertext is not null
        and t.access_expires_at is not null
        and t.access_expires_at <= $1
        and (t.refresh_expires_at is null or t.refresh_expires_at > now())
        and (t.last_refresh_attempt_at is null or t.last_refresh_attempt_at < now() - interval '2 minutes')
      order by t.access_expires_at asc
      limit $2`,
    [cutoff, Math.max(1, Math.min(500, Number(limit) || 100))],
  );
  return rows.map((row) => Number(row.account_id)).filter(Number.isFinite);
}

module.exports = {
  saveTokens,
  getTokenRecord,
  markRefreshAttempt,
  markRefreshFailure,
  findAccountsNeedingRefresh,
};
