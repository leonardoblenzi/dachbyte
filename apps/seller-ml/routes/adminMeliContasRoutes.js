"use strict";

const express = require("express");
const db = require("../db/db");
const { createAuditAction } = require("../middleware/auditAction");

const router = express.Router();

// Master-only gate
function ensureMasterOnly(req, res, next) {
  const u = req.user || res.locals.user;
  const nivel = String(u?.nivel || "").trim().toLowerCase();
  if (nivel === "admin_master") return next();
  return res.status(403).json({ ok: false, error: "Acesso não autorizado." });
}

router.use(ensureMasterOnly);

function normalizeText(v, { lower = false } = {}) {
  let s = String(v ?? "").trim();
  if (!s) return null;
  if (lower) s = s.toLowerCase();
  return s;
}

function normalizeSiteId(v) {
  const s = normalizeText(v, { lower: true });
  if (!s) return "MLB";
  return s.toUpperCase();
}

function normalizeStatus(v) {
  const s = normalizeText(v, { lower: true });
  if (!s) return "ativa";
  // mantém simples e compatível com seu sistema
  if (!["ativa", "revogada", "erro"].includes(s)) return null;
  return s;
}

// GET /api/admin/meli-contas
router.get("/meli-contas", async (_req, res) => {
  try {
    const { rows } = await db.query(
      `select
         c.id,
         c.empresa_id,
         e.nome as empresa_nome,
         c.meli_user_id,
         c.apelido,
         c.site_id,
         c.status,
         c.criado_em,
         c.atualizado_em,
         c.ultimo_uso_em
       from meli_contas c
       join empresas e on e.id = c.empresa_id
       order by c.id desc`
    );
    return res.json({ ok: true, contas: rows });
  } catch (err) {
    console.error("GET /api/admin/meli-contas erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao listar contas ML" });
  }
});

// POST /api/admin/meli-contas
router.post(
  "/meli-contas",
  createAuditAction({
    evento: "admin_meli_account_created",
    metadata: (req) => ({
      empresa_id: Number(req.body?.empresa_id) || null,
      meli_user_id: Number(req.body?.meli_user_id) || null,
      apelido: normalizeText(req.body?.apelido),
      site_id: normalizeSiteId(req.body?.site_id || "MLB"),
      status: normalizeStatus(req.body?.status || "ativa"),
    }),
  }),
  express.json({ limit: "200kb" }),
  async (req, res) => {
  try {
    const empresa_id = Number(req.body?.empresa_id);
    const meli_user_id = Number(req.body?.meli_user_id);

    const apelido = normalizeText(req.body?.apelido) || null;
    const site_id = normalizeSiteId(req.body?.site_id || "MLB");
    const status = normalizeStatus(req.body?.status || "ativa");

    if (!Number.isFinite(empresa_id)) {
      return res.status(400).json({ ok: false, error: "empresa_id inválido." });
    }
    if (!Number.isFinite(meli_user_id)) {
      return res.status(400).json({ ok: false, error: "meli_user_id inválido." });
    }
    if (!status) {
      return res.status(400).json({ ok: false, error: "status inválido (ativa|revogada|erro)." });
    }

    // valida empresa existe
    const emp = await db.query(`select id from empresas where id = $1 limit 1`, [empresa_id]);
    if (!emp.rows[0]) {
      return res.status(404).json({ ok: false, error: "Empresa não encontrada." });
    }

    const { rows } = await db.query(
      `insert into meli_contas (empresa_id, meli_user_id, apelido, site_id, status)
       values ($1, $2, $3, $4, $5)
       returning id, empresa_id, meli_user_id, apelido, site_id, status, criado_em, atualizado_em, ultimo_uso_em`,
      [empresa_id, meli_user_id, apelido, site_id, status]
    );

    return res.json({ ok: true, conta: rows[0] });
  } catch (err) {
    // duplicates / unique constraints
    if (String(err.code) === "23505") {
      return res.status(409).json({
        ok: false,
        error: "Conflito: já existe conta com esse meli_user_id nessa empresa (ou apelido duplicado).",
      });
    }
    console.error("POST /api/admin/meli-contas erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao criar conta ML" });
  }
  },
);

// PUT /api/admin/meli-contas/:id
router.put(
  "/meli-contas/:id",
  createAuditAction({
    evento: "admin_meli_account_updated",
    metadata: (req) => ({
      meli_conta_id: Number(req.params.id) || null,
      apelido: req.body?.apelido !== undefined ? normalizeText(req.body.apelido) : null,
      status: req.body?.status !== undefined ? normalizeStatus(req.body.status) : null,
    }),
  }),
  express.json({ limit: "200kb" }),
  async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "ID inválido" });

    // updates permitidos
    const apelido = req.body?.apelido !== undefined ? (normalizeText(req.body.apelido) || null) : undefined;
    const status = req.body?.status !== undefined ? normalizeStatus(req.body.status) : undefined;

    if (status !== undefined && !status) {
      return res.status(400).json({ ok: false, error: "status inválido (ativa|revogada|erro)." });
    }

    const sets = [];
    const params = [];
    let i = 1;

    if (apelido !== undefined) {
      sets.push(`apelido = $${i++}`);
      params.push(apelido);
    }
    if (status !== undefined) {
      sets.push(`status = $${i++}`);
      params.push(status);
    }

    if (!sets.length) {
      return res.status(400).json({ ok: false, error: "Nada para atualizar." });
    }

    // atualizado_em
    sets.push(`atualizado_em = now()`);

    params.push(id);

    const { rows } = await db.query(
      `update meli_contas
          set ${sets.join(", ")}
        where id = $${i}
      returning id, empresa_id, meli_user_id, apelido, site_id, status, criado_em, atualizado_em, ultimo_uso_em`,
      params
    );

    if (!rows[0]) return res.status(404).json({ ok: false, error: "Conta não encontrada" });

    return res.json({ ok: true, conta: rows[0] });
  } catch (err) {
    if (String(err.code) === "23505") {
      return res.status(409).json({
        ok: false,
        error: "Conflito: apelido duplicado na empresa (ou constraint de conta).",
      });
    }
    console.error("PUT /api/admin/meli-contas/:id erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao atualizar conta ML" });
  }
  },
);

// DELETE /api/admin/meli-contas/:id
router.delete(
  "/meli-contas/:id",
  createAuditAction({
    evento: "admin_meli_account_deleted",
    metadata: (req) => ({
      meli_conta_id: Number(req.params.id) || null,
    }),
  }),
  async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "ID inválido" });

    // Se meli_tokens tiver FK com ON DELETE CASCADE, ok.
    // Se não tiver, vai dar 23503. A mensagem abaixo explica.
    const { rowCount } = await db.query(`delete from meli_contas where id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ ok: false, error: "Conta não encontrada" });

    return res.json({ ok: true });
  } catch (err) {
    if (String(err.code) === "23503") {
      return res.status(409).json({
        ok: false,
        error: "Não foi possível remover: existem registros dependentes (ex: tokens) vinculados a esta conta.",
      });
    }
    console.error("DELETE /api/admin/meli-contas/:id erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao remover conta ML" });
  }
  },
);

module.exports = router;
