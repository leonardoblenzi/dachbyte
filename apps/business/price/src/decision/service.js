"use strict";

const { withTenant } = require("../db");
const { audit } = require("../audit");
const { redactForStorage } = require("../redact");
const { summarizeProductMarket } = require("../market/analytics");
const { DEFAULT_POLICY, recommendDecision, evaluateScenario, estimateElasticity } = require("./engine");

const number = (value, fallback = null) => value === null || value === undefined || value === "" ? fallback : Number.isFinite(Number(value)) ? Number(value) : fallback;
const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const notFound = (message) => { throw Object.assign(new Error(message), { statusCode: 404 }); };

async function log(client, auth, request, action, resourceType, resourceId, metadata = {}) {
  await audit(client, { tenantId: auth.tenantId, actorUserId: auth.userId, action, resourceType, resourceId: String(resourceId || ""), metadata: redactForStorage(metadata), ip: request?.ip, userAgent: request?.get?.("user-agent") });
}

function policyFromRow(row) {
  if (!row) return { ...DEFAULT_POLICY };
  return {
    minContributionMargin: number(row.min_contribution_margin, DEFAULT_POLICY.minContributionMargin),
    minContributionAmount: number(row.min_contribution_amount, DEFAULT_POLICY.minContributionAmount),
    maxPriceChangePercent: number(row.max_price_change_percent, DEFAULT_POLICY.maxPriceChangePercent),
    cautiousTestPercent: number(row.cautious_test_percent, DEFAULT_POLICY.cautiousTestPercent),
    minConfidence: number(row.min_confidence, DEFAULT_POLICY.minConfidence),
    minElasticitySamples: number(row.min_elasticity_samples, DEFAULT_POLICY.minElasticitySamples),
    minElasticityR2: number(row.min_elasticity_r2, DEFAULT_POLICY.minElasticityR2),
    excessStockUnits: number(row.excess_stock_units, DEFAULT_POLICY.excessStockUnits),
    requireHumanApproval: true,
  };
}

async function cashContext(client) {
  const row = (await client.query(`SELECT
    coalesce((SELECT sum(opening_balance) FROM volt_price.bank_accounts WHERE status='active'),0) +
    coalesce((SELECT sum(CASE WHEN direction='inflow' THEN realized_amount ELSE -realized_amount END) FROM volt_price.cash_entries),0) AS free_cash`)).rows[0];
  return { freeCash: number(row?.free_cash, 0) };
}

async function buildProductContext(client, product, cash) {
  const [profitResult, marketResult, adsResult, storedSamplesResult, derivedSamplesResult, policyResult] = await Promise.all([
    client.query(`SELECT
      count(*)::int sample_count,
      coalesce(sum(i.quantity) FILTER (WHERE s.calculated_at>=now()-interval '30 days'),0) units_current,
      coalesce(sum(i.quantity) FILTER (WHERE s.calculated_at>=now()-interval '60 days' AND s.calculated_at<now()-interval '30 days'),0) units_previous,
      coalesce(sum(i.gross_amount) FILTER (WHERE s.calculated_at>=now()-interval '90 days'),0) gross,
      coalesce(sum(i.cost_amount) FILTER (WHERE s.calculated_at>=now()-interval '90 days'),0) cost,
      coalesce(sum(i.contribution_amount) FILTER (WHERE s.calculated_at>=now()-interval '90 days'),0) contribution,
      coalesce(sum(i.quantity) FILTER (WHERE s.calculated_at>=now()-interval '90 days'),0) quantity
      FROM volt_price.profit_snapshot_items i JOIN volt_price.profit_snapshots s ON s.id=i.profit_snapshot_id
      WHERE i.product_id=$1 OR (i.product_id IS NULL AND i.sku=$2)`, [product.id, product.sku]),
    client.query(`SELECT l.current_price observed_price,l.available FROM volt_price.competitor_listings l
      JOIN volt_price.market_matches m ON m.listing_id=l.id WHERE m.product_id=$1 AND m.status='matched'`, [product.id]),
    client.query(`SELECT coalesce(sum(spend),0) spend,coalesce(sum(attributed_revenue),0) revenue,
      coalesce(sum(conversions),0) conversions,coalesce(sum(impressions),0) impressions,coalesce(sum(clicks),0) clicks
      FROM volt_price.ads_metrics WHERE product_id=$1 AND is_current AND metric_date>=current_date-30`, [product.id]),
    client.query(`SELECT price,units,observed_date,source_type,source_ref FROM volt_price.price_performance_samples WHERE product_id=$1 ORDER BY observed_date DESC LIMIT 180`, [product.id]),
    client.query(`SELECT s.calculated_at::date observed_date,sum(i.quantity)::numeric units,
      CASE WHEN sum(i.quantity)>0 THEN sum(i.gross_amount)/sum(i.quantity) END price
      FROM volt_price.profit_snapshot_items i JOIN volt_price.profit_snapshots s ON s.id=i.profit_snapshot_id
      WHERE (i.product_id=$1 OR (i.product_id IS NULL AND i.sku=$2)) AND s.calculated_at>=now()-interval '180 days'
      GROUP BY s.calculated_at::date HAVING sum(i.quantity)>0 AND sum(i.gross_amount)>0 ORDER BY 1 DESC`, [product.id, product.sku]),
    client.query(`SELECT * FROM volt_price.decision_policies WHERE status='active' AND (product_id=$1 OR product_id IS NULL)
      ORDER BY (product_id IS NOT NULL) DESC,updated_at DESC LIMIT 1`, [product.id]),
  ]);
  const profit = profitResult.rows[0] || {};
  const quantity = number(profit.quantity, 0);
  const gross = number(profit.gross, 0);
  const cost = number(profit.cost, 0);
  const contribution = number(profit.contribution, 0);
  const currentUnits = number(profit.units_current, 0);
  const previousUnits = number(profit.units_previous, 0);
  const latestDecisionPrice = number(product.latest_price);
  const metadataPrice = number(product.metadata?.currentPrice ?? product.metadata?.current_price);
  const averagePrice = quantity > 0 ? gross / quantity : null;
  const currentPrice = latestDecisionPrice ?? metadataPrice ?? averagePrice;
  const unitCost = number(product.cost) ?? (quantity > 0 ? cost / quantity : null);
  const ownMarket = summarizeProductMarket(marketResult.rows, currentPrice);
  const adsRow = adsResult.rows[0] || {};
  const spend = number(adsRow.spend, 0);
  const revenue = number(adsRow.revenue, 0);
  const storedSamples = storedSamplesResult.rows.map((row) => ({ price: number(row.price), units: number(row.units), observedDate: row.observed_date, sourceType: row.source_type, sourceRef: row.source_ref }));
  const storedDates = new Set(storedSamples.map((sample) => String(sample.observedDate)));
  const derivedSamples = derivedSamplesResult.rows.filter((row) => !storedDates.has(String(row.observed_date))).map((row) => ({ price: number(row.price), units: number(row.units), observedDate: row.observed_date, sourceType: "DERIVED", sourceRef: `profit:${row.observed_date}` }));
  return {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    currentPrice,
    economicUnitCost: unitCost,
    stock: number(product.stock),
    baseUnits: currentUnits || (quantity > 0 ? quantity : number(storedSamples[0]?.units)),
    salesTrend: previousUnits > 0 ? (currentUnits - previousUnits) / previousUnits : 0,
    contributionMargin: gross > 0 ? contribution / gross : null,
    profitSampleCount: number(profit.sample_count, 0),
    isLaunch: product.metadata?.isLaunch === true || product.metadata?.is_launch === true,
    market: ownMarket.range,
    ads: { spend, revenue, roas: spend > 0 ? revenue / spend : null, conversions: number(adsRow.conversions, 0), impressions: number(adsRow.impressions, 0), clicks: number(adsRow.clicks, 0) },
    cash,
    performanceSamples: [...storedSamples, ...derivedSamples].slice(0, 180),
    policy: policyFromRow(policyResult.rows[0]),
  };
}

async function loadProducts(client, productId = null) {
  const values = productId ? [productId] : [];
  const where = productId ? "WHERE p.id=$1" : "";
  const products = (await client.query(`SELECT p.*,
    (SELECT current_price FROM volt_price.pricing_decisions d WHERE d.product_id=p.id AND d.current_price IS NOT NULL ORDER BY d.created_at DESC LIMIT 1) latest_price
    FROM volt_price.products p ${where} ORDER BY p.name,p.sku LIMIT 2000`, values)).rows;
  if (productId && !products.length) notFound("Produto nao encontrado neste tenant.");
  return products;
}

async function decisionOverview(auth, query = {}) {
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const productId = clean(query.productId, 80) || null;
    const [decisions, runs, policies, samples, products] = await Promise.all([
      client.query(`SELECT d.*,p.sku,p.name FROM volt_price.pricing_decisions d LEFT JOIN volt_price.products p ON p.id=d.product_id
        WHERE ($1::uuid IS NULL OR d.product_id=$1) ORDER BY d.created_at DESC LIMIT 500`, [productId]),
      client.query("SELECT * FROM volt_price.decision_runs ORDER BY started_at DESC LIMIT 100"),
      client.query("SELECT p.*,x.sku,x.name product_name FROM volt_price.decision_policies p LEFT JOIN volt_price.products x ON x.id=p.product_id ORDER BY p.product_id NULLS FIRST,p.updated_at DESC"),
      client.query(`SELECT s.*,p.sku,p.name product_name FROM volt_price.price_performance_samples s JOIN volt_price.products p ON p.id=s.product_id
        WHERE ($1::uuid IS NULL OR s.product_id=$1) ORDER BY s.observed_date DESC LIMIT 500`, [productId]),
      client.query("SELECT id,sku,name,cost,stock,metadata FROM volt_price.products ORDER BY name,sku LIMIT 2000"),
    ]);
    const summary = decisions.rows.reduce((acc, row) => { acc.total += 1; acc[row.status] = (acc[row.status] || 0) + 1; acc.states[row.strategic_state || row.state || "unknown"] = (acc.states[row.strategic_state || row.state || "unknown"] || 0) + 1; return acc; }, { total: 0, suggested: 0, approved: 0, rejected: 0, states: {} });
    return { summary, decisions: decisions.rows, runs: runs.rows, policies: policies.rows, samples: samples.rows, products: products.rows, defaults: DEFAULT_POLICY };
  });
}

async function executeDecisionRun(auth, input = {}, request = null) {
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const products = await loadProducts(client, clean(input.productId, 80) || null);
    if (!products.length) invalid("Cadastre ao menos um produto antes de executar o motor.");
    const cash = await cashContext(client);
    const run = (await client.query(`INSERT INTO volt_price.decision_runs(tenant_id,engine_version,status,period_start,period_end,input_summary,created_by)
      VALUES($1,'decision-engine-v1','running',current_date-30,current_date,$2::jsonb,$3) RETURNING *`, [auth.tenantId, JSON.stringify({ productId: input.productId || null, productCount: products.length, commissionReferenceUsed: false }), auth.userId])).rows[0];
    const decisions = [];
    for (const product of products) {
      const context = await buildProductContext(client, product, cash);
      const recommendation = recommendDecision(context, context.policy);
      const decision = (await client.query(`INSERT INTO volt_price.pricing_decisions(
        tenant_id,product_id,decision_run_id,engine_version,state,strategic_state,decision_type,current_price,recommended_price,confidence,
        confidence_components,recommendation,evidence,elasticity,guardrails,scenarios,risks,interpretation,impact,input_snapshot,status,requires_approval,valid_until)
        VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17,$18::jsonb,$19::jsonb,'suggested',true,now()+interval '7 days') RETURNING *`, [
        auth.tenantId, product.id, run.id, recommendation.engineVersion, recommendation.strategicState, recommendation.decisionType,
        recommendation.currentPrice, recommendation.recommendedPrice, recommendation.confidence, JSON.stringify(recommendation.confidenceComponents), recommendation.decision,
        JSON.stringify(recommendation.evidence), JSON.stringify(recommendation.elasticity), JSON.stringify(recommendation.guardrails), JSON.stringify(recommendation.scenarios),
        JSON.stringify(recommendation.risks), recommendation.interpretation, JSON.stringify(recommendation.impact), JSON.stringify(redactForStorage(context)),
      ])).rows[0];
      const signals = [
        { type: "strategic_state", text: recommendation.strategicState, source: "decision_engine", evidence: { interpretation: recommendation.interpretation } },
        { type: "confidence", numeric: recommendation.confidence, source: "multi_source", evidence: recommendation.confidenceComponents },
        { type: "elasticity", numeric: recommendation.elasticity.value, text: recommendation.elasticity.reason, source: "price_performance", evidence: recommendation.elasticity },
        { type: "market_position", numeric: context.market?.ownVsMedian, text: context.market?.position, source: "market", evidence: context.market || {} },
      ];
      for (const signal of signals) await client.query(`INSERT INTO volt_price.decision_signals(tenant_id,run_id,product_id,signal_type,numeric_value,text_value,confidence,source_type,source_ref,evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [auth.tenantId, run.id, product.id, signal.type, signal.numeric ?? null, signal.text ?? null, recommendation.confidence, signal.source, product.sku, JSON.stringify(signal.evidence)]);
      decisions.push({ ...decision, sku: product.sku, name: product.name });
    }
    await client.query("UPDATE volt_price.decision_runs SET status='completed',decision_count=$2,completed_at=now() WHERE id=$1", [run.id, decisions.length]);
    await log(client, auth, request, "pricing.decision.run", "decision_run", run.id, { decisionCount: decisions.length, productId: input.productId || null, autoApply: false });
    return { run: { ...run, status: "completed", decision_count: decisions.length }, decisions };
  });
}

async function upsertPolicy(auth, input = {}, request = null) {
  const productId = clean(input.productId, 80) || null;
  const values = {
    margin: number(input.minContributionMargin, DEFAULT_POLICY.minContributionMargin), amount: number(input.minContributionAmount, 0),
    change: number(input.maxPriceChangePercent, DEFAULT_POLICY.maxPriceChangePercent), test: number(input.cautiousTestPercent, DEFAULT_POLICY.cautiousTestPercent),
    confidence: number(input.minConfidence, DEFAULT_POLICY.minConfidence), samples: Math.trunc(number(input.minElasticitySamples, DEFAULT_POLICY.minElasticitySamples)),
    r2: number(input.minElasticityR2, DEFAULT_POLICY.minElasticityR2), excess: number(input.excessStockUnits, DEFAULT_POLICY.excessStockUnits),
  };
  if (values.margin < 0 || values.margin >= 1 || values.change <= 0 || values.change > 1 || values.confidence < 0 || values.confidence > 1 || values.samples < 3) invalid("Parametros da politica fora dos limites permitidos.");
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    if (productId && !(await client.query("SELECT 1 FROM volt_price.products WHERE id=$1", [productId])).rowCount) notFound("Produto nao encontrado.");
    await client.query("UPDATE volt_price.decision_policies SET status='inactive',updated_at=now() WHERE status='active' AND product_id IS NOT DISTINCT FROM $1::uuid", [productId]);
    const row = (await client.query(`INSERT INTO volt_price.decision_policies(tenant_id,product_id,name,min_contribution_margin,min_contribution_amount,max_price_change_percent,cautious_test_percent,min_confidence,min_elasticity_samples,min_elasticity_r2,excess_stock_units,require_human_approval,risk_settings,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12::jsonb,$13) RETURNING *`, [auth.tenantId, productId, clean(input.name, 200) || "Politica economica padrao", values.margin, values.amount, values.change, values.test, values.confidence, values.samples, values.r2, values.excess, JSON.stringify(redactForStorage(input.riskSettings || {})), auth.userId])).rows[0];
    await log(client, auth, request, "pricing.policy.upsert", "decision_policy", row.id, { productId, requireHumanApproval: true });
    return row;
  });
}

async function upsertPerformanceSample(auth, input = {}, request = null) {
  const productId = clean(input.productId, 80); const price = number(input.price); const units = number(input.units);
  if (!productId || !(price > 0) || !(units >= 0)) invalid("Produto, preco positivo e unidades nao negativas sao obrigatorios.");
  const observedDate = clean(input.observedDate, 10) || new Date().toISOString().slice(0, 10);
  const sourceRef = clean(input.sourceRef, 300) || `manual:${observedDate}`;
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    if (!(await client.query("SELECT 1 FROM volt_price.products WHERE id=$1", [productId])).rowCount) notFound("Produto nao encontrado.");
    const row = (await client.query(`INSERT INTO volt_price.price_performance_samples(tenant_id,product_id,observed_date,price,units,revenue,contribution,ad_spend,impressions,clicks,conversions,source_type,source_ref,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) ON CONFLICT(tenant_id,product_id,source_ref) DO UPDATE SET observed_date=EXCLUDED.observed_date,price=EXCLUDED.price,units=EXCLUDED.units,revenue=EXCLUDED.revenue,contribution=EXCLUDED.contribution,ad_spend=EXCLUDED.ad_spend,impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,conversions=EXCLUDED.conversions,metadata=EXCLUDED.metadata,updated_at=now() RETURNING *`, [auth.tenantId, productId, observedDate, price, units, number(input.revenue), number(input.contribution), number(input.adSpend), number(input.impressions), number(input.clicks), number(input.conversions), "MANUAL", sourceRef, JSON.stringify(redactForStorage(input.metadata || {}))])).rows[0];
    await log(client, auth, request, "pricing.sample.upsert", "price_performance_sample", row.id, { productId, observedDate, sourceRef });
    return row;
  });
}

async function reviewDecision(auth, decisionId, input = {}, request = null) {
  const status = clean(input.status, 20);
  if (!['approved', 'rejected'].includes(status)) invalid("Revisao deve ser approved ou rejected.");
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const before = (await client.query("SELECT * FROM volt_price.pricing_decisions WHERE id=$1 FOR UPDATE", [decisionId])).rows[0];
    if (!before) notFound("Decisao nao encontrada neste tenant.");
    if (before.status !== "suggested") invalid("A decisao ja foi revisada.");
    const row = (await client.query("UPDATE volt_price.pricing_decisions SET status=$2,reviewed_by=$3,reviewed_at=now(),review_note=$4,updated_at=now() WHERE id=$1 RETURNING *", [decisionId, status, auth.userId, clean(input.note, 1000) || null])).rows[0];
    await log(client, auth, request, `pricing.decision.${status}`, "pricing_decision", row.id, { beforeStatus: before.status, afterStatus: status, autoApply: false, recommendedPrice: row.recommended_price });
    return row;
  });
}

function simulateDecision(input = {}) {
  const context = { currentPrice: number(input.currentPrice), economicUnitCost: number(input.unitCost), baseUnits: number(input.currentUnits), stock: number(input.stock, 1), contributionMargin: number(input.contributionMargin), profitSampleCount: number(input.profitSampleCount, 1), market: input.market || {}, ads: input.ads || { spend: 0 }, cash: input.cash || { freeCash: 0 }, performanceSamples: Array.isArray(input.performanceSamples) ? input.performanceSamples : [] };
  if (!(context.currentPrice > 0) || !(context.economicUnitCost > 0) || !(context.baseUnits > 0)) invalid("Informe preco atual, custo unitario e unidades atuais positivos.");
  const policy = { ...DEFAULT_POLICY, ...(input.policy || {}) };
  if (number(input.candidatePrice) > 0) {
    const candidatePrice = number(input.candidatePrice);
    const response = { scenario: evaluateScenario(candidatePrice, context, estimateElasticity(context.performanceSamples, policy), policy), recommendation: recommendDecision(context, policy) };
    const projectedUnits = number(input.projectedUnits);
    if (projectedUnits !== null) {
      const currentContribution = (context.currentPrice - context.economicUnitCost) * context.baseUnits;
      const candidateContribution = (candidatePrice - context.economicUnitCost) * projectedUnits;
      response.simulation = { currentPrice: context.currentPrice, candidatePrice, unitCost: context.economicUnitCost, currentUnits: context.baseUnits, projectedUnits, currentContribution, candidateContribution, delta: candidateContribution - currentContribution, recommendation: candidateContribution > currentContribution ? "candidate_better" : candidateContribution < currentContribution ? "keep_current" : "equivalent" };
    }
    return response;
  }
  return { recommendation: recommendDecision(context, policy) };
}

module.exports = { decisionOverview, executeDecisionRun, upsertPolicy, upsertPerformanceSample, reviewDecision, simulateDecision, policyFromRow, buildProductContext };
