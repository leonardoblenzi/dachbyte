"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db/db");
const { createAuditAction } = require("../middleware/auditAction");
const { adminWriteRateLimiter } = require("../middleware/security");

const router = express.Router();

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

router.use(ensureMasterOnly);

async function getCompanyDeleteImpact(client, id) {
  const company = await client.query(
    `select id, nome, document_type, document_number, tenant_global_id
       from empresas
      where id = $1
      limit 1`,
    [id],
  );

  if (!company.rows[0]) return null;

  const users = await client.query(
    `select
       u.id,
       u.nome,
       u.email,
       u.nivel,
       count(eu_all.empresa_id)::int as empresas_count
     from empresa_usuarios eu
     join usuarios u on u.id = eu.usuario_id
     left join empresa_usuarios eu_all on eu_all.usuario_id = u.id
     where eu.empresa_id = $1
     group by u.id, u.nome, u.email, u.nivel
     order by u.nome nulls last, u.email asc, u.id asc`,
    [id],
  );

  const accounts = await client.query(
    `select id, apelido, meli_user_id, status
       from meli_contas
      where empresa_id = $1
      order by id asc`,
    [id],
  );

  const usuarios = users.rows || [];
  const usuariosExcluidos = usuarios.filter((user) => {
    const nivel = String(user.nivel || "").trim().toLowerCase();
    return nivel !== "admin_master" && Number(user.empresas_count || 0) <= 1;
  });
  const usuariosDesvinculados = usuarios.filter(
    (user) => !usuariosExcluidos.some((deleted) => Number(deleted.id) === Number(user.id)),
  );

  return {
    empresa: company.rows[0],
    usuarios,
    usuarios_excluidos: usuariosExcluidos,
    usuarios_desvinculados: usuariosDesvinculados,
    contas_ml: accounts.rows || [],
    counts: {
      usuarios: usuarios.length,
      usuarios_excluidos: usuariosExcluidos.length,
      usuarios_desvinculados: usuariosDesvinculados.length,
      contas_ml: accounts.rowCount || 0,
    },
  };
}

router.get("/empresas", async (_req, res) => {
  try {
    const { rows } = await db.query(
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

router.get("/empresas/:id/delete-preview", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: "ID invalido" });
    }

    const impact = await db.withClient((client) => getCompanyDeleteImpact(client, id));
    if (!impact) {
      return res.status(404).json({ ok: false, error: "Empresa nao encontrada" });
    }

    return res.json({ ok: true, ...impact });
  } catch (err) {
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

      const { rows } = await db.query(
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

      const { rows } = await db.query(
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
  createAuditAction({
    evento: "admin_company_deleted",
    metadata: (req) => ({
      company_id: Number(req.params.id) || null,
      cascade: req.body?.cascade === true,
    }),
  }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ ok: false, error: "ID invalido" });
      }

      const cascade = req.body?.cascade === true;

      const result = await db.withClient(async (client) => {
        await client.query("begin");
        try {
          const impact = await getCompanyDeleteImpact(client, id);
          if (!impact) {
            await client.query("rollback");
            return { missing: true };
          }

          if (!cascade && (impact.counts.usuarios > 0 || impact.counts.contas_ml > 0)) {
            await client.query("rollback");
            return { blocked: true, impact };
          }

          const deleteUserIds = impact.usuarios_excluidos.map((user) => Number(user.id)).filter(Number.isFinite);
          let deletedUsers = 0;
          if (deleteUserIds.length) {
            const deleted = await client.query(
              `delete from usuarios
                where id = any($1::bigint[])
                  and lower(coalesce(nivel, 'usuario')) <> 'admin_master'`,
              [deleteUserIds],
            );
            deletedUsers = deleted.rowCount || 0;
          }

          const deletedCompany = await client.query(`delete from empresas where id = $1`, [id]);
          await client.query("commit");
          return {
            ok: true,
            impact,
            deleted_company: deletedCompany.rowCount || 0,
            deleted_users: deletedUsers,
          };
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });

      if (result?.missing) {
        return res.status(404).json({ ok: false, error: "Empresa nao encontrada" });
      }

      if (result?.blocked) {
        const usuarios = result.impact.counts.usuarios || 0;
        const contas = result.impact.counts.contas_ml || 0;
        return res.status(400).json({
          ok: false,
          error: `Nao e permitido remover: empresa possui ${usuarios} usuario(s) e ${contas} conta(s) ML vinculada(s).`,
          ...result.impact,
        });
      }

      return res.json({
        ok: true,
        deleted_company: result.deleted_company,
        deleted_users: result.deleted_users,
        ...result.impact,
      });
    } catch (err) {
      console.error("DELETE /api/admin/empresas/:id erro:", err);
      return res.status(500).json({ ok: false, error: "Erro ao remover empresa" });
    }
  },
);

module.exports = router;
