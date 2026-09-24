"use strict";

const env = require("../config/env");
const db = require("../config/postgres");
const oauthStateRepository = require("../repositories/oauthStateRepository");
const accountRepository = require("../repositories/accountRepository");
const tokenRepository = require("../repositories/tokenRepository");
const protocol = require("./magaluOAuthProtocol");
const {
  createOAuthState,
  hashOAuthState,
  safeRedirectAfter,
  parseScopes,
} = require("./oauthSecurity");

function text(value) {
  return String(value == null ? "" : value).trim();
}

async function beginAuthorization({ identity, redirectAfter } = {}) {
  if (!protocol.oauthConfigured()) {
    const error = new Error("OAuth Magalu não configurado. Preencha client ID, client secret e redirect URI.");
    error.code = "MAGALU_OAUTH_NOT_CONFIGURED";
    error.status = 503;
    throw error;
  }
  const dachTenantId = text(identity?.dachTenantId);
  const dachUserId = text(identity?.dachUserId);
  if (!dachTenantId || !dachUserId) {
    const error = new Error("Identidade DACH incompleta para iniciar OAuth Magalu.");
    error.code = "MAGALU_OAUTH_IDENTITY_MISSING";
    error.status = 401;
    throw error;
  }

  const state = createOAuthState();
  const stateHash = hashOAuthState(state);
  const expiresAt = new Date(Date.now() + Math.max(120, env.MAGALU_OAUTH_STATE_TTL_SECONDS) * 1000);
  const redirect = safeRedirectAfter(redirectAfter);
  const scopes = parseScopes(env.MAGALU_OAUTH_SCOPES);
  await oauthStateRepository.createState({
    stateHash,
    dachTenantId,
    dachUserId,
    redirectAfter: redirect,
    expiresAt,
    requestedScopes: scopes,
  });

  return {
    state,
    stateHash,
    expiresAt,
    redirectAfter: redirect,
    authorizationUrl: protocol.buildConsentUrl({ state, scopes }),
  };
}

async function finishAuthorization({ stateRecord, code } = {}) {
  if (!stateRecord?.dach_tenant_id || !stateRecord?.dach_user_id) {
    const error = new Error("Estado OAuth Magalu inválido.");
    error.code = "MAGALU_OAUTH_STATE_INVALID";
    error.status = 400;
    throw error;
  }
  const response = await protocol.exchangeAuthorizationCode(code);
  const tokenSet = protocol.normalizeTokenSet(response);
  const authorizedScopes = tokenSet.scopes.length
    ? tokenSet.scopes
    : parseScopes(stateRecord.requested_scopes);

  const result = await db.withClient(async (client) => {
    await client.query("begin");
    try {
      const account = await accountRepository.upsertConnectedAccount(client, {
        dachTenantId: stateRecord.dach_tenant_id,
        dachUserId: stateRecord.dach_user_id,
        magaluTenantId: tokenSet.subject,
        scopes: authorizedScopes,
        metadata: {
          oauth: {
            source: "authorization_code",
            token_created_at: tokenSet.createdAt,
          },
        },
      });
      const token = await tokenRepository.saveTokens(client, account.id, tokenSet);
      await client.query("commit");
      return { account, token };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });

  return {
    ...result,
    subject: tokenSet.subject,
    scopes: authorizedScopes,
    accessExpiresAt: tokenSet.accessExpiresAt,
    refreshExpiresAt: tokenSet.refreshExpiresAt,
  };
}

module.exports = {
  oauthConfigured: protocol.oauthConfigured,
  publicOAuthConfig: protocol.publicOAuthConfig,
  buildConsentUrl: protocol.buildConsentUrl,
  beginAuthorization,
  exchangeAuthorizationCode: protocol.exchangeAuthorizationCode,
  refreshTokenGrant: protocol.refreshTokenGrant,
  normalizeTokenSet: protocol.normalizeTokenSet,
  finishAuthorization,
};
