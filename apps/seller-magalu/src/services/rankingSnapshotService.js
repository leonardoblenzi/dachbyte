"use strict";

// Fotos mensais do ranking de anuncios (mesma ideia do ML).
// Para cada conta com "Guardar histórico mensal" ligado, guarda o Top N de cada
// mes fechado, por faturamento e por quantidade, com os totais do mes.
// Diferente do ML (so no dia 1), aqui a verificacao roda a cada 6 horas e gera
// qualquer mes fechado que estiver faltando nos ultimos meses.

const rankingRepository = require("../repositories/rankingRepository");
const uxAnalyticsRepository = require("../repositories/uxAnalyticsRepository");
const rules = require("./rankingRules");

const MONTHS_BACK = 6;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function generateMonth(accountId, range, snapshotLimit) {
  const rawRows = await uxAnalyticsRepository.soldSkus(accountId, { ...range, limit: 5000 });
  const rows = rawRows.map(rules.normalizeRow);
  const totals = {
    revenue: Math.round(rows.reduce((sum, row) => sum + row.revenue, 0) * 100) / 100,
    units: rows.reduce((sum, row) => sum + row.units, 0),
    products: rows.length,
  };
  const saved = [];
  for (const type of rules.RANKING_TYPES) {
    const positioned = rules.applyPositions(rows, type).slice(0, snapshotLimit);
    saved.push({ type, ...(await rankingRepository.saveSnapshot(accountId, range, type, { snapshotLimit, totals, rows: positioned })) });
  }
  return saved;
}

// Gera os meses fechados que faltam (ou que foram guardados com limite menor que o atual).
async function runForAccount(accountId, { snapshotLimit = null, monthsBack = MONTHS_BACK, now = new Date() } = {}) {
  return rankingRepository.withAccountLock(accountId, async () => {
    const settings = snapshotLimit ? { snapshot_limit: rankingRepository.normalizeLimit(snapshotLimit) } : await rankingRepository.getSettings(accountId);
    const limit = settings.snapshot_limit;
    const existing = await rankingRepository.listSnapshotMonths(accountId);
    const done = new Map(existing.map((row) => [row.period_start, row]));
    const generated = [];
    for (const range of rules.closedMonths(monthsBack, now)) {
      const current = done.get(range.from);
      if (current && Number(current.types) >= rules.RANKING_TYPES.length && Number(current.snapshot_limit) >= limit) continue;
      await generateMonth(accountId, range, limit);
      generated.push(range.from.slice(0, 7));
    }
    return { skipped: false, account_id: Number(accountId), limit, generated };
  });
}

async function runDue({ now = new Date() } = {}) {
  const accounts = await rankingRepository.listPersistAccounts();
  const results = [];
  for (const account of accounts) {
    try {
      results.push(await runForAccount(account.accountId, { snapshotLimit: account.snapshotLimit, now }));
    } catch (error) {
      results.push({ account_id: account.accountId, ok: false, error: error?.message || String(error) });
      console.error(`[magalu] ranking snapshot conta=${account.accountId} falhou:`, error?.message || error);
    }
  }
  return results;
}

let timer = null;
let running = false;
async function check() {
  if (running) return;
  running = true;
  try {
    const results = await runDue();
    const generated = results.filter((row) => row.generated?.length);
    if (generated.length) console.log("[magalu] fotos mensais do ranking geradas:", generated.map((row) => `${row.account_id}:${row.generated.join(",")}`).join(" "));
  } catch (error) {
    console.error("[magalu] agendador do ranking falhou:", error?.message || error);
  } finally {
    running = false;
  }
}

function startRankingSnapshotScheduler() {
  if (timer) return;
  if (String(process.env.MAGALU_RANKING_SNAPSHOT_SCHEDULER || "1") === "0") {
    console.log("[magalu] agendador de fotos do ranking desativado por env.");
    return;
  }
  timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => void check(), 60 * 1000).unref?.();
}

function stopRankingSnapshotScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { MONTHS_BACK, generateMonth, runForAccount, runDue, startRankingSnapshotScheduler, stopRankingSnapshotScheduler, _test: { check } };
