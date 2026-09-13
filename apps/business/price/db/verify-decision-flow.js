"use strict";

require("../src/loadEnv").loadLocalEnv();
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { withPlatformAdmin, pool } = require("../src/db");
const { upsertPolicy, upsertPerformanceSample, executeDecisionRun, decisionOverview, reviewDecision } = require("../src/decision/service");

async function cleanupVerificationData() {
  await withPlatformAdmin(null, async (client) => {
    const tenants = (await client.query("SELECT id FROM volt_price.tenants WHERE slug LIKE 'decision-verify-%'")).rows.map((row) => row.id);
    const users = (await client.query("SELECT id FROM volt_price.users WHERE email LIKE 'decision-verify-%@invalid.local'")).rows.map((row) => row.id);
    if (!tenants.length && !users.length) return;
    await client.query("ALTER TABLE volt_price.audit_logs DISABLE TRIGGER trg_vp_audit_logs_append_only");
    try { await client.query("DELETE FROM volt_price.audit_logs WHERE tenant_id=ANY($1::uuid[]) OR actor_user_id=ANY($2::uuid[])", [tenants, users]); }
    finally { await client.query("ALTER TABLE volt_price.audit_logs ENABLE TRIGGER trg_vp_audit_logs_append_only"); }
    if (tenants.length) await client.query("DELETE FROM volt_price.tenants WHERE id=ANY($1::uuid[])", [tenants]);
    if (users.length) await client.query("DELETE FROM volt_price.users WHERE id=ANY($1::uuid[])", [users]);
  });
}

(async () => {
  const suffix = crypto.randomBytes(8).toString("hex");
  try {
    await cleanupVerificationData();
    const setup = await withPlatformAdmin(null, async (client) => {
      const tenant = (await client.query("INSERT INTO volt_price.tenants(name,slug) VALUES($1,$2) RETURNING id", [`Decision Verify ${suffix}`, `decision-verify-${suffix}`])).rows[0];
      const user = (await client.query("INSERT INTO volt_price.users(email,full_name,password_hash) VALUES($1,'Decision Verify','not-used') RETURNING id", [`decision-verify-${suffix}@invalid.local`])).rows[0];
      await client.query("INSERT INTO volt_price.memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')", [tenant.id, user.id]);
      const product = (await client.query("INSERT INTO volt_price.products(tenant_id,sku,name,cost,stock,metadata) VALUES($1,'DECISION-SKU','Produto de decisao',60,50,$2::jsonb) RETURNING id", [tenant.id, JSON.stringify({ currentPrice: 100 })])).rows[0];
      return { tenantId: tenant.id, userId: user.id, productId: product.id };
    });
    const auth = { tenantId: setup.tenantId, userId: setup.userId };
    await upsertPolicy(auth, { minConfidence: 0.55, maxPriceChangePercent: 0.1, minElasticitySamples: 4 });
    for (const [index, sample] of [[100, 100], [125, 80], [160, 62.5], [200, 50]].entries()) {
      await upsertPerformanceSample(auth, { productId: setup.productId, observedDate: `2026-08-${String(index + 1).padStart(2, "0")}`, price: sample[0], units: sample[1], sourceRef: `verify:${index}` });
    }
    const result = await executeDecisionRun(auth, { productId: setup.productId });
    assert.equal(result.run.status, "completed");
    assert.equal(result.decisions.length, 1);
    assert.equal(result.decisions[0].decision_type, "increase");
    assert.equal(Number(result.decisions[0].recommended_price), 110);
    assert.equal(result.decisions[0].requires_approval, true);
    const overview = await decisionOverview(auth, { productId: setup.productId });
    assert.equal(overview.samples.length, 4);
    assert.equal(overview.summary.suggested, 1);
    const reviewed = await reviewDecision(auth, result.decisions[0].id, { status: "approved", note: "Verificacao automatizada" });
    assert.equal(reviewed.status, "approved");
    const unchanged = await withPlatformAdmin(null, async (client) => (await client.query("SELECT metadata FROM volt_price.products WHERE id=$1", [setup.productId])).rows[0]);
    assert.equal(unchanged.metadata.currentPrice, 100);
    console.log("[VoltPrice] Fluxo Decision verificado: policy, 4 amostras, elasticidade, run, sinais, aprovacao humana e preco inalterado.");
  } finally {
    await cleanupVerificationData();
    await pool?.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
