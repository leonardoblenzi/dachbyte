// services/tokenService.js
"use strict";

const crypto = require("crypto");
const nodeFetch = require("node-fetch");
const fetch = nodeFetch;
const { Headers } = nodeFetch;
const config = require("../config/config");
const { isProductionEnvironment } = require("../../../lib/runtimeEnv");
const {
  assertTokenEncryptionConfigured,
  canEncryptTokens,
  decryptToken,
  encryptToken,
} = require("./tokenCrypto");
const {
  evaluateAccessToken,
  isReplayableBody,
} = require("./tokenRefreshPolicy");
const { withPostgresRefreshLock } = require("./tokenRefreshLock");
const { registerMlAccessTokenAccount } = require("./mlApiRateLimiter");

let db = null;
try {
  db = require("../db/db");
} catch (_e) {
  db = null;
}

let warnedMissingTokenEncryptionKey = false;
let warnedLegacyEnvSyncInProduction = false;
const refreshInFlightByKey = new Map();
const unknownExpiryValidationCache = new Map();

function resolveCreds(input = {}) {
  const creds = {
    app_id:
      input.app_id ||
      input.APP_ID ||
      input.client_id ||
      input.ML_APP_ID ||
      process.env.APP_ID ||
      process.env.ML_APP_ID ||
      process.env.MERCADOLIBRE_APP_ID,

    client_secret:
      input.client_secret ||
      input.CLIENT_SECRET ||
      input.ML_CLIENT_SECRET ||
      process.env.CLIENT_SECRET ||
      process.env.ML_CLIENT_SECRET ||
      process.env.MERCADOLIBRE_CLIENT_SECRET,

    refresh_token:
      input.refresh_token ||
      input.REFRESH_TOKEN ||
      input.ML_REFRESH_TOKEN ||
      process.env.REFRESH_TOKEN ||
      process.env.ML_REFRESH_TOKEN ||
      process.env.MERCADOLIBRE_REFRESH_TOKEN,

    access_token:
      input.access_token ||
      input.ACCESS_TOKEN ||
      process.env.ACCESS_TOKEN ||
      process.env.MERCADOLIBRE_ACCESS_TOKEN,

    redirect_uri:
      input.redirect_uri ||
      input.REDIRECT_URI ||
      input.ML_REDIRECT_URI ||
      process.env.REDIRECT_URI ||
      process.env.ML_REDIRECT_URI,

    account_key:
      input.account_key ||
      input.accountKey ||
      process.env.ACCOUNT_KEY ||
      process.env.SELECTED_ACCOUNT ||
      null,

    meli_conta_id:
      input.meli_conta_id ||
      input.meliContaId ||
      input.meli_account_id ||
      input.ml_account_id ||
      null,

    access_expires_at:
      input.access_expires_at ||
      input.accessExpiresAt ||
      input.ACCESS_EXPIRES_AT ||
      process.env.ACCESS_EXPIRES_AT ||
      process.env.ML_ACCESS_EXPIRES_AT ||
      null,
    scope: input.scope || null,
  };

  if (creds.meli_conta_id != null) {
    const n = Number(creds.meli_conta_id);
    creds.meli_conta_id = Number.isFinite(n) && n > 0 ? n : null;
  }

  return creds;
}

async function safeErrorPayload(resp) {
  try {
    return await resp.json();
  } catch {}
  try {
    return await resp.text();
  } catch {}
  return null;
}

function pickMlErrorMessage(errorData, status) {
  if (!errorData) return `HTTP ${status}`;
  if (typeof errorData === "string") return errorData;
  return (
    errorData.error_description ||
    errorData.message ||
    errorData.error ||
    `HTTP ${status}`
  );
}

function logPrefix(credsInput = {}) {
  const { account_key, meli_conta_id } = resolveCreds(credsInput);
  if (meli_conta_id) return `[oauth:${meli_conta_id}]`;
  return `[${account_key || "sem-conta"}]`;
}

function computeAccessExpiresAt(expiresInSec) {
  const sec = Number(expiresInSec || 0);
  const safe = Math.max(60, sec);
  return new Date(Date.now() + safe * 1000);
}

function refreshLockKey(credsInput = {}) {
  const { meli_conta_id, account_key, app_id } = resolveCreds(credsInput);
  if (meli_conta_id) return `oauth:${meli_conta_id}`;
  if (account_key) return `account:${String(account_key).toLowerCase()}`;
  if (app_id) return `app:${String(app_id)}`;
  return null;
}

function registerTokenAccountBestEffort(credsInput, accessToken) {
  const { meli_conta_id } = resolveCreds(credsInput);
  if (!meli_conta_id || !accessToken) return;
  registerMlAccessTokenAccount({
    accessToken,
    meliContaId: meli_conta_id,
  }).catch(() => {});
}

function unknownExpiryValidationTtlMs() {
  const parsed = Number(process.env.ML_TOKEN_UNKNOWN_EXPIRY_VALIDATION_TTL_MS);
  if (!Number.isFinite(parsed)) return 5 * 60 * 1000;
  return Math.max(30_000, Math.min(30 * 60 * 1000, Math.trunc(parsed)));
}

function tokenFingerprint(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

async function validateUnknownExpiryToken(credsInput, accessToken) {
  const baseKey = refreshLockKey(credsInput) || "legacy";
  const cacheKey = `${baseKey}:${tokenFingerprint(accessToken)}`;
  const cached = unknownExpiryValidationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.state;

  try {
    const response = await fetch(config.urls.users_me, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) {
      unknownExpiryValidationCache.set(cacheKey, {
        state: "valid",
        expiresAt: Date.now() + unknownExpiryValidationTtlMs(),
      });
      return "valid";
    }
    if (response.status === 401 || response.status === 403) {
      unknownExpiryValidationCache.delete(cacheKey);
      return "invalid";
    }
    return "unknown";
  } catch {
    // Falha de rede/5xx nao deve provocar refresh rotativo desnecessario.
    // A chamada real ao ML continua sendo a autoridade.
    return "unknown";
  }
}

function canSyncLegacyEnv() {
  return !isProductionEnvironment();
}

function warnLegacyEnvBlocked(prefix) {
  if (!isProductionEnvironment() || warnedLegacyEnvSyncInProduction) return;
  warnedLegacyEnvSyncInProduction = true;
  console.warn(
    `LEGACY ENV sync bloqueado em producao${prefix ? ` para ${prefix}` : ""}.`,
  );
}

function updateCredsBag(credsInput, tokenData = {}, fallbackRefreshToken = null) {
  if (!credsInput || typeof credsInput !== "object") return;

  if (tokenData.access_token) credsInput.access_token = tokenData.access_token;
  if (tokenData.refresh_token || fallbackRefreshToken) {
    credsInput.refresh_token = tokenData.refresh_token || fallbackRefreshToken;
  }
  if (tokenData.expires_in != null) {
    credsInput.expires_in = tokenData.expires_in;
    credsInput.access_expires_at = computeAccessExpiresAt(
      tokenData.expires_in,
    ).toISOString();
  } else if (tokenData.access_expires_at) {
    credsInput.access_expires_at = tokenData.access_expires_at;
  }
  if (tokenData.scope) credsInput.scope = tokenData.scope;
}

async function queryWith(client, text, params) {
  if (client && typeof client.query === "function") {
    return client.query(text, params);
  }
  if (db && typeof db.query === "function") {
    return db.query(text, params);
  }
  throw new Error("Banco ML indisponivel para operacao de token OAuth.");
}

function decodeStoredToken(raw) {
  if (!raw) return null;
  return decryptToken(raw);
}

async function readOAuthTokens(meliContaId, client = null) {
  const id = Number(meliContaId);
  if (!Number.isFinite(id) || id <= 0 || !db) return null;

  const result = await queryWith(
    client,
    `select access_token,
            access_expires_at,
            refresh_token,
            scope
       from meli_tokens
      where meli_conta_id = $1
      limit 1`,
    [id],
  );

  const row = result?.rows?.[0];
  if (!row) return null;

  return {
    access_token: decodeStoredToken(row.access_token),
    access_expires_at: row.access_expires_at || null,
    refresh_token: decodeStoredToken(row.refresh_token),
    scope: row.scope || null,
  };
}

async function persistOAuthTokensIfPossible(credsInput, tokenData, opts = {}) {
  const { meli_conta_id } = resolveCreds(credsInput);
  const access_token = tokenData?.access_token;
  if (!db || !meli_conta_id || !access_token) return false;

  assertTokenEncryptionConfigured("persistencia de tokens OAuth");

  const access_expires_at = tokenData?.access_expires_at
    ? new Date(tokenData.access_expires_at)
    : computeAccessExpiresAt(tokenData?.expires_in);
  const access_token_to_store = encryptToken(String(access_token));
  const refresh_token_from_api =
    tokenData?.refresh_token != null && String(tokenData.refresh_token).trim()
      ? encryptToken(String(tokenData.refresh_token).trim())
      : null;
  const scope =
    tokenData?.scope != null && String(tokenData.scope).trim()
      ? String(tokenData.scope).trim()
      : null;

  if (!canEncryptTokens() && !warnedMissingTokenEncryptionKey) {
    warnedMissingTokenEncryptionKey = true;
    console.warn(
      "ML_TOKEN_ENCRYPTION_KEY/TOKEN_ENCRYPTION_KEY nao configurada; tokens seguirao em texto puro ate a chave ser definida.",
    );
  }

  const save = async (client) => {
    await client.query(
      `insert into meli_tokens
        (meli_conta_id, access_token, access_expires_at, refresh_token, scope, refresh_obtido_em, ultimo_refresh_em)
       values ($1, $2, $3, $4, $5, now(), now())
       on conflict (meli_conta_id)
       do update set
         access_token = excluded.access_token,
         access_expires_at = excluded.access_expires_at,
         refresh_token = coalesce(excluded.refresh_token, meli_tokens.refresh_token),
         scope = coalesce(excluded.scope, meli_tokens.scope),
         ultimo_refresh_em = now()`,
      [
        meli_conta_id,
        access_token_to_store,
        access_expires_at.toISOString(),
        refresh_token_from_api,
        scope,
      ],
    );

    if (opts.touchConta) {
      await client.query(
        `update meli_contas
            set ultimo_uso_em = now(),
                atualizado_em = now(),
                status = 'ativa'
          where id = $1`,
        [meli_conta_id],
      );
    }
  };

  try {
    if (opts.client && typeof opts.client.query === "function") {
      await save(opts.client);
      return true;
    }

    if (typeof db.withClient === "function") {
      await db.withClient(save);
      return true;
    }

    if (typeof db.query === "function") {
      await queryWith(null,
        `insert into meli_tokens
          (meli_conta_id, access_token, access_expires_at, refresh_token, scope, refresh_obtido_em, ultimo_refresh_em)
         values ($1, $2, $3, $4, $5, now(), now())
         on conflict (meli_conta_id)
         do update set
           access_token = excluded.access_token,
           access_expires_at = excluded.access_expires_at,
           refresh_token = coalesce(excluded.refresh_token, meli_tokens.refresh_token),
           scope = coalesce(excluded.scope, meli_tokens.scope),
           ultimo_refresh_em = now()`,
        [
          meli_conta_id,
          access_token_to_store,
          access_expires_at.toISOString(),
          refresh_token_from_api,
          scope,
        ],
      );
      if (opts.touchConta) {
        await queryWith(null,
          `update meli_contas
              set ultimo_uso_em = now(),
                  atualizado_em = now(),
                  status = 'ativa'
            where id = $1`,
          [meli_conta_id],
        );
      }
      return true;
    }

    return false;
  } catch (error) {
    console.warn(
      `${logPrefix(credsInput)} Falha ao persistir token no banco:`,
      error?.message || error,
    );
    return false;
  }
}

function buildAuthHeaders(initHeaders, token) {
  const headers = new Headers(initHeaders || {});
  if (!headers.has("accept")) headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

async function exchangeRefreshToken(credsInput, client = null) {
  const L = logPrefix(credsInput);
  const {
    app_id,
    client_secret,
    refresh_token,
    redirect_uri,
    account_key,
    meli_conta_id,
  } = resolveCreds(credsInput);

  if (!app_id || !client_secret || !refresh_token) {
    const error = new Error(
      `${L} Credenciais nao configuradas (APP_ID/CLIENT_SECRET/REFRESH_TOKEN). Selecione a conta correta em /select-conta.`,
    );
    error.code = "ML_REFRESH_CREDENTIALS_MISSING";
    throw error;
  }

  console.log(`${L} Renovando token Mercado Livre.`);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: String(app_id),
    client_secret: String(client_secret),
    refresh_token: String(refresh_token),
  });
  if (redirect_uri) body.append("redirect_uri", String(redirect_uri));

  const response = await fetch(config.urls.oauth_token, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorData = await safeErrorPayload(response);
    const msg = pickMlErrorMessage(errorData, response.status);
    const error = new Error(`${L} Erro na API ao renovar token: ${msg}`);
    error.code = "ML_TOKEN_REFRESH_FAILED";
    error.statusCode = response.status;
    error.mlPayload = errorData;
    throw error;
  }

  const data = await response.json();
  if (!data?.access_token) {
    const error = new Error(`${L} Resposta de refresh sem access_token.`);
    error.code = "ML_TOKEN_REFRESH_INVALID_RESPONSE";
    throw error;
  }

  updateCredsBag(credsInput, data, refresh_token);
  registerTokenAccountBestEffort(credsInput, data.access_token);

  if (canSyncLegacyEnv()) {
    process.env.ACCESS_TOKEN = data.access_token;
  } else {
    warnLegacyEnvBlocked("ACCESS_TOKEN global");
  }

  if (meli_conta_id) {
    const persisted = await persistOAuthTokensIfPossible(credsInput, data, {
      touchConta: true,
      client,
    });
    if (!persisted) {
      console.warn(`${L} Nao foi possivel persistir token renovado no banco.`);
    }
  }

  if (account_key && canSyncLegacyEnv()) {
    const K = String(account_key).toUpperCase();
    process.env[`ML_${K}_ACCESS_TOKEN`] = data.access_token;
    if (credsInput?.access_expires_at) {
      process.env[`ML_${K}_ACCESS_EXPIRES_AT`] = String(credsInput.access_expires_at);
    }
    if (data.refresh_token) {
      process.env[`ML_${K}_REFRESH_TOKEN`] = data.refresh_token;
    }
  } else if (account_key) {
    warnLegacyEnvBlocked(`ML_${String(account_key).toUpperCase()}_*`);
  }

  console.log(`${L} Token Mercado Livre renovado e sincronizado.`);

  return {
    success: true,
    access_token: data.access_token,
    expires_in: data.expires_in,
    refresh_token: data.refresh_token || refresh_token,
    scope: data.scope,
  };
}

async function reuseStoredTokenIfRotated(credsInput, client, initialAccessToken) {
  const { meli_conta_id } = resolveCreds(credsInput);
  if (!meli_conta_id || !client) return null;

  const stored = await readOAuthTokens(meli_conta_id, client);
  if (!stored?.access_token) return null;

  const changed =
    initialAccessToken && String(stored.access_token) !== String(initialAccessToken);
  const state = evaluateAccessToken(stored);

  if (changed && state.usable) {
    updateCredsBag(credsInput, stored, stored.refresh_token);
    registerTokenAccountBestEffort(credsInput, stored.access_token);
    return {
      success: true,
      access_token: stored.access_token,
      refresh_token: stored.refresh_token || null,
      scope: stored.scope || null,
      reused_stored_token: true,
    };
  }

  if (stored.refresh_token) {
    credsInput.refresh_token = stored.refresh_token;
  }
  if (stored.access_token) credsInput.access_token = stored.access_token;
  if (stored.access_expires_at) {
    credsInput.access_expires_at = stored.access_expires_at;
  }
  if (stored.scope) credsInput.scope = stored.scope;
  return null;
}

class TokenService {
  static async renovarTokenSeNecessario(credsInput = {}) {
    const L = logPrefix(credsInput);
    try {
      const creds = resolveCreds(credsInput);
      const state = evaluateAccessToken(creds);
      if (state.usable) {
        if (state.reason !== "expiry_unknown_assume_usable" || !creds.refresh_token) {
          registerTokenAccountBestEffort(credsInput, creds.access_token);
          return creds.access_token;
        }

        const validation = await validateUnknownExpiryToken(
          credsInput,
          creds.access_token,
        );
        if (validation !== "invalid") {
          registerTokenAccountBestEffort(credsInput, creds.access_token);
          return creds.access_token;
        }
        console.log(`${L} Token legado sem expiracao foi rejeitado; refresh necessario.`);
      } else {
        console.log(`${L} ${state.reason}; refresh necessario.`);
      }
      const novo = await this.renovarToken(credsInput);
      registerTokenAccountBestEffort(credsInput, novo.access_token);
      return novo.access_token;
    } catch (error) {
      console.error(`${L} Erro ao obter/renovar token:`, error?.message || error);
      throw error;
    }
  }

  static async renovarToken(credsInput = {}, options = {}) {
    const L = logPrefix(credsInput);
    const lockKey = refreshLockKey(credsInput);

    if (lockKey && refreshInFlightByKey.has(lockKey)) {
      return refreshInFlightByKey.get(lockKey);
    }

    const initialAccessToken = resolveCreds(credsInput).access_token || null;
    const { meli_conta_id } = resolveCreds(credsInput);

    const refreshTask = (async () => {
      if (meli_conta_id && db) {
        try {
          return await withPostgresRefreshLock(
            db,
            meli_conta_id,
            async (client) => {
              const reused = await reuseStoredTokenIfRotated(
                credsInput,
                client,
                options.rejectedAccessToken || initialAccessToken,
              );
              if (reused) {
                console.log(`${L} Refresh ja realizado por outro processo; token do banco reutilizado.`);
                return reused;
              }
              return exchangeRefreshToken(credsInput, client);
            },
          );
        } catch (error) {
          if (error?.code === "ML_TOKEN_REFRESH_LOCK_TIMEOUT") {
            // Uma ultima leitura sem lock permite aproveitar refresh concluido logo
            // depois do timeout, mas nunca dispara um segundo refresh concorrente.
            try {
              const latest = await readOAuthTokens(meli_conta_id);
              if (
                latest?.access_token &&
                String(latest.access_token) !==
                  String(options.rejectedAccessToken || initialAccessToken || "") &&
                evaluateAccessToken(latest).usable
              ) {
                updateCredsBag(credsInput, latest, latest.refresh_token);
                return {
                  success: true,
                  access_token: latest.access_token,
                  refresh_token: latest.refresh_token || null,
                  scope: latest.scope || null,
                  reused_stored_token: true,
                };
              }
            } catch {}
          }
          throw error;
        }
      }

      return exchangeRefreshToken(credsInput, null);
    })();

    if (lockKey) refreshInFlightByKey.set(lockKey, refreshTask);
    try {
      return await refreshTask;
    } finally {
      if (lockKey && refreshInFlightByKey.get(lockKey) === refreshTask) {
        refreshInFlightByKey.delete(lockKey);
      }
    }
  }

  /**
   * Faz uma chamada autenticada ao ML e, em 401, executa no maximo um refresh
   * seguido de um retry. O retry so acontece para corpos que podem ser enviados
   * novamente com seguranca (string/Buffer/URLSearchParams/etc.).
   */
  static async fetchAutenticado(url, credsInput = {}, init = {}, options = {}) {
    const retryOn401 = options.retryOn401 !== false;
    const token = await this.renovarTokenSeNecessario(credsInput);
    const firstResponse = await fetch(url, {
      ...init,
      headers: buildAuthHeaders(init.headers, token),
    });

    if (!retryOn401 || firstResponse.status !== 401) {
      return firstResponse;
    }

    if (!isReplayableBody(init.body)) {
      console.warn(
        `${logPrefix(credsInput)} API respondeu 401, mas o corpo da requisicao nao e replayable; retry automatico ignorado.`,
      );
      return firstResponse;
    }

    let refreshed;
    try {
      refreshed = await this.renovarToken(credsInput, {
        force: true,
        rejectedAccessToken: token,
      });
    } catch (error) {
      console.warn(
        `${logPrefix(credsInput)} API respondeu 401 e o refresh falhou:`,
        error?.message || error,
      );
      return firstResponse;
    }

    const retryToken = refreshed?.access_token;
    if (!retryToken) return firstResponse;

    try {
      firstResponse.body?.resume?.();
    } catch {}

    return fetch(url, {
      ...init,
      headers: buildAuthHeaders(init.headers, retryToken),
    });
  }

  static async obterAccessToken(app_idOrObj, client_secret, refresh_token) {
    const creds =
      typeof app_idOrObj === "object" && app_idOrObj !== null
        ? app_idOrObj
        : {
            app_id: app_idOrObj,
            client_secret,
            refresh_token,
          };

    return this.renovarToken(creds);
  }

  static async obterTokenInicial(
    app_idOrObj,
    client_secret,
    code,
    redirect_uri,
  ) {
    let app_id = app_idOrObj;
    let meli_conta_id = null;

    if (typeof app_idOrObj === "object" && app_idOrObj !== null) {
      const r = resolveCreds(app_idOrObj);
      app_id = r.app_id;
      client_secret = r.client_secret ?? client_secret;
      code = app_idOrObj.code ?? app_idOrObj.CODE ?? code;
      redirect_uri = r.redirect_uri ?? redirect_uri;
      meli_conta_id = r.meli_conta_id;
    }

    const L = meli_conta_id ? `[oauth:${meli_conta_id}]` : "[oauth-inicial]";
    if (!app_id || !client_secret || !code || !redirect_uri) {
      throw new Error(`${L} Parametros insuficientes para obter token inicial.`);
    }

    const dados = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: String(app_id),
      client_secret: String(client_secret),
      code: String(code),
      redirect_uri: String(redirect_uri),
    });

    const response = await fetch(config.urls.oauth_token, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: dados.toString(),
    });

    if (!response.ok) {
      const errorData = await safeErrorPayload(response);
      const msg = pickMlErrorMessage(errorData, response.status);
      throw new Error(`${L} Erro na API: ${msg}`);
    }

    const data = await response.json();
    if (meli_conta_id) {
      updateCredsBag(app_idOrObj, data, app_idOrObj.refresh_token);
      await persistOAuthTokensIfPossible(app_idOrObj, data, {
        touchConta: true,
      });
    }

    console.log(`${L} Token inicial obtido com sucesso.`);
    return data;
  }

  // Diagnosticos explicitos. Estas funcoes continuam usando /users/me,
  // mas nao sao mais executadas pelo middleware em toda requisicao.
  static async verificarToken(credsInput = {}) {
    try {
      const { access_token } = resolveCreds(credsInput);
      if (!access_token) {
        return { success: false, error: "Token ausente para a conta atual" };
      }

      const r = await fetch(config.urls.users_me, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!r.ok) {
        return { success: false, error: "Token invalido ou expirado" };
      }

      const me = await r.json();
      return {
        success: true,
        message: "Token valido no servidor",
        nickname: me?.nickname || null,
        user_id: me?.id || null,
      };
    } catch (error) {
      return {
        success: false,
        error: error?.message || "Erro ao verificar token",
      };
    }
  }

  static async testarToken(credsInput = {}) {
    try {
      const { access_token } = resolveCreds(credsInput);
      if (!access_token) return { success: false };
      const r = await fetch(config.urls.users_me, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!r.ok) return { success: false };
      const me = await r.json();
      return { success: true, user_id: me?.id, nickname: me?.nickname };
    } catch {
      return { success: false };
    }
  }
}

module.exports = TokenService;
