"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const db = require("../db/db");
const {
  createActivationToken,
  hashToken,
  activationExpiryDate,
  buildActivationLink,
  createTemporaryPassword,
} = require("./authRoutes");
const { sendInviteEmail } = require("../services/inviteEmailService");
const { createAuditAction } = require("../middleware/auditAction");
const {
  adminWriteRateLimiter,
  validateStrongPassword,
} = require("../middleware/security");
const companyAccess = require("../services/companyAccessService");

const router = express.Router();

function ensureMasterOnly(req, res, next) {
  const u = req.user || res.locals.user;

  const nivel = String(u?.nivel || "")
    .trim()
    .toLowerCase();
  const isMaster = nivel === "admin_master" || u?.is_master === true;

  if (isMaster) return next();

  return res.status(403).json({ ok: false, error: "Acesso nao autorizado." });
}

router.use(ensureMasterOnly);

function isValidNivel(n) {
  const v = String(n || "")
    .trim()
    .toLowerCase();
  return ["usuario", "administrador", "admin_master"].includes(v);
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function normalizeNome(nome) {
  const v = String(nome || "").trim();
  return v ? v : null;
}

function createGlobalId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normRole(p) {
  return String(p || "")
    .trim()
    .toLowerCase();
}

function isRoleOk(p) {
  return ["owner", "admin", "operador"].includes(normRole(p));
}

function toIso(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

router.get("/dashboard-stats", async (_req, res) => {
  try {
    const [users, accounts, companies, recentLogins, latestLogin, companyActivity, auditUsage] =
      await Promise.all([
        db.query(
          `select
             count(*)::int as total,
             count(*) filter (where lower(coalesce(status, 'ativo')) = 'ativo')::int as active,
             count(*) filter (where ultimo_login_em >= now() - interval '24 hours')::int as logged_24h,
             count(*) filter (where ultimo_login_em >= now() - interval '7 days')::int as logged_7d
           from usuarios`,
        ),
        db.query(
          `select
             count(*)::int as total,
             count(*) filter (where lower(coalesce(status, 'ativa')) = 'ativa')::int as active,
             count(*) filter (where mt.meli_conta_id is not null)::int as with_tokens
           from meli_contas mc
           left join meli_tokens mt on mt.meli_conta_id = mc.id`,
        ),
        db.query(`select count(*)::int as total from empresas`),
        db.query(
          `select
             to_char(day, 'YYYY-MM-DD') as day,
             coalesce(count(a.id), 0)::int as total
           from generate_series(
             current_date - interval '6 days',
             current_date,
             interval '1 day'
           ) day
           left join auth_audit a
             on a.evento = 'login_success'
            and a.created_at >= day
            and a.created_at < day + interval '1 day'
           group by day
           order by day asc`,
        ),
        db.query(
          `select id, nome, email, ultimo_login_em
             from usuarios
            where ultimo_login_em is not null
            order by ultimo_login_em desc
            limit 1`,
        ),
        db.query(
          `with days as (
             select generate_series(
               current_date - interval '6 days',
               current_date,
               interval '1 day'
             )::date as day
           ),
           company_base as (
             select
               e.id,
               e.nome,
               count(distinct eu.usuario_id)::int as usuarios_count,
               count(distinct mc.id)::int as contas_ml_count,
               latest.user_id as latest_user_id,
               latest.nome as latest_user_nome,
               latest.email as latest_user_email,
               latest.ultimo_login_em as latest_login_at
             from empresas e
             left join empresa_usuarios eu on eu.empresa_id = e.id
             left join meli_contas mc on mc.empresa_id = e.id
             left join lateral (
               select u.id as user_id, u.nome, u.email, u.ultimo_login_em
                 from empresa_usuarios eu2
                 join usuarios u on u.id = eu2.usuario_id
                where eu2.empresa_id = e.id
                  and u.ultimo_login_em is not null
                order by u.ultimo_login_em desc
                limit 1
             ) latest on true
             group by e.id, e.nome, latest.user_id, latest.nome, latest.email, latest.ultimo_login_em
           )
           select
             cb.id,
             cb.nome,
             cb.usuarios_count,
             cb.contas_ml_count,
             cb.latest_user_id,
             cb.latest_user_nome,
             cb.latest_user_email,
             cb.latest_login_at,
             coalesce(sum(day_logins.total), 0)::int as logins_7d,
             jsonb_agg(
               jsonb_build_object(
                 'day', to_char(d.day, 'YYYY-MM-DD'),
                 'total', coalesce(day_logins.total, 0)
               )
               order by d.day asc
             ) as series
           from company_base cb
           cross join days d
           left join lateral (
             select count(a.id)::int as total
               from empresa_usuarios eu
               join auth_audit a
                 on a.user_id = eu.usuario_id
                and a.evento = 'login_success'
                and a.created_at >= d.day
                and a.created_at < d.day + interval '1 day'
              where eu.empresa_id = cb.id
           ) day_logins on true
           group by
             cb.id,
             cb.nome,
             cb.usuarios_count,
             cb.contas_ml_count,
             cb.latest_user_id,
             cb.latest_user_nome,
             cb.latest_user_email,
             cb.latest_login_at
           order by logins_7d desc, cb.latest_login_at desc nulls last, cb.nome asc
           limit 8`,
        ),
        db.query(
          `with event_counts as (
             select
               evento,
               count(*)::int as total,
               max(created_at) as last_at
             from auth_audit
             where created_at >= now() - interval '7 days'
             group by evento
           ),
           classified as (
             select
               case
                 when evento like 'promotion_%' then 'Promocoes'
                 when evento like 'listing_%' then 'Anuncios'
                 when evento like 'strategic_%' then 'Estrategicos'
                 when evento like 'stock_%' then 'Estoque'
                 when evento like 'production_time_%' then 'Prazo de producao'
                 when evento like 'dimensions_%' then 'Dimensoes'
                 when evento like 'model_mass_%' then 'Modelo em massa'
                 when evento like 'characteristics_%' then 'Caracteristicas'
                 when evento like 'wholesale_%' then 'Atacado'
                 when evento like 'token_%'
                   or evento like 'meli_oauth_%'
                   or evento like 'meli_account_%'
                   or evento = 'meli_default_account_selected'
                   then 'Mercado Livre'
                 when evento like 'admin_%' then 'Administracao'
                 when evento like 'login_%'
                   or evento like 'password_%'
                   or evento = 'invite_activated'
                   then 'Autenticacao'
                 else 'Outros'
               end as area,
               evento,
               total,
               last_at
             from event_counts
           ),
           ranked as (
             select
               *,
               row_number() over (partition by area order by total desc, evento asc) as rn
             from classified
           )
           select
             area,
             sum(total)::int as total,
             max(last_at) as last_at,
             jsonb_agg(
               jsonb_build_object('evento', evento, 'total', total)
               order by total desc, evento asc
             ) filter (where rn <= 3) as top_events
           from ranked
           group by area
           order by total desc, last_at desc
           limit 8`,
        ),
      ]);

    const latest = latestLogin.rows?.[0] || null;
    return res.json({
      ok: true,
      users: users.rows?.[0] || { total: 0, active: 0, logged_24h: 0, logged_7d: 0 },
      accounts: accounts.rows?.[0] || { total: 0, active: 0, with_tokens: 0 },
      companies: companies.rows?.[0] || { total: 0 },
      latest_login: latest
        ? {
            id: latest.id,
            nome: latest.nome,
            email: latest.email,
            at: toIso(latest.ultimo_login_em),
          }
        : null,
      login_series: recentLogins.rows || [],
      company_activity: (companyActivity.rows || []).map((row) => ({
        id: row.id,
        nome: row.nome,
        usuarios_count: Number(row.usuarios_count || 0),
        contas_ml_count: Number(row.contas_ml_count || 0),
        latest_login: row.latest_login_at
          ? {
              user_id: row.latest_user_id,
              nome: row.latest_user_nome,
              email: row.latest_user_email,
              at: toIso(row.latest_login_at),
            }
          : null,
        logins_7d: Number(row.logins_7d || 0),
        series: Array.isArray(row.series) ? row.series : [],
      })),
      usage_insights: (auditUsage.rows || []).map((row) => ({
        area: row.area,
        total: Number(row.total || 0),
        last_at: toIso(row.last_at),
        top_events: Array.isArray(row.top_events) ? row.top_events : [],
      })),
    });
  } catch (err) {
    console.error("GET /api/admin/dashboard-stats erro:", err);
    return res.status(500).json({
      ok: false,
      error: "Erro ao carregar dashboard master.",
    });
  }
});

async function sendInviteEmailSafe({ email, nome, link, expiresAt }) {
  try {
    return await sendInviteEmail({
      toEmail: email,
      toName: nome,
      activationLink: link,
      expiresAt,
    });
  } catch (err) {
    console.error("invite email erro:", err?.message || err);
    return {
      sent: false,
      skipped: false,
      error: err?.message || "Falha ao enviar email via Brevo.",
    };
  }
}

router.get("/usuarios", async (_req, res) => {
  try {
    const { rows } = await db.query(
      `select
         id,
         nome,
         email,
         nivel,
         status,
         criado_em,
         ultimo_login_em,
         activation_expires_at
       from usuarios
       order by id desc`,
    );
    return res.json({ ok: true, usuarios: rows });
  } catch (err) {
    console.error("GET /api/admin/usuarios erro:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Erro ao listar usuarios" });
  }
});

router.get("/usuarios/:id/access-controls", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID invalido" });
    }

    const user = await db.query(
      `select id, nome, email, nivel, status
         from usuarios
        where id = $1
        limit 1`,
      [id],
    );
    if (!user.rows[0]) {
      return res.status(404).json({ ok: false, error: "Usuario nao encontrado" });
    }

    const { rows } = await db.query(
      `select
         eu.empresa_id,
         e.nome as empresa_nome,
         eu.papel,
         coalesce(
           jsonb_agg(distinct eus.setor) filter (where eus.setor is not null),
           '[]'::jsonb
         ) as setores,
         coalesce(
           jsonb_agg(distinct jsonb_build_object(
             'modulo_key', eum.modulo_key,
             'pode_acessar', eum.pode_acessar,
             'pode_editar', eum.pode_editar
           )) filter (where eum.modulo_key is not null),
           '[]'::jsonb
         ) as modulos
       from empresa_usuarios eu
       join empresas e on e.id = eu.empresa_id
       left join empresa_usuario_setores eus
         on eus.empresa_id = eu.empresa_id
        and eus.usuario_id = eu.usuario_id
       left join empresa_usuario_modulos eum
         on eum.empresa_id = eu.empresa_id
        and eum.usuario_id = eu.usuario_id
       where eu.usuario_id = $1
       group by eu.empresa_id, e.nome, eu.papel
       order by e.nome asc, eu.empresa_id asc`,
      [id],
    );

    const setoresPorEmpresa = {};
    for (const vinculo of rows) {
      setoresPorEmpresa[String(vinculo.empresa_id)] = await companyAccess.listCompanySectors(Number(vinculo.empresa_id));
    }

    return res.json({
      ok: true,
      usuario: user.rows[0],
      roles: companyAccess.COMPANY_ROLES,
      setores: rows[0] ? setoresPorEmpresa[String(rows[0].empresa_id)] || companyAccess.USER_SECTORS : companyAccess.USER_SECTORS,
      setores_por_empresa: setoresPorEmpresa,
      modulos: companyAccess.MODULES,
      vinculos: rows,
    });
  } catch (err) {
    console.error("GET /api/admin/usuarios/:id/access-controls erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao carregar acessos do usuario" });
  }
});

router.put(
  "/usuarios/:id/access-controls/:empresaId",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_user_module_access_updated",
    metadata: (req) => ({
      target_user_id: Number(req.params.id) || null,
      empresa_id: Number(req.params.empresaId) || null,
      total_modulos: Array.isArray(req.body?.modulos) ? req.body.modulos.length : 0,
      setores: Array.isArray(req.body?.setores) ? req.body.setores : [],
      papel: normRole(req.body?.papel),
    }),
  }),
  express.json({ limit: "1mb" }),
  async (req, res) => {
    try {
      const usuarioId = Number(req.params.id);
      const empresaId = Number(req.params.empresaId);
      if (!Number.isFinite(usuarioId) || usuarioId <= 0 || !Number.isFinite(empresaId) || empresaId <= 0) {
        return res.status(400).json({ ok: false, error: "Usuario ou empresa invalida." });
      }

      const result = await companyAccess.updateCompanyUserAccess({
        empresaId,
        usuarioId,
        papel: req.body?.papel,
        setores: req.body?.setores,
        modulos: req.body?.modulos,
      });

      return res.json({ ok: true, ...result });
    } catch (err) {
      const status = Number(err?.status) || 500;
      if (status !== 500) {
        return res.status(status).json({ ok: false, error: err.message || "Erro ao atualizar acessos." });
      }
      console.error("PUT /api/admin/usuarios/:id/access-controls/:empresaId erro:", err);
      return res.status(500).json({ ok: false, error: "Erro ao atualizar acessos do usuario" });
    }
  },
);

router.post(
  "/usuarios/:id/access-controls/:empresaId/setores",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_company_sector_created",
    metadata: (req) => ({
      target_user_id: Number(req.params.id) || null,
      empresa_id: Number(req.params.empresaId) || null,
      label: String(req.body?.label || req.body?.nome || "").trim() || null,
    }),
  }),
  express.json({ limit: "1mb" }),
  async (req, res) => {
    try {
      const usuarioId = Number(req.params.id);
      const empresaId = Number(req.params.empresaId);
      if (!Number.isFinite(usuarioId) || usuarioId <= 0 || !Number.isFinite(empresaId) || empresaId <= 0) {
        return res.status(400).json({ ok: false, error: "Usuario ou empresa invalida." });
      }

      const vinculo = await db.query(
        `select 1 from empresa_usuarios where empresa_id = $1 and usuario_id = $2 limit 1`,
        [empresaId, usuarioId],
      );
      if (!vinculo.rows[0]) {
        return res.status(404).json({ ok: false, error: "Usuario nao pertence a esta empresa." });
      }

      const setor = await companyAccess.createCompanySector({
        empresaId,
        label: req.body?.label || req.body?.nome,
      });
      const setores = await companyAccess.listCompanySectors(empresaId);
      return res.json({ ok: true, setor, setores });
    } catch (err) {
      const status = Number(err?.status) || 500;
      if (status !== 500) {
        return res.status(status).json({ ok: false, error: err.message || "Erro ao criar setor." });
      }
      console.error("POST /api/admin/usuarios/:id/access-controls/:empresaId/setores erro:", err);
      return res.status(500).json({ ok: false, error: "Erro ao criar setor." });
    }
  },
);

router.put(
  "/usuarios/:id/access-controls/:empresaId/setores/:setor",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_company_sector_updated",
    metadata: (req) => ({
      target_user_id: Number(req.params.id) || null,
      empresa_id: Number(req.params.empresaId) || null,
      setor: String(req.params.setor || "").trim().toLowerCase(),
      label: String(req.body?.label || req.body?.nome || "").trim() || null,
    }),
  }),
  express.json({ limit: "1mb" }),
  async (req, res) => {
    try {
      const usuarioId = Number(req.params.id);
      const empresaId = Number(req.params.empresaId);
      if (!Number.isFinite(usuarioId) || usuarioId <= 0 || !Number.isFinite(empresaId) || empresaId <= 0) {
        return res.status(400).json({ ok: false, error: "Usuario ou empresa invalida." });
      }

      const vinculo = await db.query(
        `select 1 from empresa_usuarios where empresa_id = $1 and usuario_id = $2 limit 1`,
        [empresaId, usuarioId],
      );
      if (!vinculo.rows[0]) {
        return res.status(404).json({ ok: false, error: "Usuario nao pertence a esta empresa." });
      }

      const setor = await companyAccess.updateCompanySector({
        empresaId,
        setor: req.params.setor,
        label: req.body?.label || req.body?.nome,
      });
      const setores = await companyAccess.listCompanySectors(empresaId);
      return res.json({ ok: true, setor, setores });
    } catch (err) {
      const status = Number(err?.status) || 500;
      if (status !== 500) {
        return res.status(status).json({ ok: false, error: err.message || "Erro ao editar setor." });
      }
      console.error("PUT /api/admin/usuarios/:id/access-controls/:empresaId/setores/:setor erro:", err);
      return res.status(500).json({ ok: false, error: "Erro ao editar setor." });
    }
  },
);

router.delete(
  "/usuarios/:id/access-controls/:empresaId/setores/:setor",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_company_sector_deleted",
    metadata: (req) => ({
      target_user_id: Number(req.params.id) || null,
      empresa_id: Number(req.params.empresaId) || null,
      setor: String(req.params.setor || "").trim().toLowerCase(),
    }),
  }),
  async (req, res) => {
    try {
      const usuarioId = Number(req.params.id);
      const empresaId = Number(req.params.empresaId);
      if (!Number.isFinite(usuarioId) || usuarioId <= 0 || !Number.isFinite(empresaId) || empresaId <= 0) {
        return res.status(400).json({ ok: false, error: "Usuario ou empresa invalida." });
      }

      const vinculo = await db.query(
        `select 1 from empresa_usuarios where empresa_id = $1 and usuario_id = $2 limit 1`,
        [empresaId, usuarioId],
      );
      if (!vinculo.rows[0]) {
        return res.status(404).json({ ok: false, error: "Usuario nao pertence a esta empresa." });
      }

      const result = await companyAccess.deleteCompanySector({
        empresaId,
        setor: req.params.setor,
      });
      const setores = await companyAccess.listCompanySectors(empresaId);
      return res.json({ ok: true, ...result, setores });
    } catch (err) {
      const status = Number(err?.status) || 500;
      if (status !== 500) {
        return res.status(status).json({ ok: false, error: err.message || "Erro ao remover setor." });
      }
      console.error("DELETE /api/admin/usuarios/:id/access-controls/:empresaId/setores/:setor erro:", err);
      return res.status(500).json({ ok: false, error: "Erro ao remover setor." });
    }
  },
);

router.post(
  "/usuarios",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_user_created",
    metadata: (req) => ({
      target_email: normalizeEmail(req.body?.email),
      nivel: String(req.body?.nivel || "usuario").trim().toLowerCase(),
      empresa_id: toInt(req.body?.empresa_id),
      papel: normRole(req.body?.papel),
    }),
  }),
  express.json({ limit: "1mb" }),
  async (req, res) => {
  try {
    const nome = normalizeNome(req.body?.nome);
    const email = normalizeEmail(req.body?.email);
    const nivel = String(req.body?.nivel || "usuario")
      .trim()
      .toLowerCase();

    const empresa_id = toInt(req.body?.empresa_id);
    const papel = normRole(req.body?.papel);

    if (!email) {
      return res.status(400).json({ ok: false, error: "Informe o email." });
    }

    if (!empresa_id) {
      return res.status(400).json({
        ok: false,
        error: "Selecione uma empresa para vincular o usuario.",
      });
    }

    if (!isRoleOk(papel)) {
      return res
        .status(400)
        .json({ ok: false, error: "Papel invalido (owner/admin/operador)." });
    }

    if (!isValidNivel(nivel)) {
      return res.status(400).json({ ok: false, error: "Nivel invalido." });
    }

    const activationToken = createActivationToken();
    const activationTokenHash = hashToken(activationToken);
    const activationExpiresAt = activationExpiryDate();
    const senha_hash = await bcrypt.hash(createTemporaryPassword(), 10);
    const userGlobalId = createGlobalId();

    const created = await db.withClient(async (client) => {
      await client.query("begin");
      try {
        const emp = await client.query(
          `select 1 from empresas where id = $1 limit 1`,
          [empresa_id],
        );
        if (!emp.rows[0]) {
          throw Object.assign(new Error("Empresa nao encontrada."), {
            status: 400,
          });
        }

        const { rows } = await client.query(
          `insert into usuarios (
             nome,
             email,
             senha_hash,
             nivel,
             status,
             user_global_id,
             activation_token_hash,
             activation_expires_at,
             activation_sent_at
           )
           values ($1, $2, $3, $4, 'pendente_ativacao', $5, $6, $7, now())
           returning
             id,
             nome,
             email,
             user_global_id,
             nivel,
             status,
             criado_em,
             ultimo_login_em,
             activation_expires_at`,
          [
            nome,
            email,
            senha_hash,
            nivel,
            userGlobalId,
            activationTokenHash,
            activationExpiresAt,
          ],
        );

        const usuario = rows[0];

        await client.query(
          `insert into empresa_usuarios (empresa_id, usuario_id, papel)
           values ($1, $2, $3)`,
          [empresa_id, usuario.id, papel],
        );

        await client.query("commit");
        return usuario;
      } catch (e) {
        try {
          await client.query("rollback");
        } catch {}
        throw e;
      }
    });

    const activationLink = buildActivationLink(req, activationToken);
    const emailDelivery = await sendInviteEmailSafe({
      email,
      nome,
      link: activationLink,
      expiresAt: activationExpiresAt.toISOString(),
    });

    return res.json({
      ok: true,
      usuario: created,
      convite: {
        link: activationLink,
        expires_at: activationExpiresAt.toISOString(),
      },
      email_delivery: emailDelivery,
    });
  } catch (err) {
    const status = Number(err?.status) || 500;

    if (String(err.code) === "23505") {
      return res.status(409).json({ ok: false, error: "Email ja cadastrado." });
    }

    if (String(err.code) === "23503") {
      return res
        .status(400)
        .json({ ok: false, error: "Empresa invalida para vinculo." });
    }

    if (status !== 500) {
      return res
        .status(status)
        .json({ ok: false, error: err.message || "Erro ao criar usuario" });
    }

    console.error("POST /api/admin/usuarios erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao criar usuario" });
  }
  },
);

router.post(
  "/usuarios/:id/invite",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_user_invite_resent",
    metadata: (req) => ({
      target_user_id: Number(req.params.id) || null,
    }),
  }),
  async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: "ID invalido" });
    }

    const chk = await db.query(
      `select id, status from usuarios where id = $1 limit 1`,
      [id],
    );
    const target = chk.rows[0];
    if (!target) {
      return res
        .status(404)
        .json({ ok: false, error: "Usuario nao encontrado" });
    }

    if (String(target.status || "").toLowerCase() === "ativo") {
      return res.status(409).json({
        ok: false,
        error: "O usuario ja esta ativo. Nao e necessario gerar convite.",
      });
    }

    const activationToken = createActivationToken();
    const activationExpiresAt = activationExpiryDate();

    const { rows } = await db.query(
      `update usuarios
          set status = 'pendente_ativacao',
              activation_token_hash = $1,
              activation_expires_at = $2,
              activation_sent_at = now()
        where id = $3
      returning
        id,
        nome,
        email,
        nivel,
        status,
        criado_em,
        ultimo_login_em,
        activation_expires_at`,
      [hashToken(activationToken), activationExpiresAt, id],
    );

    const activationLink = buildActivationLink(req, activationToken);
    const emailDelivery = await sendInviteEmailSafe({
      email: rows[0].email,
      nome: rows[0].nome,
      link: activationLink,
      expiresAt: activationExpiresAt.toISOString(),
    });

    return res.json({
      ok: true,
      usuario: rows[0],
      convite: {
        link: activationLink,
        expires_at: activationExpiresAt.toISOString(),
      },
      email_delivery: emailDelivery,
    });
  } catch (err) {
    console.error("POST /api/admin/usuarios/:id/invite erro:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Erro ao gerar convite." });
  }
  },
);

router.put(
  "/usuarios/:id",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_user_updated",
    metadata: (req) => ({
      target_user_id: Number(req.params.id) || null,
      target_email: req.body?.email ? normalizeEmail(req.body.email) : null,
      nivel: req.body?.nivel ? String(req.body.nivel).trim().toLowerCase() : null,
      senha_alterada: req.body?.senha !== undefined && String(req.body?.senha || "").length > 0,
    }),
  }),
  express.json({ limit: "1mb" }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ ok: false, error: "ID invalido" });
      }

      const requesterId = Number(req.user?.uid);

      const nome =
        req.body?.nome !== undefined ? normalizeNome(req.body.nome) : undefined;

      const email =
        req.body?.email !== undefined
          ? normalizeEmail(req.body.email)
          : undefined;

      const nivel =
        req.body?.nivel !== undefined
          ? String(req.body.nivel).trim().toLowerCase()
          : undefined;

      const senha =
        req.body?.senha !== undefined ? String(req.body.senha) : undefined;

      if (nivel !== undefined && !isValidNivel(nivel)) {
        return res.status(400).json({ ok: false, error: "Nivel invalido." });
      }

      if (
        Number.isFinite(requesterId) &&
        requesterId === id &&
        nivel !== undefined &&
        nivel !== "admin_master"
      ) {
        return res.status(400).json({
          ok: false,
          error: "Voce nao pode rebaixar seu proprio admin_master.",
        });
      }

      const sets = [];
      const params = [];
      let i = 1;

      if (nome !== undefined) {
        sets.push(`nome = $${i++}`);
        params.push(nome);
      }
      if (email !== undefined) {
        sets.push(`email = $${i++}`);
        params.push(email);
      }
      if (nivel !== undefined) {
        sets.push(`nivel = $${i++}`);
        params.push(nivel);
      }

      if (senha !== undefined && senha.length > 0) {
        const passwordCheck = validateStrongPassword(senha);
        if (!passwordCheck.ok) {
          return res.status(400).json({
            ok: false,
            error: passwordCheck.error,
          });
        }
        const senha_hash = await bcrypt.hash(senha, 10);
        sets.push(`senha_hash = $${i++}`);
        params.push(senha_hash);
      }

      if (sets.length === 0) {
        return res
          .status(400)
          .json({ ok: false, error: "Nada para atualizar." });
      }

      params.push(id);

      const { rows } = await db.query(
        `update usuarios
            set ${sets.join(", ")}
          where id = $${i}
        returning
          id,
          nome,
          email,
          nivel,
          status,
          criado_em,
          ultimo_login_em,
          activation_expires_at`,
        params,
      );

      if (!rows[0]) {
        return res
          .status(404)
          .json({ ok: false, error: "Usuario nao encontrado" });
      }

      return res.json({ ok: true, usuario: rows[0] });
    } catch (err) {
      if (String(err.code) === "23505") {
        return res
          .status(409)
          .json({ ok: false, error: "Email ja cadastrado." });
      }
      console.error("PUT /api/admin/usuarios/:id erro:", err);
      return res
        .status(500)
        .json({ ok: false, error: "Erro ao atualizar usuario" });
    }
  },
);

router.delete(
  "/usuarios/:id",
  adminWriteRateLimiter,
  createAuditAction({
    evento: "admin_user_deleted",
    metadata: (req) => ({
      target_user_id: Number(req.params.id) || null,
    }),
  }),
  async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: "ID invalido" });
    }

    const requesterId = Number(req.user?.uid);

    if (Number.isFinite(requesterId) && requesterId === id) {
      return res.status(400).json({
        ok: false,
        error: "Voce nao pode remover seu proprio usuario.",
      });
    }

    const chk = await db.query(`select id, nivel from usuarios where id = $1`, [
      id,
    ]);
    const target = chk.rows[0];
    if (!target) {
      return res
        .status(404)
        .json({ ok: false, error: "Usuario nao encontrado" });
    }

    if (String(target.nivel || "").trim().toLowerCase() === "admin_master") {
      return res.status(400).json({
        ok: false,
        error:
          "Por seguranca, nao e permitido remover um admin_master via painel.",
      });
    }

    const { rowCount } = await db.query(`delete from usuarios where id = $1`, [
      id,
    ]);
    if (!rowCount) {
      return res
        .status(404)
        .json({ ok: false, error: "Usuario nao encontrado" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/admin/usuarios/:id erro:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Erro ao remover usuario" });
  }
  },
);

module.exports = router;
