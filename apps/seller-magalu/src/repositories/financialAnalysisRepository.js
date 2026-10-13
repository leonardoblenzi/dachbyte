"use strict";

const db = require("../config/postgres");

async function upsert(accountId, row, client = db) {
  await client.query(`insert into magalu.order_financial_reports (
    account_id,order_code,report_id,remote_updated_at,transaction_count,sale,commission,fees,
    shipping_net,promotion_net,subsidy,discount_net,refund_net,other_net,ignored_absolute_discount,net_receivable
  ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
  on conflict(account_id,order_code) do update set
    report_id=excluded.report_id,remote_updated_at=excluded.remote_updated_at,
    transaction_count=excluded.transaction_count,sale=excluded.sale,commission=excluded.commission,
    fees=excluded.fees,shipping_net=excluded.shipping_net,promotion_net=excluded.promotion_net,
    subsidy=excluded.subsidy,discount_net=excluded.discount_net,refund_net=excluded.refund_net,
    other_net=excluded.other_net,ignored_absolute_discount=excluded.ignored_absolute_discount,
    net_receivable=excluded.net_receivable,fetched_at=now()`, [
    Number(accountId),row.orderCode,row.reportId||null,row.remoteUpdatedAt||null,row.transactionCount,
    row.sale,row.commission,row.fees,row.shippingNet,row.promotionNet,row.subsidy,row.discountNet,
    row.refundNet,row.otherNet,row.ignoredAbsoluteDiscount,row.netReceivable,
  ]);
}

async function upsertBatch(accountId, rows) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      for (const row of rows) await upsert(accountId, row, client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

module.exports = { upsert, upsertBatch };
