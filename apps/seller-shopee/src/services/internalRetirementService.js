"use strict";

function createShopeeRetirementService({ withClient }) {
  return async function retireShopeeAccount(command) {
    const action = String(command?.action || "");
    const tenantId = String(command?.tenant_id || "").trim();
    const externalId = String(command?.external_account_id || "").trim();
    const resourceKey = String(command?.resource_key || "").trim();
    if (!["deactivate", "delete"].includes(action) || !tenantId || !/^\d+$/.test(externalId) ||
        resourceKey !== `shopee:${externalId}` || !String(command?.actor_id || "").trim() ||
        !String(command?.reason || "").trim() || !String(command?.operation_id || "").trim()) {
      const error = new Error("retirement_invalid_payload");
      error.status = 400;
      throw error;
    }
    return withClient(async (client) => {
      await client.query("begin");
      try {
        const selected = await client.query(
          `SELECT s.id,s."shopId",s.status,a."tenantGlobalId"
             FROM "Shop" s JOIN "Account" a ON a.id=s."accountId"
            WHERE s."shopId"=$1 AND a."tenantGlobalId"=$2
            LIMIT 1 FOR UPDATE OF s`,
          [externalId, tenantId],
        );
        const shop = selected.rows[0];
        if (!shop) {
          const error = new Error("retirement_account_not_found");
          error.status = 404;
          throw error;
        }
        if (action === "delete" && String(shop.status).toUpperCase() !== "INACTIVE") {
          const error = new Error("retirement_not_disabled");
          error.status = 409;
          throw error;
        }
        if (String(shop.status).toUpperCase() !== "INACTIVE") {
          await client.query(`UPDATE "Shop" SET status = 'INACTIVE', "updatedAt"=NOW() WHERE id=$1`, [shop.id]);
        }
        await client.query(`DELETE FROM "OAuthToken" WHERE "shopId"=$1`, [shop.id]);
        await client.query("commit");
        return { ok: true, state: action === "deactivate" ? "disabled" : "deleted" };
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    });
  };
}

module.exports = { createShopeeRetirementService };
