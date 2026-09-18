"use strict";

const crypto = require("node:crypto");
const { env } = require("../../config/env");
const { getRedis } = require("../../infrastructure/redis/client");
const { parseKey } = require("../../infrastructure/security/tokenVault");
const {
  assertMetaOAuthConfigured,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  debugToken,
  fetchUserProfile,
  tokenExpiryDate,
  revokePermissions,
} = require("../../infrastructure/meta/metaOAuthClient");
const { MetaGraphClient } = require("../../infrastructure/meta/metaGraphClient");

class MetaAdsService {
  constructor(repository) { this.repository = repository; }

  configurationStatus() {
    const missing = [];
    if (!env.metaAppId) missing.push("META_APP_ID");
    if (!env.metaAppSecret) missing.push("META_APP_SECRET");
    if (!env.metaRedirectUri) missing.push("META_REDIRECT_URI");
    if (!parseKey()) missing.push("ADS_TOKEN_ENCRYPTION_KEY");
    return {
      configured: missing.length === 0,
      missing,
      apiVersion: env.metaGraphApiVersion,
      scopes: env.metaOAuthScopes.split(",").map((item) => item.trim()).filter(Boolean),
      readOnly: true,
    };
  }

  async status(identity) {
    const workspace = await this.repository.ensureDefaultWorkspace(identity);
    const data = await this.repository.listConnectionsAndAccounts(identity.tenantId, workspace.id);
    return {
      configuration: this.configurationStatus(),
      workspace,
      connections: data.connections.map((item) => ({
        id: item.id,
        status: item.status,
        email: item.metadata?.email || null,
        name: item.metadata?.name || null,
        connectedAt: item.connected_at,
        updatedAt: item.updated_at,
        lastDiscoveryAt: item.metadata?.lastDiscoveryAt || null,
        discoveredBusinesses: item.metadata?.discoveredBusinesses || 0,
        discoveredAccounts: item.metadata?.discoveredAccounts || 0,
        lastError: item.metadata?.lastError || null,
      })),
      businesses: data.businesses.map((item) => ({
        id: item.id,
        connectionId: item.connection_id,
        businessId: item.external_business_id,
        name: item.name,
        verificationStatus: item.verification_status,
      })),
      accounts: data.accounts.map((item) => ({
        id: item.id,
        connectionId: item.connection_id,
        accountId: item.external_account_id,
        name: item.name,
        currencyCode: item.currency_code,
        timezone: item.timezone,
        status: item.status,
        businessId: item.metadata?.businessExternalId || null,
        businessName: item.metadata?.businessName || null,
        selected: item.sync_enabled,
        lastSyncedAt: item.last_synced_at,
        lastSyncStatus: item.last_sync_status,
        lastSyncError: item.last_sync_error,
      })),
    };
  }

  async beginOAuth(identity, returnTo = "/ads/app/meta") {
    assertMetaOAuthConfigured();
    if (!parseKey()) {
      const error = new Error("ADS_TOKEN_ENCRYPTION_KEY is not configured");
      error.code = "ADS_TOKEN_ENCRYPTION_KEY_INVALID";
      throw error;
    }
    const workspace = await this.repository.ensureDefaultWorkspace(identity);
    const state = crypto.randomBytes(32).toString("base64url");
    await getRedis().set(
      `ads:meta:oauth:${state}`,
      JSON.stringify({
        tenantId: identity.tenantId,
        userId: identity.userId,
        workspaceId: workspace.id,
        returnTo: String(returnTo || "/ads/app/meta").startsWith("/ads/") ? returnTo : "/ads/app/meta",
        createdAt: Date.now(),
      }),
      "EX",
      env.metaOAuthStateTtlSeconds,
    );
    return buildAuthorizationUrl(state);
  }

  async consumeOAuthState(state) {
    const key = `ads:meta:oauth:${state}`;
    const raw = await getRedis().eval(
      `local v=redis.call('GET',KEYS[1]); if v then redis.call('DEL',KEYS[1]); end; return v`,
      1,
      key,
    );
    if (!raw) {
      const error = new Error("Meta OAuth state is invalid or expired");
      error.code = "META_OAUTH_STATE_INVALID";
      throw error;
    }
    return JSON.parse(raw);
  }

  async completeOAuth(identity, { code, state }) {
    const oauthState = await this.consumeOAuthState(state);
    if (oauthState.tenantId !== identity.tenantId || oauthState.userId !== identity.userId) {
      const error = new Error("Meta OAuth state does not match the authenticated DACH user");
      error.code = "META_OAUTH_IDENTITY_MISMATCH";
      throw error;
    }
    const payload = await exchangeAuthorizationCode(code);
    const debug = await debugToken(payload.access_token);
    if (debug.is_valid === false) {
      const error = new Error("Meta returned an invalid access token");
      error.code = "META_ACCESS_TOKEN_INVALID";
      throw error;
    }
    const profile = await fetchUserProfile(payload.access_token);
    const connectionId = await this.repository.upsertConnectionAndCredentials({
      identity,
      workspaceId: oauthState.workspaceId,
      profile,
      debug,
      token: {
        accessToken: payload.access_token,
        expiresAt: tokenExpiryDate(payload.expires_in, debug),
      },
    });
    let discovery;
    try {
      discovery = await this.discoverAssets(identity, oauthState.workspaceId, connectionId);
    } catch (error) {
      await this.repository.markConnectionError(identity.tenantId, oauthState.workspaceId, connectionId, error.message);
      throw error;
    }
    return { connectionId, returnTo: oauthState.returnTo, discovery };
  }

  async discoverAssets(identity, workspaceId, connectionId) {
    const credentials = await this.repository.getConnectionCredentials(identity.tenantId, workspaceId, connectionId);
    if (!credentials) {
      const error = new Error("Meta Ads connection not found");
      error.code = "META_CONNECTION_NOT_FOUND";
      throw error;
    }
    if (credentials.access_token_expires_at && new Date(credentials.access_token_expires_at).getTime() <= Date.now()) {
      const error = new Error("Meta access token expired. Reconnect the Meta account.");
      error.code = "META_ACCESS_TOKEN_EXPIRED";
      throw error;
    }
    const client = new MetaGraphClient({ accessToken: credentials.accessToken });
    const discovery = await client.discoverAssets();
    await this.repository.upsertDiscoveredAssets(identity.tenantId, workspaceId, connectionId, discovery);
    return discovery;
  }

  async rediscover(identity, connectionId) {
    const workspace = await this.repository.ensureDefaultWorkspace(identity);
    return this.discoverAssets(identity, workspace.id, connectionId);
  }

  async selectAccount(identity, accountId, enabled) {
    const workspace = await this.repository.ensureDefaultWorkspace(identity);
    return this.repository.setAccountSelection(identity.tenantId, workspace.id, accountId, enabled);
  }

  async requestSync(identity, accountId) {
    const workspace = await this.repository.ensureDefaultWorkspace(identity);
    return this.repository.requestSync(identity.tenantId, workspace.id, accountId, "manual");
  }

  async disconnect(identity, connectionId) {
    const workspace = await this.repository.ensureDefaultWorkspace(identity);
    const credentials = await this.repository.getConnectionCredentials(identity.tenantId, workspace.id, connectionId);
    if (!credentials) return;
    try { await revokePermissions(credentials.accessToken); }
    catch (error) { console.warn("[dach-ads:meta] revoke failed", error.message); }
    await this.repository.markConnectionRevoked(identity.tenantId, workspace.id, connectionId);
  }
}

module.exports = { MetaAdsService };
