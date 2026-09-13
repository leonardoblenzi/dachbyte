"use strict";

const { withTenant } = require("../db");
const { audit } = require("../audit");
const { redactForStorage } = require("../redact");
const { money, generateInstallments, nextRecurrenceDate, projectCash, dreByCompetence } = require("./cash");

function clean(value, max = 500) { return String(value ?? "").trim().slice(0, max); }
function validDirection(value) { const direction = clean(value, 20); if (!["inflow", "outflow"].includes(direction)) throw Object.assign(new Error("Direcao deve ser inflow ou outflow."), { statusCode: 400 }); return direction; }
function positive(value, label = "Valor") { const result = money(value); if (result <= 0) throw Object.assign(new Error(`${label} deve ser maior que zero.`), { statusCode: 400 }); return result; }

async function log(client, auth, request, action, type, id, metadata = {}) {
  await audit(client, { tenantId: auth.tenantId, actorUserId: auth.userId, action, resourceType: type, resourceId: String(id), metadata: redactForStorage(metadata), ip: request?.ip, userAgent: request?.get?.("user-agent") });
}

async function cashOverview(auth, query = {}) {
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const from = clean(query.from, 10) || null;
    const to = clean(query.to, 10) || null;
    const values = [];
    const filters = [];
    if (from) { values.push(from); filters.push(`coalesce(expected_date,due_date)>= $${values.length}::date`); }
    if (to) { values.push(to); filters.push(`coalesce(expected_date,due_date)<= $${values.length}::date`); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const [entriesResult, accountsResult, categoriesResult, centersResult, recurrencesResult, receivablesResult] = await Promise.all([
      client.query(`SELECT * FROM volt_price.cash_entries ${where} ORDER BY coalesce(expected_date,due_date),created_at DESC LIMIT 1500`, values),
      client.query("SELECT * FROM volt_price.bank_accounts WHERE status='active' ORDER BY name"),
      client.query("SELECT * FROM volt_price.financial_categories WHERE status='active' ORDER BY direction,name"),
      client.query("SELECT * FROM volt_price.cost_centers WHERE status='active' ORDER BY code"),
      client.query("SELECT * FROM volt_price.cash_recurrences WHERE status IN ('active','paused') ORDER BY next_due_date"),
      client.query("SELECT * FROM volt_price.marketplace_receivables ORDER BY expected_date DESC NULLS LAST,created_at DESC LIMIT 500"),
    ]);
    const accounts = accountsResult.rows.map((account) => ({
      ...account,
      current_balance: money(Number(account.opening_balance || 0) + entriesResult.rows
        .filter((entry) => entry.bank_account_id === account.id)
        .reduce((sum, entry) => sum + (entry.direction === "inflow" ? 1 : -1) * money(entry.realized_amount), 0)),
    }));
    const openingBalance = accounts.reduce((sum, account) => sum + money(account.opening_balance), 0);
    const summary = projectCash({ openingBalance, entries: entriesResult.rows });
    summary.inflow = money(entriesResult.rows.filter((entry) => entry.direction === "inflow" && entry.status !== "cancelled").reduce((sum, entry) => sum + money(entry.amount), 0));
    summary.outflow = money(entriesResult.rows.filter((entry) => entry.direction === "outflow" && entry.status !== "cancelled").reduce((sum, entry) => sum + money(entry.amount), 0));
    summary.net = money(summary.inflow - summary.outflow);
    return {
      entries: entriesResult.rows,
      accounts,
      categories: categoriesResult.rows,
      costCenters: centersResult.rows,
      recurrences: recurrencesResult.rows,
      receivables: receivablesResult.rows,
      summary,
      dre: dreByCompetence(entriesResult.rows),
    };
  });
}

async function createEntries(auth, input = {}, request = null) {
  const direction = validDirection(input.direction || input.entryType);
  const totalAmount = positive(input.amount);
  const firstDueDate = input.firstDueDate || input.expectedDate || input.dueDate;
  const installments = generateInstallments({ amount: totalAmount, installments: input.installments, firstDueDate });
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const created = [];
    let parentId = null;
    for (const installment of installments) {
      const row = (await client.query(
        `INSERT INTO volt_price.cash_entries
         (tenant_id,entry_type,direction,due_date,expected_date,competence_date,amount,status,description,bank_account_id,category_id,cost_center_id,
          parent_entry_id,installment_number,installment_total,source_type,source_ref,is_fixed,variable_percent,payload)
         VALUES($1,$2,$3,$4,$4,$5,$6,'open',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb) RETURNING *`,
        [auth.tenantId, clean(input.entryType, 80) || (direction === "inflow" ? "receivable" : "payable"), direction, installment.dueDate,
          input.competenceDate || installment.dueDate, installment.amount, clean(input.description, 1000) || null, input.bankAccountId || null,
          input.categoryId || null, input.costCenterId || null, parentId, installment.number, installment.total, clean(input.sourceType, 40) || "manual",
          input.sourceRef ? `${clean(input.sourceRef, 300)}:${installment.number}` : null, Boolean(input.isFixed), input.variablePercent ?? null,
          JSON.stringify(redactForStorage(input.payload && typeof input.payload === "object" ? input.payload : {}))],
      )).rows[0];
      if (!parentId) parentId = row.id;
      created.push(row);
    }
    await log(client, auth, request, "cash.entries.create", "cash_entry", parentId, { direction, totalAmount, installments: created.length });
    return created;
  });
}

async function settleEntry(auth, entryId, input = {}, request = null) {
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const entry = (await client.query("SELECT * FROM volt_price.cash_entries WHERE id=$1 FOR UPDATE", [entryId])).rows[0];
    if (!entry) throw Object.assign(new Error("Lancamento nao encontrado."), { statusCode: 404 });
    if (entry.status === "cancelled") throw Object.assign(new Error("Lancamento cancelado nao pode ser liquidado."), { statusCode: 409 });
    const remaining = money(entry.amount) - money(entry.realized_amount);
    const settled = positive(input.amount ?? remaining);
    if (settled > remaining) throw Object.assign(new Error("Liquidacao maior que o saldo do lancamento."), { statusCode: 400 });
    const settlement = (await client.query(
      `INSERT INTO volt_price.cash_settlements(tenant_id,cash_entry_id,bank_account_id,amount,settled_at,note,metadata,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
      [auth.tenantId, entry.id, input.bankAccountId || entry.bank_account_id || null, settled, input.settledAt || new Date(), clean(input.note, 1000) || null,
        JSON.stringify(redactForStorage(input.metadata && typeof input.metadata === "object" ? input.metadata : {})), auth.userId],
    )).rows[0];
    const realized = money(Number(entry.realized_amount || 0) + settled);
    const status = realized >= money(entry.amount) ? "paid" : "partial";
    const updated = (await client.query(
      "UPDATE volt_price.cash_entries SET realized_amount=$2,realized_date=$3::timestamptz::date,status=$4,bank_account_id=coalesce($5,bank_account_id),updated_at=now() WHERE id=$1 RETURNING *",
      [entry.id, realized, settlement.settled_at, status, settlement.bank_account_id],
    )).rows[0];
    await log(client, auth, request, "cash.entry.settle", "cash_entry", entry.id, { amount: settled, status });
    return { entry: updated, settlement };
  });
}

async function cancelEntry(auth, entryId, request = null) {
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const entry = (await client.query("SELECT * FROM volt_price.cash_entries WHERE id=$1 FOR UPDATE", [entryId])).rows[0];
    if (!entry) throw Object.assign(new Error("Lancamento nao encontrado."), { statusCode: 404 });
    if (money(entry.realized_amount) > 0) throw Object.assign(new Error("Lancamento com liquidacao deve ser estornado, nao cancelado."), { statusCode: 409 });
    const updated = (await client.query("UPDATE volt_price.cash_entries SET status='cancelled',updated_at=now() WHERE id=$1 RETURNING *", [entry.id])).rows[0];
    await log(client, auth, request, "cash.entry.cancel", "cash_entry", entry.id, {});
    return updated;
  });
}

async function createReference(auth, type, input = {}, request = null) {
  if (type === "category" && input.direction && !["inflow","outflow","both"].includes(input.direction)) throw Object.assign(new Error("Direcao da categoria invalida."), { statusCode: 400 });
  const definitions = {
    account: { table: "bank_accounts", required: [clean(input.name,200)], columns: ["name","institution","account_type","opening_balance","opening_balance_date"], values: [clean(input.name,200),clean(input.institution,200)||null,clean(input.accountType,40)||"checking",money(input.openingBalance),input.openingBalanceDate||new Date().toISOString().slice(0,10)] },
    category: { table: "financial_categories", required: [clean(input.name,200)], columns: ["name","direction","dre_group"], values: [clean(input.name,200),clean(input.direction,20)||"both",clean(input.dreGroup,100)||null] },
    costCenter: { table: "cost_centers", required: [clean(input.code,60),clean(input.name,200)], columns: ["code","name"], values: [clean(input.code,60),clean(input.name,200)] },
  };
  const definition = definitions[type];
  if (!definition || definition.required.some((value) => !value)) throw Object.assign(new Error("Dados de cadastro invalidos."), { statusCode: 400 });
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const placeholders = definition.columns.map((_, index) => `$${index + 2}`).join(",");
    const row = (await client.query(`INSERT INTO volt_price.${definition.table}(tenant_id,${definition.columns.join(",")}) VALUES($1,${placeholders}) RETURNING *`, [auth.tenantId, ...definition.values])).rows[0];
    await log(client, auth, request, `cash.${type}.create`, type, row.id, {});
    return row;
  });
}

async function createRecurrence(auth, input = {}, request = null) {
  const direction = validDirection(input.direction);
  const amount = positive(input.amount);
  if (!clean(input.name,200) || !input.nextDueDate) throw Object.assign(new Error("Nome e primeiro vencimento sao obrigatorios."), { statusCode: 400 });
  if (!["weekly", "monthly", "yearly"].includes(input.frequency)) throw Object.assign(new Error("Frequencia invalida."), { statusCode: 400 });
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const row = (await client.query(
      `INSERT INTO volt_price.cash_recurrences(tenant_id,name,direction,amount,frequency,interval_count,next_due_date,end_date,category_id,cost_center_id,bank_account_id,description,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *`,
      [auth.tenantId, clean(input.name,200), direction, amount, input.frequency, Math.max(1,Math.trunc(Number(input.intervalCount)||1)), input.nextDueDate,
        input.endDate||null,input.categoryId||null,input.costCenterId||null,input.bankAccountId||null,clean(input.description,1000)||null,JSON.stringify(redactForStorage(input.metadata||{}))],
    )).rows[0];
    await log(client, auth, request, "cash.recurrence.create", "cash_recurrence", row.id, {});
    return row;
  });
}

async function materializeRecurrence(auth, recurrenceId, throughDate, request = null) {
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const recurrence = (await client.query("SELECT * FROM volt_price.cash_recurrences WHERE id=$1 FOR UPDATE", [recurrenceId])).rows[0];
    if (!recurrence) throw Object.assign(new Error("Recorrencia nao encontrada."), { statusCode: 404 });
    if (recurrence.status !== "active") throw Object.assign(new Error("Recorrencia nao esta ativa."), { statusCode: 409 });
    const limit = String(throughDate || new Date(Date.now()+90*86400000).toISOString().slice(0,10));
    let dueDate = String(recurrence.next_due_date).slice(0,10);
    let count = 0;
    while (dueDate <= limit && (!recurrence.end_date || dueDate <= String(recurrence.end_date).slice(0,10)) && count < 240) {
      await client.query(
        `INSERT INTO volt_price.cash_entries(tenant_id,entry_type,direction,due_date,expected_date,competence_date,amount,status,description,bank_account_id,category_id,cost_center_id,recurrence_id,source_type,source_ref,is_fixed)
         VALUES($1,$2,$3,$4,$4,$4,$5,'open',$6,$7,$8,$9,$10,'recurrence',$11,true) ON CONFLICT(tenant_id,source_type,source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
        [auth.tenantId, recurrence.direction==="inflow"?"receivable":"payable",recurrence.direction,dueDate,recurrence.amount,recurrence.description,recurrence.bank_account_id,recurrence.category_id,recurrence.cost_center_id,recurrence.id,`${recurrence.id}:${dueDate}`],
      );
      dueDate = nextRecurrenceDate(dueDate, recurrence.frequency, recurrence.interval_count);
      count += 1;
    }
    const status = recurrence.end_date && dueDate > String(recurrence.end_date).slice(0,10) ? "finished" : "active";
    await client.query("UPDATE volt_price.cash_recurrences SET next_due_date=$2,status=$3,updated_at=now() WHERE id=$1", [recurrence.id,dueDate,status]);
    await log(client, auth, request, "cash.recurrence.materialize", "cash_recurrence", recurrence.id, { count, throughDate: limit });
    return { count, nextDueDate: dueDate, status };
  });
}

async function createMarketplaceReceivable(auth, input = {}, request = null) {
  const channel = clean(input.channel,40);
  const externalOrderId = clean(input.externalOrderId,160);
  if (!channel || !externalOrderId) throw Object.assign(new Error("Canal e pedido externo sao obrigatorios."), { statusCode: 400 });
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const order = input.orderId ? (await client.query("SELECT * FROM volt_price.orders WHERE id=$1",[input.orderId])).rows[0] : null;
    const gross = money(input.grossAmount ?? order?.total_amount);
    const fees = money(input.feesAmount);
    const net = money(input.netAmount ?? (gross-fees));
    const version = Number((await client.query("SELECT coalesce(max(version),0)::int version FROM volt_price.marketplace_receivables WHERE channel=$1 AND external_order_id=$2",[channel,externalOrderId])).rows[0].version)+1;
    const receivable = (await client.query(
      `INSERT INTO volt_price.marketplace_receivables(tenant_id,order_id,channel,external_order_id,gross_amount,fees_amount,net_amount,expected_date,realized_date,status,version,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *`,
      [auth.tenantId,order?.id||null,channel,externalOrderId,gross,fees,net,input.expectedDate||null,input.realizedDate||null,clean(input.status,30)||"expected",version,JSON.stringify(redactForStorage(input.payload||{}))],
    )).rows[0];
    const entry = (await client.query(
      `INSERT INTO volt_price.cash_entries(tenant_id,entry_type,direction,due_date,expected_date,competence_date,amount,status,realized_amount,realized_date,description,source_type,source_ref,payload)
       VALUES($1,'marketplace_receivable','inflow',$2,$2,$3,$4,$5,$6,$7,$8,'marketplace',$9,$10::jsonb) RETURNING *`,
      [auth.tenantId,receivable.expected_date,order?.order_date||receivable.expected_date,net,receivable.status==="received"?"paid":"open",receivable.status==="received"?net:0,receivable.realized_date,`${channel} ${externalOrderId}`,`${channel}:${externalOrderId}:${version}`,JSON.stringify({receivableId:receivable.id})],
    )).rows[0];
    await client.query("UPDATE volt_price.marketplace_receivables SET cash_entry_id=$2 WHERE id=$1",[receivable.id,entry.id]);
    await log(client, auth, request, "cash.receivable.create", "marketplace_receivable", receivable.id, { channel, externalOrderId, net });
    return { receivable:{...receivable,cash_entry_id:entry.id}, entry };
  });
}

module.exports = { cashOverview, createEntries, settleEntry, cancelEntry, createReference, createRecurrence, materializeRecurrence, createMarketplaceReceivable };
