"use strict";

const db = require("../../../../../db/db");
const { createId } = require("../../id");
const { listPaymentMethods: listDefaultPaymentMethods } = require("../../paymentMethods");
const { validateCustomFields } = require("../../configuration/customFields");
const { getCompanyConfiguration, getCompanyConfigurationWithClient } = require("./configurationService");
const { insertAuditWithClient, insertEventWithClient, nextOperationalNumber, recordEvent } = require("./persistenceHelpers");

function parseMoneyValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value || "0").trim().replace(/[^\d,.-]/g, "");
  if (!cleaned) return 0;
  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");
  let normalized = cleaned;
  if (hasComma && hasDot) {
    normalized = cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")
      ? cleaned.replace(/\./g, "").replace(",", ".")
      : cleaned.replace(/,/g, "");
  } else if (hasComma) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (hasDot && /^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    normalized = cleaned.replace(/\./g, "");
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function toMoney(value) {
  const number = parseMoneyValue(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function assertPositive(value, message, code) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    const error = new Error(message);
    error.statusCode = 400;
    error.code = code;
    throw error;
  }
  return number;
}

function normalizePaymentMethod(method) {
  const normalized = String(method || "pix").trim().toLowerCase();
  const aliases = {
    dinheiro: "cash", cash: "cash", pix: "pix", debito: "debit_card", debit: "debit_card", debit_card: "debit_card",
    cartao: "credit_card", card: "credit_card", credito: "credit_card", credit: "credit_card", credit_card: "credit_card",
    crediario: "store_credit", carne: "store_credit", store_credit: "store_credit", promissory: "promissory_note", promissory_note: "promissory_note",
    cheque: "check", check: "check", boleto: "boleto", transferencia: "bank_transfer", transfer: "bank_transfer", bank_transfer: "bank_transfer",
  };
  return aliases[normalized] || normalized;
}

function normalizeDateInput(value) {
  const text = String(value || "").trim();
  if (!text || ["hoje", "agora", "12 meses"].includes(text.toLowerCase())) return null;
  let normalized = text;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const match = text.match(/^(\d{2})\/(\d{2})(?:\/(\d{4}))?$/);
    if (!match) return null;
    normalized = `${match[3] || new Date().getFullYear()}-${match[2]}-${match[1]}`;
  }
  const [year, month, day] = normalized.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? normalized
    : null;
}

function todayPlus(days = 0) {
  const date = new Date();
  date.setDate(date.getDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function validateConfiguredCustomFields(configuration, moduleName, values = {}, options = {}) {
  return validateCustomFields(configuration, moduleName, values, options);
}

async function findCustomerWithClient(client, companyId, customerId, customerName) {
  if (!customerId && (!customerName || String(customerName).toLowerCase() === "cliente avulso")) return null;
  const result = await client.query(`select id, name, document, phone, email from volt_core.customers
    where company_id = $1 and ($2::text is not null and id = $2 or $3::text is not null and lower(name) = lower($3))
    order by number asc limit 1`, [companyId, customerId || null, customerName || null]);
  return result.rows[0] || null;
}

function parsePercentage(value) {
  const normalized = String(value || "0").replace("%", "").replace(",", ".");
  return Math.max(0, Number(normalized) || 0);
}

function parseSettlementDays(value) {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : 0;
}

async function listReceivables(companyId) {
  const result = await db.query(`
    select
      r.id,
      r.customer_id as "customerId",
      c.name as "customerName",
      r.sale_id as "saleId",
      r.type,
      r.status,
      r.due_date as "dueDate",
      r.amount,
      r.paid_amount as "paidAmount",
      r.description,
      r.metadata,
      r.custom_fields as "customFields",
      r.created_at as "createdAt",
      r.updated_at as "updatedAt"
    from volt_core.receivables r
    left join volt_core.customers c on c.id = r.customer_id and c.company_id = r.company_id
    left join volt_core.sales s on s.id = r.sale_id and s.company_id = r.company_id
    where r.company_id = $1
      and r.status <> 'canceled'
      and coalesce(s.status, '') <> 'canceled'
    order by r.due_date asc, r.created_at desc;
  `, [companyId]);

  return result.rows;
}

async function createReceivable(companyId, input = {}) {
  const amount = assertPositive(toMoney(input.amount ?? input.value), "Valor do recebivel deve ser maior que zero", "RECEIVABLE_AMOUNT_INVALID");
  const dueDate = normalizeDateInput(input.dueDate || input.due);
  if (!dueDate) throw Object.assign(new Error("Vencimento do recebivel e obrigatorio"), { statusCode: 400, code: "RECEIVABLE_DUE_DATE_REQUIRED" });

  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const configuration = await getCompanyConfigurationWithClient(client, companyId);
      const customFields = validateConfiguredCustomFields(configuration, "receivable", input.customFields || {}, { requireAll: true });
      const customer = await findCustomerWithClient(client, companyId, input.customerId, input.customer);
      if (!customer) throw Object.assign(new Error("Recebivel manual exige cliente cadastrado"), { statusCode: 400, code: "RECEIVABLE_CUSTOMER_REQUIRED" });

      const type = normalizePaymentMethod(input.type || input.method || "store_credit");
      const id = input.id || createId("rec");
      const metadata = {
        source: "manual",
        dueDateSource: "manual_entry",
        currentDueDateSource: "manual_entry",
        originalDueDate: dueDate,
        bank: input.bank || null,
        checkNumber: input.checkNumber || null,
        holderName: input.holderName || null,
        holderDocument: input.holderDocument || null,
        notes: input.notes || null,
      };
      const result = await client.query(`
        insert into volt_core.receivables (
          id, company_id, customer_id, type, status, due_date, amount, description, metadata, custom_fields
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
        returning id, customer_id as "customerId", sale_id as "saleId", type, status, due_date as "dueDate",
          amount, paid_amount as "paidAmount", description, metadata, custom_fields as "customFields", created_at as "createdAt", updated_at as "updatedAt";
      `, [
        id,
        companyId,
        customer.id,
        type,
        type === "check" ? "awaiting_deposit" : "open",
        dueDate,
        amount,
        input.description || input.origin || `Recebivel manual - ${customer.name}`,
        JSON.stringify(metadata),
        JSON.stringify(customFields),
      ]);
      await insertEventWithClient(client, companyId, "receivable.created", { receivableId: id, amount, dueDate });
      await insertAuditWithClient(client, companyId, input.actorUserId, "receivable.created", "receivable", id, null, result.rows[0]);
      await client.query("commit");
      return { ...result.rows[0], customerName: customer.name };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function receiveReceivable(companyId, receivableId, input = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const receivable = await client.query(`
        select id, customer_id as "customerId", sale_id as "saleId", type, due_date as "dueDate",
          amount, paid_amount as "paidAmount", status, description, metadata
        from volt_core.receivables
        where company_id = $1 and id = $2
        for update;
      `, [companyId, receivableId]);

      if (!receivable.rowCount) {
        const error = new Error("Recebivel nao encontrado");
        error.statusCode = 404;
        error.code = "RECEIVABLE_NOT_FOUND";
        throw error;
      }

      const row = receivable.rows[0];
      if (["paid", "received", "compensated", "canceled"].includes(row.status)) {
        throw Object.assign(new Error("Recebivel nao esta aberto para baixa"), { statusCode: 409, code: "RECEIVABLE_NOT_OPEN" });
      }
      const openAmount = toMoney(Number(row.amount) - Number(row.paidAmount || 0));
      const receivedAmount = assertPositive(toMoney(input.amount ?? openAmount), "Valor recebido deve ser maior que zero", "RECEIVABLE_AMOUNT_INVALID");
      if (receivedAmount > openAmount) {
        throw Object.assign(new Error("Valor recebido maior que o saldo em aberto"), { statusCode: 400, code: "RECEIVABLE_AMOUNT_EXCEEDS_BALANCE" });
      }
      const nextPaid = toMoney(Number(row.paidAmount || 0) + receivedAmount);
      const nextStatus = nextPaid >= Number(row.amount) ? "paid" : "partial";
      const operationalAt = input.operationalAt || input.operational_at || input.receivedAt || new Date().toISOString();

      const updated = await client.query(`
        update volt_core.receivables
           set paid_amount = $3,
               status = $4,
               updated_at = now()
         where company_id = $1 and id = $2
        returning id, customer_id as "customerId", sale_id as "saleId", type, status, due_date as "dueDate",
          amount, paid_amount as "paidAmount", description, metadata, updated_at as "updatedAt";
      `, [companyId, receivableId, nextPaid, nextStatus]);

      await client.query(`
        insert into volt_core.cash_movements (
          id, company_id, type, source_type, source_id, payment_method, amount, description, actor_user_id, operational_at
        )
        values ($1, $2, 'entry', 'receivable', $3, $4, $5, $6, $7, $8);
      `, [
        createId("mov"),
        companyId,
        receivableId,
        normalizePaymentMethod(input.paymentMethod || "pix"),
        receivedAmount,
        row.description || "Baixa de recebivel",
        input.actorUserId || null,
        operationalAt,
      ]);

      await client.query(`
        insert into volt_core.events (company_id, type, payload)
        values ($1, 'receivable.received', $2::jsonb);
      `, [companyId, JSON.stringify({ receivableId, saleId: row.saleId || null, amount: receivedAmount, status: nextStatus })]);
      await insertAuditWithClient(
        client,
        companyId,
        input.actorUserId,
        "receivable.received",
        "receivable",
        receivableId,
        row,
        updated.rows[0],
        { saleId: row.saleId || null, amount: receivedAmount, paymentMethod: normalizePaymentMethod(input.paymentMethod || "pix") },
      );

      await client.query("commit");
      return updated.rows[0];
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function updateReceivableDueDate(companyId, receivableId, input = {}) {
  const dueDate = normalizeDateInput(input.dueDate || input.due);
  if (!dueDate) {
    throw Object.assign(new Error("Informe um vencimento valido"), { statusCode: 400, code: "RECEIVABLE_DUE_DATE_INVALID" });
  }
  const reason = String(input.reason || "").trim();
  if (reason.length < 5) {
    throw Object.assign(new Error("Informe o motivo da correcao do vencimento"), { statusCode: 400, code: "RECEIVABLE_DUE_DATE_REASON_REQUIRED" });
  }
  const actorUserId = String(input.actorUserId || "").trim();
  if (!actorUserId) {
    throw Object.assign(new Error("Usuario responsavel pela correcao nao identificado"), { statusCode: 400, code: "RECEIVABLE_DUE_DATE_ACTOR_REQUIRED" });
  }

  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await client.query(`
        select id, customer_id as "customerId", sale_id as "saleId", type, status,
          due_date as "dueDate", amount, paid_amount as "paidAmount", description, metadata
        from volt_core.receivables
        where company_id = $1 and id = $2
        for update;
      `, [companyId, receivableId]);

      if (!current.rowCount) {
        throw Object.assign(new Error("Recebivel nao encontrado"), { statusCode: 404, code: "RECEIVABLE_NOT_FOUND" });
      }

      const before = current.rows[0];
      const previousDueDate = normalizeDateInput(before.dueDate) || String(before.dueDate || "").slice(0, 10);
      if (["paid", "received", "compensated", "canceled"].includes(before.status)
        || Number(before.paidAmount || 0) >= Number(before.amount || 0)) {
        throw Object.assign(new Error("Vencimento de recebivel encerrado nao pode ser alterado"), { statusCode: 409, code: "RECEIVABLE_DUE_DATE_NOT_EDITABLE" });
      }
      if (previousDueDate === dueDate) {
        throw Object.assign(new Error("O novo vencimento deve ser diferente do atual"), { statusCode: 409, code: "RECEIVABLE_DUE_DATE_UNCHANGED" });
      }

      const correction = {
        previousDueDate,
        dueDate,
        reason,
        actorUserId,
        correctedAt: new Date().toISOString(),
      };
      const previousMetadata = before.metadata && typeof before.metadata === "object" ? before.metadata : {};
      const nextMetadata = {
        ...previousMetadata,
        originalDueDate: previousMetadata.originalDueDate || previousDueDate,
        dueDateSource: previousMetadata.dueDateSource || "legacy_unknown",
        currentDueDateSource: "administrative_correction",
        lastDueDateCorrection: correction,
        dueDateCorrections: [
          ...(Array.isArray(previousMetadata.dueDateCorrections) ? previousMetadata.dueDateCorrections : []),
          correction,
        ],
      };
      const updated = await client.query(`
        update volt_core.receivables
           set due_date = $3,
               metadata = $4::jsonb,
               updated_at = now()
         where company_id = $1 and id = $2
        returning id, customer_id as "customerId", sale_id as "saleId", type, status,
          due_date as "dueDate", amount, paid_amount as "paidAmount", description, metadata,
          custom_fields as "customFields", created_at as "createdAt", updated_at as "updatedAt";
      `, [companyId, receivableId, dueDate, JSON.stringify(nextMetadata)]);

      await insertEventWithClient(client, companyId, "receivable.due_date_updated", {
        receivableId,
        saleId: before.saleId || null,
        previousDueDate,
        dueDate,
        reason,
      });
      await insertAuditWithClient(
        client,
        companyId,
        actorUserId,
        "receivable.due_date_updated",
        "receivable",
        receivableId,
        before,
        updated.rows[0],
        { previousDueDate, dueDate, reason, saleId: before.saleId || null },
      );
      await client.query("commit");
      return updated.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function updateReceivableStatus(companyId, receivableId, input = {}, transition = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await client.query(`
        select id, type, status, paid_amount as "paidAmount", description
          from volt_core.receivables
         where company_id = $1 and id = $2
         for update;
      `, [companyId, receivableId]);

      if (!current.rowCount) {
        throw Object.assign(new Error("Recebivel nao encontrado"), { statusCode: 404, code: "RECEIVABLE_NOT_FOUND" });
      }

      const row = current.rows[0];
      if (transition.checkOnly && row.type !== "check") {
        throw Object.assign(new Error("Acao permitida apenas para cheque"), { statusCode: 400, code: "RECEIVABLE_NOT_CHECK" });
      }
      if (transition.blockPaid && (Number(row.paidAmount || 0) > 0 || ["paid", "received", "compensated"].includes(row.status))) {
        throw Object.assign(new Error("Recebivel baixado nao pode ser alterado"), { statusCode: 409, code: "RECEIVABLE_ALREADY_SETTLED" });
      }
      if (transition.allowedFrom && !transition.allowedFrom.includes(row.status)) {
        throw Object.assign(new Error("Status atual nao permite esta acao"), { statusCode: 409, code: "RECEIVABLE_STATUS_INVALID" });
      }

      const updated = await client.query(`
        update volt_core.receivables
           set status = $3,
               metadata = metadata || $4::jsonb,
               updated_at = now()
         where company_id = $1 and id = $2
        returning id, customer_id as "customerId", sale_id as "saleId", type, status, due_date as "dueDate",
          amount, paid_amount as "paidAmount", description, metadata, updated_at as "updatedAt";
      `, [companyId, receivableId, transition.nextStatus, JSON.stringify({
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
        lastStatusAction: transition.eventType,
      })]);

      await insertEventWithClient(client, companyId, transition.eventType, { receivableId, status: transition.nextStatus });
      await insertAuditWithClient(client, companyId, input.actorUserId, transition.eventType, "receivable", receivableId, row, updated.rows[0], { reason: input.reason, notes: input.notes });
      await client.query("commit");
      return updated.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

function depositCheckReceivable(companyId, receivableId, input = {}) {
  return updateReceivableStatus(companyId, receivableId, input, {
    allowedFrom: ["awaiting_deposit", "returned"],
    checkOnly: true,
    eventType: "receivable.check_deposited",
    nextStatus: "deposited",
  });
}

function returnCheckReceivable(companyId, receivableId, input = {}) {
  return updateReceivableStatus(companyId, receivableId, input, {
    allowedFrom: ["awaiting_deposit", "deposited"],
    checkOnly: true,
    eventType: "receivable.check_returned",
    nextStatus: "returned",
  });
}

function cancelReceivable(companyId, receivableId, input = {}) {
  return updateReceivableStatus(companyId, receivableId, input, {
    blockPaid: true,
    eventType: "receivable.canceled",
    nextStatus: "canceled",
  });
}

async function listExpenses(companyId) {
  const result = await db.query(`
    select id, number, name, category, supplier, due_date as "dueDate", amount,
      paid_amount as "paidAmount", remaining_amount as "remainingAmount", status,
      payment_method as "paymentMethod", paid_at as "paidAt", notes, custom_fields as "customFields",
      created_at as "createdAt", updated_at as "updatedAt"
    from volt_core.expenses where company_id = $1 order by due_date asc, number asc;
  `, [companyId]);
  return result.rows;
}

async function createExpense(companyId, input = {}) {
  const amount = assertPositive(toMoney(input.amount ?? input.value), "Valor da despesa deve ser maior que zero", "EXPENSE_AMOUNT_INVALID");
  if (!String(input.name || "").trim()) throw Object.assign(new Error("Nome da despesa e obrigatorio"), { statusCode: 400, code: "EXPENSE_NAME_REQUIRED" });
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const configuration = await getCompanyConfigurationWithClient(client, companyId);
      const customFields = validateConfiguredCustomFields(configuration, "expense", input.customFields || {}, { requireAll: true });
      const id = createId("exp");
      const number = await nextOperationalNumber(client, companyId, "expenses");
      const result = await client.query(`
        insert into volt_core.expenses (id, company_id, number, name, category, supplier, due_date, amount, remaining_amount, notes, custom_fields)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10::jsonb)
        returning id, number, name, category, supplier, due_date as "dueDate", amount,
          paid_amount as "paidAmount", remaining_amount as "remainingAmount", status, notes, custom_fields as "customFields";
      `, [id, companyId, number, String(input.name).trim(), input.category || "Operacional",
        input.supplier || null, normalizeDateInput(input.dueDate || input.due) || todayPlus(0), amount, input.notes || null, JSON.stringify(customFields)]);
      await insertEventWithClient(client, companyId, "expense.created", { expenseId: id, amount });
      await insertAuditWithClient(client, companyId, input.actorUserId, "expense.created", "expense", id, null, result.rows[0]);
      await client.query("commit");
      return result.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function updateExpense(companyId, expenseId, input = {}) {
  const amount = input.amount === undefined && input.value === undefined ? null : assertPositive(toMoney(input.amount ?? input.value), "Valor da despesa deve ser maior que zero", "EXPENSE_AMOUNT_INVALID");
  const configuration = await getCompanyConfiguration(companyId);
  const customFields = validateConfiguredCustomFields(configuration, "expense", input.customFields || {}, { requireAll: false });
  const result = await db.query(`
    update volt_core.expenses set name = coalesce($3,name), category = coalesce($4,category),
      supplier = coalesce($5,supplier), due_date = coalesce($6,due_date), amount = coalesce($7,amount),
      remaining_amount = case when $7::numeric is null then remaining_amount else greatest($7 - paid_amount, 0) end,
      notes = coalesce($8,notes), custom_fields = custom_fields || $9::jsonb, updated_at = now()
    where company_id = $1 and id = $2 and status <> 'canceled'
    returning id, number, name, category, due_date as "dueDate", amount, paid_amount as "paidAmount",
      remaining_amount as "remainingAmount", status, notes, custom_fields as "customFields";
  `, [companyId, expenseId, input.name || null, input.category || null, input.supplier ?? null,
    normalizeDateInput(input.dueDate || input.due), amount, input.notes ?? null, JSON.stringify(customFields)]);
  if (!result.rowCount) throw Object.assign(new Error("Despesa nao encontrada"), { statusCode: 404, code: "EXPENSE_NOT_FOUND" });
  await recordEvent(companyId, "expense.updated", { expenseId });
  return result.rows[0];
}

async function cancelExpense(companyId, expenseId, input = {}) {
  const result = await db.query(`update volt_core.expenses set status = 'canceled', canceled_at = now(), notes = coalesce($3,notes), updated_at = now()
    where company_id = $1 and id = $2 and status <> 'paid' returning id, name, status;`,
  [companyId, expenseId, input.reason || input.notes || null]);
  if (!result.rowCount) throw Object.assign(new Error("Despesa nao encontrada ou ja paga"), { statusCode: 409, code: "EXPENSE_NOT_CANCELABLE" });
  await recordEvent(companyId, "expense.canceled", { expenseId });
  return result.rows[0];
}

async function payExpense(companyId, expenseId, input = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const expenseResult = await client.query("select id, name, remaining_amount, status from volt_core.expenses where company_id = $1 and id = $2 for update", [companyId, expenseId]);
      if (!expenseResult.rowCount) throw Object.assign(new Error("Despesa nao encontrada"), { statusCode: 404, code: "EXPENSE_NOT_FOUND" });
      const expense = expenseResult.rows[0];
      if (["paid", "canceled"].includes(expense.status)) throw Object.assign(new Error("Despesa nao esta aberta"), { statusCode: 409, code: "EXPENSE_NOT_OPEN" });
      const amount = assertPositive(toMoney(input.amount ?? expense.remaining_amount), "Valor pago deve ser maior que zero", "EXPENSE_PAYMENT_INVALID");
      if (amount > Number(expense.remaining_amount)) throw Object.assign(new Error("Pagamento maior que o saldo da despesa"), { statusCode: 400, code: "EXPENSE_PAYMENT_EXCEEDS_BALANCE" });
      const operationalAt = input.operationalAt || input.operational_at || input.paidAt || new Date().toISOString();
      const remaining = toMoney(Number(expense.remaining_amount) - amount);
      const status = remaining === 0 ? "paid" : "partial";
      const updated = await client.query(`update volt_core.expenses set paid_amount = paid_amount + $3, remaining_amount = $4,
        status = $5, payment_method = $6, paid_at = case when $5 = 'paid' then now() else paid_at end, updated_at = now()
        where company_id = $1 and id = $2 returning id, name, amount, paid_amount as "paidAmount", remaining_amount as "remainingAmount", status;`,
      [companyId, expenseId, amount, remaining, status, normalizePaymentMethod(input.paymentMethod || "cash")]);
      await client.query(`insert into volt_core.cash_movements
        (id, company_id, type, source_type, source_id, payment_method, amount, description, actor_user_id, operational_at)
        values ($1,$2,'exit','expense',$3,$4,$5,$6,$7,$8);`,
      [createId("mov"), companyId, expenseId, normalizePaymentMethod(input.paymentMethod || "cash"), amount,
        `Pagamento ${expense.name}`, input.actorUserId || null, operationalAt]);
      await insertEventWithClient(client, companyId, "expense.paid", { expenseId, amount, status });
      await client.query("commit");
      return updated.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function listCompanyPaymentMethods(companyId) {
  const result = await db.query(`select id, name, method_key as "methodKey", kind, fee, settlement_days as "settlementDays", active
    from volt_core.payment_methods where company_id = $1 order by created_at asc;`, [companyId]);
  if (result.rowCount) return result.rows;
  return listDefaultPaymentMethods().map((method) => ({
    id: null,
    name: method.name,
    methodKey: method.key,
    kind: method.behavior,
    fee: 0,
    settlementDays: 0,
    active: true,
  }));
}

async function savePaymentMethod(companyId, input = {}) {
  if (!String(input.name || "").trim()) throw Object.assign(new Error("Nome da forma de pagamento e obrigatorio"), { statusCode: 400, code: "PAYMENT_METHOD_NAME_REQUIRED" });
  const methodKey = String(input.methodKey || input.name).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const kindAliases = { Imediato: "immediate", Prazo: "receivable", Recebivel: "receivable" };
  const result = await db.query(`insert into volt_core.payment_methods (id, company_id, name, method_key, kind, fee, settlement_days)
    values ($1,$2,$3,$4,$5,$6,$7)
    on conflict (company_id, method_key) do update set name = excluded.name, kind = excluded.kind, fee = excluded.fee,
      settlement_days = excluded.settlement_days, active = true, updated_at = now()
    returning id, name, method_key as "methodKey", kind, fee, settlement_days as "settlementDays", active;`,
  [input.id || createId("pay"), companyId, String(input.name).trim(), methodKey, kindAliases[input.type] || input.kind || "immediate",
    parsePercentage(input.fee), parseSettlementDays(input.settlement)]);
  return result.rows[0];
}
module.exports = {
  cancelExpense, cancelReceivable, createExpense, createReceivable, depositCheckReceivable,
  listCompanyPaymentMethods, listExpenses, listReceivables, payExpense, receiveReceivable,
  returnCheckReceivable, savePaymentMethod, updateExpense, updateReceivableDueDate,
};
