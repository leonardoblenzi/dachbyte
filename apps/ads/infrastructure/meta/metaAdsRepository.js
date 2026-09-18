"use strict";

const crypto = require("node:crypto");
const { withTenant } = require("../db/tenantDb");
const { encrypt, decrypt } = require("../security/tokenVault");

function json(value) { return JSON.stringify(value ?? {}); }
function nowIso() { return new Date().toISOString(); }

const META_ACCOUNT_STATUS = Object.freeze({
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD",
  100: "PENDING_CLOSURE",
  101: "CLOSED",
  201: "ANY_ACTIVE",
  202: "ANY_CLOSED",
});

class MetaAdsRepository {
  constructor(pool) { this.pool = pool; }

  async ensureDefaultWorkspace(identity) {
    return withTenant(this.pool, identity.tenantId, async (client) => {
      await client.query(
        `INSERT INTO ads_workspaces (id, tenant_id, name, workspace_type, is_default)
         VALUES ($1, $2, $3, 'company', true)
         ON CONFLICT (tenant_id) WHERE is_default DO UPDATE SET updated_at = now()`,
        [crypto.randomUUID(), identity.tenantId, identity.name || identity.email || "Minha empresa"],
      );
      const { rows } = await client.query(
        `SELECT id, tenant_id, name, workspace_type, status, is_default
         FROM ads_workspaces WHERE tenant_id = $1 AND is_default = true LIMIT 1`,
        [identity.tenantId],
      );
      const workspace = rows[0];
      if (!workspace) throw new Error("Failed to create default DACH Ads workspace");
      await client.query(
        `INSERT INTO ads_workspace_memberships (workspace_id, user_global_id, role)
         VALUES ($1, $2, 'owner') ON CONFLICT (workspace_id, user_global_id) DO NOTHING`,
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
         WHERE tenant_id = $1 AND workspace_id = $2 AND provider = 'meta_ads'
         ORDER BY connected_at DESC NULLS LAST, created_at DESC`,
        [tenantId, workspaceId],
      );
      const businesses = await client.query(
        `SELECT id, connection_id, external_business_id, name, verification_status, metadata, updated_at
         FROM ads_meta_businesses
         WHERE tenant_id = $1 AND workspace_id = $2
         ORDER BY name NULLS LAST, external_business_id`,
        [tenantId, workspaceId],
      );
      const accounts = await client.query(
        `SELECT id, connection_id, external_account_id, name, currency_code, timezone, status,
                sync_enabled, last_synced_at, last_sync_status, last_sync_error, metadata, updated_at
         FROM ads_ad_accounts
         WHERE tenant_id = $1 AND workspace_id = $2 AND provider = 'meta_ads'
         ORDER BY name NULLS LAST, external_account_id`,
        [tenantId, workspaceId],
      );
      return { connections: connections.rows, businesses: businesses.rows, accounts: accounts.rows };
    });
  }

  async upsertConnectionAndCredentials({ identity, workspaceId, profile, token, debug }) {
    return withTenant(this.pool, identity.tenantId, async (client) => {
      let connectionId = crypto.randomUUID();
      const { rows } = await client.query(
        `INSERT INTO ads_provider_connections
           (id, tenant_id, workspace_id, provider, external_subject, status, scopes, metadata, connected_at)
         VALUES ($1, $2, $3, 'meta_ads', $4, 'active', $5::jsonb, $6::jsonb, now())
         ON CONFLICT (tenant_id, workspace_id, provider, external_subject) WHERE external_subject IS NOT NULL DO UPDATE SET
           status = 'active', scopes = EXCLUDED.scopes, metadata = EXCLUDED.metadata,
           connected_at = now(), updated_at = now()
         RETURNING id`,
        [
          connectionId,
          identity.tenantId,
          workspaceId,
          String(profile.id),
          json(debug.scopes || []),
          json({ email: profile.email || null, name: profile.name || null, userId: String(profile.id) }),
        ],
      );
      connectionId = rows[0].id;
      await client.query(
        `INSERT INTO ads_provider_credentials
           (connection_id, tenant_id, provider, access_token_ciphertext, refresh_token_ciphertext,
            access_token_expires_at, token_type, scope, encryption_version)
         VALUES ($1, $2, 'meta_ads', $3, NULL, $4, 'Bearer', $5, 1)
         ON CONFLICT (connection_id) DO UPDATE SET
           access_token_ciphertext = EXCLUDED.access_token_ciphertext,
           refresh_token_ciphertext = NULL,
           access_token_expires_at = EXCLUDED.access_token_expires_at,
           token_type = 'Bearer', scope = EXCLUDED.scope, encryption_version = 1, updated_at = now()`,
        [connectionId, identity.tenantId, encrypt(token.accessToken), token.expiresAt, (debug.scopes || []).join(" ")],
      );
      return connectionId;
    });
  }

  async getConnectionCredentials(tenantId, workspaceId, connectionId) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.status, c.metadata, c.scopes,
                cr.access_token_ciphertext, cr.access_token_expires_at, cr.token_type, cr.scope
         FROM ads_provider_connections c
         JOIN ads_provider_credentials cr ON cr.connection_id = c.id
         WHERE c.tenant_id = $1 AND c.workspace_id = $2 AND c.id = $3 AND c.provider = 'meta_ads'
         LIMIT 1`,
        [tenantId, workspaceId, connectionId],
      );
      if (!rows[0]) return null;
      return { ...rows[0], accessToken: decrypt(rows[0].access_token_ciphertext) };
    });
  }

  async markConnectionError(tenantId, workspaceId, connectionId, message) {
    return withTenant(this.pool, tenantId, (client) => client.query(
      `UPDATE ads_provider_connections
       SET status = 'error', metadata = metadata || $4::jsonb, updated_at = now()
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND provider = 'meta_ads'`,
      [tenantId, workspaceId, connectionId, json({ lastError: String(message || "Unknown error"), lastErrorAt: nowIso() })],
    ));
  }

  async upsertDiscoveredAssets(tenantId, workspaceId, connectionId, discovery) {
    return withTenant(this.pool, tenantId, async (client) => {
      for (const business of discovery.businesses || []) {
        await client.query(
          `INSERT INTO ads_meta_businesses
             (id, tenant_id, workspace_id, connection_id, external_business_id, name, verification_status, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           ON CONFLICT (tenant_id, connection_id, external_business_id) DO UPDATE SET
             name = EXCLUDED.name, verification_status = EXCLUDED.verification_status,
             metadata = ads_meta_businesses.metadata || EXCLUDED.metadata, updated_at = now()`,
          [crypto.randomUUID(), tenantId, workspaceId, connectionId, business.externalBusinessId, business.name, business.verificationStatus, json(business.metadata)],
        );
      }
      for (const account of discovery.accounts || []) {
        const status = META_ACCOUNT_STATUS[account.statusCode] || `STATUS_${account.statusCode || 0}`;
        await client.query(
          `INSERT INTO ads_ad_accounts
             (id, tenant_id, workspace_id, connection_id, provider, external_account_id, name,
              currency_code, timezone, status, manager, test_account, metadata)
           VALUES ($1, $2, $3, $4, 'meta_ads', $5, $6, $7, $8, $9, false, false, $10::jsonb)
           ON CONFLICT (tenant_id, provider, external_account_id) DO UPDATE SET
             workspace_id = EXCLUDED.workspace_id, connection_id = EXCLUDED.connection_id,
             name = EXCLUDED.name, currency_code = EXCLUDED.currency_code,
             timezone = EXCLUDED.timezone, status = EXCLUDED.status,
             metadata = ads_ad_accounts.metadata || EXCLUDED.metadata, updated_at = now()`,
          [
            crypto.randomUUID(), tenantId, workspaceId, connectionId, account.externalAccountId,
            account.name, account.currencyCode, account.timezone, status,
            json({
              graphAccountId: account.graphAccountId,
              accountStatusCode: account.statusCode,
              businessExternalId: account.businessExternalId,
              businessName: account.businessName,
              ...(account.metadata || {}),
            }),
          ],
        );
      }
      await client.query(
        `UPDATE ads_provider_connections
         SET status = 'active', metadata = metadata || $4::jsonb, updated_at = now()
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND provider = 'meta_ads'`,
        [tenantId, workspaceId, connectionId, json({
          lastDiscoveryAt: nowIso(),
          discoveredBusinesses: (discovery.businesses || []).length,
          discoveredAccounts: (discovery.accounts || []).length,
          lastError: null,
        })],
      );
    });
  }

  async setAccountSelection(tenantId, workspaceId, accountId, enabled) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE ads_ad_accounts SET sync_enabled = $4, updated_at = now()
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND provider = 'meta_ads'
         RETURNING id, connection_id, external_account_id, sync_enabled`,
        [tenantId, workspaceId, accountId, Boolean(enabled)],
      );
      const account = rows[0];
      if (!account) return null;
      if (enabled) {
        await client.query(
          `INSERT INTO ads_sync_jobs
             (id, tenant_id, workspace_id, ad_account_id, connection_id, provider, reason, run_after)
           VALUES ($1, $2, $3, $4, $5, 'meta_ads', 'account_selected', now())
           ON CONFLICT (provider, ad_account_id) DO UPDATE SET
             run_after = now(), reason = 'account_selected', locked_at = NULL, locked_by = NULL, updated_at = now()`,
          [crypto.randomUUID(), tenantId, workspaceId, account.id, account.connection_id],
        );
      }
      return account;
    });
  }

  async requestSync(tenantId, workspaceId, accountId, reason = "manual") {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, connection_id, sync_enabled FROM ads_ad_accounts
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND provider = 'meta_ads' LIMIT 1`,
        [tenantId, workspaceId, accountId],
      );
      const account = rows[0];
      if (!account) return null;
      if (!account.sync_enabled) {
        const error = new Error("Select the Meta Ads account before requesting synchronization");
        error.code = "META_ACCOUNT_NOT_SELECTED";
        throw error;
      }
      await client.query(
        `INSERT INTO ads_sync_jobs
           (id, tenant_id, workspace_id, ad_account_id, connection_id, provider, reason, run_after)
         VALUES ($1, $2, $3, $4, $5, 'meta_ads', $6, now())
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
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND provider = 'meta_ads'`,
        [tenantId, workspaceId, connectionId],
      );
      await client.query(
        `UPDATE ads_ad_accounts SET sync_enabled = false, updated_at = now()
         WHERE tenant_id = $1 AND workspace_id = $2 AND connection_id = $3 AND provider = 'meta_ads'`,
        [tenantId, workspaceId, connectionId],
      );
    });
  }
}

module.exports = { MetaAdsRepository, META_ACCOUNT_STATUS };
