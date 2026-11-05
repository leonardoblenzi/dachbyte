"use strict";

const db = require("../db/db");

const COMPANY_ROLES = ["owner", "admin", "operador"];
const USER_SECTORS = [
  { key: "marketing", label: "Marketing" },
  { key: "cadastro", label: "Cadastro" },
  { key: "comercial", label: "Comercial/Preco" },
  { key: "ads", label: "Ads" },
  { key: "logistica", label: "Logistica" },
  { key: "atendimento", label: "Atendimento" },
  { key: "gestao", label: "Gestao" },
];

const MODULES = [
  { key: "ml.anuncios.consulta", label: "Consulta de anuncios", group: "Anuncios", path: "/filtro-anuncios" },
  { key: "ml.anuncios.cadastro", label: "Cadastro de anuncios", group: "Anuncios", path: "/anuncios/cadastro" },
  { key: "ml.anuncios.estrategicos", label: "Estrategicos", group: "Anuncios", path: "/estrategicos" },
  { key: "ml.anuncios.estoque", label: "Estoque", group: "Anuncios", path: "/estoque" },
  { key: "ml.anuncios.ranking", label: "Ranking", group: "Anuncios", path: "/ranking-anuncios" },
  { key: "ml.anuncios.clonar", label: "Clonar anuncio", group: "Anuncios", path: "/clonar-anuncio" },
  // A pagina /full ja usava esta chave; fora do catalogo, ela bloqueava o
  // Full para todo usuario que nao fosse admin.
  { key: "ml.anuncios.full", label: "Full", group: "Anuncios", path: "/full" },
  { key: "ml.operacao.excluir_massa", label: "Gestao de anuncios", group: "Operacoes", path: "/gestao-anuncios", restricted: true },
  { key: "ml.operacao.modelo_massa", label: "Modelo em massa", group: "Operacoes", path: "/modelo-massa", restricted: true },
  { key: "ml.operacao.caracteristicas", label: "Caracteristicas", group: "Operacoes", path: "/caracteristicas", restricted: true },
  { key: "ml.operacao.validar_dimensoes", label: "Validar dimensoes", group: "Operacoes", path: "/validar-dimensoes" },
  { key: "ml.operacao.prazo", label: "Prazo de producao", group: "Operacoes", path: "/prazo" },
  { key: "ml.operacao.atacado", label: "Atacado", group: "Operacoes", path: "/atacado", restricted: true },
  { key: "ml.publicidade.product_ads", label: "Product Ads", group: "Publicidade", path: "/publicidade" },
  { key: "ml.promocoes.criar", label: "Criar promocoes", group: "Promocoes", path: "/criar-promocao" },
  { key: "ml.promocoes.remover", label: "Remover promocoes", group: "Promocoes", path: "/remover-promocao" },
  { key: "ml.precificacao.margem", label: "Margem de venda", group: "Precificacao", path: "/financeiro/margem-venda-mercado-livre" },
  { key: "ml.inteligencia.curva_abc", label: "Curva ABC", group: "Inteligencia", path: "/ia-analytics/curva-abc" },
  { key: "ml.inteligencia.analise_mercado", label: "Analise Mercado", group: "Inteligencia", path: "/analise-mercado" },
  { key: "ml.pedidos.logistica", label: "Logistica de pedidos", group: "Pedidos", path: "/logistica" },
];

const MODULE_KEYS = new Set(MODULES.map((item) => item.key));
const SECTOR_KEYS = new Set(USER_SECTORS.map((item) => item.key));

function slugifySector(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function normalizeNivel(value) {
  return String(value || "").trim().toLowerCase();
}

function isMasterUser(user = {}) {
  const nivel = normalizeNivel(user.nivel || user.role);
  return nivel === "admin_master" || user.is_master === true || user.flags?.is_master === true;
}

function isAdminUser(user = {}) {
  const nivel = normalizeNivel(user.nivel || user.role);
  return isMasterUser(user) || nivel === "administrador" || user.is_admin === true || user.flags?.is_admin === true;
}

function getUserId(req) {
  const id = Number(req?.user?.uid ?? req?.user?.id ?? req?.user?.usuario_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function normalizeRole(value) {
  const role = String(value || "operador").trim().toLowerCase();
  return COMPANY_ROLES.includes(role) ? role : "operador";
}

function mergeSectors(customRows = []) {
  const byKey = new Map(USER_SECTORS.map((item) => [item.key, { ...item, default: true }]));
  for (const row of customRows || []) {
    const key = String(row?.setor || row?.key || "").trim().toLowerCase();
    if (!key) continue;
    if (row?.ativo === false) {
      byKey.delete(key);
      continue;
    }
    byKey.set(key, {
      key,
      label: String(row?.label || key).trim() || key,
      default: byKey.get(key)?.default === true,
      custom: true,
    });
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

async function listCompanySectors(empresaId) {
  const id = Number(empresaId);
  if (!Number.isFinite(id) || id <= 0) return [...USER_SECTORS];
  const { rows } = await db.query(
    `select setor, label, ativo
       from empresa_setores
      where empresa_id = $1
      order by label asc`,
    [id],
  );
  return mergeSectors(rows);
}

async function listUserSectors(empresaId, usuarioId) {
  const companyId = Number(empresaId);
  const userId = Number(usuarioId);
  if (!Number.isFinite(companyId) || companyId <= 0 || !Number.isFinite(userId) || userId <= 0) return [];
  const { rows } = await db.query(
    `select eus.setor, coalesce(es.label, initcap(replace(replace(eus.setor, '_', ' '), '-', ' '))) as label
       from empresa_usuario_setores eus
       left join empresa_setores es
         on es.empresa_id = eus.empresa_id
        and es.setor = eus.setor
      where eus.empresa_id = $1
        and eus.usuario_id = $2
        and coalesce(es.ativo, true) = true
      order by label asc`,
    [companyId, userId],
  );
  return rows.map((row) => ({ key: row.setor, label: row.label || row.setor }));
}

function normalizeSectors(values = [], allowedKeys = SECTOR_KEYS) {
  const list = Array.isArray(values) ? values : [];
  return [...new Set(list.map((value) => String(value || "").trim().toLowerCase()).filter((value) => allowedKeys.has(value)))];
}

function normalizeModules(values = []) {
  const list = Array.isArray(values) ? values : [];
  const rows = [];
  const seen = new Set();
  for (const item of list) {
    const key = String(item?.modulo_key || item?.key || "").trim().toLowerCase();
    if (!MODULE_KEYS.has(key) || seen.has(key)) continue;
    seen.add(key);
    const canAccess = item?.pode_acessar !== false;
    rows.push({
      modulo_key: key,
      pode_acessar: canAccess,
      pode_editar: canAccess ? item?.pode_editar === true : false,
    });
  }
  return rows;
}

async function userCompanyContext(userId, preferredEmpresaId = null) {
  const params = [userId];
  const filters = ["eu.usuario_id = $1"];
  if (Number.isFinite(Number(preferredEmpresaId)) && Number(preferredEmpresaId) > 0) {
    params.push(Number(preferredEmpresaId));
    filters.push(`eu.empresa_id = $${params.length}`);
  }
  const { rows } = await db.query(
    `select eu.empresa_id, eu.papel, e.nome as empresa_nome
       from empresa_usuarios eu
       join empresas e on e.id = eu.empresa_id
      where ${filters.join(" and ")}
      order by case eu.papel when 'owner' then 1 when 'admin' then 2 else 3 end, eu.criado_em asc
      limit 1`,
    params,
  );
  return rows[0] || null;
}

async function hasModuleAccess({ userId, empresaId, moduleKey, edit = false, defaultAllowIfUnconfigured = false } = {}) {
  const key = String(moduleKey || "").trim().toLowerCase();
  if (!userId || !empresaId || !MODULE_KEYS.has(key)) return false;
  const { rows } = await db.query(
    `select pode_acessar, pode_editar
       from empresa_usuario_modulos
      where empresa_id = $1
        and usuario_id = $2
        and modulo_key = $3
      limit 1`,
    [empresaId, userId, key],
  );
  if (!rows[0]) {
    if (!defaultAllowIfUnconfigured) return false;
    const configured = await db.query(
      `select 1
         from empresa_usuario_modulos
        where empresa_id = $1
          and usuario_id = $2
        limit 1`,
      [empresaId, userId],
    );
    return !configured.rows[0];
  }
  if (rows[0]?.pode_acessar !== true) return false;
  if (edit && rows[0]?.pode_editar !== true) return false;
  return true;
}

async function currentDbUser(userId) {
  if (!userId) return null;
  const { rows } = await db.query(
    `select id, nivel, status
       from usuarios
      where id = $1
      limit 1`,
    [userId],
  );
  return rows[0] || null;
}

async function isAdminUserFresh(req) {
  if (isAdminUser(req.user || {})) return true;
  const userId = getUserId(req);
  const user = await currentDbUser(userId);
  if (!user || normalizeNivel(user.status) !== "ativo") return false;
  return isAdminUser(user);
}

function deny(req, res, message = "Acesso negado.") {
  const accept = String(req.headers?.accept || "").toLowerCase();
  const isApi = String(req.path || req.originalUrl || "").startsWith("/api/");
  if (!isApi && req.method === "GET" && (accept.includes("text/html") || accept.includes("application/xhtml+xml"))) {
    const base = String(req.baseUrl || "").startsWith("/api") ? "" : String(req.baseUrl || "");
    return res.redirect(`${base}/nao-autorizado`);
  }
  return res.status(403).json({ ok: false, success: false, error: message });
}

function requireNivelAdmin() {
  return async (req, res, next) => {
    try {
      if (await isAdminUserFresh(req)) return next();
      return deny(req, res, "Acesso restrito a administradores.");
    } catch (error) {
      return next(error);
    }
  };
}

function requireModuleAccess(moduleKey, options = {}) {
  return async (req, res, next) => {
    try {
      if (await isAdminUserFresh(req)) return next();
      const userId = getUserId(req);
      const empresaId = Number(res.locals?.empresaId || req.body?.empresa_id || req.query?.empresa_id);
      if (await hasModuleAccess({
        userId,
        empresaId,
        moduleKey,
        edit: options.edit === true,
        defaultAllowIfUnconfigured: options.defaultAllowIfUnconfigured === true,
      })) return next();
      return deny(req, res, options.edit === true
        ? "Este usuario nao possui permissao de edicao neste modulo."
        : "Modulo nao liberado para este usuario.");
    } catch (error) {
      return next(error);
    }
  };
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Converte "/drafts/:id/credits/quote" em um teste exato do req.path.
function compilePathPattern(pattern) {
  const source = String(pattern || "/")
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : escapeRegExp(segment)))
    .join("/");
  const regex = new RegExp(`^${source}/?$`);
  return (pathname) => regex.test(String(pathname || "/"));
}

// Exige "Editar" do modulo em toda chamada que altera dados (POST, PUT,
// PATCH, DELETE). Consultas feitas via POST (cotacao, previa, analise,
// calculo) ficam em readOnlyPaths ou isReadRequest e nao exigem edicao.
// Usuarios sem nenhum modulo configurado seguem liberados, igual as paginas.
function requireEditForWrites(moduleKey, options = {}) {
  const readOnly = (options.readOnlyPaths || []).map(compilePathPattern);
  const isReadRequest = typeof options.isReadRequest === "function" ? options.isReadRequest : null;
  const overrides = (options.moduleByPath || []).map(([pattern, key]) => ({
    matches: compilePathPattern(pattern),
    key,
  }));
  const accessFactory = options.accessFactory || requireModuleAccess;
  const defaultAllowIfUnconfigured = options.defaultAllowIfUnconfigured !== false;
  const guards = new Map();
  const guardFor = (key) => {
    if (!guards.has(key)) {
      guards.set(key, accessFactory(key, { edit: true, defaultAllowIfUnconfigured }));
    }
    return guards.get(key);
  };

  return (req, res, next) => {
    if (!WRITE_METHODS.has(String(req.method || "").toUpperCase())) return next();
    const pathname = String(req.path || "/");
    if (readOnly.some((matches) => matches(pathname))) return next();
    if (isReadRequest && isReadRequest(req) === true) return next();
    const key = overrides.find((entry) => entry.matches(pathname))?.key || moduleKey;
    return guardFor(key)(req, res, next);
  };
}

// Usuario somente leitura: tem modulos configurados e nenhum com "Editar".
async function isReadOnlyCompanyUser(userId, empresaId = null) {
  if (!userId) return false;
  const params = [userId];
  let companyFilter = "";
  if (Number.isFinite(Number(empresaId)) && Number(empresaId) > 0) {
    params.push(Number(empresaId));
    companyFilter = " and empresa_id = $2";
  }
  const { rows } = await db.query(
    `select count(*)::int as total, coalesce(bool_or(pode_editar), false) as can_edit
       from empresa_usuario_modulos
      where usuario_id = $1${companyFilter}`,
    params,
  );
  const row = rows[0] || {};
  return Number(row.total) > 0 && row.can_edit !== true;
}

// Bloqueia operacoes fora do catalogo de modulos (ex.: vincular conta do
// Mercado Livre) para usuarios somente leitura.
function requireWriterUser(options = {}) {
  const readOnlyCheck = options.isReadOnlyCompanyUser || isReadOnlyCompanyUser;
  return async (req, res, next) => {
    try {
      if (await isAdminUserFresh(req)) return next();
      const readOnly = await readOnlyCheck(getUserId(req), res.locals?.empresaId);
      if (!readOnly) return next();
      return deny(req, res, "Usuario somente leitura nao pode executar esta operacao.");
    } catch (error) {
      return next(error);
    }
  };
}

async function listCompanyUsers(empresaId) {
  const { rows } = await db.query(
    `select
       u.id,
       u.nome,
       u.email,
       u.nivel,
       u.status,
       u.criado_em,
       u.ultimo_login_em,
       eu.papel,
       coalesce(
         jsonb_agg(distinct eus.setor) filter (
           where eus.setor is not null
             and not exists (
               select 1
                 from empresa_setores es_hidden
                where es_hidden.empresa_id = eus.empresa_id
                  and es_hidden.setor = eus.setor
                  and es_hidden.ativo = false
             )
         ),
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
     join usuarios u on u.id = eu.usuario_id
     left join empresa_usuario_setores eus
       on eus.empresa_id = eu.empresa_id
      and eus.usuario_id = eu.usuario_id
     left join empresa_usuario_modulos eum
       on eum.empresa_id = eu.empresa_id
      and eum.usuario_id = eu.usuario_id
     where eu.empresa_id = $1
     group by u.id, eu.papel
     order by case eu.papel when 'owner' then 1 when 'admin' then 2 else 3 end, u.nome nulls last, u.email`,
    [empresaId],
  );
  return rows;
}

// Acesso restrito grava TODO o catalogo (ausente = sem acesso). Assim
// desmarcar todos os modulos nunca vira acesso completo por engano.
function completeModuleRows(values = []) {
  const provided = new Map(normalizeModules(values).map((row) => [row.modulo_key, row]));
  return MODULES.map((item) => provided.get(item.key) || {
    modulo_key: item.key,
    pode_acessar: false,
    pode_editar: false,
  });
}

// acessoCompleto=true apaga as permissoes (acesso completo). Lista com
// modulos = acesso restrito. Lista vazia sem flag mantem o comportamento
// antigo (acesso completo) para telas abertas com o JavaScript anterior.
function resolveModuleRows(modulos, acessoCompleto) {
  if (acessoCompleto === true) return [];
  if (!Array.isArray(modulos) || modulos.length === 0) return [];
  return completeModuleRows(modulos);
}

async function updateCompanyUserAccess({ empresaId, usuarioId, papel, setores = [], modulos = [], acessoCompleto = false } = {}) {
  const targetId = Number(usuarioId);
  if (!Number.isFinite(targetId) || targetId <= 0) throw Object.assign(new Error("Usuario invalido."), { status: 400 });
  const role = normalizeRole(papel);
  const companySectors = await listCompanySectors(empresaId);
  const allowedSectorKeys = new Set(companySectors.map((item) => item.key));
  const sectorRows = normalizeSectors(setores, allowedSectorKeys);
  const moduleRows = resolveModuleRows(modulos, acessoCompleto);

  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const vinculo = await client.query(
        `select 1 from empresa_usuarios where empresa_id = $1 and usuario_id = $2 limit 1`,
        [empresaId, targetId],
      );
      if (!vinculo.rows[0]) throw Object.assign(new Error("Usuario nao pertence a esta empresa."), { status: 404 });

      await client.query(
        `update empresa_usuarios
            set papel = $3
          where empresa_id = $1
            and usuario_id = $2`,
        [empresaId, targetId, role],
      );

      await client.query(`delete from empresa_usuario_setores where empresa_id = $1 and usuario_id = $2`, [empresaId, targetId]);
      for (const setor of sectorRows) {
        await client.query(
          `insert into empresa_usuario_setores (empresa_id, usuario_id, setor, atualizado_em)
           values ($1, $2, $3, now())
           on conflict (empresa_id, usuario_id, setor) do update set atualizado_em = now()`,
          [empresaId, targetId, setor],
        );
      }

      await client.query(`delete from empresa_usuario_modulos where empresa_id = $1 and usuario_id = $2`, [empresaId, targetId]);
      for (const modulo of moduleRows) {
        await client.query(
          `insert into empresa_usuario_modulos
             (empresa_id, usuario_id, modulo_key, pode_acessar, pode_editar, atualizado_em)
           values ($1, $2, $3, $4, $5, now())
           on conflict (empresa_id, usuario_id, modulo_key) do update set
             pode_acessar = excluded.pode_acessar,
             pode_editar = excluded.pode_editar,
             atualizado_em = now()`,
          [empresaId, targetId, modulo.modulo_key, modulo.pode_acessar, modulo.pode_editar],
        );
      }

      await client.query("commit");
      return { success: true };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function createCompanySector({ empresaId, label } = {}) {
  const id = Number(empresaId);
  const cleanLabel = String(label || "").trim().replace(/\s+/g, " ");
  const key = slugifySector(cleanLabel);
  if (!Number.isFinite(id) || id <= 0) throw Object.assign(new Error("Empresa invalida."), { status: 400 });
  if (!cleanLabel || cleanLabel.length < 2) throw Object.assign(new Error("Informe um nome de setor valido."), { status: 400 });
  if (!key || key.length < 2) throw Object.assign(new Error("Nao foi possivel gerar o codigo do setor."), { status: 400 });

  const { rows } = await db.query(
    `insert into empresa_setores (empresa_id, setor, label, atualizado_em)
     values ($1, $2, $3, now())
     on conflict (empresa_id, setor) do update set
       label = excluded.label,
       ativo = true,
       atualizado_em = now()
     returning setor as key, label, true as custom`,
    [id, key, cleanLabel],
  );
  return rows[0];
}

async function updateCompanySector({ empresaId, setor, label } = {}) {
  const id = Number(empresaId);
  const key = String(setor || "").trim().toLowerCase();
  const cleanLabel = String(label || "").trim().replace(/\s+/g, " ");
  if (!Number.isFinite(id) || id <= 0) throw Object.assign(new Error("Empresa invalida."), { status: 400 });
  if (!key) throw Object.assign(new Error("Setor invalido."), { status: 400 });
  if (!cleanLabel || cleanLabel.length < 2) throw Object.assign(new Error("Informe um nome de setor valido."), { status: 400 });

  const { rows } = await db.query(
    `insert into empresa_setores (empresa_id, setor, label, atualizado_em)
     values ($1, $2, $3, now())
     on conflict (empresa_id, setor) do update set
       label = excluded.label,
       ativo = true,
       atualizado_em = now()
     returning setor as key, label, true as custom`,
    [id, key, cleanLabel],
  );
  return rows[0];
}

async function deleteCompanySector({ empresaId, setor } = {}) {
  const id = Number(empresaId);
  const key = String(setor || "").trim().toLowerCase();
  if (!Number.isFinite(id) || id <= 0) throw Object.assign(new Error("Empresa invalida."), { status: 400 });
  if (!key) throw Object.assign(new Error("Setor invalido."), { status: 400 });

  const available = await listCompanySectors(id);
  const current = available.find((item) => item.key === key);
  if (!current) throw Object.assign(new Error("Setor nao encontrado nesta empresa."), { status: 404 });

  const fallback = USER_SECTORS.find((item) => item.key === key);
  const label = current.label || fallback?.label || key;

  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const assigned = await client.query(
        `delete from empresa_usuario_setores
          where empresa_id = $1
            and setor = $2`,
        [id, key],
      );

      await client.query(
        `insert into empresa_setores (empresa_id, setor, label, ativo, atualizado_em)
         values ($1, $2, $3, false, now())
         on conflict (empresa_id, setor) do update set
           ativo = false,
           atualizado_em = now()`,
        [id, key, label],
      );

      await client.query("commit");
      return { success: true, removed_users: assigned.rowCount || 0 };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

module.exports = {
  COMPANY_ROLES,
  USER_SECTORS,
  MODULES,
  MODULE_KEYS,
  SECTOR_KEYS,
  slugifySector,
  listCompanySectors,
  listUserSectors,
  createCompanySector,
  updateCompanySector,
  deleteCompanySector,
  getUserId,
  isAdminUser,
  isMasterUser,
  requireNivelAdmin,
  requireModuleAccess,
  hasModuleAccess,
  requireEditForWrites,
  requireWriterUser,
  isReadOnlyCompanyUser,
  currentDbUser,
  isAdminUserFresh,
  userCompanyContext,
  listCompanyUsers,
  updateCompanyUserAccess,
  resolveModuleRows,
};
