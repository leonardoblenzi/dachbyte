"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/controllers/MarginController");

test("interpreta o periodo da margem no fuso de Sao Paulo", () => {
  const range = _test.parseMarginDateRange("2026-09-01", "2026-09-02");

  assert.equal(range.start.toISOString(), "2026-09-01T03:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-09-03T02:59:59.999Z");
  assert.equal(range.dateFrom, "2026-09-01");
  assert.equal(range.dateTo, "2026-09-02");
  assert.equal(new Date("2026-09-01T02:59:59.999Z") < range.start, true);
});

test("validates and calculates the configured tax rate", () => {
  assert.equal(_test.resolveTaxRate(undefined, 6.5), 6.5);
  assert.equal(_test.resolveTaxRate("8.25", 6.5), 8.25);
  assert.equal(_test.getConfiguredTaxCents(8.25, 10000), 825);
  assert.throws(() => _test.resolveTaxRate("101", 0), /entre 0 e 100/);
});

test("only trusts a persisted net receipt after income synchronization", () => {
  assert.equal(_test.getNetReceivedCents({ incomeNetCents: 0 }), null);
  assert.equal(
    _test.getNetReceivedCents({
      incomeNetCents: 7350,
      incomeSyncedAt: new Date(),
    }),
    7350,
  );
  assert.equal(
    _test.getNetReceivedCents({
      incomeDetailRaw: { order_income: { escrow_amount: 72.5 } },
    }),
    7250,
  );
});

test("contribution margin starts from Shopee net receipt", () => {
  const result = _test.mapOrderMargin({
    order: {
      id: 1,
      orderSn: "TEST-1",
      orderStatus: "COMPLETED",
      totalAmountCents: 10000,
      itemsSubtotalCents: 10000,
      incomeNetCents: 7000,
      incomeSyncedAt: new Date(),
      shippingCarrier: "Shopee Xpress",
      items: [{
        itemId: 123n,
        quantity: 1,
        orderPrice: 10000,
        product: { costCents: 2000, title: "Produto" },
      }],
    },
    taxRate: 10,
    monthlyAdsCost: { byItemId: new Map() },
    productCostMap: new Map(),
  });

  assert.equal(result.netReceivedCents, 7000);
  assert.equal(result.costsCents.products, 2000);
  assert.equal(result.costsCents.configuredTaxes, 1000);
  assert.equal(result.profitCents, 4000);
  assert.equal(result.profitMargin, 40);
  assert.equal(result.items[0].hasConfiguredCost, true);
});


test("details gross and net Shopee fees without double counting components", () => {
  const result = _test.mapOrderMargin({
    order: {
      id: 2,
      orderSn: "TEST-FEES",
      orderStatus: "COMPLETED",
      totalAmountCents: 90000,
      itemsSubtotalCents: 78280,
      incomeSyncedAt: new Date(),
      incomeDetailRaw: {
        order_income: {
          escrow_amount: 740.66,
          commission_fee: 87.22,
          net_commission_fee: 26.07,
          service_fee: 87.22,
          net_service_fee: 47.75,
          seller_order_processing_fee: 25.44,
          seller_transaction_fee: 14.54,
          campaign_fee: 26,
          final_shipping_vat_tax: 3,
          final_escrow_shipping_gst: 2,
        },
      },
      items: [{
        itemId: 456n,
        quantity: 1,
        orderPrice: 78280,
        product: { costCents: 30000, title: "Produto" },
      }],
    },
    taxRate: 0,
    monthlyAdsCost: { byItemId: new Map() },
    productCostMap: new Map(),
  });

  assert.equal(result.costsCents.commissions, 7382);
  assert.equal(result.costsCents.orderTaxes, 500);
  assert.equal(result.financialDetailsCents.fees.commissionGross, 8722);
  assert.equal(result.financialDetailsCents.fees.commissionNet, 2607);
  assert.equal(
    result.financialDetailsCents.fees.commissionCommercialAdjustment,
    6115,
  );
  assert.equal(result.financialDetailsCents.fees.serviceNet, 4775);
  assert.equal(
    result.financialDetailsCents.fees.serviceCommercialAdjustment,
    1823,
  );
  assert.ok(
    result.rawFinancialFieldsCents.some(
      (field) => field.field === "order_income.net_commission_fee",
    ),
  );
});

test("calcula imposto, sobra e margem somente sobre produtos, sem frete", () => {
  const result = _test.mapOrderMargin({
    order: {
      id: 3,
      orderSn: "TEST-NF",
      orderStatus: "COMPLETED",
      totalAmountCents: 11000,
      itemsSubtotalCents: 10000,
      incomeNetCents: 8000,
      incomeSyncedAt: new Date(),
      items: [{
        itemId: 789n,
        quantity: 1,
        orderPrice: 10000,
        product: { costCents: 2000, title: "Produto" },
      }],
    },
    taxRate: 10,
    monthlyAdsCost: { byItemId: new Map() },
    productCostMap: new Map(),
  });

  assert.equal(result.costsCents.configuredTaxes, 1000);
  assert.equal(result.productNetReceivedCents, 7000);
  assert.equal(result.profitCents, 4000);
  assert.equal(result.profitMargin, 40);
});

test("permite calcular a aliquota sobre o pedido completo", () => {
  const result = _test.mapOrderMargin({
    order: {
      id: 31,
      orderSn: "TEST-NF-FULL",
      orderStatus: "COMPLETED",
      totalAmountCents: 11000,
      itemsSubtotalCents: 10000,
      incomeNetCents: 8000,
      incomeSyncedAt: new Date(),
      items: [{ itemId: 790n, quantity: 1, orderPrice: 10000, product: { costCents: 2000 } }],
    },
    taxRate: 10,
    taxBase: "full_order",
    monthlyAdsCost: { byItemId: new Map() },
    productCostMap: new Map(),
  });

  assert.equal(result.configuredTaxBaseCents, 11000);
  assert.equal(result.costsCents.configuredTaxes, 1100);
  assert.equal(result.profitCents, 3900);
});

test("usa o total pago menos frete e nao desconta frete do canal duas vezes", () => {
  const result = _test.mapOrderMargin({
    order: {
      id: 32,
      orderSn: "FREIGHT-CHANNEL-SETTLED",
      orderStatus: "READY_TO_SHIP",
      shippingCarrier: "Entrega de Item Grande/Pesado",
      incomeSyncedAt: new Date(),
      incomeDetailRaw: {
        order_income: {
          buyer_total_amount: 1291.31,
          cost_of_goods_sold: 999.9,
          buyer_paid_shipping_fee: 322.82,
          actual_shipping_fee: 322.82,
          escrow_amount_after_adjustment: 815.85,
          net_commission_fee: 108.95,
          net_service_fee: 43.69,
        },
        buyer_payment_info: { buyer_total_amount: 1291.31, shipping_fee: 322.82 },
      },
      items: [{ itemId: 791n, quantity: 1, orderPrice: 99990, product: { costCents: 53754 } }],
    },
    taxRate: 11,
    taxBase: "products",
    monthlyAdsCost: { byItemId: new Map() },
    productCostMap: new Map(),
  });

  assert.equal(result.itemsRevenueCents, 96849);
  assert.equal(result.shippingRevenueCents, 32282);
  assert.equal(result.freightSettlementCents, 0);
  assert.equal(result.productNetReceivedCents, 81585);
  assert.equal(result.costsCents.configuredTaxes, 10653);
  assert.equal(result.profitCents, 17178);
  assert.equal(result.profitMargin, 17.74);
});

test("calcula TACOS real da conta com GMV pago do mes", () => {
  assert.equal(_test.calculateAccountTacos(12500, 250000), 5);
  assert.equal(_test.calculateAccountTacos(1, 0), null);
  const range = _test.getCurrentMonthRange(new Date("2026-08-20T12:00:00.000Z"));
  assert.equal(range.start.toISOString(), "2026-08-01T00:00:00.000Z");
});

test("compensa frete real com frete pago e rebate da Shopee", () => {
  const shipping = _test.getShippingCostDetailsCents({
    incomeSyncedAt: new Date(),
    incomeDetailRaw: {
      order_income: {
        actual_shipping_fee: 46.96,
        buyer_paid_shipping_fee: 6.96,
        shopee_shipping_rebate: 40,
      },
    },
  });

  assert.equal(shipping.totalCents, 0);
  assert.equal(shipping.shopeeShippingRebateCents, 4000);
  assert.equal(shipping.reconciliationCents, 4000);
});
test("provisiona frete estimado e abate receita de frete de logistica propria", () => {
  const result = _test.mapOrderMargin({
    order: {
      id: 5, orderSn: "260817J9UCJX24", orderStatus: "SHIPPED",
      totalAmountCents: 315798, itemsSubtotalCents: 168244, incomeSyncedAt: new Date(),
      incomeDetailRaw: { order_income: {
        escrow_amount_after_adjustment: 2968.51, cost_of_goods_sold: 1682.44,
        buyer_paid_shipping_fee: 1687.54, estimated_shipping_fee: 1727.54, actual_shipping_fee: 0,
        net_commission_fee: 117.84, net_service_fee: 101.63, voucher_from_seller: 134.6,
        voucher_from_shopee: 77.4, shopee_shipping_rebate: 30,
      }, buyer_payment_info: { buyer_total_amount: 3157.98 } },
      items: [{ itemId: 999n, quantity: 1, orderPrice: 168244, product: { costCents: 88994 } }],
    },
    taxRate: 11, monthlyAdsCost: { byItemId: new Map() }, productCostMap: new Map(),
  });

  assert.equal(result.shippingCost.source, "estimated");
  assert.equal(result.shippingCost.isProvisional, true);
  assert.equal(result.costsCents.shipping, 169754);
  assert.equal(result.costsCents.ownLogisticsShipping, 168754);
  assert.equal(result.costsCents.configuredTaxes, 16175);
  assert.equal(result.reconciliationCents.expectedPayout, 291131);
  assert.equal(result.reconciliationCents.adjustment, 5720);
  assert.equal(result.freightRebateExcludedCents, 3000);
  assert.equal(result.profitCents, 19928);
});

test("abate a receita de frete de logistica propria da sobra final", () => {
  const result = _test.mapOrderMargin({
    order: {
      id: 7,
      orderSn: "OWN-FREIGHT-1",
      orderStatus: "COMPLETED",
      shippingCarrier: "Correios",
      totalAmountCents: 11000,
      itemsSubtotalCents: 10000,
      incomeNetCents: 8000,
      incomeSyncedAt: new Date(),
      items: [{ itemId: 1002n, quantity: 1, orderPrice: 10000, product: { costCents: 2000 } }],
    },
    taxRate: 0, monthlyAdsCost: { byItemId: new Map() }, productCostMap: new Map(),
  });

  assert.equal(result.shippingRevenueCents, 1000);
  assert.equal(result.ownLogisticsShippingCents, 1000);
  assert.equal(result.costsCents.shipping, 1000);
  assert.equal(result.profitCents, 5000);
});
test("nao confunde Expresso de transportadora propria com Shopee Xpress", () => {
  const result = _test.mapOrderMargin({
    order: {
      id: 8,
      orderSn: "OWN-FREIGHT-EXPRESSO",
      orderStatus: "READY_TO_SHIP",
      shippingCarrier: "Logistica do vendedor - Rodonaves Expresso",
      totalAmountCents: 11000,
      itemsSubtotalCents: 10000,
      incomeNetCents: 8000,
      incomeSyncedAt: new Date(),
      items: [{ itemId: 1003n, quantity: 1, orderPrice: 10000, product: { costCents: 2000 } }],
    },
    taxRate: 0, monthlyAdsCost: { byItemId: new Map() }, productCostMap: new Map(),
  });

  assert.equal(result.isSpx, false);
  assert.equal(_test.isShopeeXpressCarrier("Expresso Aereo"), true);
  assert.equal(result.ownLogisticsShippingCents, 1000);
  assert.equal(result.costsCents.shipping, 1000);
});
test("nao cria reserva extra quando o frete do canal ja fecha no pedido", () => {
  const result = _test.mapOrderMargin({
    order: {
      id: 81, orderSn: "CHANNEL-LARGE", orderStatus: "COMPLETED",
      shippingCarrier: "Entrega de Item Grande/Pesado",
      totalAmountCents: 187462, itemsSubtotalCents: 163690, incomeSyncedAt: new Date(),
      incomeDetailRaw: { order_income: {
        escrow_amount_after_adjustment: 1339.59, cost_of_goods_sold: 1636.9,
        buyer_paid_shipping_fee: 371.18, actual_shipping_fee: 411.18,
        shopee_shipping_rebate: 40, net_commission_fee: 120.68, net_service_fee: 48.23,
      } },
      items: [{ itemId: 1004n, quantity: 1, orderPrice: 163690, product: { costCents: 50000 } }],
    },
    taxRate: 0, monthlyAdsCost: { byItemId: new Map() }, productCostMap: new Map(),
  });
  assert.equal(result.isOwnLogistics, false);
  assert.equal(result.ownLogisticsShippingCents, 0);
  assert.equal(result.freightPassThroughCents, 0);
  assert.equal(result.costsCents.shippingPassThrough, 0);
  assert.equal(result.costsCents.shipping, 0);
});

test("reserva somente a receita recebida para logistica do vendedor", () => {
  const result = _test.mapOrderMargin({
    order: {
      id: 82, orderSn: "SELLER-LOGISTICS", orderStatus: "COMPLETED",
      shippingCarrier: "Logistica do vendedor - Transportadora",
      totalAmountCents: 209807, itemsSubtotalCents: 168244, incomeSyncedAt: new Date(),
      incomeDetailRaw: { order_income: {
        escrow_amount_after_adjustment: 1925.07, cost_of_goods_sold: 1682.44,
        buyer_paid_shipping_fee: 546.31, estimated_shipping_fee: 546.31,
        net_commission_fee: 123.9, net_service_fee: 49.1,
      } },
      items: [{ itemId: 1005n, quantity: 1, orderPrice: 168244, product: { costCents: 50000 } }],
    },
    taxRate: 0, monthlyAdsCost: { byItemId: new Map() }, productCostMap: new Map(),
  });
  assert.equal(result.isOwnLogistics, true);
  assert.equal(result.ownLogisticsShippingCents, 54631);
  assert.equal(result.freightPassThroughCents, 54631);
  assert.equal(result.costsCents.shipping, 54631);
  assert.equal(result.shippingCost.source, "seller_logistics_reserve");
  assert.equal(result.shippingCost.isProvisional, true);
});
test("cupons e PIX nao reduzem a reserva de frete da logistica do vendedor", () => {
  const result = _test.mapOrderMargin({
    order: {
      id: 83, orderSn: "2608259JG25SV9", orderStatus: "READY_TO_SHIP",
      shippingCarrier: "Logística do vendedor - 28-AGL Transportes Expresso",
      totalAmountCents: 90630, itemsSubtotalCents: 81220, incomeSyncedAt: new Date(),
      incomeNetCents: 88751,
      incomeDetailRaw: { order_income: {
        escrow_amount_after_adjustment: 887.51, buyer_total_amount: 906.3,
        cost_of_goods_sold: 812.2, pix_discount: 59.05,
        voucher_from_seller: 49, voucher_from_shopee: 25,
        buyer_paid_shipping_fee: 227.15, estimated_shipping_fee: 267.15,
        actual_shipping_fee: 0, final_shipping_fee: 30,
        shopee_shipping_rebate: 30, net_commission_fee: 26.12,
        net_service_fee: 22.67,
      } },
      items: [{ itemId: 1006n, quantity: 1, orderPrice: 81220, product: { costCents: 40000 } }],
    },
    taxRate: 0, monthlyAdsCost: { byItemId: new Map() }, productCostMap: new Map(),
  });

  assert.equal(result.shippingRevenueCents, 22715);
  assert.equal(result.freightPassThroughCents, 25715);
  assert.equal(result.ownLogisticsShippingCents, 25715);
  assert.equal(result.shippingCost.source, "seller_logistics_reserve");
  assert.equal(result.costsCents.channelShipping, 0);
  assert.equal(result.costsCents.shipping, 25715);
  assert.equal(result.freightRebateExcludedCents, 3000);
  assert.equal(result.profitCents, 23036);
});
test("nao duplica o reembolso do produto nos custos de devolucao", () => {
  const result = _test.mapOrderMargin({
    order: {
      id: 6,
      orderSn: "RETURN-1",
      orderStatus: "COMPLETED",
      totalAmountCents: 147209,
      incomeSyncedAt: new Date(),
      incomeDetailRaw: {
        order_income: {
          buyer_total_amount: 1472.09,
          escrow_amount: 0,
          original_cost_of_goods_sold: 1431.9,
          cost_of_goods_sold: 0,
          seller_return_refund: -1431.9,
          drc_adjustable_refund: 1307,
        },
      },
      items: [{ itemId: 1001n, quantity: 1, orderPrice: 143190, product: { costCents: 40000 } }],
    },
    taxRate: 0,
    monthlyAdsCost: { byItemId: new Map() },
    productCostMap: new Map(),
  });

  assert.equal(result.costsCents.returns, 273890);
});

test("resumo troca Ads alocado pelo gasto real do periodo", () => {
  const result = _test.summarizeMarginOrders({
    mappedOrders: [{
      revenueCents: 10000,
      netReceivedCents: 7000,
      costsCents: {
        products: 2000, commissions: 500, returns: 0, shipping: 0,
        voucher: 0, orderTaxes: 0, configuredTaxes: 1000, ads: 250,
      },
      creditsCents: { shopeeRebates: 0 },
      otherShopeeAdjustmentsCents: 0,
      profitCents: 3750,
      isSpx: false,
      spxReferenceCents: 0,
      items: [],
    }],
    actualAdsSpendCents: 1000,
  });

  assert.equal(result.adsCents, 1000);
  assert.equal(result.allocatedAdsCents, 250);
  assert.equal(result.unallocatedAdsCents, 750);
  assert.equal(result.contributionMarginCents, 3000);
});
