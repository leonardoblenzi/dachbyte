"use strict";

const express = require("express");
const db = require("../db/db");
const { createAuditAction } = require("../middleware/auditAction");
const { adminWriteRateLimiter } = require("../middleware/security");

const router = express.Router();

// Gate master-only (como nos outros)
function ensureMasterOnly(req, res, next) {
  const u = req.user || res.locals.user;
  const nivel = String(u?.nivel || "").trim().toLowerCase();
  if (nivel === "admin_master") return next();
  return res.status(403).json({ ok: false, error: "Acesso não autorizado." });
}
router.use(ensureMasterOnly);

function normRole(p) {
  return String(p || "").trim().toLowerCase();
}
function isRoleOk(p) {
  return ["owner", "admin", "operador"].includes(normRole(p));
}
function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Lookups p/ selects
router.get("/vinculos/lookups", async (_req, res) => {
  try {
    const [e, u] = await Promise.all([
      db.query(`select id, nome from empresas order by id desc`),
      db.query(`select id, nome, email, nivel from usuarios order by id desc`),
    ]);

    return res.json({ ok: true, empresas: e.rows || [], usuarios: u.rows || [] });
  } catch (err) {
    console.error("GET /api/admin/vinculos/lookups erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao carregar lookups" });
  }
});

// LIST
router.get("/vinculos", async (_req, res) => {
  try {
    const { rows } = await db.query(
      `
      select
        eu.empresa_id,
        e.nome as empresa_nome,
        eu.usuario_id,
        u.nome as usuario_nome,
        u.email as usuario_email,
        u.nivel as usuario_nivel,
        eu.papel,
        eu.criado_em
      from empresa_usuarios eu
      join empresas e on e.id = eu.empresa_id
      join usuarios u on u.id = eu.usuario_id
      order by eu.criado_em desc, eu.empresa_id desc, eu.usuario_id desc
      `
    );

    return res.json({ ok: true, vinculos: rows });
  } catch (err) {
    console.error("GET /api/admin/vinculos erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao listar vínculos" });
  }
});

// CREATE (empresa_id + usuario_id)
router.post(
  "/vinculos",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_company_link_created",
    metadata: (req) => ({
      empresa_id: toInt(req.body?.empresa_id),
      usuario_id: toInt(req.body?.usuario_id),
      papel: normRole(req.body?.papel),
    }),
  }),
  express.json({ limit: "200kb" }),
  async (req, res) => {
  try {
    const empresa_id = toInt(req.body?.empresa_id);
    const usuario_id = toInt(req.body?.usuario_id);
    const papel = normRole(req.body?.papel);

    if (!empresa_id) return res.status(400).json({ ok: false, error: "empresa_id inválido" });
    if (!usuario_id) return res.status(400).json({ ok: false, error: "usuario_id inválido" });
    if (!isRoleOk(papel)) return res.status(400).json({ ok: false, error: "papel inválido" });

    // insere; se já existe, vai estourar PK (23505)
    await db.query(
      `insert into empresa_usuarios (empresa_id, usuario_id, papel)
       values ($1, $2, $3)`,
      [empresa_id, usuario_id, papel]
    );

    return res.json({ ok: true });
  } catch (err) {
    if (String(err.code) === "23505") {
      return res.status(409).json({ ok: false, error: "Esse usuário já está vinculado a essa empresa." });
    }
    console.error("POST /api/admin/vinculos erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao criar vínculo" });
  }
  },
);

// UPDATE (PK composta -> via URL)
router.put(
  "/vinculos/:empresa_id/:usuario_id",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_company_link_updated",
    metadata: (req) => ({
      from_empresa_id: toInt(req.params.empresa_id),
      from_usuario_id: toInt(req.params.usuario_id),
      to_empresa_id: toInt(req.body?.empresa_id),
      to_usuario_id: toInt(req.body?.usuario_id),
      papel: normRole(req.body?.papel),
    }),
  }),
  express.json({ limit: "200kb" }),
  async (req, res) => {
    const oldEmpresaId = toInt(req.params.empresa_id);
    const oldUsuarioId = toInt(req.params.usuario_id);

    if (!oldEmpresaId || !oldUsuarioId) {
      return res.status(400).json({ ok: false, error: "Chave inválida" });
    }

    try {
      const newEmpresaId = toInt(req.body?.empresa_id);
      const newUsuarioId = toInt(req.body?.usuario_id);
      const papel = normRole(req.body?.papel);

      if (!newEmpresaId) return res.status(400).json({ ok: false, error: "empresa_id inválido" });
      if (!newUsuarioId) return res.status(400).json({ ok: false, error: "usuario_id inválido" });
      if (!isRoleOk(papel)) return res.status(400).json({ ok: false, error: "papel inválido" });

      // Se chave não mudou -> update simples
      const keyChanged = oldEmpresaId !== newEmpresaId || oldUsuarioId !== newUsuarioId;

      if (!keyChanged) {
        const { rowCount } = await db.query(
          `update empresa_usuarios
              set papel = $3
            where empresa_id = $1 and usuario_id = $2`,
          [oldEmpresaId, oldUsuarioId, papel]
        );

        if (!rowCount) return res.status(404).json({ ok: false, error: "Vínculo não encontrado" });
        return res.json({ ok: true });
      }

      // Se chave mudou: move (delete+insert) com transação
      await db.withClient(async (client) => {
        await client.query("begin");
        try {
          const existsOld = await client.query(
            `select 1 from empresa_usuarios where empresa_id = $1 and usuario_id = $2 limit 1`,
            [oldEmpresaId, oldUsuarioId]
          );
          if (!existsOld.rows[0]) {
            await client.query("rollback");
            throw Object.assign(new Error("Vínculo não encontrado"), { status: 404 });
          }

          const existsNew = await client.query(
            `select 1 from empresa_usuarios where empresa_id = $1 and usuario_id = $2 limit 1`,
            [newEmpresaId, newUsuarioId]
          );
          if (existsNew.rows[0]) {
            await client.query("rollback");
            throw Object.assign(new Error("Já existe vínculo com essa chave (empresa/usuário)."), { status: 409 });
          }

          await client.query(
            `delete from empresa_usuarios where empresa_id = $1 and usuario_id = $2`,
            [oldEmpresaId, oldUsuarioId]
          );

          await client.query(
            `insert into empresa_usuarios (empresa_id, usuario_id, papel)
             values ($1, $2, $3)`,
            [newEmpresaId, newUsuarioId, papel]
          );

          await client.query("commit");
        } catch (e) {
          try { await client.query("rollback"); } catch {}
          throw e;
        }
      });

      return res.json({ ok: true });
    } catch (err) {
      const status = Number(err?.status) || 500;
      const msg = err?.message || "Erro ao atualizar vínculo";
      if (status !== 500) return res.status(status).json({ ok: false, error: msg });

      if (String(err.code) === "23505") {
        return res.status(409).json({ ok: false, error: "Já existe vínculo com essa chave (empresa/usuário)." });
      }

      console.error("PUT /api/admin/vinculos/:empresa/:usuario erro:", err);
      return res.status(500).json({ ok: false, error: "Erro ao atualizar vínculo" });
    }
  }
);

// DELETE (PK composta)
router.delete(
  "/vinculos/:empresa_id/:usuario_id",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_company_link_deleted",
    metadata: (req) => ({
      empresa_id: toInt(req.params.empresa_id),
      usuario_id: toInt(req.params.usuario_id),
    }),
  }),
  async (req, res) => {
  const empresa_id = toInt(req.params.empresa_id);
  const usuario_id = toInt(req.params.usuario_id);
  if (!empresa_id || !usuario_id) {
    return res.status(400).json({ ok: false, error: "Chave inválida" });
  }

  try {
    const { rowCount } = await db.query(
      `delete from empresa_usuarios where empresa_id = $1 and usuario_id = $2`,
      [empresa_id, usuario_id]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: "Vínculo não encontrado" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/admin/vinculos/:empresa/:usuario erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao remover vínculo" });
  }
  },
);

module.exports = router;
