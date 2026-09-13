"use strict";

const db = require("../../../../../db/db");
const { createId } = require("../../id");
const { insertAuditWithClient, insertEventWithClient, nextOperationalNumber } = require("./persistenceHelpers");

function parseMoneyValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value || "0").trim().replace(/[^\d,.-]/g, "");
  if (!cleaned) return 0;
  const hasComma = cleaned.includes(","), hasDot = cleaned.includes(".");
  let normalized = cleaned;
  if (hasComma && hasDot) normalized = cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
  else if (hasComma) normalized = cleaned.replace(/\./g, "").replace(",", ".");
  else if (hasDot && /^\d{1,3}(\.\d{3})+$/.test(cleaned)) normalized = cleaned.replace(/\./g, "");
  const number = Number(normalized); return Number.isFinite(number) ? number : 0;
}
function toMoney(value) { const number = parseMoneyValue(value); return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0; }
function assertPositive(value, message, code) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) { const error = new Error(message); error.statusCode = 400; error.code = code; throw error; }
  return number;
}
function normalizePaymentMethod(method) {
  const normalized = String(method || "pix").trim().toLowerCase();
  const aliases = { dinheiro:"cash",cash:"cash",pix:"pix",debito:"debit_card",debit:"debit_card",debit_card:"debit_card",cartao:"credit_card",card:"credit_card",credito:"credit_card",credit:"credit_card",credit_card:"credit_card",crediario:"store_credit",store_credit:"store_credit",promissory:"promissory_note",promissory_note:"promissory_note",cheque:"check",check:"check",boleto:"boleto",transferencia:"bank_transfer",transfer:"bank_transfer",bank_transfer:"bank_transfer" };
  return aliases[normalized] || normalized;
}

async function calculateSessionSummaryWithClient(client, companyId, session) {
  const movementResult = await client.query(`
    select
      coalesce(sum(case when type = 'entry' then amount else -amount end), 0)::numeric as total,
      coalesce(sum(case when type = 'entry' then amount else 0 end), 0)::numeric as "entryTotal",
      coalesce(sum(case when type = 'exit' then amount else 0 end), 0)::numeric as "exitTotal",
      count(*)::int as "movementCount"
    from volt_core.cash_movements
    where company_id = $1
      and (
        session_id = $2
        or (session_id is null and operational_at >= $3)
      );
  `, [companyId, session.id, session.opened_at]);

  const openingAmount = toMoney(session.opening_amount || session.openingAmount || 0);
  const movementTotal = toMoney(movementResult.rows[0]?.total || 0);
  const expectedAmount = toMoney(openingAmount + movementTotal);
  return {
    balance: expectedAmount,
    expectedAmount,
    movementCount: Number(movementResult.rows[0]?.movementCount || 0),
    movementTotal,
    entryTotal: toMoney(movementResult.rows[0]?.entryTotal || 0),
    exitTotal: toMoney(movementResult.rows[0]?.exitTotal || 0),
    openingAmount,
    sessionId: session.id,
    sessionNumber: session.number,
    status: session.status || "open",
    openedAt: session.opened_at || session.openedAt || null,
  };
}

async function getCashSummary(companyId) {
  return db.withClient(async (client) => {
    const sessionResult = await client.query(`
      select id, number, status, opening_amount, expected_amount, opened_at
      from volt_core.cash_sessions
      where company_id = $1 and status = 'open'
      order by opened_at desc
      limit 1;
    `, [companyId]);

    if (!sessionResult.rowCount) {
      return {
        balance: 0,
        expectedAmount: 0,
        movementCount: 0,
        movementTotal: 0,
        entryTotal: 0,
        exitTotal: 0,
        openingAmount: 0,
        sessionId: null,
        sessionNumber: null,
        status: "closed",
        openedAt: null,
      };
    }

    return calculateSessionSummaryWithClient(client, companyId, sessionResult.rows[0]);
  });
}

async function listCashMovements(companyId) {
  const result = await db.query(`
    select id, session_id as "sessionId", type, source_type as "sourceType", source_id as "sourceId",
      payment_method as "paymentMethod", amount, description, actor_user_id as "actorUserId",
      operational_at as "operationalAt", created_at as "createdAt"
    from volt_core.cash_movements
    where company_id = $1
    order by operational_at desc, created_at desc
    limit 100;
  `, [companyId]);

  return result.rows;
}

async function listCashSessions(companyId) {
  const result = await db.query(`
    select id, number, status, opening_amount as "openingAmount", expected_amount as "expectedAmount",
      counted_amount as "countedAmount", difference_amount as "differenceAmount",
      opened_by as "openedBy", closed_by as "closedBy", opened_at as "openedAt", closed_at as "closedAt", notes
    from volt_core.cash_sessions
    where company_id = $1
    order by opened_at desc
    limit 30;
  `, [companyId]);

  return result.rows;
}

async function openCashSession(companyId, input = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const existing = await client.query("select id from volt_core.cash_sessions where company_id = $1 and status = 'open' for update", [companyId]);
      if (existing.rowCount) throw Object.assign(new Error("Ja existe um caixa aberto"), { statusCode: 409, code: "CASH_SESSION_ALREADY_OPEN" });
      const id = createId("cas");
      const number = await nextOperationalNumber(client, companyId, "cash_sessions");
      const openingAmount = Math.max(0, toMoney(input.openingAmount));
      const result = await client.query(`
        insert into volt_core.cash_sessions (id, company_id, number, opening_amount, expected_amount, opened_by, notes)
        values ($1,$2,$3,$4,$4,$5,$6)
        returning id, number, status, opening_amount as "openingAmount", expected_amount as "expectedAmount",
          opened_by as "openedBy", opened_at as "openedAt", notes;
      `, [id, companyId, number, openingAmount, input.actorUserId || null, input.notes || null]);
      await insertEventWithClient(client, companyId, "cash.opened", { sessionId: id });
      await client.query("commit");
      return result.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function closeCashSession(companyId, sessionId, input = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const sessionResult = await client.query(`
        select id, number, status, opening_amount, opened_at, notes
        from volt_core.cash_sessions
        where company_id = $1 and id = $2 and status = 'open'
        for update;
      `, [companyId, sessionId]);
      if (!sessionResult.rowCount) throw Object.assign(new Error("Caixa aberto nao encontrado"), { statusCode: 404, code: "CASH_SESSION_NOT_FOUND" });

      const rawCounted = input.countedAmount ?? input.amount;
      if (rawCounted === undefined || rawCounted === null || String(rawCounted).trim() === "") {
        throw Object.assign(new Error("Informe o valor contado para fechar o caixa"), { statusCode: 400, code: "CASH_COUNTED_AMOUNT_REQUIRED" });
      }
      const countedParsed = parseMoneyValue(rawCounted);
      const cleanedCounted = String(rawCounted).trim().replace(/[^\d,.-]/g, "");
      if (!cleanedCounted || !Number.isFinite(countedParsed) || countedParsed < 0) {
        throw Object.assign(new Error("Valor contado invalido"), { statusCode: 400, code: "CASH_COUNTED_AMOUNT_INVALID" });
      }

      const session = sessionResult.rows[0];
      const summary = await calculateSessionSummaryWithClient(client, companyId, session);
      const expected = summary.expectedAmount;
      const counted = toMoney(countedParsed);
      const difference = toMoney(counted - expected);

      const updated = await client.query(`
        update volt_core.cash_sessions
           set status = 'closed',
               expected_amount = $3,
               counted_amount = $4,
               difference_amount = $5,
               closed_by = $6,
               closed_at = now(),
               notes = coalesce($7, notes)
         where company_id = $1 and id = $2 and status = 'open'
         returning id, number, status, opening_amount as "openingAmount",
           expected_amount as "expectedAmount", counted_amount as "countedAmount", difference_amount as "differenceAmount",
           opened_at as "openedAt", closed_at as "closedAt";
      `, [companyId, sessionId, expected, counted, difference, input.actorUserId || null, input.notes || null]);

      if (!updated.rowCount) {
        throw Object.assign(new Error("O caixa ja foi fechado por outra operacao"), { statusCode: 409, code: "CASH_SESSION_ALREADY_CLOSED" });
      }

      await insertEventWithClient(client, companyId, "cash.closed", { sessionId, expected, counted, difference });
      await insertAuditWithClient(
        client,
        companyId,
        input.actorUserId,
        "cash.session.closed",
        "cash_session",
        sessionId,
        { status: session.status, openingAmount: Number(session.opening_amount || 0), openedAt: session.opened_at },
        updated.rows[0],
        { expected, counted, difference },
      );
      await client.query("commit");
      return updated.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function createCashMovement(companyId, input = {}) {
  const type = ["exit", "saida", "sangria"].includes(String(input.type || "").toLowerCase()) ? "exit" : "entry";
  const amount = assertPositive(toMoney(input.amount), "Valor do movimento deve ser maior que zero", "CASH_AMOUNT_INVALID");
  const operationalAt = input.operationalAt || input.operational_at || new Date().toISOString();
  const id = createId("mov");
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const sessionResult = await client.query(`
        select id
        from volt_core.cash_sessions
        where company_id = $1
          and status = 'open'
          and ($2::text is null or id = $2)
        order by opened_at desc
        limit 1
        for update;
      `, [companyId, input.sessionId || null]);
      if (!sessionResult.rowCount) {
        throw Object.assign(new Error("Abra o caixa antes de registrar uma movimentacao"), { statusCode: 409, code: "CASH_SESSION_NOT_OPEN" });
      }

      const sessionId = sessionResult.rows[0].id;
      const result = await client.query(`
        insert into volt_core.cash_movements (
          id, company_id, session_id, type, source_type, payment_method, amount, description, actor_user_id, operational_at
        )
        values ($1, $2, $3, $4, 'manual', $5, $6, $7, $8, $9)
        returning id, session_id as "sessionId", type, source_type as "sourceType",
          payment_method as "paymentMethod", amount, description, actor_user_id as "actorUserId",
          operational_at as "operationalAt", created_at as "createdAt";
      `, [
        id,
        companyId,
        sessionId,
        type,
        normalizePaymentMethod(input.paymentMethod || "cash"),
        amount,
        input.description || (type === "entry" ? "Reforco" : "Sangria"),
        input.actorUserId || null,
        operationalAt,
      ]);

      await insertEventWithClient(client, companyId, "cash.moved", { movementId: id, sessionId, type, amount });
      await client.query("commit");
      return result.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}
module.exports = { closeCashSession, createCashMovement, getCashSummary, listCashMovements, listCashSessions, openCashSession, __test: { calculateSessionSummaryWithClient } };
