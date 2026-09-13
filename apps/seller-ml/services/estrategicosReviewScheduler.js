"use strict";

const estrategicosService = require("./estrategicosService");

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
let started = false;
let running = false;
let timer = null;

async function runDueStrategicReviews(options = {}) {
  if (running) return { skipped: true, reason: "already_running" };
  running = true;
  try {
    return await estrategicosService.reviewDueRounds(options);
  } finally {
    running = false;
  }
}

function startEstrategicosReviewScheduler() {
  if (started) return;
  started = true;
  const run = () => {
    runDueStrategicReviews({ limit: 50 }).catch((error) => {
      console.error("[Estrategicos] revisao agendada falhou:", error?.message || error);
    });
  };
  timer = setInterval(run, CHECK_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  setTimeout(run, 15000).unref?.();
  console.log("[Estrategicos] scheduler de revisao iniciado");
}

module.exports = {
  runDueStrategicReviews,
  startEstrategicosReviewScheduler,
};
