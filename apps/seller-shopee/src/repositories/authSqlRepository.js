"use strict";

const crypto = require("crypto");
const { query, queryOne, withClient } = require("../config/postgres");

let accountCompanyProfileColumnsPromise = null;

function ensureAccountCompanyProfileColumns() {
  if (!accountCompanyProfileColumnsPromise) {
    accountCompanyProfileColumnsPromise = query(`
      ALTER TABLE "Account"
        ADD COLUMN IF NOT EXISTS "companyPhotoUrl" TEXT,
        ADD COLUMN IF NOT EXISTS "responsibleName" TEXT,
        ADD COLUMN IF NOT EXISTS "responsibleContact" TEXT,
        ADD COLUMN IF NOT EXISTS "currentMonthGoalCents" BIGINT,
        ADD COLUMN IF NOT EXISTS "quarterGoalCents" BIGINT,
        ADD COLUMN IF NOT EXISTS "semesterGoalCents" BIGINT,
        ADD COLUMN IF NOT EXISTS "annualGoalCents" BIGINT
    `).catch((error) => {
      accountCompanyProfileColumnsPromise = null;
      throw error;
    });
  }
  return accountCompanyProfileColumnsPromise;
}

function mapUserRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    name: row.name || null,
    email: row.email,
    passwordHash: row.password_hash || row.passwordHash || null,
    userGlobalId: row.user_global_id || null,
    role: row.role,
    status: row.status,
    accountId: row.account_id == null ? null : Number(row.account_id),
    activationTokenHash: row.activation_token_hash || null,
    activationExpiresAt: row.activation_expires_at || null,
    activationSentAt: row.activation_sent_at || null,
    activatedAt: row.activated_at || null,
    resetTokenHash: row.reset_token_hash || null,
    resetExpiresAt: row.reset_expires_at || null,
    resetRequestedAt: row.reset_requested_at || null,
    passwordChangedAt: row.password_changed_at || null,
    createdAt: row.created_at || row.createdAt || null,
  };
}

function mapShopRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    shopId: row.shop_id == null ? null : BigInt(row.shop_id),
    region: row.region || null,
    status: row.status || null,
    accountId: row.account_id == null ? null : Number(row.account_id),
    createdAt: row.created_at || null,
  };
}

function mapAccountRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    name: row.name || null,
    tenantGlobalId: row.tenant_global_id || null,
    documentType: row.document_type || null,
    documentNumber: row.document_number || null,
    companyPhotoUrl: row.company_photo_url || null,
    responsibleName: row.responsible_name || null,
    responsibleContact: row.responsible_contact || null,
    currentMonthGoalCents: row.current_month_goal_cents == null ? null : Number(row.current_month_goal_cents),
    quarterGoalCents: row.quarter_goal_cents == null ? null : Number(row.quarter_goal_cents),
    semesterGoalCents: row.semester_goal_cents == null ? null : Number(row.semester_goal_cents),
    annualGoalCents: row.annual_goal_cents == null ? null : Number(row.annual_goal_cents),
    createdAt: row.created_at || row.createdAt || null,
  };
}

function mapReleaseNoteRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    version: row.version,
    title: row.title,
    summary: row.summary,
    subject: row.subject,
    html: row.html,
    newFeatures: row.new_features || [],
    adjustments: row.adjustments || [],
    recipientCount: Number(row.recipient_count || 0),
    sentCount: Number(row.sent_count || 0),
    skippedCount: Number(row.skipped_count || 0),
    failedCount: Number(row.failed_count || 0),
    createdByName: row.created_by_name || null,
    createdByEmail: row.created_by_email || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function reserveNextNumericId(client, tableName) {
  const allowedTables = new Set(["Account", "User"]);
  if (!allowedTables.has(tableName)) {
    throw new Error(`Tabela nao suportada para geracao de id: ${tableName}`);
  }

  const quotedTable = `"${tableName}"`;
  const typeRow = (
    await client.query(
      `
        SELECT udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = 'id'
        LIMIT 1
      `,
      [tableName],
    )
  ).rows?.[0];

  const idType = String(typeRow?.udt_name || "").toLowerCase();
  if (idType === "uuid") {
    return crypto.randomUUID();
  }

  await client.query(`LOCK TABLE ${quotedTable} IN SHARE ROW EXCLUSIVE MODE`);

  if (["text", "varchar", "bpchar"].includes(idType)) {
    const result = await client.query(
      `
        SELECT COALESCE(MAX(NULLIF(BTRIM(id::text), '')::bigint), 0) + 1 AS next_id
        FROM ${quotedTable}
        WHERE BTRIM(id::text) ~ '^[0-9]+$'
      `,
    );
    return String(result.rows?.[0]?.next_id || 1);
  }

  const result = await client.query(`SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM ${quotedTable}`);
  return Number(result.rows?.[0]?.next_id || 1);
}

async function findUserByEmail(email) {
  const row = await queryOne(
    `
      SELECT
        id,
        name,
        email,
        "passwordHash" AS password_hash,
        role,
        status,
        "accountId" AS account_id,
        "activationTokenHash" AS activation_token_hash,
        "activationExpiresAt" AS activation_expires_at,
        "activationSentAt" AS activation_sent_at,
        "activatedAt" AS activated_at,
        "resetTokenHash" AS reset_token_hash,
        "resetExpiresAt" AS reset_expires_at,
        "resetRequestedAt" AS reset_requested_at,
        "passwordChangedAt" AS password_changed_at,
        "createdAt" AS created_at
      FROM "User"
      WHERE email = $1
      LIMIT 1
    `,
    [email],
  );

  return mapUserRow(row);
}

async function findAccountById(accountId) {
  await ensureAccountCompanyProfileColumns();

  const row = await queryOne(
    `
      SELECT
        id,
        name,
        "tenantGlobalId" AS tenant_global_id,
        "documentType" AS document_type,
        "documentNumber" AS document_number,
        "companyPhotoUrl" AS company_photo_url,
        "responsibleName" AS responsible_name,
        "responsibleContact" AS responsible_contact,
        "currentMonthGoalCents" AS current_month_goal_cents,
        "quarterGoalCents" AS quarter_goal_cents,
        "semesterGoalCents" AS semester_goal_cents,
        "annualGoalCents" AS annual_goal_cents,
        "createdAt" AS created_at
      FROM "Account"
      WHERE id = $1
      LIMIT 1
    `,
    [accountId],
  );

  return mapAccountRow(row);
}

async function findUserByActivationTokenHash(tokenHash) {
  const row = await queryOne(
    `
      SELECT
        id,
        name,
        email,
        role,
        status,
        "accountId" AS account_id,
        "activationExpiresAt" AS activation_expires_at
      FROM "User"
      WHERE "activationTokenHash" = $1
      LIMIT 1
    `,
    [tokenHash],
  );

  return mapUserRow(row);
}

async function findUserByResetTokenHash(tokenHash) {
  const row = await queryOne(
    `
      SELECT
        id,
        name,
        email,
        role,
        status,
        "accountId" AS account_id,
        "resetExpiresAt" AS reset_expires_at
      FROM "User"
      WHERE "resetTokenHash" = $1
      LIMIT 1
    `,
    [tokenHash],
  );

  return mapUserRow(row);
}

async function updatePasswordResetRequest(userId, tokenHash, expiresAt) {
  const row = await queryOne(
    `
      UPDATE "User"
      SET
        "resetTokenHash" = $2,
        "resetExpiresAt" = $3,
        "resetRequestedAt" = NOW(),
        "updatedAt" = NOW()
      WHERE id::text = $1::text
      RETURNING id
    `,
    [userId, tokenHash, expiresAt],
  );

  return Boolean(row);
}

async function resetUserPassword(userId, passwordHash) {
  const row = await queryOne(
    `
      UPDATE "User"
      SET
        "passwordHash" = $2,
        "passwordChangedAt" = NOW(),
        "resetTokenHash" = NULL,
        "resetExpiresAt" = NULL,
        "updatedAt" = NOW()
      WHERE id::text = $1::text
      RETURNING id
    `,
    [userId, passwordHash],
  );

  return Boolean(row);
}

async function activateUserAccount(userId, passwordHash) {
  const row = await queryOne(
    `
      UPDATE "User"
      SET
        "passwordHash" = $2,
        "passwordChangedAt" = NOW(),
        status = 'ACTIVE',
        "activatedAt" = NOW(),
        "activationTokenHash" = NULL,
        "activationExpiresAt" = NULL,
        "activationSentAt" = NULL,
        "updatedAt" = NOW()
      WHERE id::text = $1::text
      RETURNING
        id,
        email,
        "accountId" AS account_id
    `,
    [userId, passwordHash],
  );

  return mapUserRow(row);
}

async function createSessionForUser(userId, expiresAt) {
  const sessionId = crypto.randomUUID();
  const row = await queryOne(
    `
      INSERT INTO "Session" (id, "userId", "activeShopId", "expiresAt", "createdAt")
      VALUES ($1, $2, NULL, $3, NOW())
      RETURNING id, "expiresAt" AS expires_at
    `,
    [sessionId, userId, expiresAt],
  );

  return row
    ? {
        id: row.id,
        expiresAt: row.expires_at,
      }
    : null;
}

async function listShopsByAccountId(accountId, limit = null) {
  const hasLimit = Number.isInteger(limit) && limit > 0;
  const result = await query(
    `
      SELECT
        id,
        "shopId" AS shop_id,
        region,
        status,
        "accountId" AS account_id,
        "createdAt" AS created_at
      FROM "Shop"
      WHERE "accountId" = $1
      ORDER BY id ASC
      ${hasLimit ? "LIMIT $2" : ""}
    `,
    hasLimit ? [accountId, limit] : [accountId],
  );

  return result.rows.map(mapShopRow);
}

async function updateSessionActiveShopId(sessionId, shopId) {
  const row = await queryOne(
    `
      UPDATE "Session"
      SET "activeShopId" = $2
      WHERE id::text = $1::text
      RETURNING id
    `,
    [sessionId, shopId],
  );

  return Boolean(row);
}

async function cleanupAuthAuditBefore(cutoff) {
  await query(
    `
      DELETE FROM "AuthAudit"
      WHERE "createdAt" < $1
    `,
    [cutoff],
  );
}

async function insertAuthAuditEvent({
  userId = null,
  email = null,
  event,
  status = "info",
  ip = null,
  userAgent = null,
  metadata = null,
}) {
  await query(
    `
      INSERT INTO "AuthAudit" (
        "userId",
        email,
        event,
        status,
        ip,
        "userAgent",
        metadata,
        "createdAt"
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
    `,
    [
      userId,
      email,
      event,
      status,
      ip,
      userAgent,
      metadata == null ? null : JSON.stringify(metadata),
    ],
  );
}

async function countShopsByAccountId(accountId) {
  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "Shop"
      WHERE "accountId" = $1
    `,
    [accountId],
  );

  return Number(row?.total || 0);
}

async function createInvitedUser({
  name,
  email,
  passwordHash,
  role,
  accountId,
  activationTokenHash,
  activationExpiresAt,
}) {
  const userGlobalId = crypto.randomUUID();
  return withClient(async (client) => {
    await client.query("BEGIN");

    try {
      const userId = await reserveNextNumericId(client, "User");
      const result = await client.query(
        `
          INSERT INTO "User" (
            id,
            name,
            email,
            "passwordHash",
            "userGlobalId",
            role,
            "accountId",
            status,
            "activationTokenHash",
            "activationExpiresAt",
            "activationSentAt",
            "createdAt",
            "updatedAt"
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING_ACTIVATION', $8, $9, NOW(), NOW(), NOW())
          RETURNING
            id,
            name,
            email,
            "userGlobalId" AS user_global_id,
            role,
            status,
            "activationExpiresAt" AS activation_expires_at,
            "createdAt" AS created_at
        `,
        [
          userId,
          name,
          email,
          passwordHash,
          userGlobalId,
          role,
          accountId,
          activationTokenHash,
          activationExpiresAt,
        ],
      );

      await client.query("COMMIT");
      return mapUserRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

async function createAccountAndOwnerInvite({
  accountName,
  ownerName,
  ownerEmail,
  passwordHash,
  activationTokenHash,
  activationExpiresAt,
  tenantGlobalId,
  documentType,
  documentNumber,
}) {
  return withClient(async (client) => {
    await client.query("BEGIN");

    try {
      const normalizedTenantGlobalId = tenantGlobalId || crypto.randomUUID();
      const ownerUserGlobalId = crypto.randomUUID();
      const accountId = await reserveNextNumericId(client, "Account");
      const accountResult = await client.query(
        `
          INSERT INTO "Account" (
              id,
              name,
              "tenantGlobalId",
              "documentType",
              "documentNumber",
              "createdAt",
              "updatedAt"
            )
            VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
            RETURNING
              id,
              name,
              "tenantGlobalId" AS tenant_global_id,
              "documentType" AS document_type,
              "documentNumber" AS document_number,
              "createdAt" AS created_at
          `,
          [
            accountId,
            accountName,
            normalizedTenantGlobalId,
            documentType || null,
            documentNumber || null,
          ],
        );

      const account = accountResult.rows[0];
      const userId = await reserveNextNumericId(client, "User");

      const userResult = await client.query(
        `
          INSERT INTO "User" (
            id,
            name,
            email,
            "passwordHash",
            "userGlobalId",
            role,
            "accountId",
            status,
            "activationTokenHash",
            "activationExpiresAt",
            "activationSentAt",
            "createdAt",
            "updatedAt"
          )
          VALUES ($1, $2, $3, $4, $5, 'ADMIN', $6, 'PENDING_ACTIVATION', $7, $8, NOW(), NOW(), NOW())
          RETURNING
            id,
            name,
            email,
            "userGlobalId" AS user_global_id,
            role,
            status,
            "activationExpiresAt" AS activation_expires_at,
            "createdAt" AS created_at
        `,
        [
          userId,
          ownerName,
          ownerEmail,
          passwordHash,
          ownerUserGlobalId,
          account.id,
          activationTokenHash,
          activationExpiresAt,
        ],
      );

      await client.query("COMMIT");

      return {
        account: mapAccountRow(account),
        user: mapUserRow(userResult.rows[0]),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function findUserInAccountById(userId, accountId) {
  const row = await queryOne(
    `
      SELECT
        id,
        name,
        email,
        role,
        status,
        "accountId" AS account_id,
        "userGlobalId" AS user_global_id,
        "activationExpiresAt" AS activation_expires_at,
        "createdAt" AS created_at
      FROM "User"
      WHERE id::text = $1::text
        AND "accountId" = $2
      LIMIT 1
    `,
    [userId, accountId],
  );

  return mapUserRow(row);
}

async function updateUserInvite(userId, activationTokenHash, activationExpiresAt) {
  const row = await queryOne(
    `
      UPDATE "User"
      SET
        status = 'PENDING_ACTIVATION',
        "activationTokenHash" = $2,
        "activationExpiresAt" = $3,
        "activationSentAt" = NOW(),
        "updatedAt" = NOW()
      WHERE id::text = $1::text
      RETURNING
        id,
        name,
        email,
        role,
        status,
        "createdAt" AS created_at,
        "activationExpiresAt" AS activation_expires_at
    `,
    [userId, activationTokenHash, activationExpiresAt],
  );

  return mapUserRow(row);
}

async function listUsersByAccountId(accountId) {
  const result = await query(
    `
      SELECT
        id,
        name,
        email,
        role,
        status,
        "accountId" AS account_id,
        "activationExpiresAt" AS activation_expires_at,
        "createdAt" AS created_at
      FROM "User"
      WHERE "accountId" = $1
      ORDER BY id ASC
    `,
    [accountId],
  );

  return result.rows.map(mapUserRow);
}

async function listAccountsWithUsersAndShops() {
  await ensureAccountCompanyProfileColumns();

  const accountResult = await query(
    `
      SELECT
        id,
        name,
        "tenantGlobalId" AS tenant_global_id,
        "documentType" AS document_type,
        "documentNumber" AS document_number,
        "companyPhotoUrl" AS company_photo_url,
        "responsibleName" AS responsible_name,
        "responsibleContact" AS responsible_contact,
        "currentMonthGoalCents" AS current_month_goal_cents,
        "quarterGoalCents" AS quarter_goal_cents,
        "semesterGoalCents" AS semester_goal_cents,
        "annualGoalCents" AS annual_goal_cents,
        "createdAt" AS created_at
      FROM "Account"
      ORDER BY id ASC
    `,
  );

  const shopResult = await query(
    `
      SELECT
        id,
        "shopId" AS shop_id,
        region,
        status,
        "accountId" AS account_id,
        "createdAt" AS created_at
      FROM "Shop"
      ORDER BY id ASC
    `,
  );

  const userResult = await query(
    `
      SELECT
        id,
        name,
        email,
        role,
        status,
        "accountId" AS account_id,
        "activationExpiresAt" AS activation_expires_at,
        "createdAt" AS created_at
      FROM "User"
      ORDER BY id ASC
    `,
  );

  const shopsByAccount = new Map();
  for (const row of shopResult.rows) {
    const key = Number(row.account_id);
    if (!shopsByAccount.has(key)) {
      shopsByAccount.set(key, []);
    }
    shopsByAccount.get(key).push(mapShopRow(row));
  }

  const usersByAccount = new Map();
  for (const row of userResult.rows) {
    const key = Number(row.account_id);
    if (!usersByAccount.has(key)) {
      usersByAccount.set(key, []);
    }
    usersByAccount.get(key).push(mapUserRow(row));
  }

  return accountResult.rows.map((row) => ({
    ...mapAccountRow(row),
    shops: shopsByAccount.get(Number(row.id)) || [],
    users: usersByAccount.get(Number(row.id)) || [],
  }));
}

async function listPatchNotesRecipientsByAccount() {
  const accountResult = await query(
    `
      SELECT id, name
      FROM "Account"
      ORDER BY id ASC
    `,
  );

  const userResult = await query(
    `
      SELECT
        id,
        name,
        email,
        role,
        status,
        "accountId" AS account_id
      FROM "User"
      WHERE status <> 'INACTIVE'
      ORDER BY name ASC NULLS LAST, email ASC
    `,
  );

  const usersByAccount = new Map();
  for (const row of userResult.rows) {
    const key = Number(row.account_id);
    if (!usersByAccount.has(key)) {
      usersByAccount.set(key, []);
    }
    usersByAccount.get(key).push({
      id: Number(row.id),
      name: row.name || null,
      email: row.email,
      role: row.role,
      status: row.status,
    });
  }

  return accountResult.rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    users: usersByAccount.get(Number(row.id)) || [],
  }));
}

async function listUsersByEmailsActive(emails) {
  if (!Array.isArray(emails) || emails.length === 0) {
    return [];
  }

  const result = await query(
    `
      SELECT id, name, email, status
      FROM "User"
      WHERE email = ANY($1::text[])
        AND status <> 'INACTIVE'
    `,
    [emails],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    name: row.name || null,
    email: row.email,
    status: row.status,
  }));
}

async function createReleaseNote(data) {
  const row = await queryOne(
    `
      INSERT INTO "ReleaseNote" (
        version,
        title,
        summary,
        subject,
        html,
        "newFeatures",
        adjustments,
        "recipientCount",
        "sentCount",
        "skippedCount",
        "failedCount",
        "createdByName",
        "createdByEmail",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, NOW(), NOW()
      )
      RETURNING
        id,
        version,
        title,
        summary,
        subject,
        html,
        "newFeatures" AS new_features,
        adjustments,
        "recipientCount" AS recipient_count,
        "sentCount" AS sent_count,
        "skippedCount" AS skipped_count,
        "failedCount" AS failed_count,
        "createdByName" AS created_by_name,
        "createdByEmail" AS created_by_email,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
    `,
    [
      data.version,
      data.title,
      data.summary,
      data.subject,
      data.html,
      JSON.stringify(data.newFeatures || []),
      JSON.stringify(data.adjustments || []),
      data.recipientCount,
      data.sentCount,
      data.skippedCount,
      data.failedCount,
      data.createdByName,
      data.createdByEmail,
    ],
  );

  return mapReleaseNoteRow(row);
}

async function listReleaseNotes(limit = 50) {
  const result = await query(
    `
      SELECT
        id,
        version,
        title,
        summary,
        subject,
        html,
        "newFeatures" AS new_features,
        adjustments,
        "recipientCount" AS recipient_count,
        "sentCount" AS sent_count,
        "skippedCount" AS skipped_count,
        "failedCount" AS failed_count,
        "createdByName" AS created_by_name,
        "createdByEmail" AS created_by_email,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
      FROM "ReleaseNote"
      ORDER BY "createdAt" DESC, id DESC
      LIMIT $1
    `,
    [limit],
  );

  return result.rows.map(mapReleaseNoteRow);
}

async function findReleaseNoteById(id) {
  const row = await queryOne(
    `
      SELECT
        id,
        version,
        title,
        summary,
        subject,
        html,
        "newFeatures" AS new_features,
        adjustments,
        "recipientCount" AS recipient_count,
        "sentCount" AS sent_count,
        "skippedCount" AS skipped_count,
        "failedCount" AS failed_count,
        "createdByName" AS created_by_name,
        "createdByEmail" AS created_by_email,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
      FROM "ReleaseNote"
      WHERE id::text = $1::text
      LIMIT 1
    `,
    [id],
  );

  return mapReleaseNoteRow(row);
}

async function countAdminsByAccountId(accountId) {
  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "User"
      WHERE "accountId" = $1
        AND role = 'ADMIN'
    `,
    [accountId],
  );

  return Number(row?.total || 0);
}

async function updateUserRole(userId, role) {
  const row = await queryOne(
    `
      UPDATE "User"
      SET role = $2, "updatedAt" = NOW()
      WHERE id::text = $1::text
      RETURNING
        id,
        name,
        email,
        role,
        status,
        "accountId" AS account_id,
        "userGlobalId" AS user_global_id
    `,
    [userId, role],
  );

  return mapUserRow(row);
}

async function updateAccountIdentityById(accountId, data) {
  await ensureAccountCompanyProfileColumns();

  const row = await queryOne(
    `
      UPDATE "Account"
      SET
        name = $2,
        "tenantGlobalId" = $3,
        "documentType" = $4,
        "documentNumber" = $5,
        "companyPhotoUrl" = $6,
        "responsibleName" = $7,
        "responsibleContact" = $8,
        "currentMonthGoalCents" = $9,
        "quarterGoalCents" = $10,
        "semesterGoalCents" = $11,
        "annualGoalCents" = $12,
        "updatedAt" = NOW()
      WHERE id::text = $1::text
      RETURNING
        id,
        name,
        "tenantGlobalId" AS tenant_global_id,
        "documentType" AS document_type,
        "documentNumber" AS document_number,
        "companyPhotoUrl" AS company_photo_url,
        "responsibleName" AS responsible_name,
        "responsibleContact" AS responsible_contact,
        "currentMonthGoalCents" AS current_month_goal_cents,
        "quarterGoalCents" AS quarter_goal_cents,
        "semesterGoalCents" AS semester_goal_cents,
        "annualGoalCents" AS annual_goal_cents,
        "createdAt" AS created_at
    `,
    [
      accountId,
      data.name,
      data.tenantGlobalId || null,
      data.documentType || null,
      data.documentNumber || null,
      data.companyPhotoUrl || null,
      data.responsibleName || null,
      data.responsibleContact || null,
      data.currentMonthGoalCents == null ? null : Number(data.currentMonthGoalCents),
      data.quarterGoalCents == null ? null : Number(data.quarterGoalCents),
      data.semesterGoalCents == null ? null : Number(data.semesterGoalCents),
      data.annualGoalCents == null ? null : Number(data.annualGoalCents),
    ],
  );

  return mapAccountRow(row);
}

async function updateUserProfile(userId, data) {
  const fields = [];
  const params = [userId];
  let index = 2;

  if (Object.prototype.hasOwnProperty.call(data, "name")) {
    fields.push(`name = $${index++}`);
    params.push(data.name);
  }

  if (Object.prototype.hasOwnProperty.call(data, "email")) {
    fields.push(`email = $${index++}`);
    params.push(data.email);
  }

  if (Object.prototype.hasOwnProperty.call(data, "passwordHash")) {
    fields.push(`"passwordHash" = $${index++}`);
    params.push(data.passwordHash);
  }

  if (fields.length === 0) {
    return null;
  }

  fields.push(`"updatedAt" = NOW()`);

  const row = await queryOne(
    `
      UPDATE "User"
      SET ${fields.join(", ")}
      WHERE id::text = $1::text
      RETURNING
        id,
        name,
        email,
        role,
        status,
        "accountId" AS account_id,
        "userGlobalId" AS user_global_id,
        "activationExpiresAt" AS activation_expires_at
    `,
    params,
  );

  return mapUserRow(row);
}

async function deleteSessionsByUserId(userId) {
  await query(
    `
      DELETE FROM "Session"
      WHERE "userId" = $1
    `,
    [userId],
  );
}

async function deleteUserById(userId) {
  const row = await queryOne(
    `
      DELETE FROM "User"
      WHERE id::text = $1::text
      RETURNING id
    `,
    [userId],
  );

  return Boolean(row);
}

module.exports = {
  activateUserAccount,
  cleanupAuthAuditBefore,
  countAdminsByAccountId,
  countShopsByAccountId,
  createAccountAndOwnerInvite,
  createInvitedUser,
  createReleaseNote,
  createSessionForUser,
  deleteSessionsByUserId,
  deleteUserById,
  findReleaseNoteById,
  findAccountById,
  findUserByActivationTokenHash,
  findUserByEmail,
  findUserByResetTokenHash,
  findUserInAccountById,
  insertAuthAuditEvent,
  listAccountsWithUsersAndShops,
  listPatchNotesRecipientsByAccount,
  listReleaseNotes,
  listShopsByAccountId,
  listUsersByAccountId,
  listUsersByEmailsActive,
  reserveNextNumericId,
  resetUserPassword,
  updateAccountIdentityById,
  updatePasswordResetRequest,
  updateSessionActiveShopId,
  updateUserInvite,
  updateUserProfile,
  updateUserRole,
};




