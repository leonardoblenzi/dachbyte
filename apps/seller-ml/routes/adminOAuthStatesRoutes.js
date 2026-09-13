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

// GET /api/admin/oauth-states
// Lista states com contexto (empresa, usuário)
router.get("/oauth-states", async (_req, res) => {
  try {
    const { rows } = await db.query(
      `select
         s.state,
         s.empresa_id,
         e.nome as empresa_nome,
         s.usuario_id,
         u.email as usuario_email,
         u.nome as usuario_nome,
         s.return_to,
         s.expira_em,
         -- (não retornamos code_verifier por segurança)
         case when s.expira_em < now() then true else false end as expirado
       from oauth_states s
       left join empresas e on e.id = s.empresa_id
       left join usuarios u on u.id = s.usuario_id
       order by s.expira_em desc, s.state asc`
    );

    return res.json({ ok: true, states: rows });
  } catch (err) {
    console.error("GET /api/admin/oauth-states erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao listar oauth_states" });
  }
});

// POST /api/admin/oauth-states/cleanup
// Remove todos expirados (expira_em < now())
router.post(
  "/oauth-states/cleanup",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_oauth_states_cleanup",
  }),
  async (_req, res) => {
  try {
    const r = await db.query(`delete from oauth_states where expira_em < now()`);
    return res.json({ ok: true, deleted: r.rowCount || 0 });
  } catch (err) {
    console.error("POST /api/admin/oauth-states/cleanup erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao limpar expirados" });
  }
  },
);

// DELETE /api/admin/oauth-states/:state
// Remove um state específico
router.delete(
  "/oauth-states/:state",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_oauth_state_deleted",
    metadata: (req) => ({
      oauth_state: String(req.params.state || "").trim() || null,
    }),
  }),
  async (req, res) => {
  try {
    const state = String(req.params.state || "").trim();
    if (!state) return res.status(400).json({ ok: false, error: "state inválido" });

    const r = await db.query(`delete from oauth_states where state = $1`, [state]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "state não encontrado" });

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/admin/oauth-states/:state erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao remover state" });
  }
  },
);

module.exports = router;
