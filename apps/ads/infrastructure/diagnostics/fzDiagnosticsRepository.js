"use strict";

const crypto = require("node:crypto");
const { withTenant } = require("../db/tenantDb");

class FzDiagnosticsRepository {
  constructor(pool) { this.pool = pool; }

  async createRun(tenantId, workspaceId, rangeDays, rulesVersion) {
    return withTenant(this.pool, tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO ads_fz_rule_runs (id, tenant_id, workspace_id, range_days, status, rules_version)
         VALUES ($1,$2,$3,$4,'running',$5)`,
        [id, tenantId, workspaceId, rangeDays, rulesVersion],
      );
      return id;
    });
  }

  async completeRun(tenantId, runId, findingCount) {
    return withTenant(this.pool, tenantId, (client) => client.query(
      `UPDATE ads_fz_rule_runs SET status='succeeded', finding_count=$3, finished_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, runId, findingCount],
    ));
  }

  async failRun(tenantId, runId, errorMessage) {
    return withTenant(this.pool, tenantId, (client) => client.query(
      `UPDATE ads_fz_rule_runs SET status='failed', error_message=$3, finished_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, runId, String(errorMessage || "Unknown error").slice(0, 2000)],
    ));
  }

  async upsertFindings(tenantId, workspaceId, runId, findings) {
    return withTenant(this.pool, tenantId, async (client) => {
      const ids = [];
      for (const item of findings) {
        const id = crypto.randomUUID();
        const { rows } = await client.query(
          `INSERT INTO ads_fz_findings
             (id, tenant_id, workspace_id, rule_run_id, rule_id, rule_version, fingerprint,
              provider, ad_account_id, severity, category, status, title, diagnosis, evidence,
              recommended_action, do_not_change, observation, next_decision, period_start, period_end,
              first_seen_at, last_seen_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,now(),now(),now())
           ON CONFLICT (tenant_id, workspace_id, fingerprint) DO UPDATE SET
             rule_run_id=EXCLUDED.rule_run_id,
             rule_version=EXCLUDED.rule_version,
             provider=EXCLUDED.provider,
             ad_account_id=EXCLUDED.ad_account_id,
             severity=EXCLUDED.severity,
             category=EXCLUDED.category,
             status=CASE WHEN ads_fz_findings.status='dismissed' THEN 'dismissed'
                         WHEN ads_fz_findings.status='acknowledged' THEN 'acknowledged'
                         ELSE 'open' END,
             title=EXCLUDED.title,
             diagnosis=EXCLUDED.diagnosis,
             evidence=EXCLUDED.evidence,
             recommended_action=EXCLUDED.recommended_action,
             do_not_change=EXCLUDED.do_not_change,
             observation=EXCLUDED.observation,
             next_decision=EXCLUDED.next_decision,
             period_start=EXCLUDED.period_start,
             period_end=EXCLUDED.period_end,
             resolved_at=NULL,
             last_seen_at=now(),
             updated_at=now()
           RETURNING id`,
          [id, tenantId, workspaceId, runId, item.ruleId, item.ruleVersion, item.fingerprint,
            item.provider, item.accountId, item.severity, item.category, item.title, item.diagnosis,
            JSON.stringify(item.evidence || {}), item.recommendedAction, item.doNotChange,
            item.observation, item.nextDecision, item.periodStart, item.periodEnd],
        );
        ids.push(rows[0].id);
      }
      return ids;
    });
  }

  async resolveMissing(tenantId, workspaceId, fingerprints) {
    return withTenant(this.pool, tenantId, async (client) => {
      if (!fingerprints.length) {
        await client.query(
          `UPDATE ads_fz_findings SET status='resolved', resolved_at=now(), updated_at=now()
           WHERE tenant_id=$1 AND workspace_id=$2 AND status IN ('open','acknowledged')`,
          [tenantId, workspaceId],
        );
        return;
      }
      await client.query(
        `UPDATE ads_fz_findings SET status='resolved', resolved_at=now(), updated_at=now()
         WHERE tenant_id=$1 AND workspace_id=$2 AND status IN ('open','acknowledged')
           AND NOT (fingerprint = ANY($3::text[]))`,
        [tenantId, workspaceId, fingerprints],
      );
    });
  }

  async listFindings(tenantId, workspaceId, { includeResolved = false } = {}) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, rule_id, rule_version, provider, ad_account_id, severity, category, status,
                title, diagnosis, evidence, recommended_action, do_not_change, observation,
                next_decision, period_start::text, period_end::text, first_seen_at, last_seen_at,
                resolved_at, updated_at
         FROM ads_fz_findings
         WHERE tenant_id=$1 AND workspace_id=$2
           AND ($3::boolean OR status IN ('open','acknowledged'))
         ORDER BY
           CASE severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END DESC,
           last_seen_at DESC`,
        [tenantId, workspaceId, includeResolved],
      );
      return rows;
    });
  }

  async updateStatus(tenantId, workspaceId, findingId, status) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE ads_fz_findings
         SET status=$4, resolved_at=CASE WHEN $4='resolved' THEN now() ELSE NULL END, updated_at=now()
         WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
         RETURNING id, status, updated_at`,
        [tenantId, workspaceId, findingId, status],
      );
      return rows[0] || null;
    });
  }
}

module.exports = { FzDiagnosticsRepository };
