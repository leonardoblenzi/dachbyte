"use strict";

const TERMINAL_STATUSES = new Set(["concluido", "erro", "cancelado"]);

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function reconcileCompletedQueueJob({
  queueState,
  status,
  kind,
  persistedTotal,
  csvManifest,
  finishedOn,
  updatedAt,
  now = Date.now(),
  graceMs = 30 * 1000,
} = {}) {
  const normalizedState = String(queueState || "").trim().toLowerCase();
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedState !== "completed" || TERMINAL_STATUSES.has(normalizedStatus)) {
    return null;
  }

  const isCsvExport = String(kind || "").trim().toLowerCase() === "csv_export";
  const csvReady = isCsvExport && csvManifest?.ready === true;
  const recoveredTotal = csvReady
    ? finite(csvManifest?.rows)
    : finite(persistedTotal);

  if (recoveredTotal !== null) {
    return {
      status: "concluido",
      total: recoveredTotal,
      error: null,
      progressPhase: csvReady ? "CSV pronto" : "Concluido",
      downloadReady: csvReady,
      recovered: true,
    };
  }

  const finishedAt = timestamp(finishedOn) || timestamp(updatedAt);
  const ageMs = finishedAt === null ? Infinity : Math.max(0, Number(now) - finishedAt);
  if (ageMs < Math.max(1000, Number(graceMs) || 0)) return null;

  return {
    status: "erro",
    total: null,
    error:
      "A fila terminou, mas os dados finais nao foram persistidos. Gere a consulta novamente.",
    progressPhase: "Falha ao finalizar",
    downloadReady: false,
    recovered: true,
  };
}

function shouldSupersedeOpenJob({ kind } = {}) {
  return String(kind || "").trim().toLowerCase() !== "csv_export";
}

function sameCsvExportRequest(left = {}, right = {}) {
  const leftSource = String(left.sourceJobId || "").trim();
  const rightSource = String(right.sourceJobId || "").trim();
  if (!leftSource || leftSource !== rightSource) return false;

  const normalizeFields = (fields) => (Array.isArray(fields) ? fields : [])
    .map((field) => String(field || "").trim())
    .filter(Boolean)
    .join("\u001f");
  return normalizeFields(left.fields) === normalizeFields(right.fields);
}

module.exports = {
  reconcileCompletedQueueJob,
  sameCsvExportRequest,
  shouldSupersedeOpenJob,
};
