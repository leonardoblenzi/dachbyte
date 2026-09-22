"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db/db");
const { createAuditAction } = require("../middleware/auditAction");
const { adminWriteRateLimiter } = require("../middleware/security");
const { createCompanyDeletionService } = require("../services/companyDeletionService");
const { createCompanyActiveJobsService } = require("../services/companyActiveJobsService");

function ensureMasterOnly(req, res, next) {
  const u = req.user || res.locals.user;
  const nivel = String(u?.nivel || "").trim().toLowerCase();
  if (nivel === "admin_master") return next();
  return res.status(403).json({ ok: false, error: "Acesso nao autorizado." });
}

function normalizeDocumentType(value) {
  const type = String(value || "").trim().toUpperCase();
  if (!type) return null;
  if (type !== "CPF" && type !== "CNPJ") {
    throw new Error("Tipo de documento invalido. Use CPF ou CNPJ.");
  }
  return type;
}

function normalizeDocumentNumber(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  return digits || null;
}

function createGlobalId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function validateDocument(documentType, documentNumber) {
  if (!documentType && !documentNumber) return;
  if (!documentType && documentNumber) {
    throw new Error("Selecione o tipo do documento.");
  }
  if (documentType === "CPF" && documentNumber && documentNumber.length !== 11) {
    throw new Error("CPF deve ter 11 digitos.");
  }
  if (documentType === "CNPJ" && documentNumber && documentNumber.length !== 14) {
    throw new Error("CNPJ deve ter 14 digitos.");
  }
}

function companyDeletionErrorStatus(error) {
  if (error?.code === "INVALID_COMPANY_ID") return 400;
  if (error?.code === "COMPANY_NOT_FOUND") return 404;
  if (error?.code === "COMPANY_DELETION_BLOCKED") return 409;
  return 500;
}

function parseReceiptFilters(query = {}) {
  const parsePositiveInteger = (value, fallback, label) => {
    if (value === undefined || value === null || String(value).trim() === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} invalido.`);
    return parsed;
  };
  const parseDate = (value, label) => {
    if (value === undefined || value === null || String(value).trim() === "") return undefined;
    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.getTime())) throw new Error(`${label} invalida.`);
    return String(value);
  };
  const from = parseDate(query.from, "Data inicial");
  const to = parseDate(query.to, "Data final");
  if (from && to && new Date(from) > new Date(to)) {
    throw new Error("A data inicial deve ser anterior a data final.");
  }
  return {
    search: String(query.search || "").trim() || undefined,
    from,
    to,
    operator: String(query.operator || "").trim() || undefined,
    page: parsePositiveInteger(query.page, 1, "Pagina"),
    pageSize: Math.min(100, parsePositiveInteger(query.pageSize, 25, "Tamanho da pagina")),
  };
}

function safeDeletionBlocker(details = {}) {
  return {
    blocked: true,
    canDelete: false,
    activeJobs: Array.isArray(details.activeJobs) ? details.activeJobs : [],
    inspectionFailures: Array.isArray(details.inspectionFailures) ? details.inspectionFailures : [],
  };
}

function createAdminEmpresasRouter({
  database = db,
  companyDeletionService,
  activeJobs,
  randomUUID,
} = {}) {
  const router = express.Router();
  const deletionService = companyDeletionService || createCompanyDeletionService({
    db: database,
    activeJobs: activeJobs || createCompanyActiveJobsService(),
    randomUUID,
  });

  router.use(ensureMasterOnly);

  router.get("/empresas", async (_req, res) => {
  try {
    const { rows } = await database.query(
      `
      select
        e.id,
        e.nome,
        e.document_type,
        e.document_number,
        e.tenant_global_id,
        e.criado_em,
        (
          select count(*)::int
          from empresa_usuarios eu
          where eu.empresa_id = e.id
        ) as usuarios_count,
        (
          select count(*)::int
          from meli_contas c
          where c.empresa_id = e.id
        ) as contas_ml_count
      from empresas e
      order by e.id desc
      `
    );

    return res.json({ ok: true, empresas: rows });
  } catch (err) {
    console.error("GET /api/admin/empresas erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao listar empresas" });
  }
  });

  router.get("/empresas/deletion-receipts", async (req, res) => {
    try {
      const result = await deletionService.listDeletionReceipts(parseReceiptFilters(req.query));
      return res.json({ ok: true, receipts: result.items, page: result.page, pageSize: result.pageSize, total: result.total });
    } catch (err) {
      if (/Pagina|Tamanho da pagina|Data inicial|Data final/i.test(String(err?.message || ""))) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      console.error("GET /api/admin/empresas/deletion-receipts erro:", err);
      return res.status(500).json({ ok: false, error: "Erro ao listar recibos de exclusao." });
    }
  });

  router.get("/empresas/:id/delete-preview", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: "ID invalido" });
    }

    const impact = await deletionService.previewCompanyDeletion(id);
    return res.json({ ok: true, ...impact });
  } catch (err) {
    const status = companyDeletionErrorStatus(err);
    if (status !== 500) return res.status(status).json({ ok: false, error: err.message || "Erro ao calcular impacto da exclusao." });
    console.error("GET /api/admin/empresas/:id/delete-preview erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao calcular impacto da exclusao." });
  }
  });

  router.post(
  "/empresas",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_company_created",
    metadata: (req) => ({
      company_name: String(req.body?.nome || "").trim() || null,
      document_type: String(req.body?.document_type || "").trim().toUpperCase() || null,
      tenant_global_id: String(req.body?.tenant_global_id || "").trim() || null,
    }),
  }),
  express.json({ limit: "200kb" }),
  async (req, res) => {
    try {
      const nome = String(req.body?.nome || "").trim();
      const documentType = normalizeDocumentType(req.body?.document_type);
      const documentNumber = normalizeDocumentNumber(req.body?.document_number);
      const tenantGlobalId =
        String(req.body?.tenant_global_id || "").trim() || createGlobalId();

      if (!nome) {
        return res.status(400).json({ ok: false, error: "Informe o nome da empresa." });
      }

      validateDocument(documentType, documentNumber);

      const { rows } = await database.query(
        `
        insert into empresas (nome, document_type, document_number, tenant_global_id)
        values ($1, $2, $3, $4)
        returning id, nome, document_type, document_number, tenant_global_id, criado_em
        `,
        [nome, documentType, documentNumber, tenantGlobalId]
      );

      return res.json({ ok: true, empresa: rows[0] });
    } catch (err) {
      if (err instanceof Error && /documento|CPF|CNPJ/i.test(err.message)) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      if (String(err.code) === "23505") {
        const detail = String(err.detail || "");
        if (detail.includes("tenant_global_id")) {
          return res.status(409).json({ ok: false, error: "Tenant global ja esta em uso por outra empresa." });
        }
        return res.status(409).json({ ok: false, error: "Empresa ja cadastrada com esses dados unicos." });
      }
      console.error("POST /api/admin/empresas erro:", err);
      return res.status(500).json({ ok: false, error: "Erro ao criar empresa" });
    }
  },
  );

  router.put(
  "/empresas/:id",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_company_updated",
    metadata: (req) => ({
      company_id: Number(req.params.id) || null,
      company_name: String(req.body?.nome || "").trim() || null,
      document_type: String(req.body?.document_type || "").trim().toUpperCase() || null,
      tenant_global_id: String(req.body?.tenant_global_id || "").trim() || null,
    }),
  }),
  express.json({ limit: "200kb" }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ ok: false, error: "ID invalido" });
      }

      const nome = String(req.body?.nome || "").trim();
      const documentType = normalizeDocumentType(req.body?.document_type);
      const documentNumber = normalizeDocumentNumber(req.body?.document_number);
      const tenantGlobalId = String(req.body?.tenant_global_id || "").trim() || null;

      if (!nome) {
        return res.status(400).json({ ok: false, error: "Informe o nome da empresa." });
      }

      validateDocument(documentType, documentNumber);

      const { rows } = await database.query(
        `
        update empresas
           set nome = $1,
               document_type = $2,
               document_number = $3,
               tenant_global_id = $4
         where id = $5
        returning id, nome, document_type, document_number, tenant_global_id, criado_em
        `,
        [nome, documentType, documentNumber, tenantGlobalId, id]
      );

      if (!rows[0]) {
        return res.status(404).json({ ok: false, error: "Empresa nao encontrada" });
      }

      return res.json({ ok: true, empresa: rows[0] });
    } catch (err) {
      if (err instanceof Error && /documento|CPF|CNPJ/i.test(err.message)) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      if (String(err.code) === "23505") {
        const detail = String(err.detail || "");
        if (detail.includes("tenant_global_id")) {
          return res.status(409).json({ ok: false, error: "Tenant global ja esta em uso por outra empresa." });
        }
        return res.status(409).json({ ok: false, error: "Ja existe uma empresa com esses dados unicos." });
      }
      console.error("PUT /api/admin/empresas/:id erro:", err);
      return res.status(500).json({ ok: false, error: "Erro ao atualizar empresa" });
    }
  },
  );

  router.delete(
  "/empresas/:id",
  adminWriteRateLimiter,
  express.json({ limit: "50kb" }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ ok: false, error: "ID invalido" });
      }

      if (req.body?.cascade !== true) {
        return res.status(400).json({ ok: false, error: "Confirme a exclusao em cascata para continuar." });
      }

      const actor = req.user || res.locals.user || {};
      const result = await deletionService.deleteCompany({
        companyId: id,
        actor: { id: actor.id ?? actor.uid ?? null, email: actor.email || null },
      });

      return res.json({
        ok: true,
        receipt: result.receipt,
        deleted_company: result.deletedCompany,
        deleted_users: result.deletedUsers,
        deleted_audit_events: result.deletedAuditEvents,
      });
    } catch (err) {
      const status = companyDeletionErrorStatus(err);
      if (status === 409) {
        return res.status(409).json({ ok: false, error: err.message || "Exclusao bloqueada.", ...safeDeletionBlocker(err.details) });
      }
      if (status !== 500) return res.status(status).json({ ok: false, error: err.message || "Erro ao remover empresa" });
      console.error("DELETE /api/admin/empresas/:id erro:", err);
      return res.status(500).json({ ok: false, error: "Erro ao remover empresa" });
    }
  },
  );

  return router;
}

const router = createAdminEmpresasRouter();
module.exports = router;
module.exports.createAdminEmpresasRouter = createAdminEmpresasRouter;
module.exports.parseReceiptFilters = parseReceiptFilters;
