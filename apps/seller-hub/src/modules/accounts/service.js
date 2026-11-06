// @ts-check
"use strict";

const { randomToken, sha256 } = require("../../platform/crypto");

const STATE_TTL_SECONDS = 600;

/** @param {string} message @param {number} status @param {string} code */
function fail(message, status, code) { return Object.assign(new Error(message), { status, code }); }

/**
 * Conectar e desconectar contas dos canais (marketplaces e lojas virtuais).
 * OAuth com apps próprios do Hub ou, em lojas virtuais, credenciais informadas num formulário.
 * @param {{
 *   repository: ReturnType<typeof import("./repository").createAccountsRepository>,
 *   connectors: ReturnType<typeof import("../../connectors/registry").createConnectors>,
 *   cipher: ReturnType<typeof import("../../platform/crypto").createCipher>,
 *   publicBaseUrl: string,
 *   tokens?: { getAccessToken: (accountId: number) => Promise<{ accessToken: string, externalAccountId: string }> },
 * }} deps
 */
function createAccountsService({ repository, connectors, cipher, publicBaseUrl, tokens }) {
  /** @param {string} channel */
  const redirectUri = (channel) => `${publicBaseUrl}/auth/${channel}/callback`;
  /** @param {string} channel */
  const webhookUrl = (channel) => `${publicBaseUrl}/webhooks/${channel}`;
  /** @param {string} channel */
  const subscribes = (channel) => typeof (/** @type {any} */ (connectors.get(channel))?.subscribeWebhooks) === "function";

  /**
   * Assina os avisos da conta nos canais em que cada seller assina com o próprio token (Magalu).
   * Nunca derruba a conexão: o erro fica na conta e a leitura periódica de pedidos continua cobrindo.
   * @param {{ id: number, channel: string, externalAccountId: string }} account @param {string} accessToken
   * @returns {Promise<{ ok: boolean, error?: string } | null>}
   */
  async function subscribeWebhooks(account, accessToken) {
    if (!subscribes(account.channel)) return null;
    try {
      const { secrets } = await /** @type {any} */ (connectors.get(account.channel)).subscribeWebhooks(
        { id: Number(account.id), accessToken, externalAccountId: account.externalAccountId }, { url: webhookUrl(account.channel) });
      await repository.saveWebhookSubscription(Number(account.id), { secretsEnc: cipher.encrypt(JSON.stringify(secrets)), error: null });
      return { ok: true };
    } catch (error) {
      const message = String(/** @type {any} */ (error)?.message || error || "erro").slice(0, 300);
      await repository.saveWebhookSubscription(Number(account.id), { secretsEnc: null, error: message });
      return { ok: false, error: message };
    }
  }

  /**
   * Grava a conta conectada (posse protegida) e os tokens cifrados. Igual para OAuth e formulário.
   * @param {{ identity: any, channel: string, tokens: any, account: { externalAccountId: string, label?: string | null } }} input
   */
  async function saveConnection({ identity, channel, tokens, account }) {
    const stored = await repository.upsertAccount({
      tenantId: identity.tenantId, channel, externalAccountId: account.externalAccountId, label: account.label ?? null, userId: identity.userId,
    });
    if (!stored) throw fail("Esta conta já está conectada a outra empresa no DACH Hub.", 409, "account_owned_by_other_tenant");
    await repository.saveTokens(stored.id, {
      accessTokenEnc: cipher.encrypt(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? cipher.encrypt(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt ?? null,
      scopes: tokens.scopes || [],
    });
    await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "account_connected", details: { channel, account_id: stored.id, external_account_id: account.externalAccountId } });
    await subscribeWebhooks({ id: Number(stored.id), channel, externalAccountId: account.externalAccountId }, tokens.accessToken);
    return stored;
  }

  /** @param {string} channel @param {"oauth" | "credentials"} auth */
  function connectorFor(channel, auth) {
    const connector = connectors.get(channel);
    if (connectors.definition(channel).auth !== auth) throw fail("Este canal usa outra forma de conexão.", 400, "wrong_connect_method");
    if (!connector.configured) throw fail("Este canal ainda não tem o app do DACH Hub configurado.", 503, "channel_not_configured");
    return connector;
  }

  return {
    redirectUri,

    /** Gera o state de uso único e devolve a URL de autorização do marketplace. @param {{ identity: any, channel: string }} input */
    async startConnect({ identity, channel }) {
      const connector = connectorFor(channel, "oauth");
      const state = randomToken(32);
      await repository.saveState({ stateHash: sha256(state), tenantId: identity.tenantId, userId: identity.userId, channel, ttlSeconds: STATE_TTL_SECONDS });
      return connector.authorizeUrl({ state, redirectUri: redirectUri(channel) });
    },

    /**
     * Retorno do marketplace: valida o state, troca o código por tokens, protege a
     * posse da conta e grava os tokens cifrados.
     * @param {{ identity: any, channel: string, query: Record<string, any> }} input
     */
    async finishConnect({ identity, channel, query }) {
      const connector = connectors.get(channel);
      if (query.error) throw fail("A autorização foi cancelada no marketplace.", 400, "authorization_denied");
      const state = String(query.state || "");
      const code = String(query.code || "");
      if (!state || !code) throw fail("Retorno do marketplace incompleto. Tente conectar de novo.", 400, "callback_incomplete");
      const saved = await repository.consumeState(sha256(state), channel);
      if (!saved || saved.tenantId !== identity.tenantId || saved.userId !== identity.userId) {
        throw fail("Link de conexão inválido ou expirado. Tente conectar de novo.", 400, "invalid_state");
      }
      const { tokens, account } = await connector.exchangeCode({ code, redirectUri: redirectUri(channel), shopId: query.shop_id });
      return saveConnection({ identity, channel, tokens, account });
    },

    /**
     * Loja virtual conectada por formulário: só os campos declarados no canal são repassados
     * ao conector, que valida as credenciais na própria loja antes de gravar.
     * @param {{ identity: any, channel: string, fields: Record<string, any> }} input
     */
    async connectWithCredentials({ identity, channel, fields }) {
      const connector = connectorFor(channel, "credentials");
      /** @type {Record<string, string>} */
      const clean = {};
      for (const field of connectors.definition(channel).credentialFields || []) {
        const value = String(fields?.[field.name] ?? "").trim();
        if (!value) throw fail(`Preencha o campo ${field.label}.`, 400, "missing_field");
        clean[field.name] = value;
      }
      const { tokens, account } = await connector.connectWithCredentials(clean);
      return saveConnection({ identity, channel, tokens, account });
    },

    /** Contas da empresa; `webhooks` só aparece nos canais com aviso assinado por conta. @param {string} tenantId */
    async listAccounts(tenantId) {
      const rows = await repository.listAccounts(tenantId);
      return rows.map((/** @type {any} */ { webhooksAt, webhooksError, ...row }) => ({
        ...row, webhooks: connectors.has(row.channel) && subscribes(row.channel) ? { subscribedAt: webhooksAt || null, error: webhooksError || null } : null,
      }));
    },

    /** Assina de novo os avisos da conta (botão em Contas conectadas). @param {{ identity: any, accountId: number }} input */
    async resubscribeWebhooks({ identity, accountId }) {
      const account = await repository.findTenantAccount(identity.tenantId, accountId);
      if (!account) throw fail("Conta não encontrada nesta empresa.", 404, "account_not_found");
      if (!subscribes(account.channel)) throw fail("Este canal não usa assinatura de avisos por conta.", 400, "webhooks_not_supported");
      if (!tokens) throw fail("Gerenciador de tokens indisponível.", 503, "tokens_unavailable");
      const { accessToken } = await tokens.getAccessToken(Number(account.id));
      const result = await subscribeWebhooks(account, accessToken);
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "webhooks_subscribed", details: { account_id: accountId, ok: Boolean(result?.ok) } });
      if (!result?.ok) throw fail(`Não foi possível assinar os avisos: ${result?.error || "erro"}`, 502, "webhooks_subscribe_failed");
      return result;
    },

    /**
     * Segredos dos avisos da conta, para conferir a assinatura do aviso recebido.
     * @param {string} channel @param {string} externalAccountId @returns {Promise<string[]>}
     */
    async webhookSecrets(channel, externalAccountId) {
      const sealed = await repository.webhookSecrets(channel, externalAccountId);
      if (!sealed) return [];
      try {
        const list = JSON.parse(cipher.decrypt(sealed));
        return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
      } catch (_error) { return []; }
    },

    /** @param {{ identity: any, accountId: number }} input */
    async disconnect({ identity, accountId }) {
      const done = await repository.disconnect(identity.tenantId, accountId);
      if (!done) throw fail("Conta não encontrada nesta empresa.", 404, "account_not_found");
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "account_disconnected", details: { account_id: accountId } });
      return done;
    },
  };
}

/**
 * Entrega um access token válido, renovando quando faltar pouco para expirar.
 * A renovação acontece sob trava por conta e com o token relido do banco,
 * porque o refresh do Mercado Livre é de uso único.
 */
class TokenManager {
  /**
   * @param {{ repository: ReturnType<typeof import("./repository").createAccountsRepository>,
   *           connectors: ReturnType<typeof import("../../connectors/registry").createConnectors>,
   *           cipher: ReturnType<typeof import("../../platform/crypto").createCipher>, skewMs?: number }} deps
   */
  constructor({ repository, connectors, cipher, skewMs = 5 * 60 * 1000 }) {
    this.repository = repository;
    this.connectors = connectors;
    this.cipher = cipher;
    this.skewMs = skewMs;
  }

  /** @param {number} accountId @returns {Promise<{ accessToken: string, externalAccountId: string, channel: string }>} */
  async getAccessToken(accountId) {
    const reconnect = () => fail("A conexão desta conta expirou. Reconecte a conta.", 409, "reconnect_required");
    // Erros "esperados" voltam como resultado e só são lançados depois do commit,
    // para a marcação de "reconectar" não ser desfeita pelo rollback.
    const result = await this.repository.withTokenLock(accountId, async ({ client, row }) => {
      if (!row) return { error: fail("Conta sem conexão ativa.", 404, "account_not_connected") };
      if (row.status === "reconnect_required") return { error: reconnect() };
      const expiresAt = row.expiresAt ? new Date(row.expiresAt).getTime() : null;
      if (expiresAt == null || expiresAt - Date.now() > this.skewMs) {
        return { value: { accessToken: this.cipher.decrypt(row.accessTokenEnc), externalAccountId: row.externalAccountId, channel: row.channel } };
      }
      if (!row.refreshTokenEnc) {
        await this.repository.markReconnectRequired(accountId, client);
        return { error: reconnect() };
      }
      let tokens;
      try {
        tokens = await this.connectors.get(row.channel).refresh({ refreshToken: this.cipher.decrypt(row.refreshTokenEnc), externalAccountId: row.externalAccountId });
      } catch (error) {
        const status = Number(/** @type {any} */ (error)?.status);
        if (status === 400 || status === 401 || /invalid_grant/i.test(String(/** @type {any} */ (error)?.code || ""))) {
          await this.repository.markReconnectRequired(accountId, client);
          return { error: reconnect() };
        }
        throw error;
      }
      await this.repository.saveTokens(accountId, {
        accessTokenEnc: this.cipher.encrypt(tokens.accessToken),
        refreshTokenEnc: tokens.refreshToken ? this.cipher.encrypt(tokens.refreshToken) : null,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
      }, client);
      return { value: { accessToken: tokens.accessToken, externalAccountId: row.externalAccountId, channel: row.channel } };
    });
    if (result.error) throw result.error;
    return result.value;
  }
}

module.exports = { createAccountsService, TokenManager, STATE_TTL_SECONDS };
