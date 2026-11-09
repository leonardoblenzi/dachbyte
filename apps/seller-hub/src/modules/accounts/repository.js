// @ts-check
"use strict";

/**
 * Contas conectadas, tokens cifrados e states OAuth (schema hub).
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any>, queryOne: (sql: string, params?: unknown[]) => Promise<any>, transaction: (work: (client: any) => Promise<any>) => Promise<any> }} db
 */
function createAccountsRepository(db) {
  return {
    /** @param {{ stateHash: string, tenantId: string, userId: string, channel: string, ttlSeconds: number, linkId?: number | null }} input */
    async saveState({ stateHash, tenantId, userId, channel, ttlSeconds, linkId = null }) {
      await db.query(
        `insert into hub.oauth_states (state_hash, tenant_id, user_id, channel, expires_at, link_id)
         values ($1, $2, $3, $4, now() + ($5::int * interval '1 second'), $6)`,
        [stateHash, tenantId, userId, channel, ttlSeconds, linkId]);
    },

    /** O state é de um link de autorização? (sem consumir) @param {string} stateHash @param {string} channel */
    async stateLinkId(stateHash, channel) {
      const row = await db.queryOne(
        `select link_id as "linkId" from hub.oauth_states where state_hash = $1 and channel = $2 and used_at is null and expires_at > now()`,
        [stateHash, channel]);
      return row?.linkId ? Number(row.linkId) : null;
    },

    /** Contas ativas da empresa por canal (desconectada não conta no limite do plano). @param {string} tenantId */
    async usage(tenantId) {
      const { rows } = await db.query(
        `select channel, count(*)::int as accounts from hub.channel_accounts
          where tenant_id = $1 and status <> 'disconnected' group by channel order by channel`, [tenantId]);
      return rows;
    },

    /** Conta ativa desta empresa com o id do marketplace (reconectar não gasta vaga). @param {string} tenantId @param {string} channel @param {string} externalAccountId */
    async findActiveByExternal(tenantId, channel, externalAccountId) {
      return db.queryOne(
        `select id from hub.channel_accounts where tenant_id = $1 and channel = $2 and external_account_id = $3 and status <> 'disconnected'`,
        [tenantId, channel, String(externalAccountId)]);
    },

    /** @param {string} tenantId @param {number} accountId @param {string | null} nickname */
    async setNickname(tenantId, accountId, nickname) {
      return db.queryOne(
        `update hub.channel_accounts set nickname = $3, updated_at = now()
          where id = $2 and tenant_id = $1 and status <> 'disconnected' returning id, nickname`, [tenantId, accountId, nickname]);
    },

    /** @param {{ tenantId: string, channel: string, tokenHash: string, userId: string, accountLimit: number | null, ttlSeconds: number }} input */
    async createLink({ tenantId, channel, tokenHash, userId, accountLimit, ttlSeconds }) {
      return db.queryOne(
        `insert into hub.authorization_links (tenant_id, channel, token_hash, created_by, account_limit, expires_at)
         values ($1, $2, $3, $4, $5, now() + ($6::int * interval '1 second'))
         returning id, channel, expires_at as "expiresAt"`,
        [tenantId, channel, tokenHash, userId, accountLimit, ttlSeconds]);
    },

    /** @param {string} tokenHash */
    async findLink(tokenHash) {
      return db.queryOne(
        `select id, tenant_id as "tenantId", channel, created_by as "createdBy", account_limit as "accountLimit",
                expires_at as "expiresAt", opened_at as "openedAt", used_at as "usedAt", cancelled_at as "cancelledAt"
           from hub.authorization_links where token_hash = $1`, [tokenHash]);
    },

    /** @param {number} id */
    async findLinkById(id) {
      return db.queryOne(
        `select id, tenant_id as "tenantId", channel, created_by as "createdBy", account_limit as "accountLimit",
                expires_at as "expiresAt", opened_at as "openedAt", used_at as "usedAt", cancelled_at as "cancelledAt"
           from hub.authorization_links where id = $1`, [id]);
    },

    /** Marca o link como aberto (uma vez só, dentro da validade). @param {number} id */
    async claimLink(id) {
      return db.queryOne(
        `update hub.authorization_links set opened_at = now()
          where id = $1 and opened_at is null and used_at is null and cancelled_at is null and expires_at > now() returning id`, [id]);
    },

    /** @param {number} id @param {number} accountId */
    async completeLink(id, accountId) {
      return db.queryOne(
        `update hub.authorization_links set used_at = now(), channel_account_id = $2
          where id = $1 and used_at is null and cancelled_at is null returning id`, [id, accountId]);
    },

    /** Links dos últimos 7 dias. @param {string} tenantId */
    async listLinks(tenantId) {
      const { rows } = await db.query(
        `select l.id, l.channel, l.created_by as "createdBy", l.expires_at as "expiresAt", l.opened_at as "openedAt",
                l.used_at as "usedAt", l.cancelled_at as "cancelledAt", l.created_at as "createdAt",
                coalesce(a.nickname, a.label, a.external_account_id) as account
           from hub.authorization_links l left join hub.channel_accounts a on a.id = l.channel_account_id
          where l.tenant_id = $1 and l.created_at > now() - interval '7 days'
          order by l.created_at desc limit 20`, [tenantId]);
      return rows;
    },

    /** @param {string} tenantId @param {number} id */
    async cancelLink(tenantId, id) {
      return db.queryOne(
        `update hub.authorization_links set cancelled_at = now()
          where id = $2 and tenant_id = $1 and used_at is null and cancelled_at is null returning id`, [tenantId, id]);
    },

    /** Consome o state uma única vez, dentro da validade. @param {string} stateHash @param {string} channel */
    async consumeState(stateHash, channel) {
      return db.queryOne(
        `update hub.oauth_states set used_at = now()
          where state_hash = $1 and channel = $2 and used_at is null and expires_at > now()
          returning tenant_id as "tenantId", user_id as "userId", channel, link_id as "linkId"`,
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
        `select a.id, a.channel, a.external_account_id as "externalAccountId", a.label, a.nickname, a.status,
                a.stock_sync_mode as "stockSyncMode", a.connected_at as "connectedAt", a.last_import_at as "lastImportAt",
                t.expires_at as "tokenExpiresAt", a.webhooks_subscribed_at as "webhooksAt", a.webhooks_error as "webhooksError",
                (select count(*)::int from hub.listings l where l.channel_account_id = a.id) as listings,
                case when r.id is null then null else jsonb_build_object(
                  'id', r.id, 'status', r.status, 'trigger', r.trigger, 'pages', r.pages, 'listingsSeen', r.listings_seen,
                  'linkedAuto', r.linked_auto, 'unlinked', r.unlinked, 'error', r.error_message,
                  'createdAt', r.created_at, 'startedAt', r.started_at, 'finishedAt', r.finished_at) end as "lastImport"
           from hub.channel_accounts a
           left join hub.channel_tokens t on t.channel_account_id = a.id
           left join lateral (select * from hub.import_runs x where x.channel_account_id = a.id order by x.id desc limit 1) r on true
          where a.tenant_id = $1 and a.status <> 'disconnected'
          order by a.channel, coalesce(a.nickname, a.label)`, [tenantId]);
      return rows;
    },

    /** Desconecta: apaga os tokens e marca a conta. @param {string} tenantId @param {number} accountId */
    async disconnect(tenantId, accountId) {
      return db.transaction(async (client) => {
        const { rows } = await client.query(
          `update hub.channel_accounts set status = 'disconnected', stock_sync_mode = 'off',
                  webhook_secrets_enc = null, webhooks_subscribed_at = null, webhooks_error = null, updated_at = now()
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

    /**
     * Resultado da assinatura de avisos: segredos cifrados (sucesso) ou o erro (mantém os segredos anteriores).
     * @param {number} accountId @param {{ secretsEnc: string | null, error: string | null }} input
     */
    async saveWebhookSubscription(accountId, { secretsEnc, error }) {
      await db.query(
        `update hub.channel_accounts set
            webhook_secrets_enc = coalesce($2::text, webhook_secrets_enc),
            webhooks_subscribed_at = case when $2::text is null then webhooks_subscribed_at else now() end,
            webhooks_error = $3, updated_at = now()
          where id = $1`, [accountId, secretsEnc, error]);
    },

    /** Segredos cifrados dos avisos da conta (só contas ativas). @param {string} channel @param {string} externalAccountId */
    async webhookSecrets(channel, externalAccountId) {
      const row = await db.queryOne(
        `select webhook_secrets_enc as "secretsEnc" from hub.channel_accounts
          where channel = $1 and external_account_id = $2 and status <> 'disconnected'`, [channel, String(externalAccountId)]);
      return row?.secretsEnc || null;
    },

    /** @param {string} tenantId @param {number} accountId */
    async findTenantAccount(tenantId, accountId) {
      return db.queryOne(
        `select id, tenant_id as "tenantId", channel, external_account_id as "externalAccountId", status
           from hub.channel_accounts where id = $1 and tenant_id = $2 and status <> 'disconnected'`, [accountId, tenantId]);
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
