"use strict";

const crypto = require("node:crypto");
const { env } = require("../../config/env");
const { getRedis } = require("../../infrastructure/redis/client");
const { assertConfigured, parseKey } = require("../../infrastructure/security/tokenVault");
const {
  assertGoogleOAuthConfigured,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  fetchUserInfo,
  tokenExpiryDate,
  revokeToken,
} = require("../../infrastructure/google/googleOAuthClient");
const { GoogleAdsClient } = require("../../infrastructure/google/googleAdsClient");
const { ensureValidAccessToken } = require("./googleTokenManager");

class GoogleAdsService {
  constructor(repository) {
    this.repository = repository;
  }

  configurationStatus() {
    const missing = [];
    if (!env.googleAdsClientId) missing.push("GOOGLE_ADS_CLIENT_ID");
    if (!env.googleAdsClientSecret) missing.push("GOOGLE_ADS_CLIENT_SECRET");
    if (!env.googleAdsRedirectUri) missing.push("GOOGLE_ADS_REDIRECT_URI");
    if (!parseKey()) missing.push("ADS_TOKEN_ENCRYPTION_KEY");
    return { configured: missing.length === 0, missing, apiVersion: env.googleAdsApiVersion };
  }

  async status(identity) {
    const workspace = await this.repository.ensureDefaultWorkspace(identity);
    const data = await this.repository.listConnectionsAndAccounts(identity.tenantId, workspace.id);
    return {
      configuration: this.configurationStatus(),
      workspace,
      connections: data.connections.map((connection) => ({
        id: connection.id,
        status: connection.status,
        email: connection.metadata?.email || null,
        name: connection.metadata?.name || null,
        connectedAt: connection.connected_at,
        updatedAt: connection.updated_at,
        lastDiscoveryAt: connection.metadata?.lastDiscoveryAt || null,
        discoveredAccounts: connection.metadata?.discoveredAccounts || 0,
        lastError: connection.metadata?.lastError || null,
      })),
      accounts: data.accounts.map((account) => ({
        id: account.id,
        connectionId: account.connection_id,
        customerId: account.external_account_id,
        name: account.name,
        currencyCode: account.currency_code,
        timezone: account.timezone,
        status: account.status,
        manager: account.manager,
        testAccount: account.test_account,
        level: account.account_level,
        loginCustomerId: account.login_customer_id,
        selected: account.sync_enabled,
        lastSyncedAt: account.last_synced_at,
        lastSyncStatus: account.last_sync_status,
        lastSyncError: account.last_sync_error,
      })),
    };
  }

  async beginOAuth(identity, returnTo = "/ads/app/google") {
    assertGoogleOAuthConfigured();
    assertConfigured();
    const workspace = await this.repository.ensureDefaultWorkspace(identity);
    const state = crypto.randomBytes(32).toString("base64url");
    const redis = getRedis();
    await redis.set(
      `ads:google:oauth:${state}`,
      JSON.stringify({
        tenantId: identity.tenantId,
        userId: identity.userId,
        workspaceId: workspace.id,
        returnTo: String(returnTo || "/ads/app/google").startsWith("/ads/") ? returnTo : "/ads/app/google",
        createdAt: Date.now(),
      }),
      "EX",
      env.googleOAuthStateTtlSeconds,
    );
    return buildAuthorizationUrl(state);
  }

  async consumeOAuthState(state) {
    const redis = getRedis();
    const key = `ads:google:oauth:${state}`;
    const script = `local v=redis.call('GET',KEYS[1]); if v then redis.call('DEL',KEYS[1]); end; return v`;
    const raw = await redis.eval(script, 1, key);
    if (!raw) {
      const error = new Error("Google OAuth state is invalid or expired");
      error.code = "GOOGLE_OAUTH_STATE_INVALID";
      throw error;
    }
    return JSON.parse(raw);
  }

  async completeOAuth(identity, { code, state }) {
    assertConfigured();
    const oauthState = await this.consumeOAuthState(state);
    if (oauthState.tenantId !== identity.tenantId || oauthState.userId !== identity.userId) {
      const error = new Error("Google OAuth state does not match the authenticated DACH user");
      error.code = "GOOGLE_OAUTH_IDENTITY_MISMATCH";
      throw error;
    }

    const tokenPayload = await exchangeAuthorizationCode(code);
    const profile = await fetchUserInfo(tokenPayload.access_token);
    const connectionId = await this.repository.upsertConnectionAndCredentials({
      identity,
      workspaceId: oauthState.workspaceId,
      profile,
      tokens: {
        ...tokenPayload,
        expires_at: tokenExpiryDate(tokenPayload.expires_in),
      },
      scopes: String(tokenPayload.scope || "").split(/\s+/).filter(Boolean),
    });

    let discovery;
    try {
      discovery = await this.discoverAccounts(identity, oauthState.workspaceId, connectionId);
    } catch (error) {
      await this.repository.markConnectionError(identity.tenantId, oauthState.workspaceId, connectionId, error.message);
      throw error;
    }
    return { connectionId, returnTo: oauthState.returnTo, discovery };
  }

  async discoverAccounts(identity, workspaceId, connectionId) {
    const credentials = await this.repository.getConnectionCredentials(identity.tenantId, workspaceId, connectionId);
    if (!credentials) {
      const error = new Error("Google Ads connection not found");
      error.code = "GOOGLE_CONNECTION_NOT_FOUND";
      throw error;
    }
    const accessToken = await ensureValidAccessToken(this.repository, identity.tenantId, connectionId, credentials);
    const client = new GoogleAdsClient({ accessToken });
    const discovery = await client.discoverAccounts();
    await this.repository.upsertDiscoveredAccounts(identity.tenantId, workspaceId, connectionId, discovery.accounts);
    return discovery;
  }

  async selectAccount(identity, accountId, enabled) {
    const workspace = await this.repository.ensureDefaultWorkspace(identity);
    return this.repository.setAccountSelection(identity.tenantId, workspace.id, accountId, enabled);
  }

  async requestSync(identity, accountId) {
    const workspace = await this.repository.ensureDefaultWorkspace(identity);
    return this.repository.requestSync(identity.tenantId, workspace.id, accountId, "manual");
  }

  async rediscover(identity, connectionId) {
    const workspace = await this.repository.ensureDefaultWorkspace(identity);
    return this.discoverAccounts(identity, workspace.id, connectionId);
  }

  async disconnect(identity, connectionId) {
    const workspace = await this.repository.ensureDefaultWorkspace(identity);
    const credentials = await this.repository.getConnectionCredentials(identity.tenantId, workspace.id, connectionId);
    if (credentials) await revokeToken(credentials.refreshToken || credentials.accessToken);
    await this.repository.markConnectionRevoked(identity.tenantId, workspace.id, connectionId);
  }
}

module.exports = { GoogleAdsService };
