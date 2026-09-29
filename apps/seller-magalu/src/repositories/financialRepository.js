"use strict";
const db = require("../config/postgres");
const { calculatePricing } = require("../services/magaluPricingEngine");

function text(value, max = 250) { return String(value == null ? "" : value).trim().slice(0, max); }
function has(input,key){return Object.prototype.hasOwnProperty.call(input||{},key);}
function suppliedNumber(input, key, current, { max = null } = {}) {
  if (!has(input, key)) return current == null ? 0 : Number(current);
  const raw = input[key];
  const value = Number(raw);
  if (raw === null || String(raw).trim() === "" || !Number.isFinite(value) || value < 0 || (max != null && value > max)) {
    const error = new Error(`Valor inválido para ${key}.`);
    error.status = 422;
    throw error;
  }
  return value;
}

async function listCosts(accountId, { q = "", state = "", offset = 0, limit = 50 } = {}) {
  const params = [Number(accountId)], where = ["s.account_id=$1", "s.is_present=true"];
  if (text(q)) { params.push(`%${text(q).toLowerCase()}%`); where.push(`(lower(s.sku) like $${params.length} or lower(coalesce(s.title,'')) like $${params.length})`); }
  const costState=text(state,30).toLowerCase();
  if(costState==="missing") where.push("c.unit_cost is null");
  if(costState==="risk") where.push(`c.unit_cost is not null and p.price is not null and (
    c.unit_cost>=p.price or ((p.price-c.unit_cost-(p.price*coalesce(c.tax_rate,0)/100)-coalesce(c.packaging_cost,0)-coalesce(c.operational_cost,0)-coalesce(c.other_cost,0))/nullif(p.price,0))*100<=10
  )`);
  if(costState==="healthy") where.push(`c.unit_cost is not null and p.price is not null and c.unit_cost<p.price and
    ((p.price-c.unit_cost-(p.price*coalesce(c.tax_rate,0)/100)-coalesce(c.packaging_cost,0)-coalesce(c.operational_cost,0)-coalesce(c.other_cost,0))/nullif(p.price,0))*100>10`);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50)), safeOffset = Math.max(0, Number(offset) || 0);
  params.push(safeLimit, safeOffset);
  const { rows } = await db.query(`select s.sku,s.title,p.price,c.unit_cost,c.tax_rate,c.packaging_cost,c.operational_cost,c.other_cost,c.notes,c.updated_at,count(*) over()::int total_count
    from magalu.skus s
    left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku and p.is_present=true
    left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
    where ${where.join(" and ")} order by case when c.unit_cost is null then 0 else 1 end,s.sku asc
    limit $${params.length - 1} offset $${params.length}`, params);
  return { rows, total: rows.length ? Number(rows[0].total_count) : 0, offset: safeOffset, limit: safeLimit, state:costState };
}

async function exportCosts(accountId) {
  const {rows}=await db.query(`select s.sku,s.title,p.price,c.unit_cost,c.tax_rate,c.packaging_cost,c.operational_cost,c.other_cost,c.notes,c.updated_at
    from magalu.skus s
    left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku and p.is_present=true
    left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
    where s.account_id=$1 and s.is_present=true order by s.sku asc limit 50001`,[Number(accountId)]);
  if (rows.length > 50000) {
    const error = new Error("A exportação excede 50.000 SKUs. Entre em contato com o suporte para exportar uma conta maior.");
    error.status = 413;
    throw error;
  }
  return rows;
}

async function upsertCost(accountId, sku, input = {}) {
  const normalizedSku = text(sku, 128); if (!normalizedSku) { const e = new Error("SKU obrigatório."); e.status = 400; throw e; }
  const current = await db.queryOne(`select s.sku,c.unit_cost,c.tax_rate,c.packaging_cost,c.operational_cost,c.other_cost,c.notes
    from magalu.skus s left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
    where s.account_id=$1 and s.sku=$2 and s.is_present=true`, [Number(accountId), normalizedSku]);
  if (!current) { const e = new Error("SKU não pertence ao catálogo ativo desta conta."); e.status = 404; throw e; }

  if (!has(input,"unit_cost") && current.unit_cost == null) { const e=new Error("Custo unitário obrigatório para iniciar o cadastro de custos."); e.status=422; throw e; }
  const unitCost=suppliedNumber(input,"unit_cost",current.unit_cost);
  const taxRate=suppliedNumber(input,"tax_rate",current.tax_rate,{max:100});
  const packaging=suppliedNumber(input,"packaging_cost",current.packaging_cost);
  const operational=suppliedNumber(input,"operational_cost",current.operational_cost);
  const other=suppliedNumber(input,"other_cost",current.other_cost);
  const notes=has(input,"notes")?(text(input.notes,2000)||null):(current.notes||null);

  return db.queryOne(`insert into magalu.sku_costs(account_id,sku,unit_cost,tax_rate,packaging_cost,operational_cost,other_cost,notes)
    values($1,$2,$3,$4,$5,$6,$7,$8)
    on conflict(account_id,sku) do update set unit_cost=excluded.unit_cost,tax_rate=excluded.tax_rate,
      packaging_cost=excluded.packaging_cost,operational_cost=excluded.operational_cost,other_cost=excluded.other_cost,
      notes=excluded.notes,updated_at=now() returning *`,
    [Number(accountId), normalizedSku, unitCost, taxRate, packaging, operational, other, notes]);
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
module.exports = { listCosts, exportCosts, upsertCost, margin, lookup, coverage, _test:{suppliedNumber} };
