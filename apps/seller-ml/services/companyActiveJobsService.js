const ACTIVE_STATUSES = new Set([
  "active",
  "waiting",
  "delayed",
  "paused",
  "aguardando",
  "processando",
  "cancelando",
]);

function defaultProviders() {
  return [
    { name: "promo-jobs", list: (key) => require("./promoJobsService").listRecent(500, { accountKey: key }) },
    { name: "ml-promo-bulk-remove", list: (key) => require("./promoBulkRemoveAdapter").listRecent(500, { accountKey: key }) },
    { name: "promo-smart-optimizer", list: (key) => require("./promoSmartOptimizerService").listRecent(500, { accountKey: key }) },
    { name: "ml-caracteristicas", list: (key) => require("./caracteristicasJobsService").listRecent(500, { accountKey: key }) },
    { name: "ml-exclusao-lote", list: (key) => require("./exclusaoLoteJobService").listJobs(500, { accountKey: key }) },
    { name: "atacado", list: (key) => require("./atacadoJobsService").listRecent(500, { accountKey: key }) },
    { name: "modelo-massa", list: (key) => require("./modeloMassaJobsService").listRecent(500, { accountKey: key }) },
    { name: "prazo-producao", list: (key) => require("./prazoProducaoQueueService").listPrazoJobs(500, { accountKey: key }) },
  ];
}

function normalizeJobs(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.jobs)) return result.jobs;
  if (Array.isArray(result?.items)) return result.items;
  throw new Error("Resposta invalida do provider de jobs.");
}

function normalizeStatus(job) {
  const values = [job?.status, job?.state, job?.jobState, job?.lifecycle_status]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).trim().toLowerCase());

  if (values.some(isTerminalStatus)) return "";

  for (const value of values) {
    if (ACTIVE_STATUSES.has(value)) return value;
    if (value === "processing") return "active";
    if (value === "queued" || value === "retry_wait") return "waiting";
    if (value === "paused_safety") return "paused";
    if (/^active\b/.test(value)) return "active";
    if (/^na fila\b/.test(value)) return "waiting";
    if (/^processando\b/.test(value)) return "processando";
    if (/^aguardando\b/.test(value)) return "aguardando";
    if (/^cancelando\b/.test(value)) return "cancelando";
  }

  return "";
}

function isTerminalStatus(value) {
  return /^(?:success|succeeded|completed|complete|completo|concluido|concluído|failed|failure|error|cancelled|canceled|cancelado|cancelada|falhou|finalizado|finished)\b/.test(value);
}

function jobIdOf(job, fallback) {
  return String(job?.jobId ?? job?.job_id ?? job?.id ?? job?.uuid ?? fallback);
}

function errorMessage(error) {
  return error?.message || String(error || "Falha desconhecida ao inspecionar jobs.");
}

function createCompanyActiveJobsService({ providers = defaultProviders() } = {}) {
  async function checkCompanyActiveJobs(accountKeys) {
    const activeJobs = [];
    const inspectionFailures = [];
    const uniqueAccountKeys = [...new Set((Array.isArray(accountKeys) ? accountKeys : [])
      .filter((key) => key !== null && key !== undefined && String(key).trim() !== "")
      .map((key) => String(key)))];
    const seenJobs = new Set();

    for (const accountKey of uniqueAccountKeys) {
      for (const provider of providers || []) {
        if (!provider || typeof provider.list !== "function") continue;
        const providerName = String(provider.name || "unknown");
        try {
          const jobs = normalizeJobs(await provider.list(accountKey));
          jobs.forEach((job, index) => {
            if (!job || typeof job !== "object") return;
            const status = normalizeStatus(job);
            if (!ACTIVE_STATUSES.has(status)) return;

            const jobId = jobIdOf(job, `${index}`);
            const dedupeKey = `${providerName}:${accountKey}:${jobId}`;
            if (seenJobs.has(dedupeKey)) return;
            seenJobs.add(dedupeKey);

            activeJobs.push({
              ...job,
              provider: providerName,
              accountKey,
              jobId,
              status,
            });
          });
        } catch (error) {
          inspectionFailures.push({
            provider: providerName,
            accountKey,
            message: errorMessage(error),
          });
        }
      }
    }

    return {
      blocked: activeJobs.length > 0 || inspectionFailures.length > 0,
      activeJobs,
      inspectionFailures,
    };
  }

  return { checkCompanyActiveJobs };
}

module.exports = {
  ACTIVE_STATUSES,
  createCompanyActiveJobsService,
  defaultProviders,
};
