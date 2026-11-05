"use strict";

const userAccessRepository = require("../repositories/userAccessRepository");

// Catalogo de modulos da Magalu, alinhado ao menu lateral. Cada pagina de
// operacao tem uma chave; Visao geral e Conta ficam fora (Conta e de admin).
const MODULES = Object.freeze([
  { key: "magalu.pedidos", label: "Pedidos Magalu", group: "Pedidos", path: "/pedidos" },
  { key: "magalu.operacoes.catalogo", label: "Gestão de catálogo", group: "Operações", path: "/gestao-skus" },
  { key: "magalu.operacoes.estoque", label: "Estoque", group: "Operações", path: "/estoque" },
  { key: "magalu.operacoes.precos", label: "Preços", group: "Operações", path: "/precos" },
  { key: "magalu.promocoes.campanhas", label: "Campanhas", group: "Promoções", path: "/promocoes" },
  { key: "magalu.precificacao.margem", label: "Margem de venda", group: "Precificação", path: "/margem" },
  { key: "magalu.precificacao.calculadora", label: "Calculadora", group: "Precificação", path: "/calculadora" },
]);
const MODULE_KEYS = new Set(MODULES.map((item) => item.key));
const MODULE_BY_PATH = new Map(MODULES.map((item) => [item.path, item.key]));

// Telas da secao Conta restritas a administrador (Ajuda fica aberta a todos).
const ADMIN_PAGES = new Set(["/contas", "/usuarios", "/plano", "/integracoes"]);

// Administrador = papel "admin" da empresa no Hub, ou Master da plataforma.
// Owner e operador seguem as caixas Acessar/Editar.
const ADMIN_COMPANY_ROLES = new Set(["admin", "administrador"]);
const MASTER_HUB_REASONS = new Set(["platform_admin", "platform_module_master"]);

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SEEN_TTL_MS = 5 * 60 * 1000;
const seenCache = new Map();

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function isAdmin(req) {
  if (ADMIN_COMPANY_ROLES.has(normalizeRole(req?.magaluIdentity?.companyRole))) return true;
  const reason = normalizeRole(req?.magaluHubAccess?.reason);
  return MASTER_HUB_REASONS.has(reason);
}

function deniedError(message, code = "magalu_permission_denied") {
  const error = new Error(message);
  error.status = 403;
  error.statusCode = 403;
  error.code = code;
  return error;
}

// Linhas de permissao do usuario, carregadas uma vez por requisicao.
async function moduleRowsFor(req) {
  if (!req.magaluAccessRows) {
    const identity = req.magaluIdentity || {};
    req.magaluAccessRows = await userAccessRepository.listModuleRows(identity.dachTenantId, identity.dachUserId);
  }
  return req.magaluAccessRows;
}

// Mesma semantica do ML: admin passa; sem configuracao = acesso completo;
// com configuracao, valem Acessar e Editar de cada modulo.
async function hasModuleAccess(req, moduleKey, { edit = false } = {}) {
  if (isAdmin(req)) return true;
  if (!MODULE_KEYS.has(moduleKey)) return false;
  const rows = await moduleRowsFor(req);
  if (!rows.length) return true;
  const row = rows.find((item) => item.module_key === moduleKey);
  if (!row || row.can_access !== true) return false;
  return edit ? row.can_edit === true : true;
}

async function isReadOnlyUser(req) {
  if (isAdmin(req)) return false;
  const rows = await moduleRowsFor(req);
  return rows.length > 0 && !rows.some((row) => row.can_edit === true);
}

async function assertModuleEdit(req, moduleKey) {
  if (await hasModuleAccess(req, moduleKey, { edit: true })) return;
  throw deniedError("Este usuário não possui permissão de edição neste módulo.", "magalu_edit_denied");
}

function denyJson(res, message, code) {
  return res.status(403).json({ ok: false, error: code, message });
}

function compilePathPattern(pattern) {
  const source = String(pattern || "/")
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  const regex = new RegExp(`^${source}/?$`);
  return (pathname) => regex.test(String(pathname || "/"));
}

// Exige "Editar" nas escritas (POST/PUT/PATCH/DELETE) do modulo. Consultas
// feitas via POST ficam em readOnlyPaths. moduleKey pode ser uma funcao do
// req quando o mesmo endpoint serve dois modulos (ex.: preco x estoque).
function requireEditForWrites(moduleKey, options = {}) {
  const readOnly = (options.readOnlyPaths || []).map(compilePathPattern);
  return async (req, res, next) => {
    try {
      if (!WRITE_METHODS.has(String(req.method || "").toUpperCase())) return next();
      if (readOnly.some((matches) => matches(req.path))) return next();
      const key = typeof moduleKey === "function" ? moduleKey(req) : moduleKey;
      if (!key) return next();
      if (await hasModuleAccess(req, key, { edit: true })) return next();
      return denyJson(res, "Este usuário não possui permissão de edição neste módulo.", "magalu_edit_denied");
    } catch (error) {
      return next(error);
    }
  };
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return denyJson(res, "Acesso restrito a administradores da empresa.", "magalu_admin_required");
}

// Vincular/reconectar organizacao: admin ou usuario sem restricoes, para o
// primeiro vinculo de uma empresa nova nao travar.
async function requireAccountLinker(req, res, next) {
  try {
    if (isAdmin(req)) return next();
    const rows = await moduleRowsFor(req);
    if (!rows.length) return next();
    const message = "Somente administradores podem vincular organizações Magalu.";
    // Sem redirect: o painel sem conta vinculada manda para /auth/start, e
    // voltar ao painel criaria um loop para o usuario restrito.
    if (String(req.headers?.accept || "").includes("text/html")) {
      return res.status(403).type("html").send(
        `<!doctype html><meta charset="utf-8"><title>Acesso restrito</title>` +
        `<p style="font-family:sans-serif;margin:40px">${message} Peça ao administrador da empresa para vincular a organização.</p>` +
        `<p style="font-family:sans-serif;margin:0 40px"><a href="/selecao-plataforma">Voltar aos módulos</a></p>`,
      );
    }
    return denyJson(res, message, "magalu_admin_required");
  } catch (error) {
    return next(error);
  }
}

// Decide se a pagina SPA pode abrir para este usuario.
async function canOpenPage(req, path) {
  if (ADMIN_PAGES.has(path)) return isAdmin(req);
  const moduleKey = MODULE_BY_PATH.get(path);
  if (!moduleKey) return true;
  return hasModuleAccess(req, moduleKey);
}

// Mapa de permissoes do usuario atual, para a interface.
async function viewerPermissions(req) {
  const admin = isAdmin(req);
  const rows = admin ? [] : await moduleRowsFor(req);
  const restricted = !admin && rows.length > 0;
  const modules = {};
  for (const item of MODULES) {
    const row = rows.find((entry) => entry.module_key === item.key);
    modules[item.key] = {
      access: !restricted || row?.can_access === true,
      edit: !restricted || row?.can_edit === true,
    };
  }
  const pages = {};
  for (const path of ["/contas", "/usuarios", "/plano", "/integracoes"]) pages[path] = admin;
  for (const item of MODULES) pages[item.path] = modules[item.key].access;
  return {
    is_admin: admin,
    company_role: normalizeRole(req?.magaluIdentity?.companyRole) || null,
    restricted,
    modules,
    pages,
  };
}

// Registra quem entrou no modulo (lista da tela Usuarios). Nunca bloqueia.
async function recordSeenUser(identity) {
  const key = `${identity?.dachTenantId}:${identity?.dachUserId}:${identity?.companyRole || ""}`;
  if (!identity?.dachTenantId || !identity?.dachUserId) return;
  const last = seenCache.get(key);
  if (last && Date.now() - last < SEEN_TTL_MS) return;
  seenCache.set(key, Date.now());
  try {
    await userAccessRepository.upsertSeenUser({
      tenantId: identity.dachTenantId,
      userId: identity.dachUserId,
      email: identity.email,
      name: identity.name,
      companyRole: normalizeRole(identity.companyRole) || null,
    });
  } catch (error) {
    seenCache.delete(key);
    console.warn("[seller-magalu:users] falha ao registrar acesso", error?.message || error);
  }
}

function normalizeModulePayload(values = []) {
  const byKey = new Map();
  for (const item of Array.isArray(values) ? values : []) {
    const key = String(item?.module_key || item?.key || "").trim().toLowerCase();
    if (!MODULE_KEYS.has(key)) continue;
    const canAccess = item?.can_access === true;
    byKey.set(key, { module_key: key, can_access: canAccess, can_edit: canAccess && item?.can_edit === true });
  }
  // Todo modulo do catalogo e gravado; ausente = sem acesso. Assim "nenhum
  // modulo" nunca vira acesso completo por engano.
  return MODULES.map((item) => byKey.get(item.key) || { module_key: item.key, can_access: false, can_edit: false });
}

function serializeUser(row) {
  const admin = ADMIN_COMPANY_ROLES.has(normalizeRole(row.company_role));
  const modules = Array.isArray(row.modules) ? row.modules : [];
  return {
    user_id: row.dach_user_id,
    email: row.email,
    name: row.name || row.email,
    company_role: normalizeRole(row.company_role) || null,
    is_admin: admin,
    access_mode: admin ? "admin" : modules.length ? "restricted" : "full",
    modules: modules.map((item) => ({
      module_key: item.module_key,
      can_access: item.can_access === true,
      can_edit: item.can_edit === true,
    })),
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
  };
}

module.exports = {
  MODULES,
  MODULE_KEYS,
  ADMIN_PAGES,
  isAdmin,
  hasModuleAccess,
  isReadOnlyUser,
  assertModuleEdit,
  requireEditForWrites,
  requireAdmin,
  requireAccountLinker,
  canOpenPage,
  viewerPermissions,
  recordSeenUser,
  normalizeModulePayload,
  serializeUser,
  _test: { compilePathPattern, seenCache },
};
