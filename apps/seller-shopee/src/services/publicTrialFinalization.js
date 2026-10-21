"use strict";

const { decryptTrialToken } = require("./publicTrialOAuthSession");
const { confirmHubTrialActivation } = require("./publicTrialNewIdentity");

async function finalizeShopeeTrial(pool, input) {
  const sessionId = String(input.sessionId || "").trim();
  const confirmed = confirmHubTrialActivation(input);
  if (!sessionId) throw new Error("trial_local_session_invalid");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT id, status, account_id, user_id, shop_db_id, tenant_global_id,
              shop_id, access_token_enc, refresh_token_enc,
              access_expires_at, refresh_expires_at
         FROM public_trial_oauth_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId],
    );
    const session = result.rows[0];
    if (!session || String(session.tenant_global_id) !== confirmed.tenantId ||
        String(session.shop_id) !== confirmed.shopId) throw new Error("trial_local_identity_mismatch");
    if (session.status === "activated" && session.shop_db_id) {
      await client.query("COMMIT");
      return { shopDbId: Number(session.shop_db_id), alreadyActivated: true,
        trialActive: confirmed.trialActive };
    }
    if (session.status !== "identity_staged" || !session.account_id || !session.user_id ||
        !session.access_token_enc || !session.refresh_token_enc) {
      throw new Error("trial_local_stage_invalid");
    }
    const users = await client.query(
      'SELECT id, status, "accountId" AS account_id FROM "User" WHERE id = $1 FOR UPDATE',
      [session.user_id],
    );
    const existingUser = users.rows[0];
    if (!existingUser || Number(existingUser.account_id) !== Number(session.account_id) ||
        !["ACTIVE", "PENDING"].includes(String(existingUser.status || "").toUpperCase())) {
      throw new Error("trial_local_user_mismatch");
    }
    const existing = await client.query('SELECT id FROM "Shop" WHERE "shopId" = $1 LIMIT 1',
      [confirmed.shopId]);
    if (existing.rows[0]) throw new Error("trial_shopee_shop_already_linked");
    const shop = await client.query(
      `INSERT INTO "Shop" ("accountId", "shopId", status, "createdAt", "updatedAt")
       VALUES ($1, $2, 'AUTHORIZED', NOW(), NOW()) RETURNING id`,
      [session.account_id, confirmed.shopId],
    );
    const shopDbId = Number(shop.rows[0]?.id);
    if (!Number.isSafeInteger(shopDbId) || shopDbId <= 0) throw new Error("trial_local_shop_creation_failed");
    await client.query(
      `INSERT INTO "OAuthToken" ("shopId", "accessToken", "accessTokenExpiresAt",
         "refreshToken", "refreshTokenExpiresAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [shopDbId, decryptTrialToken(session.access_token_enc, input.encryptionKey),
        session.access_expires_at || null,
        decryptTrialToken(session.refresh_token_enc, input.encryptionKey),
        session.refresh_expires_at || null],
    );
    if (String(existingUser.status).toUpperCase() === "PENDING") {
      const user = await client.query(
        `UPDATE "User" SET status = 'ACTIVE', "activatedAt" = NOW(), "updatedAt" = NOW()
          WHERE id = $1 AND status = 'PENDING' RETURNING id`,
        [session.user_id],
      );
      if (!user.rows[0]) throw new Error("trial_local_user_activation_failed");
    }
    const updated = await client.query(
      `UPDATE public_trial_oauth_sessions
          SET status = 'activated', shop_db_id = $2,
              activation_token_hash = NULL, access_token_enc = NULL,
              refresh_token_enc = NULL, updated_at = NOW()
        WHERE id = $1 AND status = 'identity_staged' RETURNING id`,
      [sessionId, shopDbId],
    );
    if (!updated.rows[0]) throw new Error("trial_local_activation_conflict");
    await client.query("COMMIT");
    return { shopDbId, alreadyActivated: false, trialActive: confirmed.trialActive };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { finalizeShopeeTrial };
