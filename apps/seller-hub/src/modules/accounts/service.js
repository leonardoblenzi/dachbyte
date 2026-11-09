// @ts-check
"use strict";

const { randomToken, sha256 } = require("../../platform/crypto");

const STATE_TTL_SECONDS = 600;
/** Link de autorização vale 15 minutos e serve uma vez (mesmo padrão do antigo Price). */
const LINK_TTL_SECONDS = 900;

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
 *   defaultAccountLimit?: number | null,
 *   resources?: { sync: (input: any) => Promise<any>, unlink: (input: any) => Promise<any> } | null,
 * }} deps
 */
function createAccountsService({ repository, connectors, cipher, publicBaseUrl, tokens, defaultAccountLimit = null, resources = null }) {
  /**
   * Limite de contas do plano: o que o hub de acessos informou para a empresa ou o padrão do ambiente.
   * null = sem limite (plano sem a informação, equipe da plataforma ou empresa da lista de reserva).
   * @param {any} identity @returns {number | null}
   */
  const limitFor = (identity) => {
    const value = identity?.accountLimit ?? defaultAccountLimit;
    return value == null || !Number.isFinite(Number(value)) ? null : Math.max(0, Math.trunc(Number(value)));
  };

  /** Contas ativas (todos os marketplaces somados) contra o limite do plano. @param {string} tenantId @param {number | null} limit */
  async function usage(tenantId, limit) {
    const rows = await repository.usage(tenantId);
    const total = rows.reduce((/** @type {number} */ s, /** @type {any} */ r) => s + Number(r.accounts), 0);
    return { total, limit, remaining: limit == null ? null : Math.max(0, limit - total), byChannel: Object.fromEntries(rows.map((/** @type {any} */ r) => [r.channel, Number(r.accounts)])) };
  }

  /** @param {string} tenantId @param {number | null} limit */
  async function assertSlot(tenantId, limit) {
    if (limit == null) return;
    const { total } = await usage(tenantId, limit);
    if (total >= limit) {
      throw fail(`Seu plano permite ${limit} conta(s) e todas já estão em uso. Desconecte uma conta ou fale com a DACHBYTE para ampliar o plano.`, 403, "account_limit_reached");
    }
  }

  /** Registro da conta no hub de acessos (cobrança e painel). Nunca derruba a conexão. @param {"sync" | "unlink"} op @param {any} input */
  async function reportResource(op, input) {
    if (!resources) return;
    try { await resources[op](input); } catch (error) { console.warn(`[seller-hub] recurso ${op} não registrado no hub de acessos:`, /** @type {any} */ (error)?.message); }
  }
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
   * Conta nova precisa de vaga no plano; reconectar uma conta que já é da empresa não gasta vaga.
   * @param {{ identity: any, channel: string, tokens: any, account: { externalAccountId: string, label?: string | null }, limit?: number | null }} input
   */
  async function saveConnection({ identity, channel, tokens, account, limit = limitFor(identity) }) {
    if (limit != null && !(await repository.findActiveByExternal(identity.tenantId, channel, account.externalAccountId))) {
      await assertSlot(identity.tenantId, limit);
    }
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
    await reportResource("sync", { tenantId: identity.tenantId, channel, externalAccountId: account.externalAccountId, label: account.label ?? null });
    return stored;
  }

  /** @param {string} channel @param {"oauth" | "credentials"} auth */
  function connectorFor(channel, auth) {
    const connector = connectors.get(channel);
    if (connectors.definition(channel).auth !== auth) throw fail("Este canal usa outra forma de conexão.", 400, "wrong_connect_method");
    if (!connector.configured) throw fail("Este canal ainda não tem o app do DACH Hub configurado.", 503, "channel_not_configured");
    return connector;
  }

  /** @param {any} link */
  const linkStatus = (link) => !link ? "invalid" : link.cancelledAt ? "cancelled" : link.usedAt ? "used"
    : new Date(link.expiresAt).getTime() <= Date.now() ? "expired" : link.openedAt ? "in_progress" : "ready";

  return {
    redirectUri,
    limitFor,
    usage: (/** @type {any} */ identity) => usage(identity.tenantId, limitFor(identity)),

    /**
     * Gera o state de uso único e devolve a URL de autorização do marketplace.
     * Conta nova precisa de vaga no plano; "Reconectar" (reconnectAccountId da própria empresa) não precisa.
     * @param {{ identity: any, channel: string, reconnectAccountId?: number }} input
     */
    async startConnect({ identity, channel, reconnectAccountId }) {
      const connector = connectorFor(channel, "oauth");
      const reconnecting = reconnectAccountId ? await repository.findTenantAccount(identity.tenantId, reconnectAccountId) : null;
      if (!reconnecting) await assertSlot(identity.tenantId, limitFor(identity));
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
      if (!saved || saved.linkId || saved.tenantId !== identity.tenantId || saved.userId !== identity.userId) {
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
      const account = await repository.findTenantAccount(identity.tenantId, accountId);
      const done = await repository.disconnect(identity.tenantId, accountId);
      if (!done) throw fail("Conta não encontrada nesta empresa.", 404, "account_not_found");
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "account_disconnected", details: { account_id: accountId } });
      if (account) await reportResource("unlink", { tenantId: identity.tenantId, channel: account.channel, externalAccountId: account.externalAccountId });
      return done;
    },

    /** Apelido da conta (ex.: "Loja Matriz"), mostrado em todas as telas. @param {{ identity: any, accountId: number, nickname: unknown }} input */
    async setNickname({ identity, accountId, nickname }) {
      const clean = String(nickname ?? "").trim().replace(/\s+/g, " ").slice(0, 60) || null;
      const done = await repository.setNickname(identity.tenantId, accountId, clean);
      if (!done) throw fail("Conta não encontrada nesta empresa.", 404, "account_not_found");
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "account_nickname", details: { account_id: accountId, nickname: clean } });
      return done;
    },

    /**
     * Link de autorização: para conectar a conta de outra pessoa (sócio, cliente da agência) ou uma segunda conta
     * do mesmo marketplace numa janela anônima. Vale 15 min, uma vez só, e precisa de vaga no plano.
     * @param {{ identity: any, channel: string }} input
     */
    async createLink({ identity, channel }) {
      connectorFor(channel, "oauth");
      const limit = limitFor(identity);
      await assertSlot(identity.tenantId, limit);
      const token = randomToken(32);
      const link = await repository.createLink({ tenantId: identity.tenantId, channel, tokenHash: sha256(token), userId: identity.userId, accountLimit: limit, ttlSeconds: LINK_TTL_SECONDS });
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "authorization_link_created", details: { channel, link_id: link.id } });
      return { id: Number(link.id), channel, expiresAt: link.expiresAt, url: `${publicBaseUrl}/conectar/${token}` };
    },

    /** @param {string} tenantId */
    async listLinks(tenantId) {
      return (await repository.listLinks(tenantId)).map((/** @type {any} */ l) => ({ ...l, status: linkStatus(l) }));
    },

    /** @param {{ identity: any, linkId: number }} input */
    async cancelLink({ identity, linkId }) {
      const done = await repository.cancelLink(identity.tenantId, linkId);
      if (!done) throw fail("Link não encontrado ou já usado.", 404, "link_not_found");
      return done;
    },

    /** Situação do link para a página pública (sem dados da empresa além do canal). @param {string} token */
    async linkInfo(token) {
      const link = await repository.findLink(sha256(String(token || "")));
      return { status: linkStatus(link), channel: link?.channel || null };
    },

    /** Quem abriu o link vai autorizar no marketplace: marca o link como aberto e gera o state. @param {string} token */
    async startLink(token) {
      const link = await repository.findLink(sha256(String(token || "")));
      const status = linkStatus(link);
      if (status !== "ready") throw fail("Este link não está mais disponível. Peça um novo link.", 410, `link_${status}`);
      const connector = connectorFor(link.channel, "oauth");
      if (!(await repository.claimLink(Number(link.id)))) throw fail("Este link já foi aberto. Peça um novo link.", 410, "link_in_progress");
      const state = randomToken(32);
      await repository.saveState({ stateHash: sha256(state), tenantId: link.tenantId, userId: link.createdBy, channel: link.channel, ttlSeconds: STATE_TTL_SECONDS, linkId: Number(link.id) });
      return connector.authorizeUrl({ state, redirectUri: redirectUri(link.channel) });
    },

    /** O retorno do marketplace é de um link de autorização? (não consome o state) @param {string} channel @param {unknown} state */
    async isLinkCallback(channel, state) {
      return Boolean(state) && Boolean(await repository.stateLinkId(sha256(String(state)), channel));
    },

    /**
     * Retorno do marketplace vindo de um link: quem autorizou não tem sessão na DACHBYTE.
     * A conta entra na empresa que gerou o link, com o limite do plano guardado no link.
     * @param {{ channel: string, query: Record<string, any> }} input
     */
    async finishLinkConnect({ channel, query }) {
      if (query.error) throw fail("A autorização foi cancelada no marketplace.", 400, "authorization_denied");
      const state = String(query.state || ""), code = String(query.code || "");
      if (!state || !code) throw fail("Retorno do marketplace incompleto.", 400, "callback_incomplete");
      const saved = await repository.consumeState(sha256(state), channel);
      if (!saved || !saved.linkId) throw fail("Link de conexão inválido ou expirado.", 400, "invalid_state");
      const link = await repository.findLinkById(Number(saved.linkId));
      if (!link || link.usedAt || link.cancelledAt) throw fail("Este link não está mais disponível.", 410, "link_unavailable");
      const { tokens, account } = await connectors.get(channel).exchangeCode({ code, redirectUri: redirectUri(channel), shopId: query.shop_id });
      const who = { tenantId: link.tenantId, userId: link.createdBy };
      const stored = await saveConnection({ identity: who, channel, tokens, account, limit: link.accountLimit == null ? null : Number(link.accountLimit) });
      await repository.completeLink(Number(link.id), Number(stored.id));
      return { account: stored, identity: who };
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
