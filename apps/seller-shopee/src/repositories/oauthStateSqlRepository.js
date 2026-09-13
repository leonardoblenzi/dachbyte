"use strict";

const { query, queryOne } = require("../config/postgres");

async function ensureOAuthStateTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS "OAuthState" (
      "id" SERIAL NOT NULL,
      state TEXT NOT NULL,
      flow TEXT NOT NULL DEFAULT 'shop',
      "userId" INTEGER,
      "accountId" INTEGER,
      "returnTo" TEXT,
      status TEXT NOT NULL DEFAULT 'ISSUED',
      "shopId" BIGINT,
      metadata JSONB,
      "expiresAt" TIMESTAMPTZ,
      "consumedAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "OAuthState_state_key" UNIQUE (state)
    )
  `);

  await query(
    `CREATE INDEX IF NOT EXISTS "OAuthState_createdAt_idx" ON "OAuthState"("createdAt" DESC)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS "OAuthState_userId_idx" ON "OAuthState"("userId")`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS "OAuthState_accountId_idx" ON "OAuthState"("accountId")`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS "OAuthState_status_idx" ON "OAuthState"(status)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt")`,
  );

  await query(`
    DO $$
    DECLARE
      oauth_user_udt TEXT;
      user_id_udt TEXT;
      oauth_account_udt TEXT;
      account_id_udt TEXT;
    BEGIN
      SELECT c.udt_name
      INTO oauth_user_udt
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'OAuthState'
        AND c.column_name = 'userId';

      SELECT c.udt_name
      INTO user_id_udt
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'User'
        AND c.column_name = 'id';

      IF to_regclass('public."User"') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conname = 'OAuthState_userId_fkey'
         )
         AND oauth_user_udt IS NOT NULL
         AND user_id_udt IS NOT NULL
         AND oauth_user_udt = user_id_udt THEN
        ALTER TABLE "OAuthState"
          ADD CONSTRAINT "OAuthState_userId_fkey"
          FOREIGN KEY ("userId") REFERENCES "User"("id")
          ON DELETE SET NULL
          ON UPDATE CASCADE;
      END IF;

      SELECT c.udt_name
      INTO oauth_account_udt
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'OAuthState'
        AND c.column_name = 'accountId';

      SELECT c.udt_name
      INTO account_id_udt
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'Account'
        AND c.column_name = 'id';

      IF to_regclass('public."Account"') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conname = 'OAuthState_accountId_fkey'
         )
         AND oauth_account_udt IS NOT NULL
         AND account_id_udt IS NOT NULL
         AND oauth_account_udt = account_id_udt THEN
        ALTER TABLE "OAuthState"
          ADD CONSTRAINT "OAuthState_accountId_fkey"
          FOREIGN KEY ("accountId") REFERENCES "Account"("id")
          ON DELETE SET NULL
          ON UPDATE CASCADE;
      END IF;
    END $$;
  `);
}

function normalizeFlow(flow) {
  const normalized = String(flow || "shop").trim().toLowerCase();
  return normalized === "ads" ? "ads" : "shop";
}

function normalizeStatus(status) {
  const normalized = String(status || "").trim().toUpperCase();
  return normalized || "ISSUED";
}

function mapOAuthStateRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    state: row.state,
    flow: row.flow || "shop",
    status: row.status || "ISSUED",
    userId: row.user_id == null ? null : Number(row.user_id),
    accountId: row.account_id == null ? null : Number(row.account_id),
    returnTo: row.return_to || null,
    shopId: row.shop_id == null ? null : String(row.shop_id),
    metadata: row.metadata || null,
    expiresAt: row.expires_at || null,
    consumedAt: row.consumed_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    userName: row.user_name || null,
    userEmail: row.user_email || null,
    accountName: row.account_name || null,
  };
}

async function createOAuthState({
  state,
  flow = "shop",
  userId = null,
  accountId = null,
  returnTo = null,
  status = "ISSUED",
  expiresAt = null,
  metadata = null,
}) {
  await ensureOAuthStateTable();
  const row = await queryOne(
    `
      INSERT INTO "OAuthState" (
        state,
        flow,
        "userId",
        "accountId",
        "returnTo",
        status,
        "expiresAt",
        metadata,
        "createdAt",
        "updatedAt"
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW(), NOW())
      ON CONFLICT (state)
      DO UPDATE SET
        flow = EXCLUDED.flow,
        "userId" = EXCLUDED."userId",
        "accountId" = EXCLUDED."accountId",
        "returnTo" = EXCLUDED."returnTo",
        status = EXCLUDED.status,
        "expiresAt" = EXCLUDED."expiresAt",
        metadata = EXCLUDED.metadata,
        "updatedAt" = NOW()
      RETURNING
        id,
        state,
        flow,
        status,
        "userId" AS user_id,
        "accountId" AS account_id,
        "returnTo" AS return_to,
        "shopId" AS shop_id,
        metadata,
        "expiresAt" AS expires_at,
        "consumedAt" AS consumed_at,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
    `,
    [
      String(state || "").trim(),
      normalizeFlow(flow),
      userId == null ? null : Number(userId),
      accountId == null ? null : Number(accountId),
      returnTo == null ? null : String(returnTo),
      normalizeStatus(status),
      expiresAt || null,
      metadata == null ? null : JSON.stringify(metadata),
    ],
  );

  return mapOAuthStateRow(row);
}

async function consumeOAuthState(state, { status = "CONSUMED", shopId = null, metadata = null } = {}) {
  await ensureOAuthStateTable();
  const row = await queryOne(
    `
      UPDATE "OAuthState"
      SET
        status = $2,
        "shopId" = COALESCE($3::bigint, "shopId"),
        metadata = COALESCE($4::jsonb, metadata),
        "consumedAt" = NOW(),
        "updatedAt" = NOW()
      WHERE state = $1
      RETURNING
        id,
        state,
        flow,
        status,
        "userId" AS user_id,
        "accountId" AS account_id,
        "returnTo" AS return_to,
        "shopId" AS shop_id,
        metadata,
        "expiresAt" AS expires_at,
        "consumedAt" AS consumed_at,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
    `,
    [
      String(state || "").trim(),
      normalizeStatus(status),
      shopId == null ? null : String(shopId),
      metadata == null ? null : JSON.stringify(metadata),
    ],
  );

  return mapOAuthStateRow(row);
}

async function consumeLatestIssuedOAuthStateForUser({
  userId,
  flow = null,
  status = "CONSUMED",
  shopId = null,
  metadata = null,
}) {
  await ensureOAuthStateTable();
  const row = await queryOne(
    `
      UPDATE "OAuthState"
      SET
        status = $3,
        "shopId" = COALESCE($4::bigint, "shopId"),
        metadata = COALESCE($5::jsonb, metadata),
        "consumedAt" = NOW(),
        "updatedAt" = NOW()
      WHERE id = (
        SELECT id
        FROM "OAuthState"
        WHERE "userId" = $1
          AND status = 'ISSUED'
          AND ($2::text IS NULL OR flow = $2)
        ORDER BY "createdAt" DESC
        LIMIT 1
      )
      RETURNING
        id,
        state,
        flow,
        status,
        "userId" AS user_id,
        "accountId" AS account_id,
        "returnTo" AS return_to,
        "shopId" AS shop_id,
        metadata,
        "expiresAt" AS expires_at,
        "consumedAt" AS consumed_at,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
    `,
    [
      Number(userId),
      flow ? normalizeFlow(flow) : null,
      normalizeStatus(status),
      shopId == null ? null : String(shopId),
      metadata == null ? null : JSON.stringify(metadata),
    ],
  );

  return mapOAuthStateRow(row);
}

async function listOAuthStates({ search = "", page = 1, limit = 50 } = {}) {
  await ensureOAuthStateTable();
  const cleanSearch = String(search || "").trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;

  const whereParts = [];
  const params = [];

  if (cleanSearch) {
    params.push(`%${cleanSearch}%`);
    whereParts.push(
      `(LOWER(os.state) LIKE $${params.length} OR LOWER(COALESCE(u.email, '')) LIKE $${params.length} OR LOWER(COALESCE(a.name, '')) LIKE $${params.length})`,
    );
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  params.push(safeLimit);
  const limitParam = params.length;
  params.push(offset);
  const offsetParam = params.length;

  const rowsResult = await query(
    `
      SELECT
        os.id,
        os.state,
        os.flow,
        os.status,
        os."userId" AS user_id,
        os."accountId" AS account_id,
        os."returnTo" AS return_to,
        os."shopId" AS shop_id,
        os.metadata,
        os."expiresAt" AS expires_at,
        os."consumedAt" AS consumed_at,
        os."createdAt" AS created_at,
        os."updatedAt" AS updated_at,
        u.name AS user_name,
        u.email AS user_email,
        a.name AS account_name
      FROM "OAuthState" os
      LEFT JOIN "User" u ON u.id::text = os."userId"::text
      LEFT JOIN "Account" a ON a.id = os."accountId"
      ${whereSql}
      ORDER BY os."createdAt" DESC, os.id DESC
      LIMIT $${limitParam}
      OFFSET $${offsetParam}
    `,
    params,
  );

  const countParams = params.slice(0, params.length - 2);
  const countResult = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "OAuthState" os
      LEFT JOIN "User" u ON u.id::text = os."userId"::text
      LEFT JOIN "Account" a ON a.id = os."accountId"
      ${whereSql}
    `,
    countParams,
  );

  return {
    total: Number(countResult?.total || 0),
    page: safePage,
    pageSize: safeLimit,
    states: rowsResult.rows.map(mapOAuthStateRow),
  };
}

async function cleanupOAuthStates({ olderThanDays = 7 } = {}) {
  await ensureOAuthStateTable();
  const safeDays = Math.max(1, Math.min(365, Number(olderThanDays) || 7));
  const row = await queryOne(
    `
      WITH deleted AS (
        DELETE FROM "OAuthState"
        WHERE
          ("expiresAt" IS NOT NULL AND "expiresAt" < NOW())
          OR "createdAt" < NOW() - ($1::text || ' days')::interval
        RETURNING 1
      )
      SELECT COUNT(*)::int AS deleted_count
      FROM deleted
    `,
    [safeDays],
  );

  return {
    deletedCount: Number(row?.deleted_count || 0),
    olderThanDays: safeDays,
  };
}

async function deleteOAuthState(state) {
  await ensureOAuthStateTable();
  const row = await queryOne(
    `
      DELETE FROM "OAuthState"
      WHERE state = $1
      RETURNING
        id,
        state,
        flow,
        status,
        "userId" AS user_id,
        "accountId" AS account_id,
        "returnTo" AS return_to,
        "shopId" AS shop_id,
        metadata,
        "expiresAt" AS expires_at,
        "consumedAt" AS consumed_at,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
    `,
    [String(state || "").trim()],
  );

  return mapOAuthStateRow(row);
}

module.exports = {
  cleanupOAuthStates,
  consumeLatestIssuedOAuthStateForUser,
  consumeOAuthState,
  createOAuthState,
  deleteOAuthState,
  ensureOAuthStateTable,
  listOAuthStates,
};
