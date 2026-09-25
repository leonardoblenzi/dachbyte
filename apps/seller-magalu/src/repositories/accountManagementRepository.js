"use strict";

const db = require("../config/postgres");

const BLOCKING_WRITE_STATES = ["queued", "running", "dispatching", "accepted", "divergent", "uncertain"];

async function blockingWrites(accountId, dachTenantId) {
  const { rows } = await db.query(
    `select id,status,resource_type,sku,created_at,updated_at
       from magalu.write_operations
      where account_id=$1 and dach_tenant_id=$2 and status = any($3::text[])
      order by created_at asc`,
    [Number(accountId), String(dachTenantId), BLOCKING_WRITE_STATES],
  );
  return rows;
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

      const blockers = (await client.query(
        `select id,status,resource_type,sku,created_at,updated_at
           from magalu.write_operations
          where account_id=$1 and dach_tenant_id=$2 and status = any($3::text[])
          order by created_at asc for update`,
        [Number(accountId), String(dachTenantId), BLOCKING_WRITE_STATES],
      )).rows;
      if (blockers.length) {
        const error = new Error("Existe uma alteração de preço/estoque ainda pendente de confirmação. Reverifique a operação antes de desvincular a conta.");
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
      await client.query(
        `insert into magalu.audit_events(account_id,dach_tenant_id,dach_user_id,action,details)
         values($1,$2,$3,'ACCOUNT_UNLINKED',$4::jsonb)`,
        [Number(accountId), String(dachTenantId), String(dachUserId || ""), JSON.stringify({ reason: String(reason || "") })],
      );

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

module.exports = { blockingWrites, unlinkLocalAccount, recordHubUnlinkResult, BLOCKING_WRITE_STATES };
