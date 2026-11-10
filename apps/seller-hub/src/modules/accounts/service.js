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
 *   brokers?: Record<string, ReturnType<typeof import("../../platform/dachbyteConnections").createDachbyteConnections>>,
 * }} deps
 */
function createAccountsService({ repository, connectors, cipher, publicBaseUrl, tokens, defaultAccountLimit = null, resources = null, brokers = {} }) {
  /** Canal conectado pela conexão única da DACHBYTE (módulo do canal é o dono das chaves)? @param {string} channel */
  const brokerFor = (channel) => (brokers[channel]?.configured ? brokers[channel] : null);
  const publicOrigin = (() => { try { return new URL(publicBaseUrl).origin; } catch (_error) { return ""; } })();
  /** Caminho do Hub para onde a autorização volta (o módulo só aceita caminhos /hub/...). @param {string} suffix */
  const hubPath = (suffix) => `${new URL(publicBaseUrl).pathname.replace(/\/+$/, "")}${suffix}`;

  /**
   * Espelha no Hub uma conta da conexão DACHBYTE (sem chaves). Conta de outra empresa no Hub: ignora.
   * @param {{ tenantId: string, userId: string | null }} who @param {string} channel @param {any} remote
   */
  async function mirrorBrokered(who, channel, remote) {
    const stored = await repository.upsertAccount({
      tenantId: who.tenantId, channel, externalAccountId: String(remote.meli_user_id), label: remote.label || null,
      userId: who.userId || "dachbyte", connectionSource: "dachbyte", status: remote.connection === "ok" ? "connected" : "reconnect_required",
    });
    if (!stored) { console.warn("[seller-hub] conta da DACHBYTE pertence a outra empresa no Hub", channel, remote.meli_user_id); return null; }
    if (stored.created) {
      await repository.audit({ tenantId: who.tenantId, userId: who.userId, action: "account_connected", details: { channel, account_id: stored.id, external_account_id: String(remote.meli_user_id), source: "dachbyte" } });
      await reportResource("sync", { tenantId: who.tenantId, channel, externalAccountId: String(remote.meli_user_id), label: remote.label || null });
    }
    return stored;
  }
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
    brokerFor,

    /** Canais para a tela: canal da conexão DACHBYTE fica disponível mesmo sem app próprio do Hub. */
    channels() {
      return connectors.list().map((c) => (brokerFor(c.id) ? { ...c, available: true, connection: "dachbyte" } : { ...c, connection: "own" }));
    },

    /**
     * Traz para o Hub as contas que a empresa ativou no Hub pela conexão DACHBYTE (ex.: acabou de
     * autorizar no Mercado Livre) e lista as que estão conectadas na DACHBYTE mas não no Hub.
     * @param {any} identity
     * @returns {Promise<{ added: any[], available: Array<{ channel: string, externalAccountId: string, label: string, connection: string }> }>}
     */
    async syncDachbyte(identity) {
      /** @type {any[]} */
      const added = [];
      /** @type {Array<{ channel: string, externalAccountId: string, label: string, connection: string }>} */
      const available = [];
      for (const channel of Object.keys(brokers)) {
        const broker = brokerFor(channel);
        if (!broker) continue;
        const remote = await broker.listAccounts(identity.tenantId);
        const local = new Map((await repository.channelAccounts(identity.tenantId, channel)).map((/** @type {any} */ a) => [String(a.externalAccountId), a]));
        for (const account of remote) {
          const id = String(account.meli_user_id);
          const mine = local.get(id);
          if (Array.isArray(account.products) && account.products.includes("dach_hub")) {
            // Desconectada no Hub fica desconectada (a desativação no módulo pode ter falhado antes).
            if (mine?.status === "disconnected") continue;
            const wantStatus = account.connection === "ok" ? "connected" : "reconnect_required";
            if (!mine || mine.connectionSource !== "dachbyte") {
              const stored = await mirrorBrokered(identity, channel, account);
              if (stored?.created) added.push(stored);
            } else if (mine.status !== wantStatus) {
              await repository.setStatus(Number(mine.id), wantStatus);
            }
          } else if (!mine || mine.status === "disconnected") {
            available.push({ channel, externalAccountId: id, label: account.label || `Conta ${id}`, connection: account.connection });
          }
        }
      }
      return { added, available };
    },

    /**
     * Usa no Hub uma conta já conectada na DACHBYTE (ex.: conta do módulo ML). Não pede nova
     * autorização ao marketplace; precisa de vaga no plano do Hub.
     * @param {{ identity: any, channel: string, externalAccountId: string }} input
     */
    async importAccount({ identity, channel, externalAccountId }) {
      const broker = brokerFor(channel);
      if (!broker) throw fail("Este canal não usa a conexão da DACHBYTE.", 400, "not_dachbyte_channel");
      const id = String(externalAccountId || "").trim();
      if (!/^\d{1,20}$/.test(id)) throw fail("Conta inválida.", 400, "invalid_account");
      if (!(await repository.findActiveByExternal(identity.tenantId, channel, id))) await assertSlot(identity.tenantId, limitFor(identity));
      const remote = await broker.activate({ tenantId: identity.tenantId, externalAccountId: id, actor: `hub_user:${identity.userId}` });
      const stored = await mirrorBrokered(identity, channel, remote || { meli_user_id: id, connection: "ok" });
      if (!stored) throw fail("Esta conta já está conectada a outra empresa no DACH Hub.", 409, "account_owned_by_other_tenant");
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "account_imported", details: { channel, account_id: stored.id, external_account_id: id } });
      return stored;
    },
    usage: (/** @type {any} */ identity) => usage(identity.tenantId, limitFor(identity)),

    /**
     * Gera o state de uso único e devolve a URL de autorização do marketplace.
     * Conta nova precisa de vaga no plano; "Reconectar" (reconnectAccountId da própria empresa) não precisa.
     * @param {{ identity: any, channel: string, reconnectAccountId?: number }} input
     */
    async startConnect({ identity, channel, reconnectAccountId }) {
      const reconnecting = reconnectAccountId ? await repository.findTenantAccount(identity.tenantId, reconnectAccountId) : null;
      const broker = brokerFor(channel);
      if (broker) {
        // Conexão única: autoriza no app da DACHBYTE pelo módulo do canal; volta para Contas conectadas.
        if (!reconnecting) await assertSlot(identity.tenantId, limitFor(identity));
        return broker.authorize({ tenantId: identity.tenantId, userId: identity.userId, companyName: identity.companyName || null, returnTo: hubPath("/contas"), publicOrigin });
      }
      const connector = connectorFor(channel, "oauth");
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
      // Conexão DACHBYTE: tira a conta do Hub no módulo dono (a conexão continua para os outros produtos).
      if (account?.connectionSource === "dachbyte") {
        const broker = brokerFor(account.channel);
        if (!broker) throw fail("Conexão da DACHBYTE indisponível no momento. Tente de novo.", 503, "connections_unavailable");
        await broker.deactivate({ tenantId: identity.tenantId, externalAccountId: account.externalAccountId });
      }
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
      if (!brokerFor(channel)) connectorFor(channel, "oauth");
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
      const broker = brokerFor(link.channel);
      const connector = broker ? null : connectorFor(link.channel, "oauth");
      if (!(await repository.claimLink(Number(link.id)))) throw fail("Este link já foi aberto. Peça um novo link.", 410, "link_in_progress");
      if (broker || !connector) {
        // Conexão única: o retorno passa pelo módulo do canal e volta para a página pública do link.
        return /** @type {any} */ (broker).authorize({ tenantId: link.tenantId, userId: link.createdBy, companyName: null, returnTo: hubPath(`/conectar/${String(token)}/concluido`), publicOrigin });
      }
      const state = randomToken(32);
      await repository.saveState({ stateHash: sha256(state), tenantId: link.tenantId, userId: link.createdBy, channel: link.channel, ttlSeconds: STATE_TTL_SECONDS, linkId: Number(link.id) });
      return connector.authorizeUrl({ state, redirectUri: redirectUri(link.channel) });
    },

    /**
     * Link concluído pela conexão DACHBYTE: o módulo já guardou a conta; ativa no Hub, para a empresa do link.
     * Só vale para link aberto e ainda não usado; a conta precisa estar na DACHBYTE dessa empresa, ativa no Hub.
     * @param {{ token: string, externalAccountId: string }} input
     */
    async finishBrokeredLink({ token, externalAccountId }) {
      const link = await repository.findLink(sha256(String(token || "")));
      if (!link || linkStatus(link) !== "in_progress") throw fail("Este link não está mais disponível.", 410, "link_unavailable");
      const broker = brokerFor(link.channel);
      if (!broker) throw fail("Este link não está mais disponível.", 410, "link_unavailable");
      const id = String(externalAccountId || "");
      const remote = (await broker.listAccounts(link.tenantId)).find((a) => String(a.meli_user_id) === id && Array.isArray(a.products) && a.products.includes("dach_hub"));
      if (!remote) throw fail("A autorização não foi concluída no marketplace. Peça um novo link.", 400, "authorization_incomplete");
      const who = { tenantId: link.tenantId, userId: link.createdBy };
      const limit = link.accountLimit == null ? null : Number(link.accountLimit);
      if (limit != null && !(await repository.findActiveByExternal(link.tenantId, link.channel, id))) await assertSlot(link.tenantId, limit);
      const stored = await mirrorBrokered(who, link.channel, remote);
      if (!stored) throw fail("Esta conta já está conectada a outra empresa no DACH Hub.", 409, "account_owned_by_other_tenant");
      await repository.completeLink(Number(link.id), Number(stored.id));
      return { account: stored, identity: who, channel: link.channel };
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
  constructor({ repository, connectors, cipher, skewMs = 5 * 60 * 1000, brokers = {} }) {
    this.repository = repository;
    this.connectors = connectors;
    this.cipher = cipher;
    this.skewMs = skewMs;
    /** Conexão única da DACHBYTE por canal: quem renova é o módulo do canal. @type {Record<string, any>} */
    this.brokers = brokers;
    /** Chave pedida ao módulo, guardada até perto de vencer. @type {Map<number, { accessToken: string, expiresAt: number }>} */
    this.brokeredCache = new Map();
  }

  /**
   * @param {number} accountId
   * @param {{ rejectedAccessToken?: string | null }} [options] chave que o canal recusou (força pedir outra)
   * @returns {Promise<{ accessToken: string, externalAccountId: string, channel: string }>}
   */
  async getAccessToken(accountId, options = {}) {
    if (Object.keys(this.brokers).length) {
      const source = await this.repository.connectionSource(accountId);
      if (source?.connectionSource === "dachbyte") return this.brokeredToken(source, options);
    }
    return this.ownToken(accountId);
  }

  /**
   * Conta da conexão DACHBYTE: pede a chave ao módulo dono da conexão. O Hub nunca renova.
   * @param {any} source @param {{ rejectedAccessToken?: string | null }} options
   */
  async brokeredToken(source, { rejectedAccessToken = null } = {}) {
    const id = Number(source.id);
    if (source.status === "disconnected") throw fail("Conta sem conexão ativa.", 404, "account_not_connected");
    const broker = this.brokers[source.channel];
    if (!broker?.configured) throw fail("Conexão da DACHBYTE indisponível no momento.", 503, "connections_unavailable");
    const cached = this.brokeredCache.get(id);
    if (cached && cached.accessToken !== rejectedAccessToken && cached.expiresAt - Date.now() > this.skewMs) {
      return { accessToken: cached.accessToken, externalAccountId: source.externalAccountId, channel: source.channel };
    }
    try {
      const token = await broker.token({ tenantId: source.tenantId, externalAccountId: source.externalAccountId, rejectedAccessToken });
      // Sem validade informada, guarda por 10 minutos e pergunta de novo.
      const expiresAt = token.expiresAt ? token.expiresAt.getTime() : Date.now() + this.skewMs + 10 * 60 * 1000;
      this.brokeredCache.set(id, { accessToken: token.accessToken, expiresAt });
      if (source.status === "reconnect_required") await this.repository.setStatus(id, "connected");
      return { accessToken: token.accessToken, externalAccountId: source.externalAccountId, channel: source.channel };
    } catch (error) {
      this.brokeredCache.delete(id);
      const code = String(/** @type {any} */ (error)?.code || "");
      if (["reconnect_required", "account_not_active_in_product", "account_not_found"].includes(code)) {
        await this.repository.setStatus(id, "reconnect_required");
        throw fail("A conexão desta conta expirou. Reconecte a conta.", 409, "reconnect_required");
      }
      throw error;
    }
  }

  /** Conexão própria do Hub: chave guardada aqui e renovada sob trava. @param {number} accountId */
  async ownToken(accountId) {
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
