"use strict";

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, number(value)));
}

function rateFraction(value) {
  const parsed = number(value);
  if (parsed <= 0) return 0;
  return parsed > 1 ? parsed / 100 : parsed;
}

function percentRate(value) {
  return Math.max(0, number(value)) / 100;
}

function decomposeMarketplaceFee({
  price,
  saleFee = 0,
  listingFee = 0,
  percentageFee = null,
  fixedFee = 0,
  listingFixedFee = null,
} = {}) {
  const safePrice = Math.max(0, number(price));
  const commission = Math.max(0, number(saleFee) + number(listingFee));
  const explicitRate = percentageFee == null ? 0 : rateFraction(percentageFee);
  const knownFixed = Math.max(
    0,
    number(fixedFee) + number(listingFixedFee == null ? listingFee : listingFixedFee),
  );

  let commissionRate = explicitRate;
  let commissionFixed = knownFixed;
  if (safePrice > 0 && commissionRate > 0) {
    commissionFixed = Math.max(0, commission - safePrice * commissionRate);
  } else if (safePrice > 0) {
    commissionFixed = Math.min(commission, knownFixed);
    commissionRate = Math.max(0, (commission - commissionFixed) / safePrice);
  }

  commissionRate = clamp(commissionRate, 0, 0.95);
  return {
    commission: round(commission, 2),
    commission_rate: commissionRate,
    commission_rate_pct: round(commissionRate * 100, 4),
    commission_fixed: round(commissionFixed, 2),
  };
}

function calculateTargetPrice({
  fixedCosts,
  commissionRate = 0,
  taxRate = 0,
  targetMargin = 0,
} = {}) {
  const denominator =
    1 - Math.max(0, number(commissionRate)) - Math.max(0, number(taxRate)) - Math.max(0, number(targetMargin));
  if (denominator <= 0.001) return null;
  return round(Math.max(0, number(fixedCosts)) / denominator, 2);
}

function calculatePricingSnapshot({
  price = 0,
  productCost = 0,
  commissionRate = 0,
  commissionFixed = 0,
  commissionAmount = null,
  taxRate = 0,
  sellerShipping = 0,
  buyerShippingTaxable = 0,
  operationCost = 0,
  otherCosts = 0,
  targetMargin = null,
} = {}) {
  const safePrice = Math.max(0, number(price));
  const safeProductCost = Math.max(0, number(productCost));
  const safeCommissionRate = clamp(number(commissionRate), 0, 0.95);
  const safeCommissionFixed = Math.max(0, number(commissionFixed));
  const safeTaxRate = clamp(number(taxRate), 0, 0.95);
  const safeSellerShipping = Math.max(0, number(sellerShipping));
  const safeBuyerShipping = Math.max(0, number(buyerShippingTaxable));
  const safeOperationCost = Math.max(0, number(operationCost));
  const safeOtherCosts = Math.max(0, number(otherCosts));

  const calculatedCommission = Math.max(
    0,
    commissionAmount == null
      ? safePrice * safeCommissionRate + safeCommissionFixed
      : number(commissionAmount),
  );
  const taxBase = Math.max(0, safePrice + safeBuyerShipping);
  const taxes = taxBase * safeTaxRate;
  const totalCosts =
    safeProductCost +
    calculatedCommission +
    taxes +
    safeSellerShipping +
    safeOperationCost +
    safeOtherCosts;
  const profit = safePrice - totalCosts;
  const marginPct = safePrice > 0 ? (profit / safePrice) * 100 : 0;
  const roiPct = safeProductCost > 0 ? (profit / safeProductCost) * 100 : null;

  // O frete pago pelo comprador não é receita do produto aqui, mas quando ele
  // compõe a base fiscal sua parcela de imposto precisa entrar no custo fixo da
  // equação de preço-alvo, igual à lógica de precificação já usada no financeiro.
  const sustainableFixedCosts =
    safeProductCost +
    safeSellerShipping +
    safeOperationCost +
    safeOtherCosts +
    safeCommissionFixed +
    safeBuyerShipping * safeTaxRate;

  const equilibriumPrice = calculateTargetPrice({
    fixedCosts: sustainableFixedCosts,
    commissionRate: safeCommissionRate,
    taxRate: safeTaxRate,
    targetMargin: 0,
  });
  const target = targetMargin == null
    ? null
    : calculateTargetPrice({
        fixedCosts: sustainableFixedCosts,
        commissionRate: safeCommissionRate,
        taxRate: safeTaxRate,
        targetMargin: Math.max(0, number(targetMargin)),
      });

  return {
    price: round(safePrice, 2),
    product_cost: round(safeProductCost, 2),
    commission: round(calculatedCommission, 2),
    commission_rate_pct: round(safeCommissionRate * 100, 4),
    commission_fixed: round(safeCommissionFixed, 2),
    tax_base: round(taxBase, 2),
    taxes: round(taxes, 2),
    tax_rate_pct: round(safeTaxRate * 100, 4),
    seller_shipping: round(safeSellerShipping, 2),
    buyer_shipping_taxable: round(safeBuyerShipping, 2),
    operation_cost: round(safeOperationCost, 2),
    other_costs: round(safeOtherCosts, 2),
    total_costs: round(totalCosts, 2),
    profit: round(profit, 2),
    margin_pct: round(marginPct, 2),
    roi_pct: roiPct == null ? null : round(roiPct, 2),
    equilibrium_price: equilibriumPrice,
    target_price: target,
    fixed_costs_for_target: round(sustainableFixedCosts, 2),
  };
}

async function solveTargetPrice({
  targetMargin,
  seedPrice,
  quote,
  tolerancePct = 0.03,
  maxIterations = 8,
} = {}) {
  if (typeof quote !== "function") throw new Error("quote callback is required.");
  const target = Math.max(0, number(targetMargin));
  let candidate = Math.max(0.01, number(seedPrice, 0.01));
  let last = null;
  let lastCandidate = candidate;

  for (let i = 0; i < Math.max(1, Math.trunc(maxIterations)); i += 1) {
    const snapshot = await quote(candidate);
    if (!snapshot || !Number.isFinite(Number(snapshot.margin_pct))) break;
    last = snapshot;
    lastCandidate = candidate;
    const diffPct = target * 100 - number(snapshot.margin_pct);
    if (Math.abs(diffPct) <= tolerancePct) {
      return { price: round(candidate, 2), snapshot, iterations: i + 1, converged: true };
    }

    const variableRate = clamp(
      rateFraction(snapshot.commission_rate_pct) + rateFraction(snapshot.tax_rate_pct),
      0,
      0.98,
    );
    const denominator = Math.max(0.02, 1 - variableRate - target);
    const fixed = Math.max(0, number(snapshot.fixed_costs_for_target));
    let next = fixed > 0 ? fixed / denominator : candidate * (1 + diffPct / 100);

    // Tarifas fixas/faixas podem produzir saltos. Misturar o novo valor com o
    // candidato anterior evita oscilações entre duas faixas de preço.
    next = candidate * 0.35 + next * 0.65;
    if (!Number.isFinite(next) || next <= 0) break;
    if (Math.abs(next - candidate) < 0.005) break;
    candidate = next;
  }

  return {
    price: last ? round(lastCandidate, 2) : null,
    snapshot: last,
    iterations: Math.max(1, Math.trunc(maxIterations)),
    converged: false,
  };
}

module.exports = {
  calculatePricingSnapshot,
  calculateTargetPrice,
  decomposeMarketplaceFee,
  percentRate,
  rateFraction,
  round,
  solveTargetPrice,
};

