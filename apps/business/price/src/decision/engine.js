"use strict";

const DEFAULT_POLICY = Object.freeze({
  minContributionMargin: 0.1,
  minContributionAmount: 0,
  maxPriceChangePercent: 0.1,
  cautiousTestPercent: 0.05,
  minConfidence: 0.6,
  minElasticitySamples: 4,
  minElasticityR2: 0.5,
  excessStockUnits: 180,
  requireHumanApproval: true,
});

const round = (value, precision = 2) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const positiveNumber = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

function estimateElasticity(samples = [], policy = DEFAULT_POLICY) {
  const rules = { ...DEFAULT_POLICY, ...policy };
  const valid = samples
    .map((sample) => ({ price: Number(sample.price), units: Number(sample.units) }))
    .filter((sample) => positiveNumber(sample.price) && positiveNumber(sample.units));

  if (valid.length < rules.minElasticitySamples) {
    return { value: null, sampleCount: valid.length, distinctPrices: new Set(valid.map((s) => s.price)).size, r2: null, reliable: false, reason: "insufficient_samples" };
  }
  const distinctPrices = new Set(valid.map((sample) => sample.price)).size;
  if (distinctPrices < 3) {
    return { value: null, sampleCount: valid.length, distinctPrices, r2: null, reliable: false, reason: "insufficient_price_variation" };
  }

  const points = valid.map((sample) => ({ x: Math.log(sample.price), y: Math.log(sample.units) }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + ((point.x - meanX) ** 2), 0);
  if (denominator <= Number.EPSILON) {
    return { value: null, sampleCount: valid.length, distinctPrices, r2: null, reliable: false, reason: "insufficient_price_variation" };
  }
  const slope = points.reduce((sum, point) => sum + ((point.x - meanX) * (point.y - meanY)), 0) / denominator;
  const intercept = meanY - (slope * meanX);
  const totalVariation = points.reduce((sum, point) => sum + ((point.y - meanY) ** 2), 0);
  const residual = points.reduce((sum, point) => sum + ((point.y - (intercept + (slope * point.x))) ** 2), 0);
  const r2 = totalVariation <= Number.EPSILON ? 0 : Math.max(0, 1 - (residual / totalVariation));
  const reliable = slope < 0 && r2 >= rules.minElasticityR2;
  return {
    value: round(slope, 4),
    sampleCount: valid.length,
    distinctPrices,
    r2: round(r2, 4),
    reliable,
    reason: reliable ? null : slope >= 0 ? "non_economic_slope" : "low_fit",
  };
}

function classifyStrategicState(context = {}, policy = DEFAULT_POLICY) {
  const rules = { ...DEFAULT_POLICY, ...policy };
  const stock = Number(context.stock);
  const margin = Number(context.contributionMargin);
  const trend = Number(context.salesTrend);
  const market = context.market || {};
  if (Number.isFinite(stock) && stock <= 0) return "rupture";
  if (context.isLaunch === true || Number(context.profitSampleCount) === 0) return "launch";
  if (Number.isFinite(margin) && margin < rules.minContributionMargin) return "margin_critical";
  if (stock >= rules.excessStockUnits && trend <= -0.15) return "excess";
  if (market.position === "above_market" && trend <= -0.15) return "defense";
  if (trend >= 0.2 && margin >= rules.minContributionMargin * 2) return "acceleration";
  if (trend > 0 && context.wasDeclining === true) return "recovery";
  return "stable";
}

function calculateConfidence(context = {}, elasticity = {}) {
  const components = {
    currentPrice: positiveNumber(context.currentPrice) ? 0.15 : 0,
    economicCost: positiveNumber(context.economicUnitCost) ? 0.2 : 0,
    sales: positiveNumber(context.baseUnits) ? 0.15 : 0,
    profit: Number(context.profitSampleCount) > 0 && Number.isFinite(Number(context.contributionMargin)) ? 0.1 : 0,
    market: Number(context.market?.count) >= 3 ? 0.15 : 0,
    inventory: Number.isFinite(Number(context.stock)) ? 0.1 : 0,
    ads: context.ads && Number.isFinite(Number(context.ads.spend)) ? 0.05 : 0,
    cash: context.cash && Number.isFinite(Number(context.cash.freeCash)) ? 0.05 : 0,
    elasticity: elasticity.reliable ? 0.05 : 0,
  };
  return { score: round(Object.values(components).reduce((sum, value) => sum + value, 0), 2), components };
}

function priceFloor(context, policy) {
  const cost = Number(context.economicUnitCost);
  if (!positiveNumber(cost) || policy.minContributionMargin >= 1) return null;
  return round(Math.max(cost + policy.minContributionAmount, cost / (1 - policy.minContributionMargin)), 2);
}

function evaluateScenario(candidatePrice, context = {}, elasticity = {}, policy = DEFAULT_POLICY) {
  const rules = { ...DEFAULT_POLICY, ...policy };
  const price = round(Number(candidatePrice), 2);
  const currentPrice = Number(context.currentPrice);
  const cost = Number(context.economicUnitCost);
  const floor = priceFloor(context, rules);
  const reasons = [];
  const changePercent = positiveNumber(currentPrice) && positiveNumber(price) ? (price - currentPrice) / currentPrice : null;
  if (!positiveNumber(price) || !positiveNumber(currentPrice)) reasons.push("invalid_price");
  if (floor !== null && price < floor) reasons.push("below_economic_floor");
  if (changePercent !== null && Math.abs(changePercent) > rules.maxPriceChangePercent + 0.000001) reasons.push("price_change_limit");

  let estimatedUnits = null;
  let estimatedRevenue = null;
  let estimatedContribution = null;
  if (elasticity.reliable && positiveNumber(context.baseUnits) && positiveNumber(price) && positiveNumber(currentPrice) && positiveNumber(cost)) {
    estimatedUnits = Number(context.baseUnits) * ((price / currentPrice) ** elasticity.value);
    estimatedRevenue = estimatedUnits * price;
    estimatedContribution = estimatedUnits * (price - cost);
  } else if (price === currentPrice && positiveNumber(context.baseUnits) && positiveNumber(cost)) {
    estimatedUnits = Number(context.baseUnits);
    estimatedRevenue = estimatedUnits * price;
    estimatedContribution = estimatedUnits * (price - cost);
  }
  return {
    price,
    changePercent: round(changePercent, 4),
    priceFloor: floor,
    allowed: reasons.length === 0,
    guardrailReasons: reasons,
    estimatedUnits: round(estimatedUnits, 2),
    estimatedRevenue: round(estimatedRevenue, 2),
    estimatedContribution: round(estimatedContribution, 2),
  };
}

function missingData(context) {
  const missing = [];
  if (!positiveNumber(context.currentPrice)) missing.push("current_price");
  if (!positiveNumber(context.economicUnitCost)) missing.push("economic_unit_cost");
  if (!positiveNumber(context.baseUnits)) missing.push("sales_baseline");
  if (!Number.isFinite(Number(context.stock))) missing.push("inventory");
  if (Number(context.market?.count) < 3) missing.push("market_range");
  if (!Number.isFinite(Number(context.contributionMargin))) missing.push("contribution_margin");
  return missing;
}

function uniquePrices(values) {
  return [...new Set(values.filter(positiveNumber).map((value) => round(Number(value), 2)))];
}

function recommendDecision(context = {}, policy = {}) {
  const rules = { ...DEFAULT_POLICY, ...policy };
  const currentPrice = round(Number(context.currentPrice), 2);
  const elasticity = estimateElasticity(context.performanceSamples || [], rules);
  const confidenceResult = calculateConfidence(context, elasticity);
  const strategicState = classifyStrategicState(context, rules);
  const floor = priceFloor(context, rules);
  const candidates = uniquePrices([
    currentPrice,
    floor,
    context.market?.p25,
    context.market?.median,
    context.market?.p75,
    positiveNumber(currentPrice) ? currentPrice * (1 - rules.maxPriceChangePercent) : null,
    positiveNumber(currentPrice) ? currentPrice * (1 + rules.maxPriceChangePercent) : null,
  ]);
  const scenarios = candidates.map((price) => evaluateScenario(price, context, elasticity, rules));
  const absent = missingData(context);

  let decisionType = "maintain";
  let recommendedPrice = currentPrice;
  let selected = scenarios.find((scenario) => scenario.price === currentPrice) || null;

  if (strategicState === "rupture") {
    decisionType = "wait";
  } else if (!positiveNumber(currentPrice) || confidenceResult.score < rules.minConfidence) {
    decisionType = "wait";
  } else if (elasticity.reliable) {
    const viable = scenarios.filter((scenario) => scenario.allowed && Number.isFinite(scenario.estimatedContribution));
    selected = viable.sort((a, b) => b.estimatedContribution - a.estimatedContribution)[0] || selected;
    recommendedPrice = selected?.price ?? currentPrice;
    const movement = (recommendedPrice - currentPrice) / currentPrice;
    decisionType = movement > 0.005 ? "increase" : movement < -0.005 ? "reduce" : "maintain";
  } else if (positiveNumber(context.market?.median)) {
    const gap = (Number(context.market.median) - currentPrice) / currentPrice;
    if (Math.abs(gap) >= 0.05) {
      const direction = Math.sign(gap);
      const target = currentPrice * (1 + (direction * Math.min(Math.abs(gap), rules.cautiousTestPercent)));
      const testScenario = evaluateScenario(target, context, elasticity, rules);
      if (testScenario.allowed) {
        selected = testScenario;
        if (!scenarios.some((scenario) => scenario.price === testScenario.price)) scenarios.push(testScenario);
        recommendedPrice = testScenario.price;
        decisionType = "test";
      }
    }
  }

  if (decisionType === "wait" || decisionType === "maintain") recommendedPrice = currentPrice;
  const movement = positiveNumber(currentPrice) && positiveNumber(recommendedPrice) ? Math.abs((recommendedPrice - currentPrice) / currentPrice) : 0;
  const risks = [];
  if (Number(context.ads?.spend) > 0 && movement > 0.05) {
    risks.push({ code: "campaign_ranking_risk", level: "high", message: "Mudanca superior a 5% com campanhas ativas pode afetar conversao e ranking." });
  }
  if (!elasticity.reliable) risks.push({ code: "elasticity_unavailable", level: "medium", message: "Impacto de demanda nao pode ser estimado com confianca." });
  if (strategicState === "rupture") risks.push({ code: "out_of_stock", level: "high", message: "Sem estoque, uma mudanca de preco nao deve ser executada." });

  const lowConfidence = confidenceResult.score < rules.minConfidence;
  const interpretation = strategicState === "rupture"
    ? "O SKU esta em ruptura; preservar o preco atual evita uma decisao sem capacidade de venda."
    : lowConfidence
      ? `Dados insuficientes para uma recomendacao economica segura: ${absent.join(", ") || "cobertura limitada"}.`
      : elasticity.reliable
        ? `A demanda observada tem elasticidade ${elasticity.value} com ajuste R² ${elasticity.r2}; os cenarios foram comparados por contribuicao estimada.`
        : "A cobertura operacional e suficiente, mas a elasticidade ainda nao e confiavel; qualquer movimento deve ser tratado como teste controlado.";
  const decision = decisionType === "wait"
    ? "Aguardar novos dados ou recomposicao de estoque e manter o preco atual."
    : decisionType === "test"
      ? `Testar o preco ${recommendedPrice} em janela limitada, medir conversao e reavaliar antes de ampliar.`
      : decisionType === "maintain"
        ? "Manter o preco atual; nenhum cenario valido apresenta ganho economico material."
        : `${decisionType === "increase" ? "Elevar" : "Reduzir"} para ${recommendedPrice}, sujeito a aprovacao humana e monitoramento.`;

  return {
    engineVersion: "decision-engine-v1",
    strategicState,
    decisionType,
    currentPrice,
    recommendedPrice,
    confidence: confidenceResult.score,
    confidenceComponents: confidenceResult.components,
    elasticity,
    guardrails: { policy: rules, priceFloor: floor, passed: selected?.allowed === true },
    scenarios: scenarios.sort((a, b) => a.price - b.price),
    evidence: {
      sources: ["profit", "inventory", "market", "ads", "cash", "price_performance"].filter((source) => {
        if (source === "profit") return Number(context.profitSampleCount) > 0;
        if (source === "inventory") return Number.isFinite(Number(context.stock));
        if (source === "market") return Number(context.market?.count) > 0;
        if (source === "ads") return Boolean(context.ads);
        if (source === "cash") return Boolean(context.cash);
        return (context.performanceSamples || []).length > 0;
      }),
      missingData: absent,
      context: { sku: context.sku || null, salesTrend: context.salesTrend ?? null, marketPosition: context.market?.position || null },
    },
    interpretation,
    decision,
    risks,
    impact: {
      estimatedUnits: elasticity.reliable ? selected?.estimatedUnits ?? null : null,
      estimatedRevenue: elasticity.reliable ? selected?.estimatedRevenue ?? null : null,
      estimatedContribution: elasticity.reliable ? selected?.estimatedContribution ?? null : null,
    },
    requiresApproval: true,
    autoApply: false,
  };
}

module.exports = {
  DEFAULT_POLICY,
  estimateElasticity,
  classifyStrategicState,
  calculateConfidence,
  evaluateScenario,
  recommendDecision,
};
