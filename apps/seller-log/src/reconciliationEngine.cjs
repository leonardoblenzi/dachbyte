"use strict";

const { safeNumber, safeString } = require("./intelipostClient.cjs");

function roundMoney(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 100) / 100;
}

function applyRule(item, fallbackRule) {
  const rule = item.rule || fallbackRule || {};
  const customer = safeNumber(item.customer_paid_shipping_amount);
  const tms = safeNumber(item.tms_expected_amount);
  const carrier = safeNumber(item.carrier_charged_amount);
  const value = safeNumber(rule.value) || 0;

  if (rule.operation === "percent_decrease" && customer !== null) return roundMoney(customer * (1 - value / 100));
  if (rule.operation === "percent_increase" && customer !== null) return roundMoney(customer * (1 + value / 100));
  if (rule.operation === "fixed_decrease" && customer !== null) return roundMoney(customer - value);
  if (rule.operation === "fixed_increase" && customer !== null) return roundMoney(customer + value);
  if (rule.operation === "replace_with_fixed") return roundMoney(value);
  if (rule.operation === "zero") return 0;
  if (rule.operation === "use_customer" && customer !== null) return roundMoney(customer);
  if (rule.operation === "use_carrier" && carrier !== null) return roundMoney(carrier);
  if (rule.operation === "use_tms" && tms !== null) return roundMoney(tms);
  return tms !== null ? roundMoney(tms) : null;
}

function statusFromValues(item, tolerance = {}) {
  const carrier = safeNumber(item.carrier_charged_amount);
  const tms = safeNumber(item.tms_expected_amount);
  const customer = safeNumber(item.customer_paid_shipping_amount);
  const davantti = safeNumber(item.davantti_expected_amount);

  if (carrier === null || davantti === null || customer === null || tms === null) {
    return "dados_incompletos";
  }

  const diff = Math.abs(carrier - davantti);
  const fixedTolerance = safeNumber(tolerance.fixed ?? tolerance.fixed_amount ?? 1) || 0;
  const percentTolerance = safeNumber(tolerance.percent ?? tolerance.percent_amount ?? 0) || 0;
  const percentAmount = davantti ? Math.abs(davantti * percentTolerance / 100) : 0;
  const maxTolerance = Math.max(fixedTolerance, percentAmount);

  if (diff === 0) return "sem_divergencia";
  if (diff <= maxTolerance) return "dentro_tolerancia";
  return "aguardando_conciliacao";
}

function enrichItem(item, options = {}) {
  const rule = item.rule || options.defaultRule || {};
  const tolerance = item.tolerance_snapshot || rule.tolerance || options.defaultTolerance || {};
  const carrier = safeNumber(item.carrier_charged_amount);
  const tms = safeNumber(item.tms_expected_amount);
  const customer = safeNumber(item.customer_paid_shipping_amount);
  const davanttiExpected = applyRule(item, rule);
  const tmsDifference = carrier === null || tms === null ? null : roundMoney(carrier - tms);
  const davanttiDifference =
    carrier === null || davanttiExpected === null ? null : roundMoney(carrier - davanttiExpected);
  const freightMargin = customer === null || carrier === null ? null : roundMoney(customer - carrier);
  const next = {
    ...item,
    davantti_expected_amount: davanttiExpected,
    tms_difference_amount: tmsDifference,
    davantti_difference_amount: davanttiDifference,
    freight_margin_amount: freightMargin,
  };
  return {
    ...next,
    status: item.status && ["divergencia_aprovada", "divergencia_contestada", "pre_fatura_gerada", "fechado"].includes(item.status)
      ? item.status
      : statusFromValues(next, tolerance),
    audit_formula: {
      carrier_charged_amount: {
        value: carrier,
        source: item.cte_key ? "CT-e/fatura transportadora" : "Fatura importada ou Intelipost",
        captured_at: item.source_payload_snapshot?.captured_at || item.updated_at || item.created_at || null,
      },
      tms_expected_amount: {
        value: tms,
        source: item.intelipost_order_number || item.source_payload_snapshot?.source === "invoice_key"
          ? "Intelipost/TMS"
          : "nao_disponivel",
        captured_at: item.source_payload_snapshot?.captured_at || null,
      },
      customer_paid_shipping_amount: {
        value: customer,
        source: safeString(item.sales_channel) || "canal_importado",
        captured_at: item.source_payload_snapshot?.captured_at || null,
      },
      davantti_expected_amount: {
        value: davanttiExpected,
        source: `${rule.name || "Regra DACHBYTE"} v${rule.version || 1}`,
        captured_at: rule.captured_at || item.updated_at || null,
      },
      formulas: {
        divergencia_tms: "carrier_charged_amount - tms_expected_amount",
        divergencia_davantti: "carrier_charged_amount - davantti_expected_amount",
        margem_frete: "customer_paid_shipping_amount - carrier_charged_amount",
      },
    },
  };
}

function conciliateItems(items, options = {}) {
  return items.map((item) => enrichItem(item, options));
}

function dashboardFromItems(items) {
  const enriched = conciliateItems(items);
  const totals = enriched.reduce(
    (acc, item) => {
      acc.total_orders += 1;
      if (["sem_divergencia", "dentro_tolerancia", "fechado"].includes(item.status)) acc.reconciled_orders += 1;
      if (["aguardando_conciliacao", "divergencia_aprovada", "divergencia_contestada"].includes(item.status)) acc.divergent_orders += 1;
      if (item.status === "aguardando_conciliacao") acc.pending_review += 1;
      acc.total_carrier_amount += safeNumber(item.carrier_charged_amount) || 0;
      acc.total_tms_amount += safeNumber(item.tms_expected_amount) || 0;
      acc.total_customer_amount += safeNumber(item.customer_paid_shipping_amount) || 0;
      acc.total_davantti_expected_amount += safeNumber(item.davantti_expected_amount) || 0;
      acc.total_tms_difference += safeNumber(item.tms_difference_amount) || 0;
      acc.total_davantti_difference += safeNumber(item.davantti_difference_amount) || 0;
      acc.total_margin += safeNumber(item.freight_margin_amount) || 0;
      if ((safeNumber(item.freight_margin_amount) || 0) < 0) acc.total_loss += Math.abs(item.freight_margin_amount);
      if ((safeNumber(item.freight_margin_amount) || 0) > 0) acc.total_gain += item.freight_margin_amount;
      if ((safeNumber(item.davantti_difference_amount) || 0) > 1) acc.contestable_amount += item.davantti_difference_amount;
      return acc;
    },
    {
      total_orders: 0,
      reconciled_orders: 0,
      divergent_orders: 0,
      pending_review: 0,
      total_carrier_amount: 0,
      total_tms_amount: 0,
      total_customer_amount: 0,
      total_davantti_expected_amount: 0,
      total_tms_difference: 0,
      total_davantti_difference: 0,
      total_margin: 0,
      total_loss: 0,
      total_gain: 0,
      contestable_amount: 0,
    },
  );

  Object.keys(totals).forEach((key) => {
    if (typeof totals[key] === "number") totals[key] = roundMoney(totals[key]);
  });

  return {
    totals,
    alerts: buildAlerts(enriched),
    charts: {
      by_carrier: aggregate(enriched, "carrier_name", "davantti_difference_amount"),
      by_channel: aggregate(enriched, "sales_channel", "freight_margin_amount"),
      by_status: countBy(enriched, "status"),
    },
  };
}

function buildAlerts(items) {
  const alerts = [];
  const missingCte = items.filter((item) => !safeString(item.cte_key)).length;
  const missingCustomerFreight = items.filter((item) => safeNumber(item.customer_paid_shipping_amount) === null).length;
  const contestable = items.filter((item) => (safeNumber(item.davantti_difference_amount) || 0) > 1);
  const negativeMargin = items.filter((item) => (safeNumber(item.freight_margin_amount) || 0) < 0);
  if (contestable.length) {
    alerts.push({
      id: "alert-contestable",
      level: "critical",
      text: `${contestable.length} pedido(s) acima da regra DACHBYTE.`,
      source: "calculo: carrier_charged_amount - davantti_expected_amount",
    });
  }
  if (negativeMargin.length) {
    alerts.push({
      id: "alert-negative-margin",
      level: "warning",
      text: `${negativeMargin.length} pedido(s) com margem negativa de frete.`,
      source: "calculo: customer_paid_shipping_amount - carrier_charged_amount",
    });
  }
  if (missingCte) {
    alerts.push({
      id: "alert-missing-cte",
      level: "warning",
      text: `${missingCte} pedido(s) sem CT-e vinculado.`,
      source: "validacao: cte_key ausente",
    });
  }
  if (missingCustomerFreight) {
    alerts.push({
      id: "alert-missing-customer-freight",
      level: "warning",
      text: `${missingCustomerFreight} pedido(s) sem frete pago pelo cliente.`,
      source: "validacao: customer_paid_shipping_amount ausente",
    });
  }
  return alerts;
}

function aggregate(items, key, valueKey) {
  const map = new Map();
  items.forEach((item) => {
    const label = safeString(item[key]) || "Nao informado";
    map.set(label, roundMoney((map.get(label) || 0) + (safeNumber(item[valueKey]) || 0)));
  });
  return Array.from(map.entries()).map(([label, value]) => ({ label, value }));
}

function countBy(items, key) {
  const map = new Map();
  items.forEach((item) => {
    const label = safeString(item[key]) || "Nao informado";
    map.set(label, (map.get(label) || 0) + 1);
  });
  return Array.from(map.entries()).map(([label, value]) => ({ label, value }));
}

function normalizeInvoiceRows(rows = [], defaults = {}) {
  return rows.map((row, index) => ({
    id: row.id || `IMP-${Date.now()}-${index + 1}`,
    order_id: safeString(row.order_id || row.pedido || row.order || row.numero_pedido),
    marketplace_order_number: safeString(row.marketplace_order_number || row.pedido_marketplace || row.order_id),
    intelipost_order_number: safeString(row.intelipost_order_number || row.pedido_intelipost),
    sales_channel: safeString(row.sales_channel || row.canal || defaults.sales_channel) || "Importado",
    customer_name: safeString(row.customer_name || row.cliente) || "Cliente",
    carrier_name: safeString(row.carrier_name || row.transportadora || defaults.carrier_name) || "Transportadora",
    delivery_service: safeString(row.delivery_service || row.servico || row.metodo_entrega),
    destination_uf: safeString(row.destination_uf || row.uf),
    destination_zipcode: safeString(row.destination_zipcode || row.cep),
    order_amount: safeNumber(row.order_amount || row.valor_pedido),
    customer_paid_shipping_amount: safeNumber(row.customer_paid_shipping_amount || row.frete_cliente || row.frete_pago_cliente),
    tms_expected_amount: safeNumber(row.tms_expected_amount || row.frete_tms || row.frete_intelipost),
    carrier_charged_amount: safeNumber(row.carrier_charged_amount || row.frete_transportadora || row.valor_frete || row.valor_cobrado),
    cte_key: safeString(row.cte_key || row.cte),
    invoice_key: safeString(row.invoice_key || row.nfe || row.chave_nfe),
    tracking_code: safeString(row.tracking_code || row.codigo_rastreio),
    billing_document: safeString(row.billing_document || row.fatura || defaults.billing_document),
    status: "aguardando_conciliacao",
    rule: defaults.rule || {
      id: "rule-use-tms",
      name: "Usar valor TMS",
      version: 1,
      operation: "use_tms",
      value: 0,
      source: "invoice_import_default",
      captured_at: new Date().toISOString(),
    },
    evidence: [
      {
        type: "Fatura",
        label: `Linha importada ${index + 1}`,
        captured_at: new Date().toISOString(),
      },
    ],
    source_payload_snapshot: {
      source: "invoice_import",
      captured_at: new Date().toISOString(),
      raw: row,
    },
  })).filter((item) => item.order_id || item.invoice_key || item.cte_key);
}

module.exports = {
  applyRule,
  conciliateItems,
  dashboardFromItems,
  enrichItem,
  normalizeInvoiceRows,
  roundMoney,
  statusFromValues,
};
