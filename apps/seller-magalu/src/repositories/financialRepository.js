"use strict";
const db = require("../config/postgres");
const { calculatePricing } = require("../services/magaluPricingEngine");
const { validateGlobalTax } = require("../services/effectiveTax");

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

async function getAccountTax(accountId) {
  const row = await db.queryOne(`select aliquota,updated_at from magalu.finance_settings where account_id=$1`, [Number(accountId)]);
  return { enabled: Number(row?.aliquota || 0) > 0, aliquota: Number(row?.aliquota || 0), updated_at: row?.updated_at || null };
}

async function saveAccountTax(accountId, value, changedBy = null) {
  const aliquota = validateGlobalTax(value);
  return db.withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const prior = await client.query(`select aliquota from magalu.finance_settings where account_id=$1 for update`, [Number(accountId)]);
      const previous = prior.rows[0]?.aliquota == null ? null : Number(prior.rows[0].aliquota);
      const saved = await client.query(`insert into magalu.finance_settings(account_id,aliquota,updated_by)
        values($1,$2,$3) on conflict(account_id) do update set aliquota=excluded.aliquota,
        updated_by=excluded.updated_by,updated_at=now() returning aliquota,updated_at`, [Number(accountId), aliquota, changedBy]);
      if (previous !== aliquota) await client.query(`insert into magalu.finance_settings_history(account_id,previous_rate,new_rate,changed_by)
        values($1,$2,$3,$4)`, [Number(accountId), previous, aliquota, changedBy]);
      await client.query("COMMIT");
      return { enabled: aliquota > 0, aliquota, updated_at: saved.rows[0]?.updated_at || null };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
}

async function listCosts(accountId, { q = "", search_type = "sku", state = "", status = "", category = "", offset = 0, limit = 50 } = {}) {
  const params = [Number(accountId)], where = ["s.account_id=$1", "s.is_present=true"];
  const tax = "coalesce(nullif(f.aliquota,0),c.tax_rate,0)";
  const query = text(q, 3000).toLowerCase();
  if (query) {
    if (search_type === "product") { params.push(`%${query}%`); where.push(`lower(coalesce(s.title,'')) like $${params.length}`); }
    else if (/[\n,;]+/.test(query)) {
      const values = [...new Set(query.split(/[\n,;]+/).map((value) => value.trim()).filter(Boolean))].slice(0, 100);
      params.push(values); where.push(`lower(s.sku)=any($${params.length}::text[])`);
    } else { params.push(`%${query}%`); where.push(`lower(s.sku) like $${params.length}`); }
  }
  if (status === "active") where.push("s.active=true");
  if (status === "inactive") where.push("s.active=false");
  if (text(category,128)) { params.push(text(category,128)); where.push(`s.category_id=$${params.length}`); }
  const costState=text(state,30).toLowerCase();
  if(costState==="missing") where.push("c.unit_cost is null");
  if(costState==="risk") where.push(`c.unit_cost is not null and p.price is not null and (
    c.unit_cost>=p.price or ((p.price-c.unit_cost-(p.price*${tax}/100)-coalesce(c.packaging_cost,0)-coalesce(c.operational_cost,0)-coalesce(c.other_cost,0))/nullif(p.price,0))*100<=10
  )`);
  if(costState==="healthy") where.push(`c.unit_cost is not null and p.price is not null and c.unit_cost<p.price and
    ((p.price-c.unit_cost-(p.price*${tax}/100)-coalesce(c.packaging_cost,0)-coalesce(c.operational_cost,0)-coalesce(c.other_cost,0))/nullif(p.price,0))*100>10`);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50)), safeOffset = Math.max(0, Number(offset) || 0);
  params.push(safeLimit, safeOffset);
  const { rows } = await db.query(`select s.sku,s.title,s.status,s.active,s.category_id,p.price,c.unit_cost,c.tax_rate as legacy_tax_rate,
    ${tax} as tax_rate,c.packaging_cost,c.operational_cost,c.other_cost,c.notes,c.updated_at,count(*) over()::int total_count
    from magalu.skus s
    left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku and p.is_present=true
    left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
    left join magalu.finance_settings f on f.account_id=s.account_id
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

async function upsertCost(accountId, sku, input = {}, { changedBy = null, source = "manual" } = {}) {
  const normalizedSku = text(sku, 128); if (!normalizedSku) { const e = new Error("SKU obrigatório."); e.status = 400; throw e; }
  if (!["manual", "xlsx"].includes(source)) { const e = new Error("Origem de custo inválida."); e.status = 422; throw e; }
  return db.withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const selected = await client.query(`select s.sku,c.unit_cost,c.tax_rate,c.packaging_cost,c.operational_cost,c.other_cost,c.notes
        from magalu.skus s left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
        where s.account_id=$1 and s.sku=$2 and s.is_present=true for update of s`, [Number(accountId), normalizedSku]);
      const current = selected.rows[0];
      if (!current) { const e = new Error("SKU não pertence ao catálogo ativo desta conta."); e.status = 404; throw e; }
      if (!has(input,"unit_cost") && current.unit_cost == null) { const e=new Error("Custo unitário obrigatório para iniciar o cadastro de custos."); e.status=422; throw e; }
      const next = {
        unit_cost:suppliedNumber(input,"unit_cost",current.unit_cost),
        tax_rate:suppliedNumber(input,"tax_rate",current.tax_rate,{max:100}),
        packaging_cost:suppliedNumber(input,"packaging_cost",current.packaging_cost),
        operational_cost:suppliedNumber(input,"operational_cost",current.operational_cost),
        other_cost:suppliedNumber(input,"other_cost",current.other_cost),
        notes:has(input,"notes")?(text(input.notes,2000)||null):(current.notes||null)
      };
      const previous = { unit_cost:current.unit_cost == null ? null : Number(current.unit_cost), tax_rate:Number(current.tax_rate||0), packaging_cost:Number(current.packaging_cost||0), operational_cost:Number(current.operational_cost||0), other_cost:Number(current.other_cost||0), notes:current.notes||null };
      const changed = Object.keys(next).some((key) => previous[key] !== next[key]);
      let saved = current;
      if (changed) {
        const result = await client.query(`insert into magalu.sku_costs(account_id,sku,unit_cost,tax_rate,packaging_cost,operational_cost,other_cost,notes)
          values($1,$2,$3,$4,$5,$6,$7,$8)
          on conflict(account_id,sku) do update set unit_cost=excluded.unit_cost,tax_rate=excluded.tax_rate,
          packaging_cost=excluded.packaging_cost,operational_cost=excluded.operational_cost,other_cost=excluded.other_cost,
          notes=excluded.notes,updated_at=now() returning *`,
          [Number(accountId), normalizedSku, next.unit_cost, next.tax_rate, next.packaging_cost, next.operational_cost, next.other_cost, next.notes]);
        saved = result.rows[0];
        await client.query(`insert into magalu.sku_cost_history(account_id,sku,previous_cost,new_cost,previous_components,new_components,source,changed_by)
          values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
          [Number(accountId), normalizedSku, previous.unit_cost, next.unit_cost, JSON.stringify(previous), JSON.stringify(next), source, changedBy]);
      }
      await client.query("COMMIT");
      return saved;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
}

async function getCostHistory(accountId, sku, limit = 50) {
  const normalizedSku = text(sku, 128);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const result = await db.query(`select previous_cost,new_cost,previous_components,new_components,source,changed_by,created_at
    from magalu.sku_cost_history where account_id=$1 and sku=$2 order by created_at desc,id desc limit $3`,
    [Number(accountId), normalizedSku, safeLimit]);
  return result.rows;
}

async function importCosts(accountId, rows, changedBy = null) {
  if (!Array.isArray(rows) || rows.length > 50000) { const e = new Error("Quantidade de linhas inválida."); e.status = 413; throw e; }
  if (!rows.length) return { updated: 0, total: 0 };
  const skus = rows.map((row) => text(row.sku, 128));
  if (new Set(skus).size !== skus.length) { const e = new Error("SKUs duplicados na planilha."); e.status = 422; throw e; }
  return db.withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const found = await client.query(`select s.sku,c.unit_cost,c.tax_rate,c.packaging_cost,c.operational_cost,c.other_cost,c.notes
        from magalu.skus s left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
        where s.account_id=$1 and s.sku=any($2::text[]) and s.is_present=true for update of s`, [Number(accountId), skus]);
      const currentBySku = new Map(found.rows.map((row) => [row.sku, row]));
      const missing = skus.filter((sku) => !currentBySku.has(sku));
      if (missing.length) { const e = new Error(`${missing.length} SKU(s) não pertencem ao catálogo ativo desta conta: ${missing.slice(0,5).join(", ")}.`); e.status = 422; throw e; }
      const updates = rows.map((row) => {
        const current = currentBySku.get(row.sku);
        const previous = { unit_cost:current.unit_cost == null ? null : Number(current.unit_cost), tax_rate:Number(current.tax_rate||0), packaging_cost:Number(current.packaging_cost||0), operational_cost:Number(current.operational_cost||0), other_cost:Number(current.other_cost||0), notes:current.notes||null };
        if (previous.unit_cost == null && !has(row, "unit_cost")) { const e = new Error(`Custo unitário ausente para ${row.sku}.`); e.status = 422; throw e; }
        const next = { unit_cost:suppliedNumber(row,"unit_cost",current.unit_cost), tax_rate:suppliedNumber(row,"tax_rate",current.tax_rate,{max:100}), packaging_cost:suppliedNumber(row,"packaging_cost",current.packaging_cost), operational_cost:suppliedNumber(row,"operational_cost",current.operational_cost), other_cost:suppliedNumber(row,"other_cost",current.other_cost), notes:has(row,"notes")?(text(row.notes,2000)||null):(current.notes||null) };
        return { sku:row.sku, previous, next, changed:Object.keys(next).some((key) => previous[key] !== next[key]) };
      });
      let updated = 0;
      for (const { sku, previous, next, changed } of updates) {
        if (!changed) continue;
        await client.query(`insert into magalu.sku_costs(account_id,sku,unit_cost,tax_rate,packaging_cost,operational_cost,other_cost,notes)
          values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(account_id,sku) do update set unit_cost=excluded.unit_cost,
          tax_rate=excluded.tax_rate,packaging_cost=excluded.packaging_cost,operational_cost=excluded.operational_cost,
          other_cost=excluded.other_cost,notes=excluded.notes,updated_at=now()`,
          [Number(accountId),sku,next.unit_cost,next.tax_rate,next.packaging_cost,next.operational_cost,next.other_cost,next.notes]);
        await client.query(`insert into magalu.sku_cost_history(account_id,sku,previous_cost,new_cost,previous_components,new_components,source,changed_by)
          values($1,$2,$3,$4,$5::jsonb,$6::jsonb,'xlsx',$7)`,
          [Number(accountId),sku,previous.unit_cost,next.unit_cost,JSON.stringify(previous),JSON.stringify(next),changedBy]);
        updated++;
      }
      await client.query("COMMIT");
      return { updated, total:rows.length };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
}

async function margin(accountId, { q = "", offset = 0, limit = 50 } = {}) {
  const data = await listCosts(accountId, { q, offset, limit });
  return { ...data, rows: data.rows.map((row) => ({ ...row, estimate: calculatePricing({ sale_price: row.price, unit_cost: row.unit_cost, tax_rate: row.tax_rate, packaging_cost: row.packaging_cost, operational_cost: row.operational_cost, other_cost: row.other_cost }) })) };
}
async function lookup(accountId, sku) { return db.queryOne(`select s.sku,s.title,p.price,c.unit_cost,c.tax_rate as legacy_tax_rate,coalesce(nullif(f.aliquota,0),c.tax_rate,0) as tax_rate,
  case when f.aliquota>0 then 'global' else 'legacy' end as tax_source,c.packaging_cost,c.operational_cost,c.other_cost
  from magalu.skus s left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku
  left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
  left join magalu.finance_settings f on f.account_id=s.account_id
  where s.account_id=$1 and s.sku=$2 and s.is_present=true`, [Number(accountId), text(sku, 128)]); }
async function coverage(accountId) {
  return db.queryOne(`select count(*) filter(where s.is_present)::int as sku_count,
    count(*) filter(where s.is_present and p.price is not null)::int as priced_skus,
    count(*) filter(where s.is_present and p.price is not null and c.unit_cost is not null)::int as costed_skus
    from magalu.skus s left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku
    left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku where s.account_id=$1`, [Number(accountId)]);
}
module.exports = { listCosts, exportCosts, upsertCost, margin, lookup, coverage, getAccountTax, saveAccountTax, getCostHistory, importCosts, _test:{suppliedNumber} };
