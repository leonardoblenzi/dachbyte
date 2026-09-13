"use strict";

const startedAt = new Date();
const state = {
  requests: { total: 0, success: 0, clientError: 0, serverError: 0, slow: 0 },
  database: { queries: 0, errors: 0, slow: 0, totalDurationMs: 0, maxDurationMs: 0 },
  integrations: { completedJobs: 0, retriedJobs: 0, deadLetterJobs: 0, completedOutbox: 0, deadLetterOutbox: 0 },
};

function recordRequest(statusCode, durationMs, slowThresholdMs) {
  state.requests.total += 1;
  if (statusCode >= 500) state.requests.serverError += 1;
  else if (statusCode >= 400) state.requests.clientError += 1;
  else state.requests.success += 1;
  if (durationMs >= slowThresholdMs) state.requests.slow += 1;
}

function recordDatabaseQuery(durationMs, { error = false, slowThresholdMs = 750 } = {}) {
  state.database.queries += 1;
  state.database.totalDurationMs += durationMs;
  state.database.maxDurationMs = Math.max(state.database.maxDurationMs, durationMs);
  if (error) state.database.errors += 1;
  if (durationMs >= slowThresholdMs) state.database.slow += 1;
}

function recordIntegration(metric) {
  if (Object.prototype.hasOwnProperty.call(state.integrations, metric)) state.integrations[metric] += 1;
}

function snapshot() {
  const avg = state.database.queries ? state.database.totalDurationMs / state.database.queries : 0;
  return {
    startedAt: startedAt.toISOString(),
    uptimeSec: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    requests: { ...state.requests },
    database: { ...state.database, avgDurationMs: Number(avg.toFixed(2)) },
    integrations: { ...state.integrations },
  };
}

module.exports = { recordDatabaseQuery, recordIntegration, recordRequest, snapshot };
