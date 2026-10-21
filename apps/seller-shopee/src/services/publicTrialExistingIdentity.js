"use strict";

const crypto = require("node:crypto");

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function stageExistingShopeeIdentity(pool, input) {
  const browserNonce = String(input.browserNonce || "").trim();
  const identity = input.identity || {};
  const email = String(identity.email || "").trim().toLowerCase();
  const tenantId = String(identity.tenantId || "").trim();
  const globalUserId = String(identity.userId || "").trim();
  const fullName = String(identity.fullName || email).trim();
  const companyName = String(identity.companyName || "").trim();
  if (!browserNonce || !email || !tenantId || !globalUserId || !companyName) {
    throw new Error("trial_existing_identity_invalid");
  }
  const reserveId = (...args) => (input.reserveId ||
    require("../repositories/authSqlRepository").reserveNextNumericId)(...args);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT id, status, email, shop_id, shop_db_id, account_id, user_id,
              tenant_global_id, user_global_id, stored_full_name, stored_company_name
         FROM public_trial_oauth_sessions
        WHERE browser_nonce_hash = $1
          AND ((status = 'awaiting_login' AND activation_expires_at > NOW())
            OR (status = 'identity_staged' AND recovery_expires_at > NOW())
            OR status = 'activated')
        FOR UPDATE`, [digest(browserNonce)],
    );
    const session = found.rows[0];
    if (!session || String(session.email || "").toLowerCase() !== email) {
      throw new Error("trial_existing_identity_mismatch");
    }
    const shopId = String(session.shop_id || "");
    if (!/^\d+$/.test(shopId) || BigInt(shopId) <= 0n) throw new Error("trial_shopee_shop_invalid");
    if (session.status === "identity_staged" || session.status === "activated") {
      if (String(session.tenant_global_id) !== tenantId ||
          String(session.user_global_id) !== globalUserId || !session.account_id || !session.user_id ||
          (session.status === "activated" && !session.shop_db_id)) {
        throw new Error("trial_existing_identity_mismatch");
      }
      await client.query("COMMIT");
      return { sessionId: session.id, accountId: session.account_id, userId: session.user_id,
        tenantId, globalUserId, fullName: session.stored_full_name,
        companyName: session.stored_company_name, email, shopId };
    }
    const linkedShop = await client.query('SELECT id FROM "Shop" WHERE "shopId" = $1 LIMIT 1', [shopId]);
    if (linkedShop.rows[0]) throw new Error("trial_shopee_shop_already_linked");
    let account = (await client.query(
      'SELECT id, name FROM "Account" WHERE "tenantGlobalId" = $1 LIMIT 1', [tenantId],
    )).rows[0];
    if (!account) {
      const accountId = await reserveId(client, "Account");
      account = (await client.query(
        'INSERT INTO "Account" (id, name, "tenantGlobalId", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id, name',
        [accountId, companyName, tenantId],
      )).rows[0];
    }
    let user = (await client.query(
      'SELECT id, status, "accountId" AS account_id, "userGlobalId" AS user_global_id FROM "User" WHERE LOWER(email) = $1 LIMIT 1',
      [email],
    )).rows[0];
    if (user && (Number(user.account_id) !== Number(account.id) ||
        (user.user_global_id && String(user.user_global_id) !== globalUserId))) {
      throw new Error("trial_existing_identity_mismatch");
    }
    if (!user) {
      const userId = await reserveId(client, "User");
      const passwordHash = await require("bcrypt").hash(crypto.randomBytes(32).toString("base64url"), 10);
      user = (await client.query(
        `INSERT INTO "User" (id, name, email, "passwordHash", role, status,
          "accountId", "userGlobalId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'ADMIN', 'PENDING', $5, $6, NOW(), NOW())
         RETURNING id, status, "userGlobalId" AS user_global_id`,
        [userId, fullName, email, passwordHash, account.id, globalUserId],
      )).rows[0];
    }
    if (user && !user.user_global_id) {
      const linkedUser = await client.query(
        'UPDATE "User" SET "userGlobalId" = $2, "updatedAt" = NOW() WHERE id = $1 AND "userGlobalId" IS NULL RETURNING id',
        [user.id, globalUserId],
      );
      if (!linkedUser.rows[0]) throw new Error("trial_existing_identity_mismatch");
    }
    if (!user || !["ACTIVE", "PENDING"].includes(String(user.status || "").toUpperCase())) {
      throw new Error("trial_existing_user_inactive");
    }
    const updated = await client.query(
      `UPDATE public_trial_oauth_sessions
          SET status = 'identity_staged', account_id = $2, user_id = $3,
              tenant_global_id = $4, user_global_id = $5,
              stored_full_name = $6, stored_company_name = $7,
              recovery_expires_at = NOW() + INTERVAL '7 days', updated_at = NOW()
        WHERE id = $1 AND status = 'awaiting_login' RETURNING id`,
      [session.id, account.id, user.id, tenantId, globalUserId, fullName, companyName],
    );
    if (!updated.rows[0]) throw new Error("trial_existing_stage_conflict");
    await client.query("COMMIT");
    return { sessionId: session.id, accountId: account.id, userId: user.id,
      tenantId, globalUserId, fullName, companyName, email, shopId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { stageExistingShopeeIdentity };
