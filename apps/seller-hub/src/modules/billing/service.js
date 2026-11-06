// @ts-check
"use strict";

/** @param {string} message @param {number} status @param {string} code */
function fail(message, status, code) { return Object.assign(new Error(message), { status, code }); }

/** "YYYY-MM" do instante no fuso de São Paulo. @param {Date} date */
function monthInSaoPaulo(date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(date);
  return `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}`;
}

/** Valida "YYYY-MM" e devolve "YYYY-MM-01". @param {string} month */
function monthStart(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))) throw fail("Mês inválido. Use AAAA-MM.", 400, "invalid_month");
  return `${month}-01`;
}

/**
 * Medição de vendas (GMV) para a cobrança por % (roadmap, seção 2).
 * Regras: valor dos produtos sem frete; pedidos do mês no fuso de São Paulo; cancelado/devolvido dentro do mês
 * sai da base; cancelado depois do fechamento vira crédito no mês em que aconteceu. Mês fechado não muda.
 * @param {{ repository: ReturnType<typeof import("../orders/repository").createOrdersRepository>, now?: () => Date }} deps
 */
function createBillingService({ repository, now = () => new Date() }) {
  return {
    currentMonth: () => monthInSaoPaulo(now()),

    /** Resumo do mês (padrão: mês atual). @param {string} tenantId @param {string} [month] "YYYY-MM" */
    async month(tenantId, month) {
      const m = month || monthInSaoPaulo(now());
      const data = await repository.gmvMonth(tenantId, monthStart(m));
      return { month: m, current: m === monthInSaoPaulo(now()), ...data, base: Math.round((Number(data.gmv) - Number(data.credits)) * 100) / 100 };
    },

    /** Extrato do mês, pedido a pedido. @param {string} tenantId @param {string} month @param {{ limit?: number, offset?: number }} [options] */
    statement: (tenantId, month, options) => repository.gmvStatement(tenantId, monthStart(month), options),

    /** Fecha os meses passados ainda abertos (rodado pelo worker todo dia). */
    async closePastMonths() {
      const current = `${monthInSaoPaulo(now())}-01`;
      let closed = 0;
      for (const row of await repository.monthsToClose(current)) {
        if (await repository.closeMonth(row.tenantId, row.month)) closed += 1;
      }
      return { closed };
    },
  };
}

module.exports = { createBillingService, monthInSaoPaulo, monthStart };
