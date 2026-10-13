"use strict";

function createMagaluRetirementService({ query, unlinkLocalAccount }) {
  return async function retireMagaluAccount(command) {
    const action = String(command?.action || "");
    const tenantId = String(command?.tenant_id || "").trim();
    const externalId = String(command?.external_account_id || "").trim();
    const resourceKey = String(command?.resource_key || "").trim();
    const actor = String(command?.actor_id || "").trim();
    const reason = String(command?.reason || "").trim();
    const operationId = String(command?.operation_id || "").trim();
    if (!["deactivate", "delete"].includes(action) || !tenantId || !externalId || !actor || !reason || !operationId || resourceKey !== `magalu:${externalId}`) {
      const error = new Error("retirement_invalid_payload");
      error.status = 400;
      throw error;
    }
    const result = await query(
      `select id,status,dach_tenant_id,magalu_tenant_id from magalu.accounts
        where dach_tenant_id=$1 and magalu_tenant_id=$2 limit 1`,
      [tenantId, externalId],
    );
    const account = result.rows[0];
    if (!account) {
      const error = new Error("retirement_account_not_found");
      error.status = 404;
      throw error;
    }
    if (action === "deactivate") {
      if (!["disabled", "revoked"].includes(String(account.status))) {
        await query(
          `update magalu.accounts set status='disabled',catalog_sync_status='idle',updated_at=now()
            where id=$1 and dach_tenant_id=$2 and status<>'revoked'`,
          [Number(account.id), tenantId],
        );
      }
      return { ok: true, state: "disabled" };
    }
    if (!["disabled", "revoked"].includes(String(account.status))) {
      const error = new Error("retirement_not_disabled");
      error.status = 409;
      throw error;
    }
    await unlinkLocalAccount(Number(account.id), tenantId, actor, reason);
    return { ok: true, state: "deleted" };
  };
}

module.exports = { createMagaluRetirementService };
