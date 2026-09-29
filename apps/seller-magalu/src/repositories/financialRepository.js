"use strict";
const db = require("../config/postgres");
const { calculatePricing } = require("../services/magaluPricingEngine");

function text(value, max = 250) { return String(value == null ? "" : value).trim().slice(0, max); }
function positiveMoney(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : fallback; }

async function listCosts(accountId, { q = "", offset = 0, limit = 50 } = {}) {
  const params = [Number(accountId)], where = ["s.account_id=$1", "s.is_present=true"];
  if (text(q)) { params.push(`%${text(q).toLowerCase()}%`); where.push(`(lower(s.sku) like $${params.length} or lower(coalesce(s.title,'')) like $${params.length})`); }
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50)), safeOffset = Math.max(0, Number(offset) || 0);
  params.push(safeLimit, safeOffset);
  const { rows } = await db.query(`select s.sku,s.title,p.price,c.unit_cost,c.tax_rate,c.packaging_cost,c.operational_cost,c.other_cost,c.notes,c.updated_at,count(*) over()::int total_count from magalu.skus s left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku where ${where.join(" and ")} order by s.sku asc limit $${params.length - 1} offset $${params.length}`, params);
  return { rows, total: rows.length ? Number(rows[0].total_count) : 0, offset: safeOffset, limit: safeLimit };
}
async function upsertCost(accountId, sku, input = {}) {
  const normalizedSku = text(sku, 128); if (!normalizedSku) { const e = new Error("SKU obrigatório."); e.status = 400; throw e; }
  const exists = await db.queryOne("select 1 from magalu.skus where account_id=$1 and sku=$2 and is_present=true", [Number(accountId), normalizedSku]);
  if (!exists) { const e = new Error("SKU não pertence ao catálogo ativo desta conta."); e.status = 404; throw e; }
  return db.queryOne(`insert into magalu.sku_costs(account_id,sku,unit_cost,tax_rate,packaging_cost,operational_cost,other_cost,notes) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(account_id,sku) do update set unit_cost=excluded.unit_cost,tax_rate=excluded.tax_rate,packaging_cost=excluded.packaging_cost,operational_cost=excluded.operational_cost,other_cost=excluded.other_cost,notes=excluded.notes,updated_at=now() returning *`, [Number(accountId), normalizedSku, positiveMoney(input.unit_cost), positiveMoney(input.tax_rate), positiveMoney(input.packaging_cost), positiveMoney(input.operational_cost), positiveMoney(input.other_cost), text(input.notes, 2000) || null]);
}
async function margin(accountId, { q = "", offset = 0, limit = 50 } = {}) {
  const data = await listCosts(accountId, { q, offset, limit });
  return { ...data, rows: data.rows.map((row) => ({ ...row, estimate: calculatePricing({ sale_price: row.price, unit_cost: row.unit_cost, tax_rate: row.tax_rate, packaging_cost: row.packaging_cost, operational_cost: row.operational_cost, other_cost: row.other_cost }) })) };
}
async function lookup(accountId, sku) { return db.queryOne(`select s.sku,s.title,p.price,c.unit_cost,c.tax_rate,c.packaging_cost,c.operational_cost,c.other_cost from magalu.skus s left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku where s.account_id=$1 and s.sku=$2 and s.is_present=true`, [Number(accountId), text(sku, 128)]); }
async function coverage(accountId) {
  return db.queryOne(`select count(*) filter(where s.is_present)::int as sku_count,
    count(*) filter(where s.is_present and p.price is not null)::int as priced_skus,
    count(*) filter(where s.is_present and p.price is not null and c.unit_cost is not null)::int as costed_skus
    from magalu.skus s left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku
    left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku where s.account_id=$1`, [Number(accountId)]);
}
module.exports = { listCosts, upsertCost, margin, lookup, coverage };
