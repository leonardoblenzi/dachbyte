"use strict";

const path = require("path");
const { loadRuntimeEnv } = require("../../../lib/runtimeEnv");

loadRuntimeEnv({
  defaultCandidates: [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "..", ".env"),
  ],
});

const db = require("../db/db");

const DISABLED_VALUES = new Set(["", "0", "false", "off", "none", "disabled", "null", "undefined"]);

function parseArgs(argv) {
  const args = {};
  for (const part of argv) {
    const raw = String(part || "");
    if (raw.startsWith("--no-")) {
      args[raw.slice(5)] = false;
      continue;
    }
    if (raw.startsWith("--") && !raw.includes("=")) {
      args[raw.slice(2)] = true;
      continue;
    }
    const match = raw.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function normalizeConfigValue(value) {
  const normalized = String(value ?? "").trim();
  return DISABLED_VALUES.has(normalized.toLowerCase()) ? "" : normalized;
}

function normalizeLimit(value) {
  const parsed = Math.trunc(Number(value || 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeAccountIds(value) {
  return String(value || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function normalizeConcurrency(value) {
  const parsed = Math.trunc(Number(value || 3));
  if (!Number.isFinite(parsed) || parsed <= 0) return 3;
  return Math.min(parsed, 10);
}

function buildHubConfig() {
  return {
    baseUrl: normalizeConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, ""),
    token: normalizeConfigValue(process.env.HUB_INTERNAL_TOKEN),
  };
}

async function postHub(pathname, payload) {
  const config = buildHubConfig();
  if (!config.baseUrl || !config.token) {
    throw new Error("Configure HUB_BASE_URL e HUB_INTERNAL_TOKEN antes do backfill.");
  }

  const response = await fetch(`${config.baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `hub_http_${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function markLegacyAccountsUnlimited({ dryRun }) {
  if (dryRun) {
    const result = await db.query(`
      select count(*)::int as total
        from meli_contas
       where billing_status = 'legacy_active'
         and billing_mode = 'legacy'
    `);
    return Number(result.rows[0]?.total || 0);
  }

  const result = await db.query(`
    update meli_contas
       set billing_status = 'legacy_active',
           billing_mode = 'legacy',
           usage_policy = 'unlimited',
           range_enforcement = false,
           plan_code = null,
           order_range_code = null,
           billing_updated_at = now()
     where billing_status = 'legacy_active'
       and billing_mode = 'legacy'
  `);
  return result.rowCount || 0;
}

async function loadAccounts({ accountIds, limit }) {
  const params = [];
  const filters = [];
  if (accountIds.length) {
    params.push(accountIds);
    filters.push(`mc.id = any($${params.length}::bigint[])`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const limitSql = limit ? `limit ${Number(limit)}` : "";

  const result = await db.query(`
    select
      mc.id,
      mc.empresa_id,
      mc.meli_user_id::text as meli_user_id,
      coalesce(nullif(mc.apelido, ''), 'Conta ' || mc.meli_user_id::text) as apelido,
      mc.billing_status,
      mc.billing_mode,
      mc.usage_policy,
      mc.range_enforcement,
      mc.plan_code,
      mc.order_range_code,
      e.nome as empresa_nome,
      e.tenant_global_id,
      e.document_type,
      e.document_number,
      u.user_global_id,
      u.nome as usuario_nome,
      u.email as usuario_email,
      eu.papel as usuario_papel
    from meli_contas mc
    join empresas e on e.id = mc.empresa_id
    left join lateral (
      select eu.usuario_id, eu.papel
        from empresa_usuarios eu
       where eu.empresa_id = mc.empresa_id
       order by case eu.papel when 'owner' then 0 when 'admin' then 1 else 2 end, eu.criado_em asc
       limit 1
    ) eu on true
    left join usuarios u on u.id = eu.usuario_id
    ${where}
    order by e.nome asc, mc.id asc
    ${limitSql}
  `, params);
  return result.rows || [];
}

function identityPayload(row) {
  const tenantId = String(row.tenant_global_id || "").trim();
  const userId = String(row.user_global_id || "").trim();
  const email = String(row.usuario_email || "").trim().toLowerCase();
  if (!tenantId || !userId || !email) return null;
  return {
    tenant_id: tenantId,
    company_name: String(row.empresa_nome || `Empresa ${row.empresa_id}`).trim(),
    document_type: row.document_type || null,
    document_number: row.document_number || null,
    user_id: userId,
    full_name: String(row.usuario_nome || email).trim(),
    email,
    role: row.usuario_papel || "owner",
  };
}

function syncPayload(row) {
  const tenantId = String(row.tenant_global_id || `ml_empresa_${row.empresa_id}`).trim();
  const companyName = String(row.empresa_nome || `Empresa ${row.empresa_id}`).trim();
  const accountLabel = String(row.apelido || row.meli_user_id || "").trim();
  return {
    tenant_id: tenantId,
    company_name: companyName,
    account_id: String(row.meli_user_id || "").trim(),
    label: accountLabel ? `${companyName} - ${accountLabel}` : companyName,
    status: row.billing_status || "legacy_active",
    billing_mode: row.billing_mode || "legacy",
    usage_policy: row.usage_policy || "unlimited",
    range_enforcement: Boolean(row.range_enforcement),
    plan_code: row.plan_code || null,
    order_range_code: row.order_range_code || null,
    metadata: {
      source: "ml_backfill",
      ml_local_account_id: row.id,
      ml_empresa_id: row.empresa_id,
      ml_account_label: accountLabel,
    },
  };
}

async function runPool(items, concurrency, worker) {
  const results = [];
  let nextIndex = 0;
  async function runOne() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runOne));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);
  const skipIdentity = Boolean(args["skip-identity"]);
  const accountIds = normalizeAccountIds(args.accounts);
  const limit = normalizeLimit(args.limit);
  const concurrency = normalizeConcurrency(args.concurrency);

  console.log("[Hub ML Accounts] Iniciando backfill", JSON.stringify({
    dryRun,
    skipIdentity,
    accounts: accountIds.length ? accountIds : "all",
    limit: limit || "none",
    concurrency,
  }));

  const migrated = await markLegacyAccountsUnlimited({ dryRun });
  console.log(`[Hub ML Accounts] Contas legado ${dryRun ? "que seriam marcadas" : "marcadas"} como ilimitadas: ${migrated}`);

  const accounts = await loadAccounts({ accountIds, limit });
  console.log(`[Hub ML Accounts] Contas carregadas para sync: ${accounts.length}`);

  if (dryRun) {
    accounts.slice(0, 10).forEach((row) => {
      console.log("[dry-run]", JSON.stringify({
        identity: identityPayload(row),
        account: syncPayload(row),
      }));
    });
    if (accounts.length > 10) {
      console.log(`[dry-run] ... ${accounts.length - 10} conta(s) omitidas no preview.`);
    }
    return;
  }

  const identityRowsByTenant = new Map();
  for (const row of accounts) {
    const payload = identityPayload(row);
    if (payload && !identityRowsByTenant.has(payload.tenant_id)) {
      identityRowsByTenant.set(payload.tenant_id, payload);
    }
  }

  let identitiesSynced = 0;
  let identitiesSkipped = 0;
  if (!skipIdentity) {
    for (const payload of identityRowsByTenant.values()) {
      try {
        await postHub("/v1/internal/identity/sync", payload);
        identitiesSynced += 1;
        console.log(`[identity-ok] ${payload.tenant_id} / ${payload.email}`);
      } catch (error) {
        identitiesSkipped += 1;
        console.warn(`[identity-erro] ${payload.tenant_id}: ${error?.message || error}`);
      }
    }
  }

  let synced = 0;
  let failed = 0;
  const failures = [];
  await runPool(accounts, concurrency, async (row) => {
    const payload = syncPayload(row);
    try {
      await postHub("/v1/internal/ml/accounts/sync", payload);
      synced += 1;
      console.log(`[ok] ${payload.tenant_id} / ${payload.account_id} / ${payload.label}`);
    } catch (error) {
      failed += 1;
      failures.push({
        local_account_id: row.id,
        account_id: payload.account_id,
        tenant_id: payload.tenant_id,
        error: error?.message || String(error),
        status: error?.status || null,
      });
      console.error(`[erro] ${payload.tenant_id} / ${payload.account_id}: ${error?.message || error}`);
    }
  });

  console.log(JSON.stringify({
    ok: failed === 0,
    synced,
    failed,
    identities_synced: identitiesSynced,
    identities_skipped: identitiesSkipped,
    migrated_unlimited: migrated,
    failures,
  }, null, 2));

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("[Hub ML Accounts] Backfill falhou:", error?.message || error);
    process.exit(1);
  })
  .finally(async () => {
    if (db.pool && typeof db.pool.end === "function") {
      await db.pool.end().catch(() => {});
    }
  });
