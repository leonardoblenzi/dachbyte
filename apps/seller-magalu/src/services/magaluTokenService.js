"use strict";

const db = require("../config/postgres");
const accountRepository = require("../repositories/accountRepository");
const tokenRepository = require("../repositories/tokenRepository");
const { refreshTokenGrant, normalizeTokenSet } = require("./magaluOAuthService");

function permanentRefreshError(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || "").toLowerCase();
  return [400, 401, 403].includes(status) || ["invalid_grant", "invalid_token", "unauthorized"].includes(code);
}

function assertOwnership(record, dachTenantId) {
  if (!record) {
    const error = new Error("Conta Magalu não encontrada.");
    error.code = "MAGALU_ACCOUNT_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  if (dachTenantId && String(record.dach_tenant_id) !== String(dachTenantId)) {
    const error = new Error("A conta Magalu não pertence ao tenant DACH atual.");
    error.code = "MAGALU_ACCOUNT_FORBIDDEN";
    error.status = 403;
    throw error;
  }
}

async function refreshAccount(accountId, { dachTenantId = null } = {}) {
  const record = await tokenRepository.getTokenRecord(accountId);
  assertOwnership(record, dachTenantId);
  if (record.account_status === "disabled" || record.account_status === "revoked") {
    const error = new Error("A conexão Magalu está desativada ou revogada.");
    error.code = "MAGALU_ACCOUNT_INACTIVE";
    error.status = 409;
    throw error;
  }
  if (record.refresh_expires_at && new Date(record.refresh_expires_at).getTime() <= Date.now()) {
    const error = new Error("O refresh token Magalu expirou. Reconecte a conta.");
    error.code = "MAGALU_REFRESH_TOKEN_EXPIRED";
    error.status = 409;
    await tokenRepository.markRefreshFailure(accountId, error.message, { permanent: true }).catch(() => {});
    throw error;
  }

  await tokenRepository.markRefreshAttempt(accountId);
  try {
    const response = await refreshTokenGrant(record.refresh_token);
    const tokenSet = normalizeTokenSet(response, record.refresh_token);
    if (String(tokenSet.subject) !== String(record.magalu_tenant_id)) {
      const error = new Error("O tenant retornado na renovação não corresponde à conta conectada.");
      error.code = "MAGALU_REFRESH_SUBJECT_MISMATCH";
      error.status = 502;
      throw error;
    }

    await db.withClient(async (client) => {
      await client.query("begin");
      try {
        await tokenRepository.saveTokens(client, accountId, tokenSet);
        await accountRepository.updateAccountAfterRefresh(client, accountId, tokenSet.scopes);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    });

    return {
      accountId: Number(accountId),
      accessToken: tokenSet.accessToken,
      accessExpiresAt: tokenSet.accessExpiresAt,
      scopes: tokenSet.scopes,
    };
  } catch (error) {
    await tokenRepository.markRefreshFailure(accountId, error?.message || "Falha ao renovar token Magalu.", {
      permanent: permanentRefreshError(error),
    }).catch(() => {});
    throw error;
  }
}

async function getValidAccessToken(accountId, { dachTenantId = null, minValiditySeconds = 120 } = {}) {
  const record = await tokenRepository.getTokenRecord(accountId);
  assertOwnership(record, dachTenantId);
  const expiresAt = record.access_expires_at ? new Date(record.access_expires_at).getTime() : 0;
  if (record.access_token && expiresAt > Date.now() + Math.max(0, Number(minValiditySeconds) || 0) * 1000) {
    return { accessToken: record.access_token, accessExpiresAt: record.access_expires_at, refreshed: false };
  }
  const refreshed = await refreshAccount(accountId, { dachTenantId });
  return { ...refreshed, refreshed: true };
}

module.exports = { refreshAccount, getValidAccessToken, _test: { permanentRefreshError, assertOwnership } };
