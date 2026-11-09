"use strict";

function createMlRetirementService({ withClient }) {
  return async function retireMlAccount(command) {
    const action = String(command?.action || "");
    const tenantId = String(command?.tenant_id || "").trim();
    const externalId = String(command?.external_account_id || "").trim();
    const resourceKey = String(command?.resource_key || "").trim();
    if (!["deactivate", "delete"].includes(action) || !tenantId || !externalId ||
        resourceKey !== `ml:${externalId}` || !String(command?.actor_id || "").trim() ||
        !String(command?.reason || "").trim() || !String(command?.operation_id || "").trim()) {
      const error = new Error("retirement_invalid_payload");
      error.status = 400;
      throw error;
    }
    return withClient(async (client) => {
      await client.query("begin");
      try {
        const selected = await client.query(
          `select mc.id,mc.empresa_id,mc.status,mc.meli_user_id,e.tenant_global_id
             from meli_contas mc join empresas e on e.id=mc.empresa_id
            where mc.meli_user_id=$1 and e.tenant_global_id=$2
            limit 1 for update of mc`,
          [externalId, tenantId],
        );
        const account = selected.rows[0];
        if (!account) {
          const error = new Error("retirement_account_not_found");
          error.status = 404;
          throw error;
        }
        const unlinked = ["desvinculada", "revogada", "unlinked", "revoked"].includes(String(account.status).toLowerCase());
        // Conexão única: se outro produto (DACH Hub) usa a conta, o módulo ML só
        // sai dela; a conexão e as chaves continuam para o outro produto.
        const others = await client.query(
          `select 1 from ml.meli_conta_produtos where meli_conta_id=$1 and produto <> 'ml' limit 1`,
          [account.id],
        );
        const keepConnection = others.rows.length > 0;
        const mlActive = (await client.query(
          `select 1 from ml.meli_conta_produtos where meli_conta_id=$1 and produto='ml' limit 1`,
          [account.id],
        )).rows.length > 0;
        if (action === "delete" && !unlinked && !(keepConnection && !mlActive)) {
          const error = new Error("retirement_not_disabled");
          error.status = 409;
          throw error;
        }
        await client.query(`delete from ml.meli_conta_produtos where meli_conta_id=$1 and produto='ml'`, [account.id]);
        if (!unlinked) {
          await client.query(
            `update meli_contas set status = case when $2::boolean then status else 'desvinculada' end,
                    billing_status='awaiting_subscription', atualizado_em=now() where id=$1`,
            [account.id, keepConnection],
          );
        }
        if (!keepConnection) await client.query(`delete from meli_tokens where meli_conta_id=$1`, [account.id]);
        await client.query(
          `update empresa_usuarios set default_meli_conta_id=null
            where empresa_id=$1 and default_meli_conta_id=$2`,
          [account.empresa_id, account.id],
        );
        await client.query("commit");
        return { ok: true, state: action === "deactivate" ? "disabled" : "deleted" };
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    });
  };
}

module.exports = { createMlRetirementService };
