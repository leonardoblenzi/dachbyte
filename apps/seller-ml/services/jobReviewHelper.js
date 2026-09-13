"use strict";

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsv(rows, header) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeHeader = Array.isArray(header) ? header : [];
  return [safeHeader, ...safeRows]
    .map((cols) => cols.map(csvEscape).join(","))
    .join("\n");
}

function buildReviewAction({
  basePath = "",
  jobId,
  errors = 0,
  completed = false,
  hasCsv = false,
  label = null,
  url = null,
} = {}) {
  const normalizedId = String(jobId || "").trim();
  if (!completed || !hasCsv || !normalizedId) {
    return null;
  }

  const safeUrl = String(url || "").trim();
  const safeBase = String(basePath || "").trim().replace(/\/+$/, "");
  const finalUrl =
    safeUrl || `${safeBase}/${encodeURIComponent(normalizedId)}/download.csv`;
  const errorCount = Number(errors || 0);

  return {
    type: "download_csv",
    label:
      label ||
      (Number.isFinite(errorCount) && errorCount > 0
        ? "Ver e corrigir"
        : "Baixar CSV"),
    url: finalUrl,
    download: true,
  };
}

function attachJobReview(job, options = {}) {
  if (!job || typeof job !== "object") return job;

  const errors =
    Number(
      options.errors ??
        job.errors ??
        job.erros ??
        job.failed ??
        job.fail ??
        job.error_count ??
        0,
    ) || 0;
  const completed =
    typeof options.completed === "boolean"
      ? options.completed
      : !!job.completed;
  const reviewAction = buildReviewAction({
    ...options,
    jobId: options.jobId ?? job.id ?? job.job_id ?? job.process_id,
    errors,
    completed,
  });

  if (!reviewAction) return job;

  return {
    ...job,
    has_errors: errors > 0,
    download_csv_url: reviewAction.url,
    review_action: reviewAction,
  };
}

module.exports = {
  csvEscape,
  buildCsv,
  buildReviewAction,
  attachJobReview,
};
