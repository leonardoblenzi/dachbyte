"use strict";

const crypto = require("node:crypto");

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function loadAuthenticatedUser(client, userId, email) {
  const result = await client.query(
    "SELECT id, email, nome, status, user_global_id FROM usuarios WHERE id = $1 LIMIT 1",
    [userId]
  );
  const user = result.rows[0];
  if (!user || String(user.email || "").trim().toLowerCase() !==
      String(email || "").trim().toLowerCase() || user.status !== "ativo") {
    throw new Error("trial_login_email_mismatch");
  }
  return user;
}

async function listExistingTrialCompanies(db, input) {
  const nonce = String(input.browserNonce || "").trim();
  const userId = validId(input.userId);
  if (!nonce || !userId) throw new Error("trial_login_required");
  const result = await db.query(
    `SELECT id, email, status FROM public_trial_oauth_sessions
      WHERE browser_nonce_hash = $1 AND status IN ('awaiting_login', 'existing_identity_staged')
        AND (activation_expires_at > NOW() OR recovery_expires_at > NOW())
      LIMIT 1`,
    [digest(nonce)]
  );
  const session = result.rows[0];
  if (!session) throw new Error("trial_oauth_session_not_confirmed");
  await loadAuthenticatedUser(db, userId, session.email);
  const memberships = await db.query(
    `SELECT e.id, e.nome FROM empresa_usuarios eu
       JOIN empresas e ON e.id = eu.empresa_id
      WHERE eu.usuario_id = $1 ORDER BY e.nome, e.id`,
    [userId]
  );
  return { companies: memberships.rows.map((row) => ({
    id: Number(row.id), name: String(row.nome || "")
  })) };
}

async function stageExistingMlTrialLink(pool, input) {
  const nonce = String(input.browserNonce || "").trim();
  const userId = validId(input.userId);
  const companyId = validId(input.companyId);
  const now = input.now instanceof Date ? input.now : new Date();
  if (!nonce || !userId || !companyId || !Number.isFinite(now.getTime())) {
    throw new Error("trial_existing_link_invalid");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessions = await client.query(
      `SELECT id, email, ml_user_id, status, activation_expires_at,
              recovery_expires_at, empresa_id, usuario_id
         FROM public_trial_oauth_sessions
        WHERE browser_nonce_hash = $1
          AND ((status = 'awaiting_login' AND activation_expires_at > $2)
            OR (status = 'existing_identity_staged' AND recovery_expires_at > $2))
        FOR UPDATE`,
      [digest(nonce), now.toISOString()]
    );
    const session = sessions.rows[0];
    if (!session) throw new Error("trial_oauth_session_not_confirmed");
    if (session.status === "existing_identity_staged" &&
        (Number(session.empresa_id) !== companyId || Number(session.usuario_id) !== userId)) {
      throw new Error("trial_existing_link_already_claimed");
    }
    const user = await loadAuthenticatedUser(client, userId, session.email);
    const memberships = await client.query(
      `SELECT e.id, e.nome, e.tenant_global_id, eu.papel
         FROM empresa_usuarios eu JOIN empresas e ON e.id = eu.empresa_id
        WHERE eu.usuario_id = $1 AND eu.empresa_id = $2 LIMIT 1`,
      [userId, companyId]
    );
    const company = memberships.rows[0];
    if (!company) throw new Error("trial_company_membership_required");
    if (!company.tenant_global_id || !user.user_global_id) {
      throw new Error("trial_existing_identity_missing_global_ids");
    }
    const mlUserId = Number(session.ml_user_id);
    if (!Number.isSafeInteger(mlUserId) || mlUserId <= 0) {
      throw new Error("trial_ml_account_invalid");
    }
    if (session.status === "awaiting_login") {
      const existing = await client.query(
        "SELECT id FROM meli_contas WHERE meli_user_id = $1 LIMIT 1", [mlUserId]
      );
      if (existing.rows[0]) throw new Error("trial_ml_account_already_linked");
      const staged = await client.query(
        `UPDATE public_trial_oauth_sessions
            SET status = 'existing_identity_staged', empresa_id = $2, usuario_id = $3,
                tenant_global_id = $4, user_global_id = $5,
                recovery_expires_at = $6, updated_at = NOW()
          WHERE id = $1 AND status = 'awaiting_login' RETURNING id`,
        [session.id, companyId, userId, company.tenant_global_id, user.user_global_id,
          new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()]
      );
      if (!staged.rows[0]) throw new Error("trial_existing_link_conflict");
    }
    await client.query("COMMIT");
    return {
      sessionId: session.id, companyId, userId,
      tenantId: company.tenant_global_id, globalUserId: user.user_global_id,
      companyName: company.nome, fullName: user.nome, email: user.email,
      mlUserId, role: company.papel
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { listExistingTrialCompanies, stageExistingMlTrialLink };
