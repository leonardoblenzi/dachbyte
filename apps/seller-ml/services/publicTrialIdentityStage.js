"use strict";

const crypto = require("node:crypto");
const { normalizeCompanyCnpj } = require("../../shared/brazilianDocument");

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requiredText(value, error) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(error);
  return normalized;
}

// Only called after the user followed the verification link. Nothing here
// creates an operational marketplace account or starts the Hub trial clock.
async function stageVerifiedMlTrialIdentity(pool, input) {
  const token = requiredText(input.token, "trial_activation_token_required");
  const fullName = requiredText(input.fullName, "trial_full_name_required");
  const companyName = requiredText(input.companyName, "trial_company_name_required");
  const document = normalizeCompanyCnpj(input.documentNumber);
  const passwordHash = requiredText(input.passwordHash, "trial_password_hash_required");
  if (!/^\$2[aby]\$\d{2}\$/.test(passwordHash)) throw new Error("trial_password_hash_invalid");
  const now = input.now instanceof Date ? input.now : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("trial_activation_time_invalid");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessions = await client.query(
      `SELECT s.id, s.email, s.ml_user_id, s.status, s.activation_expires_at,
              s.recovery_expires_at, s.empresa_id, s.usuario_id,
              s.tenant_global_id, s.user_global_id,
              e.nome AS stored_company_name, e.document_type AS stored_document_type,
              e.document_number AS stored_document_number, u.nome AS stored_full_name
         FROM public_trial_oauth_sessions s
         LEFT JOIN empresas e ON e.id = s.empresa_id
         LEFT JOIN usuarios u ON u.id = s.usuario_id
        WHERE s.activation_token_hash = $1
          AND ((s.status IN ('email_pending', 'activation_pending') AND s.activation_expires_at > $2)
            OR (s.status = 'identity_staged' AND s.recovery_expires_at > $2))
        FOR UPDATE OF s`,
      [digest(token), now.toISOString()]
    );
    const session = sessions.rows[0];
    if (!session) throw new Error("trial_activation_invalid_or_expired");
    const mlUserId = Number(session.ml_user_id);
    if (!Number.isSafeInteger(mlUserId) || mlUserId <= 0) {
      throw new Error("trial_ml_account_invalid");
    }
    if (session.status === "identity_staged") {
      if (!session.empresa_id || !session.usuario_id ||
          !session.tenant_global_id || !session.user_global_id ||
          !session.stored_company_name || !session.stored_full_name) {
        throw new Error("trial_identity_stage_corrupt");
      }
      if (session.stored_document_type !== document.type ||
          session.stored_document_number !== document.number) {
        const corrected = await client.query(
          "UPDATE empresas SET document_type = $1, document_number = $2 WHERE id = $3 RETURNING id",
          [document.type, document.number, session.empresa_id]
        );
        if (!corrected.rows[0]) throw new Error("trial_identity_stage_corrupt");
      }
      await client.query("COMMIT");
      return {
        sessionId: session.id, companyId: Number(session.empresa_id),
        userId: Number(session.usuario_id), tenantId: session.tenant_global_id,
        globalUserId: session.user_global_id, email: session.email,
        mlUserId, fullName: session.stored_full_name,
        companyName: session.stored_company_name,
        documentType: document.type, documentNumber: document.number
      };
    }

    const [existingUser, existingAccount] = await Promise.all([
      client.query("SELECT id FROM usuarios WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) LIMIT 1", [session.email]),
      client.query("SELECT id FROM meli_contas WHERE meli_user_id = $1 LIMIT 1", [mlUserId])
    ]);
    if (existingUser.rows[0]) throw new Error("trial_email_login_required");
    if (existingAccount.rows[0]) throw new Error("trial_ml_account_already_linked");

    const tenantId = crypto.randomUUID();
    const globalUserId = crypto.randomUUID();
    const company = await client.query(
      "INSERT INTO empresas (nome, tenant_global_id, document_type, document_number) VALUES ($1, $2, $3, $4) RETURNING id",
      [companyName, tenantId, document.type, document.number]
    );
    const user = await client.query(
      `INSERT INTO usuarios (nome, email, senha_hash, nivel, status, user_global_id)
       VALUES ($1, $2, $3, 'usuario', 'pendente_ativacao', $4) RETURNING id`,
      [fullName, session.email, passwordHash, globalUserId]
    );
    const companyId = Number(company.rows[0]?.id);
    const userId = Number(user.rows[0]?.id);
    if (!Number.isSafeInteger(companyId) || !Number.isSafeInteger(userId)) {
      throw new Error("trial_identity_stage_failed");
    }
    await client.query(
      "INSERT INTO empresa_usuarios (empresa_id, usuario_id, papel) VALUES ($1, $2, 'owner')",
      [companyId, userId]
    );
    const update = await client.query(
      `UPDATE public_trial_oauth_sessions
          SET status = 'identity_staged', empresa_id = $2, usuario_id = $3,
              tenant_global_id = $4, user_global_id = $5,
              recovery_expires_at = $6, updated_at = NOW()
        WHERE id = $1 AND status IN ('email_pending', 'activation_pending')
        RETURNING id`,
      [session.id, companyId, userId, tenantId, globalUserId,
        new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()]
    );
    if (!update.rows[0]) throw new Error("trial_identity_stage_conflict");
    await client.query("COMMIT");
    return {
      sessionId: session.id, companyId, userId, tenantId, globalUserId,
      email: session.email, mlUserId, fullName, companyName,
      documentType: document.type, documentNumber: document.number
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { stageVerifiedMlTrialIdentity };
