"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_POLICY,
  estimateElasticity,
  classifyStrategicState,
  evaluateScenario,
  recommendDecision,
} = require("../src/decision/engine");
const { simulateDecision } = require("../src/decision/service");

function completeContext(overrides = {}) {
  return {
    productId: "product-1",
    sku: "SKU-1",
    currentPrice: 100,
    economicUnitCost: 60,
    stock: 40,
    baseUnits: 100,
    salesTrend: 0,
    contributionMargin: 0.4,
    profitSampleCount: 4,
    market: { count: 5, p25: 95, median: 100, p75: 110, position: "at_market" },
    ads: { spend: 0, roas: null, conversions: 0 },
    cash: { freeCash: 10000 },
    performanceSamples: [
      { price: 100, units: 100 },
      { price: 125, units: 80 },
      { price: 160, units: 62.5 },
      { price: 200, units: 50 },
    ],
    ...overrides,
  };
}

test("estima elasticidade log-log confiavel quando ha variacao e amostras suficientes", () => {
  const result = estimateElasticity(completeContext().performanceSamples, DEFAULT_POLICY);
  assert.ok(Math.abs(result.value + 1) < 0.0001);
  assert.ok(result.r2 > 0.999);
  assert.equal(result.sampleCount, 4);
  assert.equal(result.reliable, true);
  assert.equal(result.reason, null);
});

test("nao inventa elasticidade quando faltam amostras", () => {
  const result = estimateElasticity([{ price: 100, units: 10 }, { price: 110, units: 9 }], DEFAULT_POLICY);
  assert.equal(result.value, null);
  assert.equal(result.reliable, false);
  assert.equal(result.reason, "insufficient_samples");
});

test("classifica estados estrategicos com prioridades explicitas", () => {
  assert.equal(classifyStrategicState(completeContext({ stock: 0 })), "rupture");
  assert.equal(classifyStrategicState(completeContext({ contributionMargin: 0.04 })), "margin_critical");
  assert.equal(classifyStrategicState(completeContext({ stock: 500, salesTrend: -0.25 })), "excess");
  assert.equal(classifyStrategicState(completeContext({ market: { count: 4, median: 80, position: "above_market" }, salesTrend: -0.3 })), "defense");
  assert.equal(classifyStrategicState(completeContext({ salesTrend: 0.35, contributionMargin: 0.35 })), "acceleration");
});

test("guardrail rejeita qualquer cenario abaixo do piso economico", () => {
  const scenario = evaluateScenario(65, completeContext(), { value: -1, reliable: true }, DEFAULT_POLICY);
  assert.equal(scenario.allowed, false);
  assert.ok(scenario.guardrailReasons.includes("below_economic_floor"));
  assert.equal(scenario.priceFloor, 66.67);
});

test("ruptura bloqueia mudanca e recomenda aguardar", () => {
  const result = recommendDecision(completeContext({ stock: 0 }));
  assert.equal(result.strategicState, "rupture");
  assert.equal(result.decisionType, "wait");
  assert.equal(result.recommendedPrice, 100);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.autoApply, false);
});

test("baixa confianca assume dados insuficientes de forma explicita", () => {
  const result = recommendDecision({ productId: "p", sku: "SEM-DADOS", currentPrice: 100, stock: 5 });
  assert.equal(result.decisionType, "wait");
  assert.ok(result.confidence < DEFAULT_POLICY.minConfidence);
  assert.ok(result.evidence.missingData.includes("economic_unit_cost"));
  assert.match(result.interpretation, /dados insuficientes/i);
});

test("elasticidade confiavel escolhe o melhor cenario de contribuicao dentro dos guardrails", () => {
  const result = recommendDecision(completeContext());
  assert.equal(result.elasticity.reliable, true);
  assert.equal(result.decisionType, "increase");
  assert.equal(result.recommendedPrice, 110);
  assert.ok(result.impact.estimatedContribution > 4000);
});

test("sem elasticidade confiavel recomenda teste pequeno em vez de afirmar impacto", () => {
  const result = recommendDecision(completeContext({
    market: { count: 5, p25: 105, median: 112, p75: 120, position: "below_market" },
    performanceSamples: [],
  }));
  assert.equal(result.elasticity.reliable, false);
  assert.equal(result.decisionType, "test");
  assert.equal(result.recommendedPrice, 105);
  assert.equal(result.impact.estimatedUnits, null);
  assert.equal(result.impact.estimatedContribution, null);
});

test("mudanca relevante com Ads ativos sinaliza risco de campanha e ranking", () => {
  const result = recommendDecision(completeContext({ ads: { spend: 500, roas: 4, conversions: 20 } }));
  assert.ok(result.risks.some((risk) => risk.code === "campaign_ranking_risk" && risk.level === "high"));
});

test("recomendacao e explicavel e nunca executa preco automaticamente", () => {
  const result = recommendDecision(completeContext());
  assert.ok(result.evidence.sources.length >= 4);
  assert.ok(result.interpretation.length > 20);
  assert.ok(result.decision.length > 20);
  assert.ok(Array.isArray(result.scenarios) && result.scenarios.length >= 3);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.autoApply, false);
});

test("simulador preserva comparacao legada de contribuicao total", () => {
  const result = simulateDecision({ currentPrice: 100, candidatePrice: 110, unitCost: 60, currentUnits: 100, projectedUnits: 90 });
  assert.equal(result.simulation.currentContribution, 4000);
  assert.equal(result.simulation.candidateContribution, 4500);
  assert.equal(result.simulation.delta, 500);
  assert.equal(result.simulation.recommendation, "candidate_better");
  assert.ok(result.recommendation);
});
