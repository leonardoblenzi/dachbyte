"use strict";

const crypto = require("node:crypto");

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function confirmHubTrialActivation(input) {
  const tenantId = String(input.tenantId || "").trim();
  const shopId = String(input.shopId || "").trim();
  const resource = input.activation?.resource;
  const endsAt = input.activation?.trial?.endsAt;
  if (!tenantId || !/^\d+$/.test(shopId) ||
      resource?.resource_key !== `shopee:${shopId}` || resource?.tenant_id !== tenantId ||
      resource?.access_policy !== "temporary" || !Number.isFinite(Date.parse(endsAt))) {
    throw new Error("trial_hub_confirmation_invalid");
  }
  return { tenantId, shopId, trialActive: Date.parse(endsAt) > Date.now() };
}

async function stageVerifiedShopeeIdentity(pool, input) {
  const token = String(input.token || "").trim();
  const fullName = String(input.fullName || "").trim();
  const companyName = String(input.companyName || "").trim();
  const passwordHash = String(input.passwordHash || "");
  if (!token || !fullName || !companyName || !/^\$2[aby]\$\d{2}\$/.test(passwordHash)) {
    throw new Error("trial_identity_fields_invalid");
  }
  const reserveId = input.reserveId || require("../repositories/authSqlRepository").reserveNextNumericId;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query(
      `SELECT id, status, email, shop_id, account_id, user_id,
              tenant_global_id, user_global_id, stored_full_name, stored_company_name
         FROM public_trial_oauth_sessions
        WHERE activation_token_hash = $1
          AND ((status = 'email_pending' AND activation_expires_at > NOW())
            OR (status = 'identity_staged' AND recovery_expires_at > NOW()))
        FOR UPDATE`,
      [digest(token)],
    );
    const session = rows.rows[0];
    if (!session) throw new Error("trial_activation_invalid_or_expired");
    const shopId = String(session.shop_id || "");
    if (!/^\d+$/.test(shopId) || BigInt(shopId) <= 0n) throw new Error("trial_shopee_shop_invalid");
    if (session.status === "identity_staged") {
      if (!session.account_id || !session.user_id || !session.tenant_global_id ||
          !session.user_global_id || !session.stored_full_name || !session.stored_company_name) {
        throw new Error("trial_identity_stage_corrupt");
      }
      await client.query("COMMIT");
      return {
        sessionId: session.id, accountId: session.account_id, userId: session.user_id,
        tenantId: session.tenant_global_id, globalUserId: session.user_global_id,
        fullName: session.stored_full_name, companyName: session.stored_company_name,
        email: session.email, shopId,
      };
    }
    const existingUser = await client.query('SELECT id FROM "User" WHERE LOWER(email) = $1 LIMIT 1', [session.email]);
    if (existingUser.rows[0]) throw new Error("trial_email_login_required");
    const existingShop = await client.query('SELECT id FROM "Shop" WHERE "shopId" = $1 LIMIT 1', [shopId]);
    if (existingShop.rows[0]) throw new Error("trial_shopee_shop_already_linked");
    const tenantId = crypto.randomUUID();
    const globalUserId = crypto.randomUUID();
    const accountId = await reserveId(client, "Account");
    await client.query(
      'INSERT INTO "Account" (id, name, "tenantGlobalId", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id',
      [accountId, companyName, tenantId],
    );
    const userId = await reserveId(client, "User");
    await client.query(
      `INSERT INTO "User" (id, name, email, "passwordHash", role, status,
         "accountId", "userGlobalId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'ADMIN', 'PENDING', $5, $6, NOW(), NOW()) RETURNING id`,
      [userId, fullName, session.email, passwordHash, accountId, globalUserId],
    );
    const updated = await client.query(
      `UPDATE public_trial_oauth_sessions
          SET status = 'identity_staged', account_id = $2, user_id = $3,
              tenant_global_id = $4, user_global_id = $5,
              stored_full_name = $6, stored_company_name = $7,
              recovery_expires_at = NOW() + INTERVAL '7 days', updated_at = NOW()
        WHERE id = $1 AND status = 'email_pending' RETURNING id`,
      [session.id, accountId, userId, tenantId, globalUserId, fullName, companyName],
    );
    if (!updated.rows[0]) throw new Error("trial_identity_stage_conflict");
    await client.query("COMMIT");
    return { sessionId: session.id, accountId, userId, tenantId, globalUserId,
      fullName, companyName, email: session.email, shopId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { stageVerifiedShopeeIdentity, confirmHubTrialActivation };
