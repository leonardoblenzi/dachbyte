const assert = require("node:assert/strict");
const test = require("node:test");

const {
  attachJobContract,
  backendJobIdFromUid,
  createJobUid,
} = require("../services/jobContract");

test("job uid namespaces equal numeric ids from different modules", () => {
  assert.equal(createJobUid("filtro-anuncios", 42), "filtro-anuncios:42");
  assert.equal(createJobUid("promocoes", 42), "promocoes:42");
  assert.notEqual(createJobUid("filtro-anuncios", 42), createJobUid("promocoes", 42));
});

test("promotion source id remains available as backend id", () => {
  const job = attachJobContract(
    { id: "promo:382", state: "active", progress: 100 },
    { module: "promocoes" },
  );

  assert.equal(job.job_uid, "promocoes:promo:382");
  assert.equal(job.backend_job_id, "promo:382");
  assert.equal(job.lifecycle_status, "processing");
  assert.equal(backendJobIdFromUid("promocoes", job.job_uid), "promo:382");
});

test("completed job with errors uses partial lifecycle", () => {
  const job = attachJobContract(
    { id: 160, status: "concluido", completed: true, errors: 1 },
    { module: "filtro-anuncios" },
  );

  assert.equal(job.lifecycle_status, "partial");
  assert.equal(job.terminal, true);
  assert.equal(job.progress_percent, 100);
});

test("canceling remains non-terminal until cancellation is confirmed", () => {
  const job = attachJobContract(
    { id: 7, status: "cancelando", completed: false },
    { module: "prazo" },
  );

  assert.equal(job.lifecycle_status, "processing");
  assert.equal(job.terminal, false);
});
