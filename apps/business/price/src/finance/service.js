"use strict";

const { withTenant } = require("../db");
const { audit } = require("../audit");
const { redactForStorage } = require("../redact");
const { normalizeFeeResult, amount } = require("./fees");
const { calculateProfit, extractOrderItems, allocateItems } = require("./profit");

async function cachedFee(auth, channel, orderId, maxAgeHours, connectionId = null) {
  return withTenant(auth.tenantId, auth.userId, async (client) => (await client.query(
    `SELECT * FROM volt_price.fee_snapshots WHERE channel=$1 AND external_order_id=$2 AND is_current
     AND fetched_at>now()-($3::text||' hours')::interval
     AND ($4::text IS NULL OR raw_data->>'connectionId'=$4::text)
     LIMIT 1`,
    [channel, String(orderId), String(maxAgeHours), connectionId ? String(connectionId) : null],
  )).rows[0] || null);
}

async function saveFeeSnapshot(auth, result) {
  const normalized = normalizeFeeResult(result);
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const current = (await client.query(
      "SELECT * FROM volt_price.fee_snapshots WHERE channel=$1 AND external_order_id=$2 AND is_current FOR UPDATE",
      [result.channel, String(result.orderId)],
    )).rows[0] || null;
    if (current?.fingerprint === normalized.fingerprint) return { snapshot: current, created: false };
    const version = Number(current?.version || 0) + 1;
    if (current) await client.query("UPDATE volt_price.fee_snapshots SET is_current=false WHERE id=$1", [current.id]);
    const snapshot = (await client.query(
      `INSERT INTO volt_price.fee_snapshots
       (tenant_id,channel,external_order_id,summary,raw_data,version,fingerprint,currency,components,total_amount,supersedes_id,is_current)
       VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,true) RETURNING *`,
      [auth.tenantId, result.channel, String(result.orderId), JSON.stringify(result.summary || {}), JSON.stringify(redactForStorage(result)),
        version, normalized.fingerprint, normalized.currency, JSON.stringify(normalized.components), normalized.totalAmount, current?.id || null],
    )).rows[0];
    return { snapshot, created: true };
  });
}

async function calculateOrderProfit(auth, orderId, input = {}, request = null) {
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const order = (await client.query("SELECT * FROM volt_price.orders WHERE id=$1", [orderId])).rows[0];
    if (!order) throw Object.assign(new Error("Pedido nao encontrado."), { statusCode: 404 });
    const feeSnapshot = order.marketplace && order.marketplace_order_id && order.marketplace_connection_id
      ? (await client.query(
        "SELECT * FROM volt_price.fee_snapshots WHERE channel=$1 AND external_order_id=$2 AND raw_data->>'connectionId'=$3::text AND is_current LIMIT 1",
        [order.marketplace, order.marketplace_order_id, String(order.marketplace_connection_id)],
      )).rows[0] || null
      : null;
    const marketingCosts = (await client.query(`SELECT id,cost_type,amount,source_type,source_ref,funded_by,metadata FROM volt_price.order_marketing_costs WHERE order_id=$1 AND funded_by IN ('seller','shared')`, [order.id])).rows;
    const marketingComponents = marketingCosts.map((item) => ({ type: item.cost_type, amount: amount(item.amount), sourceType: item.source_type, sourceRef: item.source_ref || item.id, metadata: { ...item.metadata, fundedBy: item.funded_by, marketingCostId: item.id } }));
    const calculation = calculateProfit({
      grossAmount: input.grossAmount ?? order.total_amount,
      feeComponents: feeSnapshot?.components || [],
      expectedFeeAmount: input.expectedFeeAmount,
      input,
      extraComponents: marketingComponents,
    });
    const attributedAds = amount(marketingCosts.filter((item) => item.cost_type === "ads").reduce((sum,item) => sum + Number(item.amount || 0), 0));
    const version = Number((await client.query("SELECT coalesce(max(version),0)::int version FROM volt_price.profit_snapshots WHERE order_id=$1", [order.id])).rows[0].version) + 1;
    const snapshot = (await client.query(
      `INSERT INTO volt_price.profit_snapshots
       (tenant_id,order_id,fee_snapshot_id,version,calculation_type,source_order_id,source_channel,gross_amount,fees_amount,
        shipping_amount,ads_amount,tax_amount,cost_amount,contribution_amount,expected_contribution_amount,realized_contribution_amount,components,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb) RETURNING *`,
      [auth.tenantId, order.id, feeSnapshot?.id || null, version, calculation.calculationType, order.source_order_id, order.marketplace || order.source_channel,
        calculation.grossAmount, calculation.feesAmount, amount(input.shippingAmount), amount(input.adsAmount) + attributedAds, amount(input.taxAmount), amount(input.costAmount),
        calculation.contributionAmount, calculation.expectedContribution, calculation.realizedContribution, JSON.stringify(calculation.components),
        JSON.stringify({ marketplace: order.marketplace, marketplaceOrderId: order.marketplace_order_id, marketplaceConnectionId: order.marketplace_connection_id || null, feeVersion: feeSnapshot?.version || null, marketingCostIds: marketingCosts.map((item) => item.id) })],
    )).rows[0];
    for (const component of calculation.components) {
      await client.query(
        `INSERT INTO volt_price.profit_components(tenant_id,profit_snapshot_id,component_type,amount,source_type,source_ref,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [auth.tenantId, snapshot.id, component.type, component.amount, component.sourceType, component.sourcePath || component.sourceRef || null, JSON.stringify(component.metadata || {})],
      );
    }
    const allocations = allocateItems(extractOrderItems(order.raw_data), calculation);
    for (const item of allocations) {
      const product = item.sku ? (await client.query("SELECT id FROM volt_price.products WHERE sku=$1", [item.sku])).rows[0] : null;
      await client.query(
        `INSERT INTO volt_price.profit_snapshot_items
         (tenant_id,profit_snapshot_id,product_id,sku,title,quantity,gross_amount,cost_amount,contribution_amount,allocation_ratio)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [auth.tenantId, snapshot.id, product?.id || null, item.sku, item.title, item.quantity, item.grossAmount, item.costAmount, item.contributionAmount, item.allocationRatio],
      );
    }
    await audit(client, { tenantId: auth.tenantId, actorUserId: auth.userId, action: "profit.calculate", resourceType: "profit_snapshot", resourceId: snapshot.id,
      metadata: { orderId: order.id, version, calculationType: calculation.calculationType, contribution: calculation.contributionAmount }, ip: request?.ip, userAgent: request?.get?.("user-agent") });
    return { snapshot, components: calculation.components, items: allocations };
  });
}

async function profitOverview(auth) {
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const snapshots = (await client.query(`
      SELECT DISTINCT ON (order_id) id,order_id,version,calculation_type,source_order_id,source_channel,gross_amount,fees_amount,
        shipping_amount,ads_amount,tax_amount,cost_amount,contribution_amount,expected_contribution_amount,realized_contribution_amount,calculated_at
      FROM volt_price.profit_snapshots WHERE order_id IS NOT NULL ORDER BY order_id,version DESC LIMIT 500
    `)).rows;
    const byChannel = (await client.query(`
      SELECT source_channel,count(*)::int orders,sum(gross_amount)::numeric gross,sum(contribution_amount)::numeric contribution
      FROM (SELECT DISTINCT ON (order_id) * FROM volt_price.profit_snapshots WHERE order_id IS NOT NULL ORDER BY order_id,version DESC) latest
      GROUP BY source_channel ORDER BY source_channel
    `)).rows;
    const bySku = (await client.query(`
      SELECT i.sku,max(i.title) title,sum(i.quantity)::numeric quantity,sum(i.gross_amount)::numeric gross,sum(i.contribution_amount)::numeric contribution
      FROM volt_price.profit_snapshot_items i JOIN volt_price.profit_snapshots p ON p.id=i.profit_snapshot_id
      WHERE p.id=(SELECT p2.id FROM volt_price.profit_snapshots p2 WHERE p2.order_id=p.order_id ORDER BY p2.version DESC LIMIT 1)
      GROUP BY i.sku ORDER BY contribution DESC NULLS LAST LIMIT 200
    `)).rows;
    const totals = snapshots.reduce((acc, row) => {
      for (const key of ["gross_amount", "fees_amount", "contribution_amount", "expected_contribution_amount", "realized_contribution_amount"]) acc[key] = amount((acc[key] || 0) + Number(row[key] || 0));
      return acc;
    }, {});
    return { snapshots, totals, byChannel, bySku };
  });
}

module.exports = { cachedFee, saveFeeSnapshot, calculateOrderProfit, profitOverview };
