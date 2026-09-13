const assert = require("node:assert/strict");
const test = require("node:test");

require("../public/js/jobs-panel-adapters.js");

const normalize = global.JobsPanelAdapters.normalize;

test("promotion remains active when progress reaches 100 before backend completion", () => {
  const job = normalize("promocoes", {
    id: 382,
    status: "active",
    processed: 1025,
    total: 368,
    progress: 100,
  });

  assert.equal(job.active, true);
  assert.equal(job.completed, false);
});

test("filter remains active at 100 percent without a terminal backend state", () => {
  const job = normalize("filtro-anuncios", {
    id: 158,
    status: "processando",
    processed: 46,
    total: 46,
    progress: 100,
  });

  assert.equal(job.completed, false);
});

test("completed filter exposes its CSV action", () => {
  const job = normalize("filtro-anuncios", {
    id: 157,
    status: "concluido",
    completed: true,
    processed: 46,
    total: 46,
    download_csv_url: "/download.csv",
  });

  assert.equal(job.completed, true);
  assert.equal(job.reviewAction.url, "/download.csv");
  assert.equal(job.reviewAction.label, "Baixar CSV");
});

test("completed CSV export status exposes download action from endpoints", () => {
  const job = normalize("filtro-anuncios", {
    job_id: "240",
    kind: "csv_export",
    status: "concluido",
    completed: true,
    progress: 100,
    processed: 4497,
    total: 4497,
    endpoints: {
      download_csv_url: "/api/analytics/filtro-anuncios/jobs/240/download.csv",
    },
  });

  assert.equal(job.id, "filtro-anuncios:240");
  assert.equal(job.backendJobId, "240");
  assert.equal(job.title, "Exportacao CSV enriquecida");
  assert.equal(job.completed, true);
  assert.equal(job.reviewAction.url, "/api/analytics/filtro-anuncios/jobs/240/download.csv");
  assert.equal(job.reviewAction.label, "Baixar CSV");
});

test("partial filter is terminal and keeps the correction download available", () => {
  const job = normalize("filtro-anuncios", {
    id: 159,
    status: "concluido",
    completed: true,
    errors: 1,
    download_csv_url: "/partial.csv",
  });

  assert.equal(job.completed, true);
  assert.equal(job.failed, true);
  assert.equal(job.reviewAction.label, "Ver e corrigir");
});

test("generic adapter preserves legacy count-based completion", () => {
  const job = normalize("generic", {
    id: 1,
    processed: 10,
    total: 10,
    progress: 100,
  });

  assert.equal(job.completed, true);
});

test("module adapters namespace identical backend ids", () => {
  const filtro = normalize("filtro-anuncios", { id: 42, status: "aguardando" });
  const promo = normalize("promocoes", { id: 42, status: "queued" });

  assert.equal(filtro.id, "filtro-anuncios:42");
  assert.equal(promo.id, "promocoes:42");
  assert.equal(filtro.backendJobId, "42");
  assert.notEqual(filtro.id, promo.id);
});

test("module adapters preserve backend source", () => {
  const job = normalize("promocoes", {
    id: "remove:77",
    source: "remove",
    status: "queued",
  });

  assert.equal(job.id, "promocoes:remove:77");
  assert.equal(job.backendJobId, "remove:77");
  assert.equal(job.source, "remove");
});

test("versioned backend contract is authoritative", () => {
  const job = normalize("promocoes", {
    id: "promo:382",
    job_uid: "promocoes:promo:382",
    backend_job_id: "promo:382",
    lifecycle_status: "processing",
    completed: false,
    progress_percent: 100,
    job_contract: {
      version: 1,
      uid: "promocoes:promo:382",
      backend_id: "promo:382",
      status: "processing",
      progress: { percent: 100, current: 1025, total: 368 },
      actions: {},
    },
  });

  assert.equal(job.id, "promocoes:promo:382");
  assert.equal(job.backendJobId, "promo:382");
  assert.equal(job.completed, false);
  assert.equal(job.processed, 1025);
});

test("canceling job remains active", () => {
  const job = normalize("prazo", {
    id: 8,
    lifecycle_status: "processing",
    state: "cancelando",
    completed: false,
  });

  assert.equal(job.completed, false);
  assert.equal(job.active, true);
});

test("paused promotion exposes safe resume metadata", () => {
  const job = normalize("promocoes", {
    id: "promo:1623",
    state: "pausado por seguranca: 359/1003",
    completed: true,
    processed: 359,
    total: 1003,
    errors: 7,
    resumable: true,
    pending: 644,
    resume_url: "/api/promocoes/jobs/promo:1623/resume",
  });

  assert.equal(job.resumable, true);
  assert.equal(job.pending, 644);
  assert.equal(job.resumeUrl, "/api/promocoes/jobs/promo:1623/resume");
});
