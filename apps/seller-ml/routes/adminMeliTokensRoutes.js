"use strict";

const express = require("express");
const db = require("../db/db");
const { createAuditAction } = require("../middleware/auditAction");
const { adminWriteRateLimiter } = require("../middleware/security");

const router = express.Router();

// Master-only gate
function ensureMasterOnly(req, res, next) {
  const u = req.user || res.locals.user;
  const nivel = String(u?.nivel || "").trim().toLowerCase();
  if (nivel === "admin_master") return next();
  return res.status(403).json({ ok: false, error: "Acesso não autorizado." });
}

router.use(ensureMasterOnly);

// GET /api/admin/meli-tokens
// Lista tokens + contexto (empresa, conta, apelido, meli_user_id)
router.get("/meli-tokens", async (_req, res) => {
  try {
    const { rows } = await db.query(
      `select
         t.meli_conta_id,
         t.access_expires_at,
         t.scope,
         t.refresh_obtido_em,
         t.ultimo_refresh_em,
         -- contexto
         c.empresa_id,
         e.nome as empresa_nome,
         c.meli_user_id,
         c.apelido,
         c.site_id,
         c.status as conta_status,
         c.atualizado_em as conta_atualizado_em
       from meli_tokens t
       join meli_contas c on c.id = t.meli_conta_id
       join empresas e on e.id = c.empresa_id
       order by t.ultimo_refresh_em desc nulls last, t.refresh_obtido_em desc nulls last, t.meli_conta_id desc`
    );

    // calcula expires_in_min em JS (evita dependência de SQL interval)
    const now = Date.now();
    const withCalc = rows.map((r) => {
      let expires_in_min = null;
      if (r.access_expires_at) {
        const ts = new Date(r.access_expires_at).getTime();
        if (!Number.isNaN(ts)) expires_in_min = Math.floor((ts - now) / 60000);
      }
      return { ...r, expires_in_min };
    });

    return res.json({ ok: true, tokens: withCalc });
  } catch (err) {
    console.error("GET /api/admin/meli-tokens erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao listar tokens ML" });
  }
});

// DELETE /api/admin/meli-tokens/:meli_conta_id
// Remove o registro de tokens (força reauth/refresh futuro falhar)
router.delete(
  "/meli-tokens/:meli_conta_id",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_meli_token_deleted",
    metadata: (req) => ({
      meli_conta_id: Number(req.params.meli_conta_id) || null,
    }),
  }),
  async (req, res) => {
  try {
    const meli_conta_id = Number(req.params.meli_conta_id);
    if (!Number.isFinite(meli_conta_id)) {
      return res.status(400).json({ ok: false, error: "meli_conta_id inválido." });
    }

    const { rowCount } = await db.query(
      `delete from meli_tokens where meli_conta_id = $1`,
      [meli_conta_id]
    );

    if (!rowCount) {
      return res.status(404).json({ ok: false, error: "Token não encontrado para essa conta." });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/admin/meli-tokens/:meli_conta_id erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao remover token ML" });
  }
  },
);

// POST /api/admin/meli-tokens/:meli_conta_id/revogar-conta
// Marca a conta como "revogada" em meli_contas (só status, não mexe em tokens)
router.post(
  "/meli-tokens/:meli_conta_id/revogar-conta",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_meli_account_revoked",
    metadata: (req) => ({
      meli_conta_id: Number(req.params.meli_conta_id) || null,
    }),
  }),
  async (req, res) => {
  try {
    const meli_conta_id = Number(req.params.meli_conta_id);
    if (!Number.isFinite(meli_conta_id)) {
      return res.status(400).json({ ok: false, error: "meli_conta_id inválido." });
    }

    const { rows } = await db.query(
      `update meli_contas
          set status = 'revogada',
              atualizado_em = now()
        where id = $1
      returning id, empresa_id, meli_user_id, apelido, status, atualizado_em`,
      [meli_conta_id]
    );

    if (!rows[0]) {
      return res.status(404).json({ ok: false, error: "Conta não encontrada." });
    }

    return res.json({ ok: true, conta: rows[0] });
  } catch (err) {
    console.error("POST /api/admin/meli-tokens/:meli_conta_id/revogar-conta erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao revogar conta" });
  }
  },
);

module.exports = router;
