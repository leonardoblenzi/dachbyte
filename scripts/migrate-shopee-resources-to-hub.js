"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const moduleRoot = path.resolve(__dirname, "..");

[
  path.join(moduleRoot, ".env"),
  path.join(moduleRoot, "apps", "seller-shopee", ".env"),
  path.join(moduleRoot, "apps", "seller-shopee", "src", ".env"),
].forEach((envPath) => {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
});

function resolvePgModule() {
  const candidates = [path.join(moduleRoot, "apps", "seller-shopee"), moduleRoot];
  for (const candidate of candidates) {
    try {
      return require(require.resolve("pg", { paths: [candidate] }));
    } catch (_error) {}
  }
  throw new Error("Nao foi possivel localizar o pacote 'pg'.");
}

const { Pool } = resolvePgModule();

function parseArgs(argv) {
  const args = {
    apply: false,
    company: "drossi",
    email: "",
    tenant: "",
    document: "",
    mode: "legacy",
  };

  for (const raw of argv.slice(2)) {
    const value = String(raw || "").trim();
    if (!value) continue;
    if (value === "--apply") {
      args.apply = true;
      continue;
    }
    if (value === "--dry-run") {
      args.apply = false;
      continue;
    }
    const match = value.match(/^--([^=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      args[key] = match[2];
    }
  }

  args.mode = ["legacy", "paid"].includes(String(args.mode || "").toLowerCase())
    ? String(args.mode).toLowerCase()
    : "legacy";
  return args;
}

function normalizeDatabaseUrl(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  try {
    const connectionUrl = new URL(value);
    if (process.platform === "win32" && connectionUrl.searchParams.get("channel_binding") === "require") {
      connectionUrl.searchParams.set("channel_binding", "disable");
    }
    if (connectionUrl.searchParams.get("sslmode") === "require" && !connectionUrl.searchParams.has("uselibpqcompat")) {
      connectionUrl.searchParams.set("uselibpqcompat", "true");
    }
    return connectionUrl.toString();
  } catch (_error) {
    return value;
  }
}

function resolveSslOptions(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const sslMode = String(parsed.searchParams.get("sslmode") || "").toLowerCase();
    if (sslMode === "require" || /\.neon\.(tech|build)$/i.test(parsed.hostname)) {
      return { rejectUnauthorized: false };
    }
  } catch (_error) {}
  return undefined;
}

function normalizeHubBaseUrl(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function requiredEnv(name, value) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Configure ${name} antes de rodar a migracao.`);
  return normalized;
}

function createPool(connectionString) {
  return new Pool({
    connectionString,
    ssl: resolveSslOptions(connectionString),
    max: 2,
  });
}

function maskTenant(value) {
  const text = String(value || "").trim();
  if (text.length <= 12) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function normalizePattern(value) {
  return `%${String(value || "").trim().toLowerCase()}%`;
}

async function findShopeeShops(pool, filters) {
  const companyPattern = normalizePattern(filters.company || "");
  const emailPattern = normalizePattern(filters.email || "");
  const documentPattern = normalizePattern(filters.document || "");
  const tenantId = String(filters.tenant || "").trim();

  const result = await pool.query(
    `
      SELECT
        a.id AS account_id,
        a.name AS account_name,
        a."tenantGlobalId" AS tenant_global_id,
        a."documentType" AS document_type,
        a."documentNumber" AS document_number,
        s.id AS local_shop_id,
        s."shopId" AS shopee_shop_id,
        s.status AS shop_status,
        s."createdAt" AS shop_created_at,
        COALESCE(users.user_count, 0)::int AS user_count,
        users.sample_email
      FROM "Account" a
      JOIN "Shop" s ON s."accountId" = a.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS user_count, MIN(u.email) AS sample_email
        FROM "User" u
        WHERE u."accountId" = a.id
      ) users ON TRUE
      WHERE
        ($1::text <> '' AND a."tenantGlobalId" = $1)
        OR ($2::text <> '%%' AND LOWER(COALESCE(a.name, '')) LIKE $2)
        OR ($3::text <> '%%' AND EXISTS (
          SELECT 1 FROM "User" u
          WHERE u."accountId" = a.id AND LOWER(COALESCE(u.email, '')) LIKE $3
        ))
        OR ($4::text <> '%%' AND REGEXP_REPLACE(COALESCE(a."documentNumber", ''), '[^0-9]', '', 'g') LIKE REGEXP_REPLACE($4, '[^0-9]', '', 'g'))
      ORDER BY LOWER(COALESCE(a.name, '')), s.id
    `,
    [tenantId, companyPattern, emailPattern, documentPattern],
  );

  return result.rows || [];
}

function buildSyncPayload(row, args) {
  const tenantId = String(args.tenant || row.tenant_global_id || "").trim();
  const shopId = String(row.shopee_shop_id || "").trim();
  if (!tenantId || !shopId) return null;

  const isPaid = args.mode === "paid";
  return {
    tenant_id: tenantId,
    module_slug: "shopee",
    account_id: shopId,
    label: String(row.account_name || `Shopee ${shopId}`).trim(),
    status: isPaid ? "active" : "legacy_active",
    billing_mode: isPaid ? "paid" : "legacy",
    usage_policy: isPaid ? "metered" : "unlimited",
    range_enforcement: isPaid,
    plan_code: "shopee_pro",
    order_range_code: "up_to_30",
    metadata: {
      source: "davantti_shopee_existing_resource_migration",
      local_account_id: row.account_id == null ? null : Number(row.account_id),
      local_shop_id: row.local_shop_id == null ? null : Number(row.local_shop_id),
      shop_status: row.shop_status || null,
      migrated_mode: args.mode,
      migrated_at: new Date().toISOString(),
    },
  };
}

async function syncResource(hubBaseUrl, hubToken, payload) {
  const response = await fetch(`${hubBaseUrl}/v1/internal/resources/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${hubToken}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error || data?.reason || "hub_resource_sync_failed");
    err.status = response.status;
    err.detail = data;
    throw err;
  }
  return data;
}

async function main() {
  const args = parseArgs(process.argv);
  const databaseUrl = normalizeDatabaseUrl(
    process.env.SHOPEE_DATABASE_URL || process.env.DATABASE_URL,
  );
  const hubBaseUrl = normalizeHubBaseUrl(process.env.HUB_BASE_URL);
  const hubToken = String(process.env.HUB_INTERNAL_TOKEN || "").trim();

  requiredEnv("SHOPEE_DATABASE_URL ou DATABASE_URL", databaseUrl);
  requiredEnv("HUB_BASE_URL", hubBaseUrl);
  requiredEnv("HUB_INTERNAL_TOKEN", hubToken);

  const pool = createPool(databaseUrl);
  try {
    const rows = await findShopeeShops(pool, args);
    if (!rows.length) {
      console.log(JSON.stringify({ ok: true, apply: args.apply, matched: 0, synced: 0, skipped: 0 }, null, 2));
      return;
    }

    const summary = [];
    let synced = 0;
    let skipped = 0;

    for (const row of rows) {
      const payload = buildSyncPayload(row, args);
      const item = {
        account_id: Number(row.account_id),
        account_name: row.account_name,
        tenant: maskTenant(args.tenant || row.tenant_global_id),
        local_shop_id: Number(row.local_shop_id),
        shopee_shop_id: String(row.shopee_shop_id),
        mode: args.mode,
        action: args.apply ? "sync" : "dry_run",
      };

      if (!payload) {
        skipped += 1;
        summary.push({ ...item, ok: false, reason: "tenant_or_shop_missing" });
        continue;
      }

      if (!args.apply) {
        summary.push({ ...item, ok: true });
        continue;
      }

      try {
        const result = await syncResource(hubBaseUrl, hubToken, payload);
        synced += 1;
        summary.push({
          ...item,
          ok: true,
          resource_key: result?.resource?.resource_key || `shopee:${payload.account_id}`,
          access_allow: result?.access?.allow ?? null,
        });
      } catch (error) {
        skipped += 1;
        summary.push({ ...item, ok: false, status: error.status || null, reason: error.message });
      }
    }

    console.log(JSON.stringify({ ok: true, apply: args.apply, matched: rows.length, synced, skipped, items: summary }, null, 2));
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || "migration_failed" }, null, 2));
  process.exit(1);
});
