"use strict";

// O hub de acessos confirmou a contratação de uma conta do Mercado Livre (aceite do
// pós-pago ou pagamento confirmado): a conta entra no módulo ML e fica liberada para
// operar com o plano e a faixa contratados. Idempotente: o hub pode reenviar.

const UNLINKED = ["desvinculada", "revogada", "unlinked", "revoked"];
const CODE = /^[a-z0-9_]{1,60}$/i;

function fail(code, status) {
  return Object.assign(new Error(code), { status });
}

function createMlActivationService({ withClient }) {
  return async function activateMlAccount(command) {
    const tenantId = String(command?.tenant_id || "").trim();
    const externalId = String(command?.external_account_id || "").trim();
    const resourceKey = String(command?.resource_key || "").trim();
    const operationId = String(command?.operation_id || "").trim();
    const planCode = command?.plan_code == null || command.plan_code === "" ? null : String(command.plan_code).trim();
    const rangeCode = command?.range_code == null || command.range_code === "" ? null : String(command.range_code).trim();
    if (String(command?.action || "") !== "activate" || !tenantId || !/^\d{1,20}$/.test(externalId) ||
        resourceKey !== `ml:${externalId}` || !operationId ||
        (planCode && !CODE.test(planCode)) || (rangeCode && !CODE.test(rangeCode))) {
      throw fail("activation_invalid_payload", 400);
    }

    return withClient(async (client) => {
      await client.query("begin");
      try {
        const selected = await client.query(
          `select mc.id, mc.empresa_id, mc.status
             from meli_contas mc join empresas e on e.id = mc.empresa_id
            where mc.meli_user_id = $1 and e.tenant_global_id = $2
            limit 1 for update of mc`,
          [externalId, tenantId],
        );
        const account = selected.rows[0];
        if (!account) throw fail("activation_account_not_found", 404);
        if (UNLINKED.includes(String(account.status || "").toLowerCase())) throw fail("activation_account_unlinked", 409);

        await client.query(
          `insert into ml.meli_conta_produtos (meli_conta_id, produto, ativado_por)
           values ($1, 'ml', $2) on conflict (meli_conta_id, produto) do nothing`,
          [account.id, `hub_activation:${operationId.slice(0, 80)}`],
        );
        await client.query(
          `update meli_contas
              set billing_status = 'active',
                  billing_mode = 'paid',
                  plan_code = coalesce($2, plan_code),
                  order_range_code = coalesce($3, order_range_code),
                  billing_grace_expires_at = null,
                  atualizado_em = now()
            where id = $1`,
          [account.id, planCode, rangeCode],
        );
        await client.query("commit");
        return { ok: true, state: "active", meli_conta_id: Number(account.id) };
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    });
  };
}

module.exports = { createMlActivationService };
