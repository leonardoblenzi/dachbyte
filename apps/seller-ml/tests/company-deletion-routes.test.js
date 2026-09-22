"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");

const dbModulePath = require.resolve("../db/db");
require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    query: async () => ({ rows: [] }),
    withClient: async () => {
      throw new Error("O servico de exclusao injetado deve ser usado no teste.");
    },
  },
};
const { createAdminEmpresasRouter } = require("../routes/adminEmpresasRoutes");

function startApp(router, user = { id: 91, email: "master@example.com", nivel: "admin_master" }) {
  const app = express();
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.use("/api/admin", router);
  const server = http.createServer(app);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  })));
}

async function request(baseUrl, path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function createService(overrides = {}) {
  return {
    previewCompanyDeletion: async () => ({
      empresa: { id: 7, nome: "Empresa" },
      auditEventsCount: 14,
      activeJobs: [],
      inspectionFailures: [],
      canDelete: true,
      blocked: false,
    }),
    deleteCompany: async () => ({
      receipt: { request_id: "receipt-1", deleted_empresa_id: 7, audit_events_deleted_count: 14 },
      deletedCompany: 1,
      deletedUsers: 2,
      deletedAuditEvents: 14,
    }),
    listDeletionReceipts: async () => ({ items: [], page: 1, pageSize: 25, total: 0 }),
    ...overrides,
  };
}

test("rotas de exclusao delegam preview, exclusao e recibos ao servico canonico", async (t) => {
  const calls = [];
  const service = createService({
    previewCompanyDeletion: async (companyId) => {
      calls.push(["preview", companyId]);
      return { empresa: { id: companyId, nome: "Empresa" }, auditEventsCount: 14, activeJobs: [], inspectionFailures: [], canDelete: true, blocked: false };
    },
    deleteCompany: async (input) => {
      calls.push(["delete", input]);
      return { receipt: { request_id: "receipt-1", deleted_empresa_id: input.companyId, audit_events_deleted_count: 14 }, deletedCompany: 1, deletedUsers: 2, deletedAuditEvents: 14 };
    },
    listDeletionReceipts: async (filters) => {
      calls.push(["receipts", filters]);
      return { items: [{ request_id: "receipt-1" }], page: 2, pageSize: 50, total: 1 };
    },
  });
  const { server, baseUrl } = await startApp(createAdminEmpresasRouter({ companyDeletionService: service }));
  t.after(() => server.close());

  const receiptResponse = await request(baseUrl, "/api/admin/empresas/deletion-receipts?search=Empresa&page=2&pageSize=999&from=2026-01-01&to=2026-01-31&operator=91");
  assert.equal(receiptResponse.status, 200);
  assert.deepEqual(receiptResponse.body.receipts, [{ request_id: "receipt-1" }]);
  assert.deepEqual(calls[0], ["receipts", {
    search: "Empresa", from: "2026-01-01", to: "2026-01-31", operator: "91", page: 2, pageSize: 100,
  }]);

  const previewResponse = await request(baseUrl, "/api/admin/empresas/7/delete-preview");
  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.body.auditEventsCount, 14);
  assert.deepEqual(calls[1], ["preview", 7]);

  const deleteResponse = await request(baseUrl, "/api/admin/empresas/7", { method: "DELETE", body: { cascade: true } });
  assert.equal(deleteResponse.status, 200);
  assert.equal(deleteResponse.body.receipt.request_id, "receipt-1");
  assert.deepEqual(calls[2], ["delete", { companyId: 7, actor: { id: 91, email: "master@example.com" } }]);
});

test("DELETE exige cascade, retorna 409 para bloqueio e nao registra auditoria legada", async (t) => {
  const service = createService({
    deleteCompany: async () => {
      const error = new Error("Jobs ativos");
      error.code = "COMPANY_DELETION_BLOCKED";
      error.details = { activeJobs: [{ jobId: "job-1" }], inspectionFailures: [], canDelete: false, blocked: true };
      throw error;
    },
  });
  const router = createAdminEmpresasRouter({ companyDeletionService: service });
  const deletionLayer = router.stack.find((layer) => layer.route?.path === "/empresas/:id" && layer.route.methods.delete);
  assert.ok(deletionLayer, "a rota DELETE deve existir");
  assert.equal(
    deletionLayer.route.stack.some((layer) => /auditAction/i.test(layer.handle?.name || "")),
    false,
    "a exclusao nao pode registrar admin_company_deleted apos apagar a empresa",
  );
  const { server, baseUrl } = await startApp(router);
  t.after(() => server.close());

  const missingCascade = await request(baseUrl, "/api/admin/empresas/7", { method: "DELETE", body: {} });
  assert.equal(missingCascade.status, 400);

  const blocked = await request(baseUrl, "/api/admin/empresas/7", { method: "DELETE", body: { cascade: true } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.blocked, true);
  assert.deepEqual(blocked.body.activeJobs, [{ jobId: "job-1" }]);
});

test("recibos e exclusao permanecem exclusivos para admin_master", async (t) => {
  const service = createService();
  const { server, baseUrl } = await startApp(
    createAdminEmpresasRouter({ companyDeletionService: service }),
    { id: 2, email: "user@example.com", nivel: "usuario" },
  );
  t.after(() => server.close());

  const receipts = await request(baseUrl, "/api/admin/empresas/deletion-receipts");
  assert.equal(receipts.status, 403);
  const deletion = await request(baseUrl, "/api/admin/empresas/7", { method: "DELETE", body: { cascade: true } });
  assert.equal(deletion.status, 403);
});
