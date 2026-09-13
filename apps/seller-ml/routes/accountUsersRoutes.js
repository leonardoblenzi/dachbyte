"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const db = require("../db/db");
const companyAccess = require("../services/companyAccessService");
const {
  createActivationToken,
  hashToken,
  activationExpiryDate,
  buildActivationLink,
  createTemporaryPassword,
} = require("./authRoutes");
const { sendInviteEmail } = require("../services/inviteEmailService");
const { syncHubIdentity } = require("../services/hubAccessService");
const { adminWriteRateLimiter } = require("../middleware/security");

const router = express.Router();

function parsePositiveInt(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

async function resolveEmpresaId(req, res) {
  const localEmpresaId = parsePositiveInt(res.locals?.empresaId);
  if (localEmpresaId) return localEmpresaId;

  const userId = companyAccess.getUserId(req);
  if (!userId) return null;

  const selectedContaId = parsePositiveInt(req.cookies?.meli_conta_id);
  if (selectedContaId) {
    const { rows } = await db.query(
      `select mc.empresa_id
         from meli_contas mc
         join empresa_usuarios eu
           on eu.empresa_id = mc.empresa_id
          and eu.usuario_id = $2
        where mc.id = $1
        limit 1`,
      [selectedContaId, userId],
    );
    if (rows[0]?.empresa_id) return Number(rows[0].empresa_id);
  }

  const ctx = await companyAccess.userCompanyContext(userId);
  return parsePositiveInt(ctx?.empresa_id);
}

function requireEmpresaAdmin() {
  const requireNivelAdmin = companyAccess.requireNivelAdmin();
  return async (req, res, next) => {
    res.locals.empresaId = await resolveEmpresaId(req, res);
    if (!res.locals.empresaId) {
      return res.status(400).json({
        ok: false,
        error: "Selecione uma conta para gerenciar os usuarios da empresa.",
      });
    }
    return requireNivelAdmin(req, res, next);
  };
}

function createGlobalId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeName(name, fallbackEmail = "") {
  const clean = String(name || "").trim().replace(/\s+/g, " ");
  return clean || fallbackEmail.split("@")[0] || "Usuario Davantti";
}

function normalizeInviteNivel(value) {
  const nivel = String(value || "usuario").trim().toLowerCase();
  return nivel === "administrador" || nivel === "admin" ? "administrador" : "usuario";
}

function normalizeCompanyRole(value, nivel = "usuario") {
  const role = String(value || "").trim().toLowerCase();
  if (["owner", "admin", "operador"].includes(role)) return role;
  return nivel === "administrador" ? "admin" : "operador";
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

async function sendInviteEmailSafe({ email, nome, link, expiresAt }) {
  try {
    return await sendInviteEmail({
      toEmail: email,
      toName: nome,
      activationLink: link,
      expiresAt,
    });
  } catch (err) {
    console.error("account invite email erro:", err?.message || err);
    return {
      sent: false,
      skipped: false,
      error: err?.message || "Falha ao enviar email via Brevo.",
    };
  }
}

async function loadEmpresaIdentity(empresaId) {
  const { rows } = await db.query(
    `select id as empresa_id,
            nome as empresa_nome,
            nome as company_name,
            tenant_global_id,
            document_type,
            document_number
       from empresas
      where id = $1
      limit 1`,
    [empresaId],
  );
  return rows[0] || null;
}

async function syncInvitedUserToHub({ empresaId, usuario, papel }) {
  try {
    const company = await loadEmpresaIdentity(empresaId);
    if (!company || !usuario?.id || !usuario?.email) {
      return { ok: false, skipped: true, reason: "identity_not_ready" };
    }

    return await syncHubIdentity({
      company,
      user: {
        id: usuario.id,
        user_global_id: usuario.user_global_id,
        name: usuario.nome,
        email: usuario.email,
        nivel: usuario.nivel,
      },
      role: papel,
      module: "ml",
      modules: ["ml"],
      access_policy: "explicit",
    });
  } catch (error) {
    console.error("account invite hub sync erro:", error?.message || error);
    return {
      ok: false,
      reason: "hub_identity_sync_failed",
      detail: error?.message || String(error || "unknown_error"),
    };
  }
}

async function issueInviteForUser(req, usuario) {
  const activationToken = createActivationToken();
  const activationExpiresAt = activationExpiryDate();
  const { rows } = await db.query(
    `update usuarios
        set status = 'pendente_ativacao',
            activation_token_hash = $1,
            activation_expires_at = $2,
            activation_sent_at = now()
      where id = $3
      returning id, nome, email, nivel, status, user_global_id, criado_em, ultimo_login_em, activation_expires_at`,
    [hashToken(activationToken), activationExpiresAt, usuario.id],
  );

  const updated = rows[0] || usuario;
  const activationLink = buildActivationLink(req, activationToken);
  const emailDelivery = await sendInviteEmailSafe({
    email: updated.email,
    nome: updated.nome,
    link: activationLink,
    expiresAt: activationExpiresAt.toISOString(),
  });

  return {
    usuario: updated,
    convite: {
      link: activationLink,
      expires_at: activationExpiresAt.toISOString(),
    },
    email_delivery: emailDelivery,
  };
}

router.use(express.json({ limit: "1mb" }));
router.use(requireEmpresaAdmin());

router.get("/metadata", async (_req, res, next) => {
  try {
    const setores = await companyAccess.listCompanySectors(Number(res.locals.empresaId));
    res.json({
      ok: true,
      roles: companyAccess.COMPANY_ROLES,
      setores,
      modulos: companyAccess.MODULES,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/setores", async (req, res) => {
  try {
    const setor = await companyAccess.createCompanySector({
      empresaId: Number(res.locals.empresaId),
      label: req.body?.label || req.body?.nome,
    });
    const setores = await companyAccess.listCompanySectors(Number(res.locals.empresaId));
    res.json({ ok: true, setor, setores });
  } catch (error) {
    const status = Number(error?.status) || 500;
    res.status(status).json({
      ok: false,
      error: error?.message || "Falha ao criar setor.",
    });
  }
});

router.put("/setores/:setor", async (req, res) => {
  try {
    const setor = await companyAccess.updateCompanySector({
      empresaId: Number(res.locals.empresaId),
      setor: req.params.setor,
      label: req.body?.label || req.body?.nome,
    });
    const setores = await companyAccess.listCompanySectors(Number(res.locals.empresaId));
    res.json({ ok: true, setor, setores });
  } catch (error) {
    const status = Number(error?.status) || 500;
    res.status(status).json({
      ok: false,
      error: error?.message || "Falha ao editar setor.",
    });
  }
});

router.delete("/setores/:setor", async (req, res) => {
  try {
    const result = await companyAccess.deleteCompanySector({
      empresaId: Number(res.locals.empresaId),
      setor: req.params.setor,
    });
    const setores = await companyAccess.listCompanySectors(Number(res.locals.empresaId));
    res.json({ ok: true, ...result, setores });
  } catch (error) {
    const status = Number(error?.status) || 500;
    res.status(status).json({
      ok: false,
      error: error?.message || "Falha ao remover setor.",
    });
  }
});

router.get("/", async (_req, res, next) => {
  try {
    const usuarios = await companyAccess.listCompanyUsers(Number(res.locals.empresaId));
    res.json({ ok: true, usuarios });
  } catch (error) {
    next(error);
  }
});

router.post("/invite", adminWriteRateLimiter, async (req, res) => {
  try {
    const empresaId = Number(res.locals.empresaId);
    const email = normalizeEmail(req.body?.email);
    const nivel = normalizeInviteNivel(req.body?.nivel);
    const papel = normalizeCompanyRole(req.body?.papel, nivel);
    const nome = normalizeName(req.body?.nome || req.body?.full_name, email);

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: "Informe um email valido." });
    }

    const result = await db.withClient(async (client) => {
      await client.query("begin");
      try {
        const existing = await client.query(
          `select id, nome, email, nivel, status, user_global_id, criado_em, ultimo_login_em, activation_expires_at
             from usuarios
            where lower(trim(email)) = $1
            limit 1`,
          [email],
        );

        let usuario = existing.rows[0] || null;
        if (!usuario) {
          const senhaHash = await bcrypt.hash(createTemporaryPassword(), 10);
          const userGlobalId = createGlobalId();
          const created = await client.query(
            `insert into usuarios (nome, email, senha_hash, nivel, status, user_global_id)
             values ($1, $2, $3, $4, 'pendente_ativacao', $5)
             returning id, nome, email, nivel, status, user_global_id, criado_em, ultimo_login_em, activation_expires_at`,
            [nome, email, senhaHash, nivel, userGlobalId],
          );
          usuario = created.rows[0];
        } else if (String(usuario.status || "").toLowerCase() !== "ativo") {
          await client.query(
            `update usuarios
                set nome = coalesce(nullif($2, ''), nome),
                    nivel = $3
              where id = $1`,
            [usuario.id, nome, nivel],
          );
          usuario = { ...usuario, nome, nivel };
        }

        await client.query(
          `insert into empresa_usuarios (empresa_id, usuario_id, papel)
           values ($1, $2, $3)
           on conflict (empresa_id, usuario_id) do update set papel = excluded.papel`,
          [empresaId, usuario.id, papel],
        );

        await client.query("commit");
        return usuario;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    });

    const active = String(result.status || "").toLowerCase() === "ativo";
    const invite = active ? { usuario: result, convite: null, email_delivery: { sent: false, skipped: true } } : await issueInviteForUser(req, result);
    const hubSync = await syncInvitedUserToHub({
      empresaId,
      usuario: invite.usuario || result,
      papel,
    });
    const usuarios = await companyAccess.listCompanyUsers(empresaId);
    res.json({
      ok: true,
      ...invite,
      hub_sync: hubSync,
      usuarios,
      message: active
        ? "Usuario ativo vinculado a empresa. Ele ja pode acessar com a senha atual."
        : "Convite gerado para ativacao do usuario.",
    });
  } catch (error) {
    const code = String(error?.code || "");
    if (code === "23505") {
      return res.status(409).json({ ok: false, error: "Email ja cadastrado ou usuario ja vinculado." });
    }
    console.error("POST /api/account/users/invite erro:", error);
    res.status(Number(error?.status) || 500).json({
      ok: false,
      error: error?.message || "Falha ao convidar usuario.",
    });
  }
});

router.post("/:usuarioId/invite", adminWriteRateLimiter, async (req, res) => {
  try {
    const empresaId = Number(res.locals.empresaId);
    const usuarioId = parsePositiveInt(req.params.usuarioId);
    if (!usuarioId) return res.status(400).json({ ok: false, error: "Usuario invalido." });

    const { rows } = await db.query(
      `select u.id, u.nome, u.email, u.nivel, u.status, u.user_global_id, u.criado_em, u.ultimo_login_em, u.activation_expires_at,
              eu.papel
         from empresa_usuarios eu
         join usuarios u on u.id = eu.usuario_id
        where eu.empresa_id = $1
          and eu.usuario_id = $2
        limit 1`,
      [empresaId, usuarioId],
    );
    const usuario = rows[0];
    if (!usuario) return res.status(404).json({ ok: false, error: "Usuario nao pertence a esta empresa." });
    if (String(usuario.status || "").toLowerCase() === "ativo") {
      return res.status(409).json({ ok: false, error: "O usuario ja esta ativo. Nao e necessario reenviar convite." });
    }

    const invite = await issueInviteForUser(req, usuario);
    const hubSync = await syncInvitedUserToHub({
      empresaId,
      usuario: invite.usuario || usuario,
      papel: usuario.papel,
    });
    res.json({ ok: true, ...invite, hub_sync: hubSync });
  } catch (error) {
    console.error("POST /api/account/users/:id/invite erro:", error);
    res.status(Number(error?.status) || 500).json({
      ok: false,
      error: error?.message || "Falha ao reenviar convite.",
    });
  }
});

router.put("/:usuarioId/access", async (req, res, next) => {
  try {
    const result = await companyAccess.updateCompanyUserAccess({
      empresaId: Number(res.locals.empresaId),
      usuarioId: req.params.usuarioId,
      papel: req.body?.papel,
      setores: req.body?.setores,
      modulos: req.body?.modulos,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    const status = Number(error?.status) || 500;
    res.status(status).json({
      ok: false,
      error: error?.message || "Falha ao atualizar acessos do usuario.",
    });
  }
});

module.exports = router;
