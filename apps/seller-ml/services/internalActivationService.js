"use strict";

// O hub de acessos decide se uma conta do Mercado Livre pode operar e avisa o módulo:
// - activate: contratação confirmada, renovação paga ou contestação revertida. A conta
//   entra no módulo ML e fica liberada com o plano e a faixa contratados;
// - suspend: atraso depois do período pago, estorno, contestação ou período vencido.
//   Só desliga conta paga; teste grátis, legado, cortesia e interna seguem a regra local.
// Idempotente: o hub repete o aviso até receber confirmação.

const UNLINKED = ["desvinculada", "revogada", "unlinked", "revoked"];
const CODE = /^[a-z0-9_]{1,60}$/i;
const SUSPEND_REASONS = new Set(["chargeback", "refunded", "past_due", "expired", "suspended_by_payment"]);
const UNLIMITED_STATUSES = ["legacy_active", "courtesy_unlimited", "internal_unlimited"];

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
    const action = String(command?.action || "");
    const reason = String(command?.reason || "");
    if (!["activate", "suspend"].includes(action) || !tenantId || !/^\d{1,20}$/.test(externalId) ||
        resourceKey !== `ml:${externalId}` || !operationId ||
        (action === "suspend" && !SUSPEND_REASONS.has(reason)) ||
        (planCode && !CODE.test(planCode)) || (rangeCode && !CODE.test(rangeCode))) {
      throw fail("activation_invalid_payload", 400);
    }

    return withClient(async (client) => {
      await client.query("begin");
      try {
        const selected = await client.query(
          `select mc.id, mc.empresa_id, mc.status, mc.billing_status, mc.billing_mode, mc.usage_policy
             from meli_contas mc join empresas e on e.id = mc.empresa_id
            where mc.meli_user_id = $1 and e.tenant_global_id = $2
            limit 1 for update of mc`,
          [externalId, tenantId],
        );
        const account = selected.rows[0];
        if (!account) throw fail("activation_account_not_found", 404);
        if (UNLINKED.includes(String(account.status || "").toLowerCase())) throw fail("activation_account_unlinked", 409);

        if (action === "suspend") {
          const paidAccount = String(account.billing_mode || "").toLowerCase() === "paid" &&
            String(account.usage_policy || "").toLowerCase() !== "unlimited" &&
            !UNLIMITED_STATUSES.includes(String(account.billing_status || "").toLowerCase());
          if (!paidAccount) {
            await client.query("commit");
            return { ok: true, state: "unchanged", meli_conta_id: Number(account.id) };
          }
          await client.query(
            `update meli_contas
                set billing_status = $2,
                    billing_grace_expires_at = null,
                    billing_updated_at = now(),
                    atualizado_em = now()
              where id = $1`,
            [account.id, reason],
          );
          await client.query("commit");
          return { ok: true, state: "suspended", meli_conta_id: Number(account.id) };
        }

        await client.query(
          `insert into ml.meli_conta_produtos (meli_conta_id, produto, ativado_por)
           values ($1, 'ml', $2) on conflict (meli_conta_id, produto) do nothing`,
          [account.id, `hub_activation:${operationId.slice(0, 80)}`],
        );
        await client.query(
          `update meli_contas
              set billing_status = 'active',
                  billing_mode = 'paid',
                  usage_policy = 'metered',
                  plan_code = coalesce($2, plan_code),
                  order_range_code = coalesce($3, order_range_code),
                  billing_grace_expires_at = null,
                  billing_updated_at = now(),
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
