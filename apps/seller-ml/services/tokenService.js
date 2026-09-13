// services/tokenService.js
"use strict";

const fetch = require("node-fetch");
const config = require("../config/config"); // ok
const { isProductionEnvironment } = require("../../../lib/runtimeEnv");
const {
  assertTokenEncryptionConfigured,
  canEncryptTokens,
  encryptToken,
} = require("./tokenCrypto");

// ✅ OAuth: persistência em banco (sem quebrar legado)
let db = null;
try {
  db = require("../db/db");
} catch (_e) {
  db = null;
}

let warnedMissingTokenEncryptionKey = false;
let warnedLegacyEnvSyncInProduction = false;
const refreshInFlightByKey = new Map();

// ----------------------------------------------------
// Helpers
// ----------------------------------------------------
/** Unifica leitura de credenciais (+ account_key para logs) */
function resolveCreds(input = {}) {
  const creds = {
    // ===== App Central (OAuth) / Legado =====
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

    // ===== Identidade/Contexto =====
    account_key:
      input.account_key ||
      input.accountKey ||
      process.env.ACCOUNT_KEY ||
      process.env.SELECTED_ACCOUNT ||
      null,

    // ✅ OAuth: id da conta do ML no seu banco (meli_contas.id)
    meli_conta_id:
      input.meli_conta_id ||
      input.meliContaId ||
      input.meli_account_id ||
      input.ml_account_id ||
      null,

    // opcional (ajuda debug)
    access_expires_at: input.access_expires_at || input.accessExpiresAt || null,
  };

  // normaliza meli_conta_id para number (ou null)
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
  // prioriza OAuth id para facilitar debug
  if (meli_conta_id) return `[oauth:${meli_conta_id}]`;
  return `[${account_key || "sem-conta"}]`;
}

function computeAccessExpiresAt(expiresInSec) {
  const sec = Number(expiresInSec || 0);
  // ML costuma devolver 21600; garante mínimo
  const safe = Math.max(60, sec);
  return new Date(Date.now() + safe * 1000);
}

function parseDateMs(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function refreshLockKey(credsInput = {}) {
  const { meli_conta_id, account_key, app_id, refresh_token } = resolveCreds(
    credsInput,
  );
  if (meli_conta_id) return `oauth:${meli_conta_id}`;
  if (account_key) return `account:${String(account_key).toLowerCase()}`;
  if (app_id && refresh_token) {
    return `app:${String(app_id)}:${String(refresh_token).slice(0, 16)}`;
  }
  return null;
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

async function persistOAuthTokensIfPossible(credsInput, tokenData, opts = {}) {
  // Só persiste se:
  // - tem db
  // - tem meli_conta_id
  // - tem access_token
  const { meli_conta_id } = resolveCreds(credsInput);
  const access_token = tokenData?.access_token;

  if (!db || !meli_conta_id || !access_token) return false;

  assertTokenEncryptionConfigured("persistencia de tokens OAuth");

  const access_expires_at = computeAccessExpiresAt(tokenData?.expires_in);
  const access_token_to_store = encryptToken(String(access_token));

  // refresh_token pode vir vazio em alguns fluxos; NÃO PODE virar null no banco
  // então: se não vier, a query vai manter o existente
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
      "⚠️ ML_TOKEN_ENCRYPTION_KEY/TOKEN_ENCRYPTION_KEY não configurada; tokens seguirão em texto puro até a chave ser definida.",
    );
  }

  try {
    // ✅ Seu db no projeto usa withClient; não assume db.query
    if (typeof db.withClient === "function") {
      await db.withClient(async (client) => {
        await client.query(
          `insert into meli_tokens
            (meli_conta_id, access_token, access_expires_at, refresh_token, scope, refresh_obtido_em, ultimo_refresh_em)
           values ($1, $2, $3, $4, $5, now(), now())
           on conflict (meli_conta_id)
           do update set
             access_token = excluded.access_token,
             access_expires_at = excluded.access_expires_at,
             refresh_token = coalesce(excluded.refresh_token, meli_tokens.refresh_token),
             scope = excluded.scope,
             ultimo_refresh_em = now()`,
          [
            meli_conta_id,
            access_token_to_store,
            access_expires_at.toISOString(),
            refresh_token_from_api, // pode ser null -> mantém o antigo via COALESCE
            scope,
          ]
        );

        if (opts.touchConta) {
          await client.query(
            `update meli_contas
                set ultimo_uso_em = now(),
                    atualizado_em = now(),
                    status = 'ativa'
              where id = $1`,
            [meli_conta_id]
          );
        }
      });

      return true;
    }

    // fallback: se seu db tiver query direta (alguns setups)
    if (typeof db.query === "function") {
      await db.query(
        `insert into meli_tokens
          (meli_conta_id, access_token, access_expires_at, refresh_token, scope, refresh_obtido_em, ultimo_refresh_em)
         values ($1, $2, $3, $4, $5, now(), now())
         on conflict (meli_conta_id)
         do update set
           access_token = excluded.access_token,
           access_expires_at = excluded.access_expires_at,
           refresh_token = coalesce(excluded.refresh_token, meli_tokens.refresh_token),
           scope = excluded.scope,
           ultimo_refresh_em = now()`,
        [
          meli_conta_id,
          access_token_to_store,
          access_expires_at.toISOString(),
          refresh_token_from_api,
          scope,
        ]
      );

      if (opts.touchConta) {
        await db.query(
          `update meli_contas
              set ultimo_uso_em = now(),
                  atualizado_em = now(),
                  status = 'ativa'
            where id = $1`,
          [meli_conta_id]
        );
      }

      return true;
    }

    // nenhum método conhecido
    console.warn(
      `⚠️ ${logPrefix(
        credsInput
      )} db não expõe withClient/query; não foi possível persistir tokens.`
    );
    return false;
  } catch (e) {
    console.warn(
      `⚠️ ${logPrefix(credsInput)} Falha ao persistir token no banco:`,
      e?.message || e
    );
    return false;
  }
}

// ----------------------------------------------------
// Service
// ----------------------------------------------------
class TokenService {
  /**
   * Usa token atual; se inválido, renova via refresh_token.
   * → retorna STRING (access_token)
   */
  static async renovarTokenSeNecessario(credsInput = {}) {
    const L = logPrefix(credsInput);

    try {
      const { access_token, access_expires_at } = resolveCreds(credsInput);
      const expiresAtMs = parseDateMs(access_expires_at);

      if (
        access_token &&
        expiresAtMs &&
        expiresAtMs - Date.now() > 90 * 1000
      ) {
        return access_token;
      }

      if (access_token) {
        const testResponse = await fetch(config.urls.users_me, {
          headers: { Authorization: `Bearer ${access_token}` },
        });

        if (testResponse.ok) {
          console.log(`✅ ${L} Token atual válido`);
          return access_token;
        }

        console.log(`🔄 ${L} Token inválido/expirado, tentando renovar…`);
      } else {
        console.log(`ℹ️ ${L} ACCESS_TOKEN ausente; tentando renovar…`);
      }

      const novo = await this.renovarToken(credsInput);
      return novo.access_token;
    } catch (error) {
      console.error(
        `❌ ${L} Erro ao renovar token (automático):`,
        error?.message || error
      );
      throw error;
    }
  }

  /**
   * Renova o token via refresh_token e (se OAuth) persiste no banco.
   * Retorna { success, access_token, expires_in, refresh_token }
   */
  static async renovarToken(credsInput = {}) {
    const L = logPrefix(credsInput);
    const lockKey = refreshLockKey(credsInput);

    if (lockKey && refreshInFlightByKey.has(lockKey)) {
      return refreshInFlightByKey.get(lockKey);
    }

    const refreshTask = (async () => {

    const {
      app_id,
      client_secret,
      refresh_token,
      redirect_uri,
      account_key,
      meli_conta_id,
    } = resolveCreds(credsInput);

    if (!app_id || !client_secret || !refresh_token) {
      throw new Error(
        `${L} Credenciais não configuradas (APP_ID/CLIENT_SECRET/REFRESH_TOKEN). Selecione a conta correta em /select-conta.`
      );
    }

    console.log(`🔄 ${L} Renovando token…`);

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
      throw new Error(`${L} Erro na API ao renovar token: ${msg}`);
    }

    const data = await response.json();

    // ==========================
    // ✅ Atualiza em memória (res.locals.mlCreds aponta pra esse objeto)
    // ==========================
    if (credsInput && typeof credsInput === "object") {
      credsInput.access_token = data.access_token;
      // refresh_token pode rotacionar
      credsInput.refresh_token = data.refresh_token || refresh_token;
      credsInput.expires_in = data.expires_in;
      credsInput.access_expires_at = computeAccessExpiresAt(
        data.expires_in
      ).toISOString();
      if (data.scope) credsInput.scope = data.scope;
    }

    // ==========================
    // ✅ Atualiza env global (compatibilidade)
    // ==========================
    if (canSyncLegacyEnv()) {
      process.env.ACCESS_TOKEN = data.access_token;
    } else {
      warnLegacyEnvBlocked("ACCESS_TOKEN global");
    }

    // ==========================
    // ✅ OAuth: persiste no banco se possível
    // ==========================
    if (meli_conta_id) {
      const persisted = await persistOAuthTokensIfPossible(credsInput, data, {
        touchConta: true,
      });
      if (persisted) {
        console.log(`💾 ${L} Token persistido no banco (meli_tokens)`);
      } else {
        console.warn(`⚠️ ${L} Não foi possível persistir token no banco`);
      }
    }

    // ==========================
    // LEGADO: atualiza env por conta (se conhecida)
    // ==========================
    if (account_key && canSyncLegacyEnv()) {
      const K = String(account_key).toUpperCase();
      process.env[`ML_${K}_ACCESS_TOKEN`] = data.access_token;

      // refresh pode mudar
      if (data.refresh_token) {
        process.env[`ML_${K}_REFRESH_TOKEN`] = data.refresh_token;
      }
    } else if (account_key) {
      warnLegacyEnvBlocked(`ML_${String(account_key).toUpperCase()}_*`);
    }

    console.log(
      `✅ ${L} Token renovado! (${
        data.access_token
          ? String(data.access_token).substring(0, 18) + "…"
          : ""
      })`
    );

    return {
      success: true,
      access_token: data.access_token,
      expires_in: data.expires_in,
      refresh_token: data.refresh_token || refresh_token,
      scope: data.scope,
    };
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

  // =====================================================
  // As funções abaixo foram mantidas por compatibilidade.
  // =====================================================

  static async obterAccessToken(app_idOrObj, client_secret, refresh_token) {
    try {
      let app_id = app_idOrObj;
      let redirect_uri;
      let account_key;
      let meli_conta_id;

      if (typeof app_idOrObj === "object" && app_idOrObj !== null) {
        const r = resolveCreds(app_idOrObj);
        app_id = r.app_id;
        client_secret = r.client_secret;
        refresh_token = r.refresh_token;
        redirect_uri = r.redirect_uri;
        account_key = r.account_key;
        meli_conta_id = r.meli_conta_id;
      }

      const L = meli_conta_id
        ? `[oauth:${meli_conta_id}]`
        : `[${account_key || process.env.ACCOUNT_KEY || "sem-conta"}]`;

      if (!app_id || !client_secret || !refresh_token) {
        throw new Error(
          `${L} Parâmetros insuficientes para obterAccessToken (app_id, client_secret, refresh_token).`
        );
      }

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
        throw new Error(`${L} Erro na API: ${msg}`);
      }

      const data = await response.json();

      // ✅ OAuth: persiste se possível
      if (meli_conta_id) {
        await persistOAuthTokensIfPossible(app_idOrObj, data, {
          touchConta: true,
        });
      }

      console.log(`${L} Token renovado com sucesso:`, {
        access_token: data.access_token
          ? `${String(data.access_token).substring(0, 12)}…`
          : "(vazio)",
        expires_in: data.expires_in,
        refresh_token: data.refresh_token
          ? `${String(data.refresh_token).substring(0, 10)}…`
          : "(mantido)",
      });

      return {
        success: true,
        access_token: data.access_token,
        expires_in: data.expires_in,
        refresh_token: data.refresh_token || refresh_token,
        scope: data.scope,
      };
    } catch (error) {
      throw error;
    }
  }

  static async obterTokenInicial(
    app_idOrObj,
    client_secret,
    code,
    redirect_uri
  ) {
    try {
      let app_id = app_idOrObj;
      let account_key;
      let meli_conta_id;

      if (typeof app_idOrObj === "object" && app_idOrObj !== null) {
        const r = resolveCreds(app_idOrObj);
        app_id = r.app_id;
        client_secret = r.client_secret ?? client_secret;
        code = r.code ?? r.CODE ?? code;
        redirect_uri = r.redirect_uri ?? redirect_uri;
        account_key = r.account_key;
        meli_conta_id = r.meli_conta_id;
      }

      const L = meli_conta_id
        ? `[oauth:${meli_conta_id}]`
        : `[${account_key || process.env.ACCOUNT_KEY || "sem-conta"}]`;

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

      // ✅ OAuth: persiste se possível (se meli_conta_id já existir no objeto)
      if (meli_conta_id) {
        await persistOAuthTokensIfPossible(app_idOrObj, data, {
          touchConta: true,
        });
      }

      console.log(`${L} Resposta da API (token inicial):`, {
        user_id: data.user_id,
        access_token_preview: data.access_token
          ? `${String(data.access_token).substring(0, 12)}…`
          : "(vazio)",
      });

      return data;
    } catch (error) {
      throw error;
    }
  }

  static async verificarToken(credsInput = {}) {
    try {
      const { access_token } = resolveCreds(credsInput);
      if (!access_token) {
        return {
          success: false,
          error: "Token ausente para a conta atual",
        };
      }

      const r = await fetch(config.urls.users_me, {
        headers: { Authorization: `Bearer ${access_token}` },
      });

      if (!r.ok) {
        return {
          success: false,
          error: "Token invalido ou expirado",
        };
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

/* =====================================================
 * LEGADO (referência)
 * - antes, você atualizava ML_${K}_ACCESS_TOKEN no env.
 * - agora, no modo OAuth, persistimos em meli_tokens também.
 *
 * DICA:
 * Para o OAuth ficar “redondo”, o ensureAccount precisa injetar:
 *   creds.meli_conta_id
 *   creds.refresh_token
 *   creds.access_token
 *   creds.access_expires_at (opcional)
 * ===================================================== */
