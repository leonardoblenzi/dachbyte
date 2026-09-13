"use strict";

const { query, queryOne } = require("../config/postgres");

let sessionAccountContextColumnPromise = null;

function ensureSessionAccountContextColumn() {
  if (!sessionAccountContextColumnPromise) {
    sessionAccountContextColumnPromise = query(`
      ALTER TABLE "Session"
        ADD COLUMN IF NOT EXISTS "accountContextId" INTEGER
    `).catch((error) => {
      sessionAccountContextColumnPromise = null;
      throw error;
    });
  }
  return sessionAccountContextColumnPromise;
}

function toBigIntOrNull(value) {
  if (value == null || value === "") {
    return null;
  }

  try {
    return BigInt(value);
  } catch (_error) {
    return null;
  }
}

function mapSessionRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.session_id,
    userId: Number(row.user_id),
    activeShopId: row.active_shop_id == null ? null : Number(row.active_shop_id),
    accountContextId:
      row.account_context_id == null ? null : Number(row.account_context_id),
    realUserId: row.real_user_id == null ? null : Number(row.real_user_id),
    impersonating: Boolean(row.impersonating),
    expiresAt: row.expires_at,
    user: {
      id: Number(row.user_id),
      email: row.user_email,
      role: row.user_role,
      userGlobalId: row.user_global_id || null,
      accountId: row.account_id == null ? null : Number(row.account_id),
      account: row.account_id == null
        ? null
        : {
            id: Number(row.account_id),
            name: row.account_name,
            tenantGlobalId: row.account_tenant_global_id || null,
          },
    },
  };
}

function mapShopSummaryRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    shopId: toBigIntOrNull(row.shop_id),
    region: row.region || null,
    accountId: row.account_id == null ? null : Number(row.account_id),
  };
}

async function findSessionWithUserAccountById(sessionId) {
  await ensureSessionAccountContextColumn();

  const row = await queryOne(
    `
      SELECT
        s.id AS session_id,
        s."userId" AS user_id,
        s."activeShopId" AS active_shop_id,
        s."realUserId" AS real_user_id,
        s.impersonating,
        s."expiresAt" AS expires_at,
        u.email AS user_email,
        u.role AS user_role,
        u."userGlobalId" AS user_global_id,
        s."accountContextId" AS account_context_id,
        COALESCE(s."accountContextId", u."accountId") AS account_id,
        a.name AS account_name,
        a."tenantGlobalId" AS account_tenant_global_id
      FROM "Session" s
      INNER JOIN "User" u ON u.id::text = s."userId"::text
      LEFT JOIN "Account" a ON a.id = COALESCE(s."accountContextId", u."accountId")
      WHERE s.id = $1
      LIMIT 1
    `,
    [sessionId],
  );

  return mapSessionRow(row);
}

async function deleteSessionById(sessionId) {
  await queryOne(
    `
      DELETE FROM "Session"
      WHERE id = $1
      RETURNING id
    `,
    [sessionId],
  );
}

async function findShopById(shopDbId) {
  const row = await queryOne(
    `
      SELECT id, "shopId" AS shop_id, region, "accountId" AS account_id
      FROM "Shop"
      WHERE id = $1
      LIMIT 1
    `,
    [shopDbId],
  );

  return mapShopSummaryRow(row);
}

async function findShopForAccountById(shopDbId, accountId) {
  const row = await queryOne(
    `
      SELECT id, "shopId" AS shop_id, region, "accountId" AS account_id
      FROM "Shop"
      WHERE id = $1
        AND "accountId" = $2
      LIMIT 1
    `,
    [shopDbId, accountId],
  );

  return mapShopSummaryRow(row);
}

async function findAccountSummaryById(accountId) {
  return queryOne(
    `
      SELECT id, name
      FROM "Account"
      WHERE id = $1
      LIMIT 1
    `,
    [accountId],
  );
}

async function findUserSummaryById(userId) {
  return queryOne(
    `
      SELECT id, name, email
      FROM "User"
      WHERE id::text = $1::text
      LIMIT 1
    `,
    [userId],
  );
}

module.exports = {
  deleteSessionById,
  findAccountSummaryById,
  findSessionWithUserAccountById,
  findShopById,
  findShopForAccountById,
  findUserSummaryById,
};
