// @ts-check
"use strict";

/**
 * Contas conectadas, tokens cifrados e states OAuth (schema hub).
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any>, queryOne: (sql: string, params?: unknown[]) => Promise<any>, transaction: (work: (client: any) => Promise<any>) => Promise<any> }} db
 */
function createAccountsRepository(db) {
  return {
    /** @param {{ stateHash: string, tenantId: string, userId: string, channel: string, ttlSeconds: number }} input */
    async saveState({ stateHash, tenantId, userId, channel, ttlSeconds }) {
      await db.query(
        `insert into hub.oauth_states (state_hash, tenant_id, user_id, channel, expires_at)
         values ($1, $2, $3, $4, now() + ($5::int * interval '1 second'))`,
        [stateHash, tenantId, userId, channel, ttlSeconds]);
    },

    /** Consome o state uma única vez, dentro da validade. @param {string} stateHash @param {string} channel */
    async consumeState(stateHash, channel) {
      return db.queryOne(
        `update hub.oauth_states set used_at = now()
          where state_hash = $1 and channel = $2 and used_at is null and expires_at > now()
          returning tenant_id as "tenantId", user_id as "userId", channel`,
        [stateHash, channel]);
    },

    /**
     * Cria ou atualiza a conta. Se a conta do marketplace já pertence a outra
     * empresa, nada é alterado e o retorno é null (posse protegida).
     * @param {{ tenantId: string, channel: string, externalAccountId: string, label: string | null, userId: string }} input
     */
    async upsertAccount({ tenantId, channel, externalAccountId, label, userId }) {
      return db.queryOne(
        `insert into hub.channel_accounts (tenant_id, channel, external_account_id, label, connected_by)
         values ($1, $2, $3, $4, $5)
         on conflict (channel, external_account_id) do update set
           label = coalesce(excluded.label, hub.channel_accounts.label), status = 'connected',
           connected_by = excluded.connected_by, connected_at = now(), updated_at = now()
         where hub.channel_accounts.tenant_id = excluded.tenant_id
         returning id, tenant_id as "tenantId", channel, external_account_id as "externalAccountId", label, status`,
        [tenantId, channel, externalAccountId, label, userId]);
    },

    /** @param {number} accountId @param {{ accessTokenEnc: string, refreshTokenEnc: string | null, expiresAt: Date | null, scopes: string[] }} tokens @param {any} [client] */
    async saveTokens(accountId, tokens, client) {
      const runner = client || db;
      await runner.query(
        `insert into hub.channel_tokens (channel_account_id, access_token_enc, refresh_token_enc, expires_at, scopes, refresh_failures, updated_at)
         values ($1, $2, $3, $4, $5, 0, now())
         on conflict (channel_account_id) do update set
           access_token_enc = excluded.access_token_enc,
           refresh_token_enc = coalesce(excluded.refresh_token_enc, hub.channel_tokens.refresh_token_enc),
           expires_at = excluded.expires_at, scopes = excluded.scopes, refresh_failures = 0, updated_at = now()`,
        [accountId, tokens.accessTokenEnc, tokens.refreshTokenEnc, tokens.expiresAt, tokens.scopes]);
    },

    /** @param {string} tenantId */
    async listAccounts(tenantId) {
      const { rows } = await db.query(
        `select a.id, a.channel, a.external_account_id as "externalAccountId", a.label, a.status,
                a.stock_sync_mode as "stockSyncMode", a.connected_at as "connectedAt", a.last_import_at as "lastImportAt",
                t.expires_at as "tokenExpiresAt",
                (select count(*)::int from hub.listings l where l.channel_account_id = a.id) as listings
           from hub.channel_accounts a
           left join hub.channel_tokens t on t.channel_account_id = a.id
          where a.tenant_id = $1 and a.status <> 'disconnected'
          order by a.channel, a.label`, [tenantId]);
      return rows;
    },

    /** Desconecta: apaga os tokens e marca a conta. @param {string} tenantId @param {number} accountId */
    async disconnect(tenantId, accountId) {
      return db.transaction(async (client) => {
        const { rows } = await client.query(
          `update hub.channel_accounts set status = 'disconnected', stock_sync_mode = 'off', updated_at = now()
            where id = $1 and tenant_id = $2 returning id`, [accountId, tenantId]);
        if (!rows[0]) return null;
        await client.query("delete from hub.channel_tokens where channel_account_id = $1", [accountId]);
        return rows[0];
      });
    },

    /**
     * Executa `work` com a trava da conta (advisory lock na transação) e os
     * tokens relidos sob a trava — o refresh do ML é de uso único.
     * @template T @param {number} accountId @param {(ctx: { client: any, row: any }) => Promise<T>} work @returns {Promise<T>}
     */
    async withTokenLock(accountId, work) {
      return db.transaction(async (client) => {
        await client.query("select pg_advisory_xact_lock(hashtext('hub-token:' || $1::text))", [accountId]);
        const { rows } = await client.query(
          `select a.id, a.channel, a.external_account_id as "externalAccountId", a.status,
                  t.access_token_enc as "accessTokenEnc", t.refresh_token_enc as "refreshTokenEnc", t.expires_at as "expiresAt"
             from hub.channel_accounts a join hub.channel_tokens t on t.channel_account_id = a.id
            where a.id = $1 for update of t`, [accountId]);
        return work({ client, row: rows[0] || null });
      });
    },

    /** @param {number} accountId @param {any} [client] */
    async markReconnectRequired(accountId, client) {
      const runner = client || db;
      await runner.query(
        `update hub.channel_accounts set status = 'reconnect_required', updated_at = now() where id = $1`, [accountId]);
      await runner.query(
        `update hub.channel_tokens set refresh_failures = refresh_failures + 1, updated_at = now() where channel_account_id = $1`, [accountId]);
    },

    /** @param {{ tenantId: string, userId: string | null, action: string, details: Record<string, any> }} event */
    async audit(event) {
      await db.query("insert into hub.audit_events (tenant_id, user_id, action, details) values ($1, $2, $3, $4)",
        [event.tenantId, event.userId, event.action, JSON.stringify(event.details || {})]);
    },
  };
}

module.exports = { createAccountsRepository };
