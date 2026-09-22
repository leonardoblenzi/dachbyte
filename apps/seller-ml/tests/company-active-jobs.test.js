const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createCompanyActiveJobsService,
} = require("../services/companyActiveJobsService");

function provider(name, list) {
  return { name, list };
}

test("libera exclusao quando nenhum provider retorna job", async () => {
  const service = createCompanyActiveJobsService({
    providers: [provider("promocoes", async () => [])],
  });

  const result = await service.checkCompanyActiveJobs(["conta-a"]);

  assert.equal(result.blocked, false);
  assert.deepEqual(result.activeJobs, []);
  assert.deepEqual(result.inspectionFailures, []);
});

test("bloqueia exclusao e identifica provider e conta para job ativo", async () => {
  const service = createCompanyActiveJobsService({
    providers: [
      provider("promocoes", async () => ({
        jobs: [{ id: "job-7", status: "ACTIVE", description: "Aplicando" }],
      })),
    ],
  });

  const result = await service.checkCompanyActiveJobs(["conta-a"]);

  assert.equal(result.blocked, true);
  assert.deepEqual(result.inspectionFailures, []);
  assert.equal(result.activeJobs.length, 1);
  assert.equal(result.activeJobs[0].provider, "promocoes");
  assert.equal(result.activeJobs[0].accountKey, "conta-a");
  assert.equal(result.activeJobs[0].jobId, "job-7");
  assert.equal(result.activeJobs[0].status, "active");
  assert.equal(result.activeJobs[0].description, "Aplicando");
});

test("nao bloqueia para estados terminais", async () => {
  const service = createCompanyActiveJobsService({
    providers: [
      provider("promocoes", async () => [
        { id: 1, state: "completed" },
        { id: 2, jobState: "FAILED" },
        { id: 3, status: "cancelado" },
        { id: 4, status: "concluido" },
      ]),
    ],
  });

  const result = await service.checkCompanyActiveJobs(["conta-a"]);

  assert.equal(result.blocked, false);
  assert.deepEqual(result.activeJobs, []);
});

test("inspeciona todas as contas", async () => {
  const calls = [];
  const service = createCompanyActiveJobsService({
    providers: [
      provider("estoque", async (accountKey) => {
        calls.push(accountKey);
        return accountKey === "conta-b" ? [{ jobId: "b-1", state: "processando" }] : [];
      }),
    ],
  });

  const result = await service.checkCompanyActiveJobs(["conta-a", "conta-b"]);

  assert.deepEqual(calls, ["conta-a", "conta-b"]);
  assert.equal(result.blocked, true);
  assert.equal(result.activeJobs[0].accountKey, "conta-b");
  assert.equal(result.activeJobs[0].status, "processando");
});

test("deduplica o mesmo job retornado mais de uma vez", async () => {
  const service = createCompanyActiveJobsService({
    providers: [
      provider("estoque", async () => [
        { id: "job-1", status: "waiting" },
        { id: "job-1", status: "waiting" },
      ]),
    ],
  });

  const result = await service.checkCompanyActiveJobs(["conta-a"]);

  assert.equal(result.activeJobs.length, 1);
});

test("bloqueia labels reais de fila e lifecycle_status", async () => {
  const service = createCompanyActiveJobsService({
    providers: [
      provider("promocoes", async () => ({
        items: [
          { id: "promo-active", state: "active 3/10" },
          { id: "promo-queue", status: "na fila: aguardando worker" },
          { id: "promo-lifecycle", lifecycle_status: "paused_safety" },
        ],
      })),
      provider("prazo", async () => [
        { id: "prazo-progress", status: "processando 3/10" },
        { id: "retry", lifecycle_status: "retry_wait" },
        { id: "finished", status: "completed with active warnings" },
      ]),
    ],
  });

  const result = await service.checkCompanyActiveJobs(["conta-a"]);

  assert.equal(result.blocked, true);
  assert.deepEqual(
    result.activeJobs.map((job) => [job.jobId, job.status]),
    [
      ["promo-active", "active"],
      ["promo-queue", "waiting"],
      ["promo-lifecycle", "paused"],
      ["prazo-progress", "processando"],
      ["retry", "waiting"],
    ],
  );
});

test("falha de inspecao bloqueia exclusao", async () => {
  const service = createCompanyActiveJobsService({
    providers: [
      provider("atacado", async () => {
        throw new Error("Redis indisponivel");
      }),
    ],
  });

  const result = await service.checkCompanyActiveJobs(["conta-a"]);

  assert.equal(result.blocked, true);
  assert.deepEqual(result.activeJobs, []);
  assert.deepEqual(result.inspectionFailures, [
    { provider: "atacado", accountKey: "conta-a", message: "Redis indisponivel" },
  ]);
});

test("resposta ausente ou malformada de provider bloqueia exclusao", async () => {
  const service = createCompanyActiveJobsService({
    providers: [
      provider("sem-resposta", async () => undefined),
      provider("malformado", async () => ({ total: 3 })),
    ],
  });

  const result = await service.checkCompanyActiveJobs(["conta-a"]);

  assert.equal(result.blocked, true);
  assert.deepEqual(result.activeJobs, []);
  assert.deepEqual(
    result.inspectionFailures.map((failure) => [failure.provider, failure.accountKey]),
    [
      ["sem-resposta", "conta-a"],
      ["malformado", "conta-a"],
    ],
  );
});

test("registra padrao pode ser criado sem chamar providers reais", () => {
  const service = createCompanyActiveJobsService();

  assert.equal(typeof service.checkCompanyActiveJobs, "function");
});
