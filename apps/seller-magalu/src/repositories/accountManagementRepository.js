"use strict";

const db = require("../config/postgres");
const { appendAuditEvent } = require("./auditRepository");

const BLOCKING_WRITE_STATES = ["queued", "running", "dispatching", "accepted", "divergent", "uncertain"];

async function tableColumns(queryable, tableName) {
  const { rows } = await queryable.query(
    `select column_name from information_schema.columns where table_schema='magalu' and table_name=$1`,
    [String(tableName)],
  );
  return new Set(rows.map((row) => String(row.column_name)));
}

async function massOperationBlockers(queryable, accountId, dachTenantId, { lock = false } = {}) {
  const relation = await queryable.query(`select to_regclass('magalu.mass_operation_items')::text as items, to_regclass('magalu.mass_operation_batches')::text as batches`);
  const state = relation.rows[0] || {};
  if (!state.items) return [];

  const itemColumns = await tableColumns(queryable, "mass_operation_items");
  const batchColumns = state.batches ? await tableColumns(queryable, "mass_operation_batches") : new Set();
  const suffix = lock ? " for update of i" : "";

  if (!itemColumns.has("status")) {
    return [{
      source: "mass_operation_item",
      status: "schema_unknown",
      code: "MAGALU_MASS_OPERATION_SCHEMA_UNSUPPORTED",
      message: "A tabela de operações massivas não possui coluna de status reconhecível para o bloqueio seguro.",
    }];
  }

  if (itemColumns.has("account_id")) {
    const tenantClause = itemColumns.has("dach_tenant_id") ? " and i.dach_tenant_id=$3" : "";
    const params = itemColumns.has("dach_tenant_id")
      ? [Number(accountId), BLOCKING_WRITE_STATES, String(dachTenantId)]
      : [Number(accountId), BLOCKING_WRITE_STATES];
    const fields = ["i.id", "i.status"];
    if (itemColumns.has("sku")) fields.push("i.sku");
    if (itemColumns.has("batch_id")) fields.push("i.batch_id");
    if (itemColumns.has("created_at")) fields.push("i.created_at");
    if (itemColumns.has("updated_at")) fields.push("i.updated_at");
    const { rows } = await queryable.query(
      `select ${fields.join(",")} from magalu.mass_operation_items i
        where i.account_id=$1 and i.status = any($2::text[])${tenantClause}
        order by i.id asc${suffix}`,
      params,
    );
    return rows.map((row) => ({ source: "mass_operation_item", ...row }));
  }

  if (itemColumns.has("batch_id") && state.batches && batchColumns.has("id") && batchColumns.has("account_id")) {
    const tenantClause = batchColumns.has("dach_tenant_id") ? " and b.dach_tenant_id=$3" : "";
    const params = batchColumns.has("dach_tenant_id")
      ? [Number(accountId), BLOCKING_WRITE_STATES, String(dachTenantId)]
      : [Number(accountId), BLOCKING_WRITE_STATES];
    const fields = ["i.id", "i.status", "i.batch_id"];
    if (itemColumns.has("sku")) fields.push("i.sku");
    if (itemColumns.has("created_at")) fields.push("i.created_at");
    if (itemColumns.has("updated_at")) fields.push("i.updated_at");
    const { rows } = await queryable.query(
      `select ${fields.join(",")} from magalu.mass_operation_items i
        join magalu.mass_operation_batches b on b.id=i.batch_id
       where b.account_id=$1 and i.status = any($2::text[])${tenantClause}
       order by i.id asc${suffix}`,
      params,
    );
    return rows.map((row) => ({ source: "mass_operation_item", ...row }));
  }

  // A tabela futura existe, mas o vínculo conta->item não é reconhecido. Em
  // uma ação destrutiva a escolha segura é bloquear, nunca presumir ausência.
  return [{
    source: "mass_operation_item",
    status: "schema_unknown",
    code: "MAGALU_MASS_OPERATION_SCHEMA_UNSUPPORTED",
    message: "A tabela de operações massivas existe, mas o vínculo com a conta não pôde ser verificado com segurança.",
  }];
}

async function blockingWrites(accountId, dachTenantId) {
  const { rows } = await db.query(
    `select id,status,resource_type,sku,created_at,updated_at
       from magalu.write_operations
      where account_id=$1 and dach_tenant_id=$2 and status = any($3::text[])
      order by created_at asc`,
    [Number(accountId), String(dachTenantId), BLOCKING_WRITE_STATES],
  );
  const mass = await massOperationBlockers(db, accountId, dachTenantId);
  return [
    ...rows.map((row) => ({ source: "write_operation", ...row })),
    ...mass,
  ];
}

async function unlinkLocalAccount(accountId, dachTenantId, dachUserId, reason) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const account = (await client.query(
        `select * from magalu.accounts where id=$1 and dach_tenant_id=$2 limit 1 for update`,
        [Number(accountId), String(dachTenantId)],
      )).rows[0] || null;
      if (!account) {
        const error = new Error("Conta Magalu não encontrada para esta empresa.");
        error.code = "MAGALU_ACCOUNT_NOT_FOUND";
        error.status = 404;
        throw error;
      }

      const currentWrites = (await client.query(
        `select id,status,resource_type,sku,created_at,updated_at
           from magalu.write_operations
          where account_id=$1 and dach_tenant_id=$2 and status = any($3::text[])
          order by created_at asc for update`,
        [Number(accountId), String(dachTenantId), BLOCKING_WRITE_STATES],
      )).rows.map((row) => ({ source: "write_operation", ...row }));
      const massWrites = await massOperationBlockers(client, accountId, dachTenantId, { lock: true });
      const blockers = [...currentWrites, ...massWrites];
      if (blockers.length) {
        const error = new Error("Existem operações Magalu ainda pendentes ou ambíguas. Reverifique/conclua as operações antes de desvincular a conta.");
        error.code = "MAGALU_ACCOUNT_UNLINK_BLOCKED_BY_WRITE";
        error.status = 409;
        error.blockers = blockers;
        throw error;
      }

      if (String(account.status).toLowerCase() !== "revoked") {
        await client.query(
          `update magalu.accounts
              set status='revoked', revoked_at=now(), catalog_sync_status='idle', catalog_last_error=null,
                  metadata=coalesce(metadata,'{}'::jsonb) || $3::jsonb, updated_at=now()
            where id=$1 and dach_tenant_id=$2`,
          [Number(accountId), String(dachTenantId), JSON.stringify({
            unlink: { at: new Date().toISOString(), by_user_id: String(dachUserId || ""), reason: String(reason || "") },
          })],
        );
      }

      const deletedTokens = await client.query(`delete from magalu.tokens where account_id=$1`, [Number(accountId)]);
      const disabledWebhooks = await client.query(
        `update magalu.webhook_subscriptions set status='disabled',updated_at=now() where account_id=$1 and status <> 'disabled'`,
        [Number(accountId)],
      );
      await appendAuditEvent({
        accountId: Number(accountId),
        dachTenantId: String(dachTenantId),
        dachUserId: String(dachUserId || ""),
        magaluTenantId: account.magalu_tenant_id,
        action: "ACCOUNT_UNLINKED",
        category: "account",
        outcome: "success",
        source: "account-management",
        details: { reason: String(reason || "") },
      }, { client });

      const replacement = (await client.query(
        `select id from magalu.accounts where dach_tenant_id=$1 and id<>$2 and status='active'
          order by last_oauth_at desc nulls last, connected_at desc nulls last, id asc limit 1`,
        [String(dachTenantId), Number(accountId)],
      )).rows[0] || null;

      await client.query("commit");
      return {
        account,
        replacementAccountId: replacement?.id || null,
        deletedTokens: Number(deletedTokens.rowCount || 0),
        disabledWebhooks: Number(disabledWebhooks.rowCount || 0),
        alreadyRevoked: String(account.status).toLowerCase() === "revoked",
      };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function recordHubUnlinkResult(accountId, result) {
  const payload = result?.ok
    ? { status: "ok", at: new Date().toISOString() }
    : { status: "failed", at: new Date().toISOString(), error: String(result?.error || "hub_unlink_failed").slice(0, 500) };
  await db.query(
    `update magalu.accounts
        set metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{hub_unlink}',$2::jsonb,true),updated_at=now()
      where id=$1`,
    [Number(accountId), JSON.stringify(payload)],
  );
}

module.exports = {
  blockingWrites,
  unlinkLocalAccount,
  recordHubUnlinkResult,
  BLOCKING_WRITE_STATES,
  _test: { massOperationBlockers, tableColumns },
};
