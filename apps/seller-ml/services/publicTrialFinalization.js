"use strict";

function confirmHubActivation(input) {
  const sessionId = String(input.sessionId || "").trim();
  const tenantId = String(input.tenantId || "").trim();
  const mlUserId = Number(input.mlUserId);
  const resource = input.activation?.resource;
  const trial = input.activation?.trial;
  if (!sessionId || !tenantId || !Number.isSafeInteger(mlUserId) || mlUserId <= 0 ||
      resource?.resource_key !== `ml:${mlUserId}` || resource?.tenant_id !== tenantId ||
      resource?.access_policy !== "temporary" || !Number.isFinite(Date.parse(trial?.endsAt))) {
    throw new Error("trial_hub_confirmation_invalid");
  }
  return { sessionId, tenantId, mlUserId };
}

// Hub's trial resource must already be committed. The local account, its OAuth
// tokens and the login become operational together; a failed transaction can
// be retried against the original Hub clock.
async function finalizeConfirmedMlTrial(pool, input) {
  const { sessionId, tenantId, mlUserId } = confirmHubActivation(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT id, status, empresa_id, usuario_id, meli_conta_id, tenant_global_id,
              ml_user_id, access_token_enc, refresh_token_enc, access_expires_at, scope
         FROM public_trial_oauth_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );
    const session = result.rows[0];
    if (!session || String(session.tenant_global_id) !== tenantId ||
        Number(session.ml_user_id) !== mlUserId) {
      throw new Error("trial_local_identity_mismatch");
    }
    if (session.status === "activated" && session.meli_conta_id) {
      await client.query("COMMIT");
      return { accountId: Number(session.meli_conta_id), alreadyActivated: true };
    }
    if (!["identity_staged", "existing_identity_staged"].includes(session.status) ||
        !session.empresa_id || !session.usuario_id ||
        !String(session.access_token_enc || "").startsWith("enc::v1::") ||
        !String(session.refresh_token_enc || "").startsWith("enc::v1::") ||
        !Number.isFinite(Date.parse(session.access_expires_at))) {
      throw new Error("trial_local_stage_invalid");
    }
    const existing = await client.query(
      "SELECT id FROM meli_contas WHERE meli_user_id = $1 LIMIT 1", [mlUserId]
    );
    if (existing.rows[0]) throw new Error("trial_ml_account_already_linked");
    const created = await client.query(
      `INSERT INTO meli_contas
         (empresa_id, meli_user_id, apelido, site_id, status,
          billing_status, billing_mode, usage_policy, range_enforcement)
       VALUES ($1, $2, $3, 'MLB', 'ativa', 'active', 'trial', 'unlimited', false)
       RETURNING id`,
      [session.empresa_id, mlUserId, `Conta ${mlUserId}`]
    );
    const accountId = Number(created.rows[0]?.id);
    if (!Number.isSafeInteger(accountId)) throw new Error("trial_local_account_creation_failed");
    await client.query(
      `INSERT INTO meli_tokens
         (meli_conta_id, access_token, access_expires_at, refresh_token,
          scope, refresh_obtido_em, ultimo_refresh_em)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [accountId, session.access_token_enc, session.access_expires_at,
        session.refresh_token_enc, session.scope]
    );
    if (session.status === "identity_staged") {
      const user = await client.query(
        `UPDATE usuarios SET status = 'ativo', activated_at = NOW()
          WHERE id = $1 AND status = 'pendente_ativacao' RETURNING id`,
        [session.usuario_id]
      );
      if (!user.rows[0]) throw new Error("trial_local_user_activation_failed");
    }
    const updated = await client.query(
      `UPDATE public_trial_oauth_sessions
          SET status = 'activated', meli_conta_id = $2,
              activation_token_hash = NULL, access_token_enc = NULL,
              refresh_token_enc = NULL, activated_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status IN ('identity_staged', 'existing_identity_staged') RETURNING id`,
      [sessionId, accountId]
    );
    if (!updated.rows[0]) throw new Error("trial_local_activation_conflict");
    await client.query("COMMIT");
    return { accountId, alreadyActivated: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { finalizeConfirmedMlTrial };
