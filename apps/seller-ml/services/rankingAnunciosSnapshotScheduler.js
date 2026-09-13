"use strict";

const { snapshots } = require("../routes/mercadolivreRankingRoutes");

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let started = false;
let running = false;
let timer = null;

async function checkMonthlySnapshots() {
  if (running) return;
  running = true;
  try {
    const result = await snapshots.runDueMonthlySnapshots();
    if (!result?.skipped) {
      console.log("[Ranking] Snapshot mensal executado:", result?.range || "");
    }
  } catch (error) {
    console.error("[Ranking] Falha no scheduler de snapshots:", error?.message || error);
  } finally {
    running = false;
  }
}

function startRankingSnapshotScheduler() {
  if (started) return;
  if (String(process.env.ML_RANKING_SNAPSHOT_SCHEDULER || "1") === "0") {
    console.log("[Ranking] Scheduler de snapshots desativado por env.");
    return;
  }
  started = true;
  timer = setInterval(checkMonthlySnapshots, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  setTimeout(checkMonthlySnapshots, 60 * 1000).unref?.();
  console.log("[Ranking] Scheduler de snapshots mensais ativo.");
}

module.exports = {
  checkMonthlySnapshots,
  startRankingSnapshotScheduler,
};
