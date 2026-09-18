"use strict";

const crypto = require("node:crypto");
const { withTenant } = require("../db/tenantDb");
const { encrypt, decrypt } = require("../security/tokenVault");

function nowIso() {
  return new Date().toISOString();
}

function json(value) {
  return JSON.stringify(value ?? {});
}

class GoogleAdsRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async ensureDefaultWorkspace(identity) {
    return withTenant(this.pool, identity.tenantId, async (client) => {
      await client.query(
        `INSERT INTO ads_workspaces (id, tenant_id, name, workspace_type, is_default)
         VALUES ($1, $2, $3, 'company', true)
         ON CONFLICT (tenant_id) WHERE is_default DO UPDATE
         SET updated_at = now()`,
        [crypto.randomUUID(), identity.tenantId, identity.name || identity.email || "Minha empresa"],
      );
      const { rows } = await client.query(
        `SELECT id, tenant_id, name, workspace_type, status, is_default
         FROM ads_workspaces
         WHERE tenant_id = $1 AND is_default = true
         LIMIT 1`,
        [identity.tenantId],
      );
      const workspace = rows[0];
      if (!workspace) throw new Error("Failed to create default DACH Ads workspace");
      await client.query(
        `INSERT INTO ads_workspace_memberships (workspace_id, user_global_id, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT (workspace_id, user_global_id) DO NOTHING`,
        [workspace.id, identity.userId],
      );
      return workspace;
    });
  }

  async listConnectionsAndAccounts(tenantId, workspaceId) {
    return withTenant(this.pool, tenantId, async (client) => {
      const connections = await client.query(
        `SELECT id, provider, external_subject, status, scopes, metadata, connected_at, created_at, updated_at
         FROM ads_provider_connections
         WHERE tenant_id = $1 AND workspace_id = $2 AND provider = 'google_ads'
         ORDER BY connected_at DESC NULLS LAST, created_at DESC`,
        [tenantId, workspaceId],
      );
      const accounts = await client.query(
        `SELECT id, connection_id, external_account_id, name, currency_code, timezone, status,
                manager, test_account, account_level, login_customer_id, sync_enabled,
                last_synced_at, last_sync_status, last_sync_error, metadata, updated_at
         FROM ads_ad_accounts
         WHERE tenant_id = $1 AND workspace_id = $2 AND provider = 'google_ads'
         ORDER BY manager DESC, account_level NULLS LAST, name NULLS LAST, external_account_id`,
        [tenantId, workspaceId],
      );
      return { connections: connections.rows, accounts: accounts.rows };
    });
  }

  async upsertConnectionAndCredentials({ identity, workspaceId, profile, tokens, scopes }) {
    return withTenant(this.pool, identity.tenantId, async (client) => {
      const existingResult = await client.query(
        `SELECT c.id, cr.refresh_token_ciphertext
         FROM ads_provider_connections c
         LEFT JOIN ads_provider_credentials cr ON cr.connection_id = c.id
         WHERE c.tenant_id = $1 AND c.workspace_id = $2 AND c.provider = 'google_ads'
           AND c.external_subject = $3
         LIMIT 1`,
        [identity.tenantId, workspaceId, String(profile.sub)],
      );
      const existing = existingResult.rows[0];
      let connectionId = existing?.id || crypto.randomUUID();

      const connectionUpsert = await client.query(
        `INSERT INTO ads_provider_connections
           (id, tenant_id, workspace_id, provider, external_subject, status, scopes, metadata, connected_at)
         VALUES ($1, $2, $3, 'google_ads', $4, 'active', $5::jsonb, $6::jsonb, now())
         ON CONFLICT (tenant_id, workspace_id, provider, external_subject) WHERE external_subject IS NOT NULL DO UPDATE SET
           status = 'active',
           scopes = EXCLUDED.scopes,
           metadata = EXCLUDED.metadata,
           connected_at = now(),
           updated_at = now()
         RETURNING id`,
        [
          connectionId,
          identity.tenantId,
          workspaceId,
          String(profile.sub),
          json(scopes || []),
          json({ email: profile.email || null, name: profile.name || null, picture: profile.picture || null }),
        ],
      );
      connectionId = connectionUpsert.rows[0].id;

      let refreshTokenCiphertext = existing?.refresh_token_ciphertext || null;
      if (tokens.refresh_token) refreshTokenCiphertext = encrypt(tokens.refresh_token);
      if (!refreshTokenCiphertext) {
        const credentialResult = await client.query(
          `SELECT refresh_token_ciphertext
           FROM ads_provider_credentials
           WHERE tenant_id = $1 AND connection_id = $2
           LIMIT 1`,
          [identity.tenantId, connectionId],
        );
        refreshTokenCiphertext = credentialResult.rows[0]?.refresh_token_ciphertext || null;
      }
      if (!refreshTokenCiphertext) {
        const error = new Error("Google OAuth did not return a refresh token. Reconnect with consent enabled.");
        error.code = "GOOGLE_REFRESH_TOKEN_MISSING";
        throw error;
      }

      await client.query(
        `INSERT INTO ads_provider_credentials
           (connection_id, tenant_id, provider, access_token_ciphertext, refresh_token_ciphertext,
            access_token_expires_at, token_type, scope, encryption_version)
         VALUES ($1, $2, 'google_ads', $3, $4, $5, $6, $7, 1)
         ON CONFLICT (connection_id) DO UPDATE SET
           access_token_ciphertext = EXCLUDED.access_token_ciphertext,
           refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
           access_token_expires_at = EXCLUDED.access_token_expires_at,
           token_type = EXCLUDED.token_type,
           scope = EXCLUDED.scope,
           encryption_version = 1,
           updated_at = now()`,
        [
          connectionId,
          identity.tenantId,
          encrypt(tokens.access_token),
          refreshTokenCiphertext,
          tokens.expires_at,
          tokens.token_type || "Bearer",
          tokens.scope || null,
        ],
      );

      return connectionId;
    });
  }

  async getConnectionCredentials(tenantId, workspaceId, connectionId) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.status, c.metadata, c.scopes,
                cr.access_token_ciphertext, cr.refresh_token_ciphertext,
                cr.access_token_expires_at, cr.token_type, cr.scope
         FROM ads_provider_connections c
         JOIN ads_provider_credentials cr ON cr.connection_id = c.id
         WHERE c.tenant_id = $1 AND c.workspace_id = $2 AND c.id = $3
           AND c.provider = 'google_ads'
         LIMIT 1`,
        [tenantId, workspaceId, connectionId],
      );
      if (!rows[0]) return null;
      return {
        ...rows[0],
        accessToken: decrypt(rows[0].access_token_ciphertext),
        refreshToken: decrypt(rows[0].refresh_token_ciphertext),
      };
    });
  }

  async updateAccessToken(tenantId, connectionId, { accessToken, expiresAt, tokenType, scope }) {
    return withTenant(this.pool, tenantId, (client) => client.query(
      `UPDATE ads_provider_credentials
       SET access_token_ciphertext = $3,
           access_token_expires_at = $4,
           token_type = COALESCE($5, token_type),
           scope = COALESCE($6, scope),
           updated_at = now()
       WHERE tenant_id = $1 AND connection_id = $2`,
      [tenantId, connectionId, encrypt(accessToken), expiresAt, tokenType || null, scope || null],
    ));
  }

  async markConnectionError(tenantId, workspaceId, connectionId, message) {
    return withTenant(this.pool, tenantId, (client) => client.query(
      `UPDATE ads_provider_connections
       SET status = 'error', metadata = metadata || $4::jsonb, updated_at = now()
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
      [tenantId, workspaceId, connectionId, json({ lastError: String(message || "Unknown error"), lastErrorAt: nowIso() })],
    ));
  }

  async upsertDiscoveredAccounts(tenantId, workspaceId, connectionId, accounts) {
    return withTenant(this.pool, tenantId, async (client) => {
      for (const account of accounts) {
        await client.query(
          `INSERT INTO ads_ad_accounts
             (id, tenant_id, workspace_id, connection_id, provider, external_account_id, name,
              currency_code, timezone, status, manager, test_account, account_level,
              login_customer_id, metadata)
           VALUES ($1, $2, $3, $4, 'google_ads', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
           ON CONFLICT (tenant_id, provider, external_account_id) DO UPDATE SET
             workspace_id = EXCLUDED.workspace_id,
             connection_id = EXCLUDED.connection_id,
             name = EXCLUDED.name,
             currency_code = EXCLUDED.currency_code,
             timezone = EXCLUDED.timezone,
             status = EXCLUDED.status,
             manager = EXCLUDED.manager,
             test_account = EXCLUDED.test_account,
             account_level = EXCLUDED.account_level,
             login_customer_id = EXCLUDED.login_customer_id,
             metadata = ads_ad_accounts.metadata || EXCLUDED.metadata,
             updated_at = now()`,
          [
            crypto.randomUUID(), tenantId, workspaceId, connectionId, account.externalAccountId,
            account.name, account.currencyCode, account.timezone, account.status || "UNKNOWN",
            account.manager, account.testAccount, account.level, account.loginCustomerId,
            json({ sourceDirectAccountId: account.sourceDirectAccountId || null }),
          ],
        );
      }
      await client.query(
        `UPDATE ads_provider_connections
         SET status = 'active', metadata = metadata || $4::jsonb, updated_at = now()
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
        [tenantId, workspaceId, connectionId, json({ lastDiscoveryAt: nowIso(), discoveredAccounts: accounts.length })],
      );
    });
  }

  async setAccountSelection(tenantId, workspaceId, accountId, enabled) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE ads_ad_accounts
         SET sync_enabled = $4, updated_at = now()
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND provider = 'google_ads'
         RETURNING id, connection_id, external_account_id, sync_enabled, manager`,
        [tenantId, workspaceId, accountId, Boolean(enabled)],
      );
      const account = rows[0];
      if (!account) return null;
      if (enabled && account.manager) {
        await client.query(
          `UPDATE ads_ad_accounts SET sync_enabled = false, updated_at = now() WHERE id = $1`,
          [account.id],
        );
        const error = new Error("Manager accounts are containers; select an advertiser/client account instead");
        error.code = "GOOGLE_MANAGER_ACCOUNT_NOT_SYNCABLE";
        throw error;
      }
      if (enabled) {
        await client.query(
          `INSERT INTO ads_sync_jobs
             (id, tenant_id, workspace_id, ad_account_id, connection_id, provider, reason, run_after)
           VALUES ($1, $2, $3, $4, $5, 'google_ads', 'account_selected', now())
           ON CONFLICT (provider, ad_account_id) DO UPDATE SET
             run_after = now(),
             reason = 'account_selected',
             locked_at = NULL,
             locked_by = NULL,
             updated_at = now()`,
          [crypto.randomUUID(), tenantId, workspaceId, account.id, account.connection_id],
        );
      }
      return account;
    });
  }

  async requestSync(tenantId, workspaceId, accountId, reason = "manual") {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, connection_id, sync_enabled
         FROM ads_ad_accounts
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND provider = 'google_ads'
         LIMIT 1`,
        [tenantId, workspaceId, accountId],
      );
      const account = rows[0];
      if (!account) return null;
      if (!account.sync_enabled) {
        const error = new Error("Select the Google Ads account before requesting synchronization");
        error.code = "GOOGLE_ACCOUNT_NOT_SELECTED";
        throw error;
      }
      await client.query(
        `INSERT INTO ads_sync_jobs
           (id, tenant_id, workspace_id, ad_account_id, connection_id, provider, reason, run_after)
         VALUES ($1, $2, $3, $4, $5, 'google_ads', $6, now())
         ON CONFLICT (provider, ad_account_id) DO UPDATE SET
           run_after = now(), reason = EXCLUDED.reason, locked_at = NULL, locked_by = NULL, updated_at = now()`,
        [crypto.randomUUID(), tenantId, workspaceId, account.id, account.connection_id, reason],
      );
      return account;
    });
  }

  async markConnectionRevoked(tenantId, workspaceId, connectionId) {
    return withTenant(this.pool, tenantId, async (client) => {
      await client.query(
        `UPDATE ads_provider_connections SET status = 'revoked', updated_at = now()
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND provider = 'google_ads'`,
        [tenantId, workspaceId, connectionId],
      );
      await client.query(
        `UPDATE ads_ad_accounts SET sync_enabled = false, updated_at = now()
         WHERE tenant_id = $1 AND workspace_id = $2 AND connection_id = $3 AND provider = 'google_ads'`,
        [tenantId, workspaceId, connectionId],
      );
    });
  }
}

module.exports = { GoogleAdsRepository };
