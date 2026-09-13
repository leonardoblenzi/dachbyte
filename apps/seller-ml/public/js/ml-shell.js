"use strict";

(() => {
  window.__ML_NATIVE_ALERTS_FILTER__ = true;
  const STORAGE_COLLAPSED = "ml:shell:collapsed";
  const STORAGE_GROUPS = "ml:shell:groups";
  const STORAGE_ALERTS_VIEW = "ml-shell-alerts-view";
  const STORAGE_ALERTS_READ = "ml-shell-alerts-read-cache";
  const THEME_KEY = "ml_theme_mode";
  const ALERTS_READ_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;
  const ALERTS_READ_MAX_ENTRIES = 240;

  const ICONS = {
    grid:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/></svg>',
    home:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M9 20v-6h6v6"/></svg>',
    megaphone:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1Z"/><path d="M14 8.5a6 6 0 0 1 0 7"/><path d="M16.5 6a10 10 0 0 1 0 12"/></svg>',
    chart:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M7 16V9"/><path d="M12 16V5"/><path d="M17 16v-3"/></svg>',
    shield:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 5 6v6c0 4.5 2.9 7.9 7 9 4.1-1.1 7-4.5 7-9V6l-7-3Z"/><path d="m9.5 12 1.8 1.8 3.2-3.6"/></svg>',
    box:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="M12 12 4 7.5"/><path d="M12 12l8-4.5"/><path d="M12 12v9"/></svg>',
    edit:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/></svg>',
    trash:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
    layers:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 4.5-9 4.5-9-4.5L12 3Z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/></svg>',
    ruler:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m3 16.5 9.5-9.5L17 11.5 7.5 21 3 16.5Z"/><path d="M8 12l1.5 1.5"/><path d="M11 9l1.5 1.5"/><path d="M14 6l1.5 1.5"/></svg>',
    clock:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    sparkles:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z"/><path d="m5 17 .8 2.2L8 20l-2.2.8L5 23l-.8-2.2L2 20l2.2-.8L5 17Z"/><path d="m19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14Z"/></svg>',
    ticket:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5A2.5 2.5 0 0 0 5.5 12 2.5 2.5 0 0 0 3 14.5V18h18v-3.5a2.5 2.5 0 0 0-2.5-2.5A2.5 2.5 0 0 0 21 9.5V6H3v3.5Z"/><path d="M12 6v12"/><path d="M12 9.5v.01"/><path d="M12 14.5v.01"/></svg>',
    search:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    brain:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 4a3 3 0 0 0-3 3v.4A3.2 3.2 0 0 0 4 10.5 3 3 0 0 0 5.7 16 3.5 3.5 0 0 0 9 19.5h.5"/><path d="M14.5 4a3 3 0 0 1 3 3v.4a3.2 3.2 0 0 1 2.5 3.1A3 3 0 0 1 18.3 16 3.5 3.5 0 0 1 15 19.5h-.5"/><path d="M12 4v16"/><path d="M9.5 9.5H12"/><path d="M12 14.5h2.5"/></svg>',
    user:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21a8 8 0 1 0-16 0"/><circle cx="12" cy="8" r="4"/></svg>',
    building:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 10h.01"/><path d="M15 10h.01"/><path d="M9 14h.01"/><path d="M15 14h.01"/><path d="M12 21v-4"/></svg>',
    link:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 1 0-7l1-1a5 5 0 0 1 7 7l-1 1"/><path d="M14 11a5 5 0 0 1 0 7l-1 1a5 5 0 0 1-7-7l1-1"/></svg>',
    key:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M12 15h9"/><path d="M18 12v6"/><path d="M21 12v6"/></svg>',
    route:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h4a4 4 0 0 0 4-4V7"/></svg>',
    database:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7"/></svg>',
    archive:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18"/><path d="M5 7v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7"/><path d="M9 12h6"/><path d="M4 4h16v3H4z"/></svg>',
    wallet:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14V7Z"/><path d="M18 13h2v4h-2a2 2 0 1 1 0-4Z"/><path d="M16 7V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v2"/></svg>',
    operations:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l1 2h3v14H5V6h3l1-2Z"/><path d="M9 12l2 2 4-4"/><path d="M8 17h8"/></svg>',
    bell:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 0 0-5-5.9V4a1 1 0 1 0-2 0v1.1A6 6 0 0 0 6 11v3.2c0 .5-.2 1-.6 1.4L4 17h5"></path><path d="M9 17a3 3 0 0 0 6 0"></path></svg>',
    trendUp:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M9 7h8v8"/></svg>',
    trendDown:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 7 10 10"/><path d="M17 9v8H9"/></svg>',
    minus:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h12"/></svg>',
    warning:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.95" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 3.7 18a1.4 1.4 0 0 0 1.2 2h14.2a1.4 1.4 0 0 0 1.2-2L12 4Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    help:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 1 1 5 2.2c-.9.7-1.6 1.2-1.6 2.8"/><path d="M12 17h.01"/></svg>',
    menu:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg>',
    chevron:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
    logout:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M20 4v16"/></svg>',
  };

  const NAV_GROUPS = [
    {
      id: "overview",
      label: "Visão geral",
      hint: "Painel e novidades",
      icon: "grid",
      items: [
        { id: "painel", label: "Painel", path: "/painel", icon: "grid" },
        { id: "projecao-mensal", label: "Projeção Mensal", path: "/projecao-mensal", aliases: ["/dashboard"], icon: "home" },
        { id: "reputacao", label: "Reputação", path: "/reputacao", icon: "shield", badge: "BETA" },
      ],
    },
    {
      id: "ads",
      label: "Anúncios",
      hint: "Catálogo e monitoramento",
      icon: "box",
      items: [
        { id: "consulta-anuncios", label: "Consulta de anúncios", path: "/filtro-anuncios", icon: "search" },
        { id: "cadastro-anuncios", label: "Cadastro", path: "/anuncios/cadastro", icon: "edit" },
        { id: "estoque-alerta", label: "Estoque", path: "/estoque", icon: "warning", badge: "BETA" },
        { id: "ranking-anuncios", label: "Ranking", path: "/ranking-anuncios", icon: "chart" },
        { id: "full", label: "Full", path: "/full", icon: "box", badge: "BETA" },
        { id: "estrategicos", label: "Estratégicos", path: "/estrategicos", icon: "brain", badge: "BETA" },
      ],
    },
    {
      id: "operations",
      label: "Operações",
      hint: "Execução, cadastro e lote",
      icon: "operations",
      items: [
        { id: "excluir-massa", label: "Gestão de anúncios", path: "/gestao-anuncios", icon: "edit" },
        { id: "modelo-massa", label: "Modelo em massa", path: "/modelo-massa", icon: "layers" },
        { id: "caracteristicas", label: "Características", path: "/caracteristicas", icon: "edit", badge: "BETA" },
        { id: "validar-dimensoes", label: "Validar dimensões", path: "/validar-dimensoes", icon: "ruler" },
        { id: "prazo-producao", label: "Prazo de produção", path: "/prazo", icon: "clock" },
        { id: "atacado", label: "Atacado", path: "/atacado", icon: "ticket" },
      ],
    },
    {
      id: "advertising",
      label: "Publicidade",
      hint: "Campanhas e ROAS",
      icon: "megaphone",
      items: [
        { id: "publicidade", label: "Product Ads", path: "/publicidade/product-ads", aliases: ["/publicidade"], prefixes: ["/publicidade/product-ads/campanhas/", "/publicidade/campanha/"], icon: "megaphone" },
      ],
    },
    {
      id: "promos",
      label: "Promoções",
      hint: "Campanhas e descontos",
      icon: "ticket",
      items: [
        { id: "central-promocoes", label: "Criar promoções", path: "/criar-promocao", icon: "ticket" },
        { id: "remover-promocoes", label: "Remover promoções", path: "/remover-promocao", icon: "trash" },
      ],
    },
    {
      id: "pricing",
      label: "Precificação",
      hint: "Custos, margem e preço",
      icon: "wallet",
      items: [
        { id: "financeiro-custos-ml", label: "Custos por SKU", path: "/financeiro/custos-mercado-livre", icon: "wallet" },
        { id: "financeiro-margem-ml", label: "Margem de venda", path: "/financeiro/margem-venda-mercado-livre", icon: "chart" },
      ],
    },
    {
      id: "analytics",
      label: "Inteligência",
      hint: "Curvas e mercado",
      icon: "chart",
      items: [
        { id: "curva-abc", label: "Curva ABC", path: "/ia-analytics/curva-abc", icon: "chart" },
        { id: "analise-mercado", label: "Análise Mercado", path: "/analise-mercado", icon: "trendUp" },
      ],
    },
    {
      id: "fiscal",
      label: "Pedidos",
      hint: "Comercial e logística",
      icon: "operations",
      items: [
        { id: "logistica", label: "Logistica", path: "/logistica", aliases: ["/fiscal/vendas"], icon: "chart", badge: "BETA" },
      ],
    },
    {
      id: "account",
      label: "Conta",
      hint: "Acesso e integrações",
      icon: "user",
      items: [
        { id: "conta-contas", label: "Contas vinculadas", path: "/conta/contas", icon: "route" },
        { id: "conta-usuarios", label: "Usuários", path: "/conta/usuarios", icon: "user" },
        { id: "conta-integracoes", label: "Integrações", path: "/conta/integracoes", icon: "link" },
        { id: "conta-creditos", label: "Plano e créditos", path: "/conta/creditos", icon: "wallet" },
        { id: "conta-automacoes", label: "Automações", path: "/conta/automacoes", icon: "clock" },
        { id: "ajuda", label: "Ajuda e contato", path: "/ajuda", icon: "help" },
      ],
    },
    {
      id: "admin",
      label: "Administração",
      hint: "Governança e suporte",
      icon: "building",
      requiresAdmin: true,
      items: [
        { id: "admin-dashboard", label: "Painel master", path: "/admin/dashboard", icon: "chart" },
        { id: "admin-selecionar-conta", label: "Selecao global", path: "/select-conta", icon: "route" },
        { id: "admin-usuarios", label: "Usuários", path: "/admin/usuarios", icon: "user" },
        { id: "admin-empresas", label: "Empresas", path: "/admin/empresas", icon: "building" },
        { id: "admin-vinculos", label: "Vínculos", path: "/admin/vinculos", icon: "link" },
        { id: "admin-contas-ml", label: "Contas ML", path: "/admin/contas-ml", aliases: ["/admin/meli-contas"], icon: "route" },
        { id: "admin-relatorios-ml", label: "Relatorios", path: "/admin/relatorios-ml", icon: "chart" },
        { id: "admin-tokens-ml", label: "Tokens ML", path: "/admin/tokens-ml", aliases: ["/admin/meli-tokens"], icon: "key" },
        { id: "admin-oauth-states", label: "OAuth States", path: "/admin/oauth-states", icon: "route" },
        { id: "admin-migracoes", label: "Migrações", path: "/admin/migracoes", icon: "database" },
        { id: "admin-auditoria", label: "Auditoria", path: "/admin/auditoria", icon: "shield" },
        { id: "admin-patch-notes", label: "Patch Notes", path: "/admin/patch-notes", icon: "edit" },
        { id: "admin-jobs", label: "Automações", path: "/admin/jobs", icon: "clock" },
        { id: "admin-backup", label: "Backup", path: "/admin/backup", icon: "archive" },
      ],
    },
  ];

  const SHELL_DISABLED_PATHS = [
    "/",
    "/login",
    "/cadastro",
    "/ativar",
    "/esqueci-senha",
    "/redefinir-senha",
    "/selecao-plataforma",
    "/vincular-conta",
    "/nao-autorizado",
  ];

  function getCurrentPath() {
    const pathname = String(window.location.pathname || "/");
    const base = String(window.ML?.base || window.__ML_BASE__ || "");
    if (base && pathname.startsWith(base)) {
      const sliced = pathname.slice(base.length);
      return sliced || "/";
    }
    return pathname || "/";
  }

  function normalizePath(path) {
    return String(path || "/").replace(/\/+$/, "") || "/";
  }

  function isShellDisabledPath(pathname) {
    const normalized = normalizePath(pathname);
    return SHELL_DISABLED_PATHS.some((path) => normalizePath(path) === normalized);
  }

  function isAdminPath(path) {
    const normalized = normalizePath(path);
    return normalized === "/select-conta" || normalized === "/admin" || normalized.startsWith("/admin/");
  }

  function pathMatches(current, item) {
    const normalizedCurrent = normalizePath(current);
    const allPaths = [item.path].concat(item.aliases || []);
    if (allPaths.some((candidate) => normalizedCurrent === normalizePath(candidate))) return true;
    const prefixes = item.prefixes || [];
    return prefixes.some((prefix) => normalizedCurrent.startsWith(normalizePath(prefix)));
  }

  function getCurrentMeta(pathname) {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (pathMatches(pathname, item)) {
          return { group, item };
        }
      }
    }
    return null;
  }

  function shouldEnhance(pathname) {
    if (window.__ML_DISABLE_SHELL__) return false;
    if (document.body?.dataset?.mlShell === "off") return false;
    if (document.body?.classList?.contains("auth-page")) return false;
    if (isShellDisabledPath(pathname)) return false;
    const hasLegacyLayout =
      document.querySelector(".account-bar") ||
      document.querySelector(".main-nav") ||
      document.querySelector(".admin-layout");
    if (hasLegacyLayout) return true;
    return !!getCurrentMeta(pathname);
  }

  function readState(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeState(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  function normalizeGroupState(groupState = {}, activeGroupId = "") {
    const visibleGroupIds = new Set(
      NAV_GROUPS
        .filter((group) => !group.requiresAdmin || isAdminPath(getCurrentPath()))
        .map((group) => group.id),
    );
    const preferred =
      activeGroupId ||
      Object.keys(groupState).find((groupId) => groupState[groupId] && visibleGroupIds.has(groupId)) ||
      (isAdminPath(getCurrentPath()) ? "admin" : "overview");

    return NAV_GROUPS.reduce((acc, group) => {
      acc[group.id] = group.id === preferred;
      return acc;
    }, {});
  }

  function makeIcon(name) {
    return ICONS[name] || ICONS.home;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .toLowerCase();
  }

  function getContentNodes() {
    const children = Array.from(document.body.children);
    const nodes = [];

    for (const child of children) {
      if (child.tagName === "SCRIPT" || child.classList.contains("ml-shell")) continue;
      if (child.matches(".account-bar, .main-nav")) continue;

      nodes.push(child);
    }

    return nodes;
  }

  function renderSidebar(currentMeta, groupState) {
    const pathname = getCurrentPath();
    const adminContext = isAdminPath(pathname);
    const visibleGroups = isAdminPath(pathname)
      ? NAV_GROUPS.filter((group) => group.id === "admin")
      : NAV_GROUPS.filter((group) => group.id !== "admin");
    const navMarkup = visibleGroups.map((group) => {
      const activeChild = group.items.find((item) => pathMatches(pathname, item));
      const expanded = groupState[group.id] ?? !!activeChild ?? group.id === "overview";
      const children = group.items
        .map((item) => {
          const active = pathMatches(pathname, item);
          const badge = item.badge
            ? `<span class="ml-shell__item-badge">${escapeHtml(item.badge)}</span>`
            : "";
          return `
            <a class="ml-shell__link ml-shell__child-link ${active ? "is-active" : ""}" href="${window.mlUrl(item.path)}" data-nav-item="${item.id}">
              <span class="ml-shell__label">${escapeHtml(item.label)}</span>
              ${badge}
            </a>
          `;
        })
        .join("");

      return `
        <section class="ml-shell__group sidebar-category ${activeChild ? "is-active-category" : ""} ${expanded ? "is-open" : ""}" data-group="${group.id}" ${group.requiresAdmin ? 'data-requires-admin="true" hidden' : ""}>
          <button class="ml-shell__group-button sidebar-category__toggle" type="button" aria-expanded="${expanded ? "true" : "false"}" data-group-toggle="${group.id}">
            <span class="ml-shell__icon sidebar-category__icon">${makeIcon(group.icon)}</span>
            <span class="ml-shell__label-wrap sidebar-category__meta">
              <strong class="ml-shell__label">${escapeHtml(group.label)}</strong>
              <small>${escapeHtml(group.hint || "")}</small>
            </span>
            <span class="ml-shell__arrow sidebar-category__chevron">${makeIcon("chevron")}</span>
          </button>
          <div class="ml-shell__children sidebar-category__body" ${expanded ? "" : "hidden"}>
            <div class="sidebar-category__inner">
              ${children}
            </div>
          </div>
        </section>
      `;
    }).join("");
    const brandHref = isAdminPath(pathname)
      ? window.mlUrl("/admin/dashboard")
      : window.mlUrl("/painel");
    const adminFooter = isAdminPath(pathname)
      ? `
          <button class="ml-shell__admin-logout" id="admin-logout" type="button">
            <span class="ml-shell__icon">${makeIcon("logout")}</span>
            <span class="ml-shell__label">Sair</span>
          </button>
        `
      : "";
    const accountMarkup = adminContext
      ? ""
      : `
          <div class="ml-shell__account-wrap ml-shell__account-wrap--sidebar" id="shell-account">
            <button class="ml-shell__account-pill ml-shell__account-pill--sidebar" id="account-menu-toggle" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="shell-account-menu">
              <span class="ml-shell__account-name" id="account-current">Carregando...</span>
              <span class="ml-shell__account-chevron" aria-hidden="true">⌄</span>
            </button>
            <section class="ml-shell__account-menu ml-shell__account-menu--sidebar" id="shell-account-menu" hidden aria-label="Contas">
              <div class="ml-shell__account-menu-label">Contas</div>
              <div class="ml-shell__account-list" id="shell-account-list">
                <div class="ml-shell__account-empty">Carregando contas...</div>
              </div>
            </section>
          </div>
        `;

    return `
      <aside class="ml-shell__sidebar" aria-label="Navegação principal">
        <div class="ml-shell__sidebar-inner">
          <div class="ml-shell__sidebar-toolbar">
            <button class="ml-shell__sidebar-toggle" type="button" data-shell-toggle aria-label="Recolher ou expandir menu lateral">
              ${makeIcon("chevron")}
            </button>
          </div>
          <div class="ml-shell__sidebar-head">
            <a class="ml-shell__brand" href="${brandHref}">
              <span class="ml-shell__brand-logo">
                <img src="/brand/dachbyte/seller/mark-transparent.png" alt="DACHBYTE Seller" />
              </span>
              <span class="ml-shell__brand-copy">
                <span class="ml-shell__brand-name">DACHBYTE</span>
                <span class="ml-shell__brand-sub">Seller · Mercado Livre</span>
              </span>
            </a>
          </div>
          ${accountMarkup}
          <div class="ml-shell__sidebar-title">Categorias</div>
          <nav class="ml-shell__nav">
            ${navMarkup}
          </nav>
          <div class="ml-shell__sidebar-foot">
            <div class="ml-shell__sidebar-note">Operação, catálogo, promoções e inteligência em um único fluxo.</div>
            ${adminFooter}
          </div>
        </div>
      </aside>
    `;
  }

  function renderTopbar(currentMeta) {
    const itemIcon = currentMeta?.item?.icon || currentMeta?.group?.icon || "grid";
    const eyebrow = currentMeta?.group?.label || "Mercado Livre";
    const title = currentMeta?.item?.label || "Painel";

    return `
      <header class="ml-shell__topbar">
        <div class="ml-shell__topbar-left">
          <button class="ml-shell__desktop-toggle" type="button" data-shell-toggle aria-label="Recolher ou expandir menu lateral">
            ${makeIcon("menu")}
          </button>
          <button class="ml-shell__mobile-toggle" type="button" data-shell-mobile-open aria-label="Abrir menu lateral">
            ${makeIcon("menu")}
          </button>
          <div class="ml-shell__page-context">
            <div class="ml-shell__breadcrumb">
              <span class="ml-shell__page-icon" aria-hidden="true">${makeIcon(itemIcon)}</span>
              <span>${escapeHtml(eyebrow)}</span>
            </div>
            <h1 class="ml-shell__page-title">${escapeHtml(title)}</h1>
          </div>
        </div>
        <div class="ml-shell__topbar-right">
          <button class="ml-shell__credits-btn is-loading" id="btn-credits-wallet" type="button" title="Ver plano e tokens">
            <span class="ml-shell__credits-dot"></span>
            <span class="ml-shell__credits-copy">
              <span class="ml-shell__credits-label">Tokens</span>
              <strong class="ml-shell__credits-value" id="shell-credits-value">...</strong>
            </span>
          </button>
          <button class="ml-shell__theme-btn" id="btn-theme-toggle" type="button">
            Dark Mode
          </button>
          <button class="ml-shell__status-btn is-operational" id="btn-status" type="button" title="Ver status da integração">
            <span class="ml-shell__status-dot"></span>
            <span class="ml-shell__status-label">Operacional</span>
          </button>
          <div class="ml-shell__alerts-wrap" id="shell-alerts">
            <button class="ml-shell__icon-btn" id="btn-alerts" type="button" title="Alertas e lembretes" aria-label="Alertas e lembretes" aria-expanded="false" aria-controls="shell-alerts-panel">
              ${makeIcon("bell")}
              <span class="ml-shell__icon-btn-badge" id="shell-alerts-badge" aria-hidden="true" hidden></span>
            </button>
            <section class="ml-shell__alerts-panel" id="shell-alerts-panel" hidden aria-label="Notificações">
              <div class="ml-shell__alerts-head">
                <div>
                  <strong class="ml-shell__alerts-title">Notificações</strong>
                  <div class="ml-shell__alerts-subtitle" id="shell-alerts-subtitle" hidden></div>
                </div>
                <div class="ml-shell__alerts-actions">
                  <div class="ml-shell__alerts-switch" role="group" aria-label="Filtro de notificações">
                    <button class="ml-shell__alerts-switch-btn" id="shell-alerts-mode-today" type="button" data-alerts-mode="today">Hoje</button>
                    <button class="ml-shell__alerts-switch-btn" id="shell-alerts-mode-history" type="button" data-alerts-mode="history">Histórico</button>
                  </div>
                  <button class="ml-shell__alerts-refresh" id="shell-alerts-refresh" type="button">Atualizar</button>
                </div>
              </div>
              <div class="ml-shell__alerts-body" id="shell-alerts-body">
                <div class="ml-shell__alerts-empty">Carregando alertas...</div>
              </div>
            </section>
          </div>
          <button class="ml-shell__icon-btn" id="btn-help" type="button" title="Ajuda e contato" aria-label="Ajuda e contato">
            <span class="ml-shell__help-glyph" aria-hidden="true">?</span>
          </button>
          <button class="ml-shell__logout-btn" id="btn-logout-account" type="button">
            Sair
          </button>
        </div>
      </header>
    `;
  }
  function applyAdminVisibility() {
    const adminGroups = document.querySelectorAll('[data-requires-admin="true"]');
    if (!adminGroups.length) return;
    if (!isAdminPath(getCurrentPath())) {
      adminGroups.forEach((node) => {
        node.hidden = true;
      });
      return;
    }

    window.fetch(window.mlUrl("/api/auth/me"), {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json" },
    })
      .then((response) => response.json())
      .then((payload) => {
        const show = payload?.flags?.is_master === true || payload?.is_master === true;
        adminGroups.forEach((node) => {
          node.hidden = !show;
        });
      })
      .catch(() => {
        adminGroups.forEach((node) => {
          node.hidden = true;
        });
      });
  }

  function accountInitials(label) {
    const words = String(label || "")
      .replace(/[•·|]/g, " ")
      .split(/\s+/)
      .map((word) => word.trim())
      .filter(Boolean);
    const initials = words.slice(0, 2).map((word) => word[0]).join("");
    return (initials || "ML").slice(0, 2).toUpperCase();
  }

  function accountLabelFromRow(row = {}) {
    return row.apelido || row.label || row.nickname || row.meli_user_id || "Conta Mercado Livre";
  }

  function accountSubtitleFromRow(row = {}) {
    const parts = [];
    if (row.empresa_nome) parts.push(row.empresa_nome);
    if (row.meli_user_id) parts.push(`ML ${row.meli_user_id}`);
    return parts.join(" • ") || row.site_id || "Mercado Livre";
  }

  function accountBillingFromRow(row = {}) {
    const billing = row.billing || {};
    return {
      label: billing.label || row.billing_status || "Status indefinido",
      tone: billing.tone || "neutral",
      canOperate: billing.can_operate !== false,
      renewalUrl: billing.renewal_checkout_url || row.renewal_checkout_url || "",
      isUnlimited: billing.is_unlimited === true || row.usage_policy === "unlimited",
    };
  }

  function accountBillingToneClass(tone) {
    if (tone === "ok" || tone === "success") return "is-ok";
    if (tone === "warn" || tone === "warning") return "is-warn";
    if (tone === "danger" || tone === "error") return "is-danger";
    return "is-neutral";
  }

  function accountPinIcon(isDefault) {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M14 4.5 19.5 10l-2.8 2.8 1.4 4.1-1.4 1.4-4.2-4.2-4.8 4.8-1.4-1.4 4.8-4.8-4.1-4.1L8.9 6l4.1 1.4L14 4.5Z" fill="${isDefault ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"></path>
        <path d="M7.2 16.8 4.2 19.8" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    `;
  }

  function ensureDefaultAccountModal() {
    let modal = document.getElementById("shell-default-account-modal");
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = "shell-default-account-modal";
    modal.className = "ml-shell__confirm-modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="ml-shell__confirm-card" role="dialog" aria-modal="true" aria-labelledby="shell-default-account-title">
        <div class="ml-shell__confirm-head">
          <span class="ml-shell__confirm-pin">${accountPinIcon(true)}</span>
          <div>
            <h2 id="shell-default-account-title">Definir conta padrao</h2>
            <p id="shell-default-account-text">Esta conta sera aberta automaticamente nos proximos logins.</p>
          </div>
        </div>
        <div class="ml-shell__confirm-actions">
          <button type="button" class="ml-shell__confirm-btn ml-shell__confirm-btn--ghost" data-default-account-cancel>Cancelar</button>
          <button type="button" class="ml-shell__confirm-btn ml-shell__confirm-btn--primary" data-default-account-confirm>Definir padrao</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener("click", (event) => {
      if (event.target === modal || event.target.closest("[data-default-account-cancel]")) {
        modal.hidden = true;
      }
    });

    return modal;
  }

  function openDefaultAccountModal(account) {
    const modal = ensureDefaultAccountModal();
    const label = accountLabelFromRow(account);
    const text = modal.querySelector("#shell-default-account-text");
    const confirm = modal.querySelector("[data-default-account-confirm]");
    if (text) {
      text.textContent = `${label} sera aberta automaticamente nos proximos logins.`;
    }
    if (confirm) {
      confirm.disabled = false;
      confirm.onclick = async () => {
        confirm.disabled = true;
        try {
          const response = await window.fetch(window.mlUrl("/api/meli/default"), {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ meli_conta_id: Number(account.id || account.meli_conta_id) }),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok || payload?.ok === false) {
            throw new Error(payload?.error || "Falha ao definir conta padrao.");
          }
          modal.hidden = true;
          hydrateAccountMenu();
        } catch {
          confirm.disabled = false;
        }
      };
    }
    modal.hidden = false;
  }

  function renderAccountMenu(accounts = [], currentId = null, options = {}) {
    const list = document.getElementById("shell-account-list");
    if (!list) return;

    if (!accounts.length) {
      list.innerHTML = `<div class="ml-shell__account-empty">Nenhuma conta encontrada.</div>`;
      return;
    }

    list.innerHTML = accounts.map((account) => {
      const id = account.id || account.meli_conta_id;
      const label = accountLabelFromRow(account);
      const active = String(id || "") === String(currentId || "");
      const isDefault = account.is_default === true || account.is_default === "true";
      const canSetDefault = options.canSetDefault !== false;
      const billing = accountBillingFromRow(account);
      const billingClass = accountBillingToneClass(billing.tone);
      return `
        <div class="ml-shell__account-menu-row ${active ? "is-active" : ""} ${isDefault ? "is-default" : ""} ${billing.canOperate ? "" : "is-blocked"}">
          <button class="ml-shell__account-menu-item" type="button" data-shell-account-id="${escapeHtml(id)}">
            <span class="ml-shell__account-menu-avatar">${escapeHtml(accountInitials(label))}</span>
            <span class="ml-shell__account-menu-copy">
              <span class="ml-shell__account-menu-name">${escapeHtml(label)}</span>
              <span class="ml-shell__account-menu-sub">${escapeHtml(accountSubtitleFromRow(account))}</span>
              <span class="ml-shell__account-billing-tag ${billingClass}">${escapeHtml(billing.label)}${billing.isUnlimited ? " - ilimitado" : ""}</span>
            </span>
            ${active ? '<span class="ml-shell__account-active-dot" aria-label="Conta ativa"></span>' : ""}
          </button>
          ${!billing.canOperate ? `<button class="ml-shell__account-regularize" type="button" data-shell-regularize-account-id="${escapeHtml(id)}" title="Regularizar esta conta">Regularizar</button>` : ""}
          ${canSetDefault ? `<button class="ml-shell__account-default-pin ${isDefault ? "is-default" : ""}" type="button" data-shell-default-account-id="${escapeHtml(id)}" aria-label="${isDefault ? "Conta padrao" : "Definir como conta padrao"}" title="${isDefault ? "Conta padrao" : "Definir como conta padrao"}">
            ${accountPinIcon(isDefault)}
          </button>` : ""}
        </div>
      `;
    }).join("");

    window.__ML_SHELL_ACCOUNTS = accounts.reduce((acc, account) => {
      const id = account.id || account.meli_conta_id;
      if (id != null) acc[String(id)] = account;
      return acc;
    }, {});
  }

  function hydrateAccountInfo() {
    const labelNode = document.getElementById("account-current");
    const avatarNode = document.getElementById("account-avatar");
    if (!labelNode) return;

    window.fetch(window.mlUrl("/api/account/current"), {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json" },
    })
      .then((response) => response.json())
      .then((payload) => {
        const current = payload?.current || null;
        const label = payload?.label || current?.label || "Nenhuma selecionada";
        labelNode.textContent = label;
        if (avatarNode) avatarNode.textContent = accountInitials(label);
      })
      .catch(() => {
        labelNode.textContent = "Conta indisponível";
        if (avatarNode) avatarNode.textContent = "ML";
      });
  }

  function formatCreditNumber(value) {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric)) return "0";
    return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(Math.max(0, Math.trunc(numeric)));
  }

  function readWalletBalance(payload) {
    const resource = payload?.resource || {};
    const monthly = Number(resource.monthly_balance || resource.monthly_credits_balance || 0);
    const purchased = Number(resource.purchased_balance || resource.purchased_credits_balance || 0);
    return {
      monthly: Number.isFinite(monthly) ? monthly : 0,
      purchased: Number.isFinite(purchased) ? purchased : 0,
    };
  }

  function hasUnlimitedCredits(payload) {
    const resource = payload?.resource || {};
    const context = payload?.billing_context || payload?.context || {};
    const status = String(resource.status || context.status || payload?.status || "").toLowerCase();
    const billingMode = String(resource.billing_mode || context.billingMode || context.billing_mode || "").toLowerCase();
    const usagePolicy = String(resource.usage_policy || context.usagePolicy || context.usage_policy || "").toLowerCase();
    return Boolean(
      payload?.unlimited ||
        resource.unlimited ||
        usagePolicy === "unlimited" ||
        ["internal_unlimited", "courtesy_unlimited"].includes(status) ||
        (status === "legacy_active" && billingMode === "legacy"),
    );
  }

  async function hydrateCreditWallet() {
    const button = document.getElementById("btn-credits-wallet");
    const valueNode = document.getElementById("shell-credits-value");
    if (!button || !valueNode) return;

    button.addEventListener("click", () => {
      window.location.href = window.mlUrl("/conta/creditos");
    });

    try {
      const response = await window.fetch(window.mlUrl("/api/billing/credits"), {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.message || payload?.error || "credits_unavailable");
      }

      const wallet = readWalletBalance(payload);
      const unlimited = hasUnlimitedCredits(payload);
      const total = wallet.monthly + wallet.purchased;
      button.classList.remove("is-loading", "is-unavailable", "is-low", "is-empty", "is-unlimited");
      if (unlimited) {
        button.classList.add("is-unlimited");
        valueNode.textContent = "Ilimitado";
        button.title = "Tokens ilimitados nesta conta";
        return;
      }
      button.classList.toggle("is-empty", total <= 0);
      button.classList.toggle("is-low", total > 0 && total <= 50);
      valueNode.textContent = `${formatCreditNumber(total)} c`;
      button.title = `Tokens: ${formatCreditNumber(wallet.monthly)} mensais + ${formatCreditNumber(wallet.purchased)} recarga`;
    } catch {
      button.classList.remove("is-loading", "is-low", "is-unlimited");
      button.classList.add("is-unavailable");
      valueNode.textContent = "indisp.";
      button.title = "Creditos indisponiveis no momento";
    }
  }

  async function hydrateAccountMenu() {
    const list = document.getElementById("shell-account-list");
    if (!list) return;

    try {
      const response = await window.fetch(window.mlUrl("/api/meli/contas?active_only=1&limit=50"), {
        method: "GET",
        credentials: "include",
        headers: { accept: "application/json" },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || "Falha ao carregar contas.");
      }

      renderAccountMenu(
        Array.isArray(payload?.contas) ? payload.contas : [],
        payload?.current_meli_conta_id || null,
        { canSetDefault: payload?.is_master !== true },
      );
    } catch (error) {
      list.innerHTML = `<div class="ml-shell__account-empty">Nao foi possivel carregar as contas.</div>`;
    }
  }

  function applyTheme(theme) {
    const normalized = theme === "dark" ? "dark" : "light";
    document.body.classList.toggle("theme-light", normalized === "light");
    document.body.classList.toggle("theme-dark", normalized === "dark");
    try {
      window.localStorage.setItem(THEME_KEY, normalized);
    } catch {}

    const btn = document.getElementById("btn-theme-toggle");
    if (btn) {
      btn.textContent = normalized === "light" ? "Dark Mode" : "White Mode";
    }

    if (window.Chart && window.Chart.defaults) {
      const isLight = normalized === "light";
      window.Chart.defaults.color = isLight ? "#334155" : "#d7e1f0";
      window.Chart.defaults.borderColor = isLight
        ? "rgba(148, 163, 184, 0.28)"
        : "rgba(148, 163, 184, 0.18)";
    }

    window.dispatchEvent(new CustomEvent("ml-themechange", {
      detail: { theme: normalized },
    }));
  }

  function initThemeToggle() {
    let saved = "light";
    try {
      saved = window.localStorage.getItem(THEME_KEY) || "light";
    } catch {}
    applyTheme(saved);
    document.getElementById("btn-theme-toggle")?.addEventListener("click", () => {
      applyTheme(document.body.classList.contains("theme-light") ? "dark" : "light");
    });
  }

  async function handleAccountExit() {
    let isMaster = false;
    try {
      const meResponse = await window.fetch(window.mlUrl("/api/auth/me"), {
        method: "GET",
        credentials: "include",
        headers: { accept: "application/json" },
      });
      const me = await meResponse.json().catch(() => null);
      isMaster = me?.flags?.is_master === true || me?.is_master === true;
    } catch {}

    if (isMaster) {
      try {
        await window.fetch(window.mlUrl("/api/meli/limpar-selecao"), {
          method: "POST",
          credentials: "include",
        });
      } catch {}
      window.location.href = window.mlUrl("/select-conta");
      return;
    }

    try {
      await window.fetch(window.mlUrl("/api/auth/logout"), {
        method: "POST",
        credentials: "include",
      });
    } catch {}
    window.location.href = "/selecao-plataforma";
  }

  function formatReferenceDay(value) {
    if (!value) return "Sem data";
    const date = new Date(`${value}T12:00:00`);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const todayText = today.toLocaleDateString("en-CA", {
      timeZone: "America/Sao_Paulo",
    });
    const yesterdayText = yesterday.toLocaleDateString("en-CA", {
      timeZone: "America/Sao_Paulo",
    });

    if (value === todayText) return "Hoje";
    if (value === yesterdayText) return "Ontem";

    return date.toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
    });
  }

  function getAlertsView() {
    try {
      return window.localStorage.getItem(STORAGE_ALERTS_VIEW) === "history"
        ? "history"
        : "today";
    } catch {
      return "today";
    }
  }

  function setAlertsView(mode) {
    const next = mode === "history" ? "history" : "today";
    try {
      window.localStorage.setItem(STORAGE_ALERTS_VIEW, next);
    } catch {}
    return next;
  }

  function stableSerialize(value) {
    if (value == null) return "null";
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
    }
    if (typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${key}:${stableSerialize(value[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function formatDayKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-CA", {
      timeZone: "America/Sao_Paulo",
    });
  }

  function getTodayDayKey() {
    return formatDayKey(new Date());
  }

  function getNotificationDayKey(item = {}) {
    const explicit = String(item.reference_date || "").trim();
    if (explicit) return explicit;
    return formatDayKey(item.updated_at || item.created_at) || "sem-data";
  }

  function buildNotificationReadSignature(item = {}) {
    const payload = item?.payload || {};
    return [
      String(item.type || ""),
      String(getNotificationDayKey(item) || ""),
      String(item.title || ""),
      String(item.message || ""),
      stableSerialize({
        kind: payload.kind || "",
        metric: payload.metric || "",
        label: payload.label || "",
        compare_label: payload.compare_label || "",
        current_value: payload.current_value ?? null,
        previous_value: payload.previous_value ?? null,
        limit_value: payload.limit_value ?? null,
        delta_pct: payload.delta_pct ?? null,
        direction: payload.direction || "",
        current_label: payload.current_label || "",
        previous_label: payload.previous_label || "",
        limit_label: payload.limit_label || "",
        threshold_ratio: payload.threshold_ratio ?? null,
      }),
    ].join("|");
  }

  function pruneReadCache(cache = {}) {
    const now = Date.now();
    const entries = Object.entries(cache)
      .filter(([, stamp]) => {
        const ts = Number(stamp);
        return Number.isFinite(ts) && now - ts <= ALERTS_READ_MAX_AGE_MS;
      })
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, ALERTS_READ_MAX_ENTRIES);

    return Object.fromEntries(entries);
  }

  function readAlertsReadCache() {
    return pruneReadCache(readState(STORAGE_ALERTS_READ, {}));
  }

  function writeAlertsReadCache(cache = {}) {
    writeState(STORAGE_ALERTS_READ, pruneReadCache(cache));
  }

  function formatTimestamp(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    return date.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatAlertDelta(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "Sem base";
    return `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n).toLocaleString("pt-BR", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}%`;
  }

  function groupNotificationsByDay(items = []) {
    const groups = new Map();
    items.forEach((item) => {
      const key = getNotificationDayKey(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    return Array.from(groups.entries());
  }

  function getAlertTone(item) {
    const kind = item?.payload?.kind;
    const direction = item?.payload?.direction;
    if (kind === "limit") {
      return direction === "down" ? "down" : "warning";
    }
    if (direction === "warning") return "warning";
    if (direction === "up") return "up";
    if (direction === "down") return "down";
    return "neutral";
  }

  function getAlertChip(item) {
    const tone = getAlertTone(item);
    const payload = item?.payload || {};

    if (payload.kind === "delta") {
      const icon =
        tone === "up"
          ? makeIcon("trendUp")
          : tone === "down"
            ? makeIcon("trendDown")
            : makeIcon("minus");

      return {
        tone,
        icon,
        text:
          payload.delta_pct == null
            ? "Sem base"
            : formatAlertDelta(payload.delta_pct),
      };
    }

    if (payload.kind === "limit") {
      const ratio = Number(payload.threshold_ratio || 0);
      const overLimit = ratio > 1;
      const atLimit = !overLimit && Math.abs(ratio - 1) < 0.0001;
      return {
        tone,
        icon: overLimit ? makeIcon("trendDown") : makeIcon("warning"),
        text: overLimit
          ? "Acima do limite"
          : atLimit
            ? "No limite"
            : "Perto do limite",
      };
    }

    return {
      tone: "neutral",
      icon: makeIcon("minus"),
      text: "Atualizado",
    };
  }

  function initAlertsCenter() {
    const wrap = document.getElementById("shell-alerts");
    const button = document.getElementById("btn-alerts");
    const badge = document.getElementById("shell-alerts-badge");
    const panel = document.getElementById("shell-alerts-panel");
    const body = document.getElementById("shell-alerts-body");
    const refreshButton = document.getElementById("shell-alerts-refresh");
    const subtitle = document.getElementById("shell-alerts-subtitle");
    const modeButtons = Array.from(panel?.querySelectorAll("[data-alerts-mode]") || []);
    if (!wrap || !button || !badge || !panel || !body) return;

    const state = {
      open: false,
      loading: false,
      loaded: false,
      readInFlight: false,
      items: [],
      unreadCount: 0,
      error: "",
      prefetchDone: false,
      mode: getAlertsView(),
      readCache: readAlertsReadCache(),
    };

    function rememberReadItems(items = []) {
      let changed = false;
      items.forEach((item) => {
        if (!item || item.unread) return;
        const signature = buildNotificationReadSignature(item);
        if (!signature) return;
        const stamp = Date.parse(item.read_at || item.updated_at || item.created_at || "");
        const nextValue = Number.isFinite(stamp) ? stamp : Date.now();
        if (state.readCache[signature] === nextValue) return;
        state.readCache[signature] = nextValue;
        changed = true;
      });

      if (!changed) return;
      state.readCache = pruneReadCache(state.readCache);
      writeAlertsReadCache(state.readCache);
    }

    function applyReadCache(items = []) {
      rememberReadItems(items);
      return items.map((item) => {
        if (!item?.unread) return item;
        const signature = buildNotificationReadSignature(item);
        const cachedStamp = Number(state.readCache?.[signature] || 0);
        if (!Number.isFinite(cachedStamp) || cachedStamp <= 0) return item;
        return {
          ...item,
          unread: false,
          read_at: item.read_at || new Date(cachedStamp).toISOString(),
        };
      });
    }

    function syncModeControls() {
      modeButtons.forEach((modeButton) => {
        const active = modeButton.getAttribute("data-alerts-mode") === state.mode;
        modeButton.classList.toggle("is-active", active);
        modeButton.setAttribute("aria-pressed", active ? "true" : "false");
      });

      if (!subtitle) return;
      if (state.mode === "history") {
        subtitle.hidden = false;
        subtitle.textContent = "Ultimos 7 dias";
        return;
      }

      subtitle.hidden = true;
      subtitle.textContent = "";
    }

    function filterItemsByMode(items = []) {
      const todayKey = getTodayDayKey();
      return items.filter((item) => {
        const dayKey = getNotificationDayKey(item);
        if (!dayKey || dayKey === "sem-data") return state.mode === "history";
        return state.mode === "history" ? dayKey !== todayKey : dayKey === todayKey;
      });
    }

    function syncBadge() {
      badge.hidden = !(state.unreadCount > 0);
      button.classList.toggle("has-notifications", state.unreadCount > 0);
    }

    function renderLoading() {
      body.innerHTML = `
        <div class="ml-shell__alerts-skeleton">
          <span class="ml-shell__alerts-skeleton-row"></span>
          <span class="ml-shell__alerts-skeleton-row"></span>
          <span class="ml-shell__alerts-skeleton-row"></span>
        </div>
      `;
    }

    function renderEmpty(text) {
      const fallback =
        state.mode === "history"
          ? "Nenhuma notificacao no historico dos ultimos 7 dias."
          : "Nenhuma notificacao para hoje.";
      body.innerHTML = `<div class="ml-shell__alerts-empty">${escapeHtml(text || fallback)}</div>`;
    }

    function renderError(text) {
      body.innerHTML = `
        <div class="ml-shell__alerts-empty is-error">
          ${escapeHtml(text || "Nao foi possivel carregar as notificacoes agora.")}
        </div>
      `;
    }

    function renderItems() {
      const filteredItems = filterItemsByMode(state.items);
      if (!filteredItems.length) {
        renderEmpty();
        return;
      }

      const sections = groupNotificationsByDay(filteredItems)
        .map(([dayKey, items]) => {
          const showDayLabel = state.mode === "history";
          const cards = items
            .map((item) => {
              const chip = getAlertChip(item);
              const tone = getAlertTone(item);
              const referenceMeta = showDayLabel
                ? `<span>Referencia: ${escapeHtml(formatReferenceDay(getNotificationDayKey(item)))}</span>`
                : "";
              const kicker =
                item?.payload?.metric === "roas" || item?.payload?.metric === "conversion"
                  ? "Publicidade"
                  : item?.payload?.kind === "limit"
                    ? "Reputacao"
                    : "Aviso";

              return `
                <article class="ml-shell__alert-card ${item.unread ? "is-unread" : "is-read"}" data-tone="${tone}">
                  <div class="ml-shell__alert-main">
                    <div class="ml-shell__alert-top">
                      <div class="ml-shell__alert-heading">
                        <span class="ml-shell__alert-kicker">${escapeHtml(kicker)}</span>
                        <strong class="ml-shell__alert-title">${escapeHtml(item.title || "Notificacao")}</strong>
                      </div>
                      <span class="ml-shell__alert-chip is-${chip.tone}">
                        <span class="ml-shell__alert-chip-icon">${chip.icon}</span>
                        <span>${escapeHtml(chip.text)}</span>
                      </span>
                    </div>
                    <p class="ml-shell__alert-message">${escapeHtml(item.message || "")}</p>
                    <div class="ml-shell__alert-meta">
                      ${referenceMeta}
                      <span>${escapeHtml(formatTimestamp(item.updated_at || item.created_at))}</span>
                    </div>
                  </div>
                </article>
              `;
            })
            .join("");

          return `
            <section class="ml-shell__alerts-section ${showDayLabel ? "" : "is-current"}">
              ${showDayLabel ? `<div class="ml-shell__alerts-day">${escapeHtml(formatReferenceDay(dayKey))}</div>` : ""}
              <div class="ml-shell__alerts-stack">
                ${cards}
              </div>
            </section>
          `;
        })
        .join("");

      body.innerHTML = sections;
    }

    function render() {
      syncModeControls();
      syncBadge();
      button.setAttribute("aria-expanded", state.open ? "true" : "false");
      wrap.classList.toggle("is-open", state.open);
      panel.hidden = !state.open;

      if (!state.open && !state.loaded && !state.loading) return;
      if (state.loading) {
        renderLoading();
        return;
      }
      if (state.error) {
        renderError(state.error);
        return;
      }
      renderItems();
    }

    async function requestJson(path, init = {}) {
      const response = await window.fetch(window.mlUrl(path), {
        credentials: "include",
        headers: {
          accept: "application/json",
          ...(init.method && init.method !== "GET"
            ? { "content-type": "application/json" }
            : {}),
          ...(init.headers || {}),
        },
        ...init,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || "Falha ao carregar notificacoes.");
      }
      return data;
    }

    async function load({ refresh = false, silent = false, force = false } = {}) {
      if (state.loading) return;
      state.loading = true;
      state.error = "";
      if (!silent) render();

      try {
        const data = refresh
          ? await requestJson("/api/notifications/refresh", {
              method: "POST",
              body: JSON.stringify({ force }),
            })
          : await requestJson("/api/notifications");

        const incomingItems = Array.isArray(data?.items) ? data.items : [];
        state.items = applyReadCache(incomingItems);
        state.unreadCount = state.items.filter((item) => item.unread).length;
        state.loaded = true;
        state.error = "";
        if (state.open && state.unreadCount > 0) {
          window.setTimeout(() => {
            markAllRead();
          }, 180);
        }
      } catch (error) {
        state.error = error.message || "Falha ao carregar notificacoes.";
      } finally {
        state.loading = false;
        render();
      }
    }

    async function markAllRead() {
      if (state.readInFlight || state.unreadCount <= 0) return;
      state.readInFlight = true;
      try {
        await requestJson("/api/notifications/read-all", { method: "POST" });
        state.items = state.items.map((item) => ({
          ...item,
          unread: false,
          read_at: new Date().toISOString(),
        }));
        rememberReadItems(state.items);
        state.unreadCount = 0;
        render();
      } catch {}
      state.readInFlight = false;
    }

    function openPanel() {
      state.open = true;
      render();
      if (!state.loaded) {
        load({ refresh: true });
      }
      window.setTimeout(() => {
        markAllRead();
      }, 350);
    }

    function closePanel() {
      state.open = false;
      render();
    }

    function togglePanel() {
      if (state.open) closePanel();
      else openPanel();
    }

    function schedulePrefetch() {
      if (state.prefetchDone) return;
      state.prefetchDone = true;
      window.setTimeout(() => {
        load({ refresh: true, silent: true });
      }, 4000);
    }

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      togglePanel();
    });

    refreshButton?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      load({ refresh: true, force: true });
    });

    modeButtons.forEach((modeButton) => {
      modeButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.mode = setAlertsView(modeButton.getAttribute("data-alerts-mode"));
        render();
      });
    });

    document.addEventListener("click", (event) => {
      if (!state.open) return;
      if (wrap.contains(event.target)) return;
      closePanel();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.open) closePanel();
    });

    schedulePrefetch();
    render();
  }

  function bindShellInteractions(groupState) {
    const body = document.body;
    const sidebarToggles = Array.from(document.querySelectorAll("[data-shell-toggle]"));
    const mobileToggle = document.querySelector("[data-shell-mobile-open]");
    const overlay = document.querySelector(".ml-shell__overlay");

    sidebarToggles.forEach((toggle) => {
      toggle.addEventListener("click", () => {
        body.classList.toggle("ml-shell-collapsed");
        writeState(STORAGE_COLLAPSED, body.classList.contains("ml-shell-collapsed"));
      });
    });

    mobileToggle?.addEventListener("click", () => {
      body.classList.add("ml-shell-mobile-open");
    });

    overlay?.addEventListener("click", () => {
      body.classList.remove("ml-shell-mobile-open");
    });

    document.querySelectorAll("[data-group-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const groupId = button.getAttribute("data-group-toggle");
        const expanded = button.getAttribute("aria-expanded") === "true";

        document.querySelectorAll("[data-group-toggle]").forEach((otherButton) => {
          const otherGroupId = otherButton.getAttribute("data-group-toggle");
          const shouldExpand = otherGroupId === groupId ? !expanded : false;
          const wrapper = otherButton.closest(".ml-shell__group");
          const children = wrapper?.querySelector(".ml-shell__children");
          otherButton.setAttribute("aria-expanded", String(shouldExpand));
          if (children) children.hidden = !shouldExpand;
          wrapper?.classList.toggle("is-open", shouldExpand);
          groupState[otherGroupId] = shouldExpand;
        });

        writeState(STORAGE_GROUPS, groupState);
      });
    });

    const accountWrap = document.getElementById("shell-account");
    const accountToggle = document.getElementById("account-menu-toggle");
    const accountMenu = document.getElementById("shell-account-menu");
    const closeAccountMenu = () => {
      if (accountMenu) accountMenu.hidden = true;
      if (accountToggle) accountToggle.setAttribute("aria-expanded", "false");
    };

    accountToggle?.addEventListener("click", () => {
      if (!accountMenu) return;
      const willOpen = accountMenu.hidden;
      accountMenu.hidden = !willOpen;
      accountToggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
      if (willOpen) hydrateAccountMenu();
    });

    accountMenu?.addEventListener("click", async (event) => {
      const pin = event.target.closest("[data-shell-default-account-id]");
      if (pin) {
        event.preventDefault();
        event.stopPropagation();
        const id = pin.getAttribute("data-shell-default-account-id");
        const account = window.__ML_SHELL_ACCOUNTS?.[String(id)];
        if (!account || pin.closest(".ml-shell__account-menu-row")?.classList.contains("is-default")) {
          return;
        }
        openDefaultAccountModal(account);
        return;
      }

      const regularize = event.target.closest("[data-shell-regularize-account-id]");
      if (regularize) {
        event.preventDefault();
        event.stopPropagation();
        const id = regularize.getAttribute("data-shell-regularize-account-id");
        const account = window.__ML_SHELL_ACCOUNTS?.[String(id)];
        const billing = accountBillingFromRow(account);
        if (billing.renewalUrl) {
          window.location.href = billing.renewalUrl;
          return;
        }
        window.location.href = window.mlUrl("/conta/regularizar");
        return;
      }

      const item = event.target.closest("[data-shell-account-id]");
      if (!item) return;
      const id = item.getAttribute("data-shell-account-id");
      if (!id || item.closest(".ml-shell__account-menu-row")?.classList.contains("is-active")) {
        closeAccountMenu();
        return;
      }

      item.disabled = true;
      try {
        const response = await window.fetch(window.mlUrl("/api/meli/selecionar"), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ meli_conta_id: Number(id) }),
        });
        if (!response.ok) throw new Error("Falha ao selecionar conta.");
        const account = window.__ML_SHELL_ACCOUNTS?.[String(id)];
        const billing = accountBillingFromRow(account);
        if (billing.canOperate) {
          window.location.reload();
          return;
        }
        window.location.href = window.mlUrl("/conta/regularizar");
      } catch {
        item.disabled = false;
      }
    });

    document.addEventListener("click", (event) => {
      if (!accountWrap || accountWrap.contains(event.target)) return;
      closeAccountMenu();
    });

    document.getElementById("btn-logout-account")?.addEventListener("click", handleAccountExit);

    document.getElementById("btn-help")?.addEventListener("click", () => {
      window.location.href = window.mlUrl("/ajuda");
    });

    document.getElementById("admin-logout")?.addEventListener("click", async () => {
      try {
        await window.fetch(window.mlUrl("/api/auth/logout"), {
          method: "POST",
          credentials: "include",
        });
      } catch {}
      window.location.href = "/selecao-plataforma";
    });
  }

  function ensureStatusModal() {
    let modal = document.getElementById("modal-status");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "modal-status";
      modal.className = "modal";
      modal.innerHTML = `
        <div class="modal-content">
          <div class="modal-header alt">
            <h3>Status da Integração</h3>
            <span class="close" data-shell-status-close>&times;</span>
          </div>
          <div class="modal-body">
            <div class="status-grid">
              <div class="stat-mini"><h4 id="status-usuario">—</h4><p>Usuário</p></div>
              <div class="stat-mini"><h4 id="status-token">—</h4><p>Token</p></div>
              <div class="stat-mini"><h4 id="status-msg">—</h4><p>Mensagem</p></div>
            </div>
            <div class="modal-controls mt-3">
              <button class="btn-primary btn-sm" type="button" data-shell-status-verify>Verificar</button>
              <button class="btn-secondary btn-sm" type="button" data-shell-status-refresh>Renovar</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    if (modal.dataset.bound === "true") return;
    modal.dataset.bound = "true";

    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    const setShellStatus = (status, label) => {
      const chip = document.getElementById("btn-status");
      const text = chip?.querySelector(".ml-shell__status-label");
      if (!chip || !text) return;
      chip.classList.remove("is-operational", "is-degraded", "is-offline");
      chip.classList.add(status);
      text.textContent = label;
    };

    const openModal = () => modal.classList.add("is-open");
    const closeModal = () => modal.classList.remove("is-open");

    async function requestStatus(url, options = {}) {
      try {
        const response = await window.fetch(window.mlUrl(url), {
          credentials: "include",
          ...options,
        });
        const data = await response.json().catch(() => null);
        if (!data?.success) {
          setText("status-msg", data?.error || "Falha ao consultar a integração.");
          setShellStatus("is-offline", "Fora do ar");
          return;
        }

        setText("status-usuario", data.nickname || "usuario");
        setText("status-token", data.token_status_label || "Token ativo no servidor");
        setText("status-msg", data.message || "OK");
        const tokenLabel = String(data.token_status_label || data.message || "").toLowerCase();
        if (tokenLabel.includes("expir") || tokenLabel.includes("inv") || tokenLabel.includes("revog")) {
          setShellStatus("is-degraded", "Degradado");
        } else {
          setShellStatus("is-operational", "Operacional");
        }
      } catch (error) {
        setText("status-msg", `Erro: ${error.message}`);
        setShellStatus("is-offline", "Fora do ar");
      }
    }

    document.getElementById("btn-status")?.addEventListener("click", async () => {
      openModal();
      await requestStatus("/api/tokens/verificar-token");
    });

    modal.querySelector("[data-shell-status-close]")?.addEventListener("click", closeModal);
    modal.querySelector("[data-shell-status-verify]")?.addEventListener("click", async () => {
      await requestStatus("/api/tokens/verificar-token");
    });
    modal.querySelector("[data-shell-status-refresh]")?.addEventListener("click", async () => {
      await requestStatus("/api/tokens/renovar-token-automatico", { method: "POST" });
    });

    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal();
    });
  }

  function hideRedundantTitles(currentMeta) {
    const expected = normalizeText(currentMeta?.item?.label || "");
    if (!expected) return;

    const viewport = document.querySelector(".ml-shell__viewport");
    if (!viewport) return;

    const keepVisibleSelector = [
      ".overview-header",
      ".ops-hero",
      ".hero",
      ".car-page-header",
      ".ex-page-header",
      ".pz-page-header",
      ".dim-hero",
      ".promo-module-header",
      ".ads-page-header",
      ".fml-hero",
      ".fv-hero",
      ".linked-accounts-hero"
    ].join(",");

    viewport.querySelectorAll("h1").forEach((heading) => {
      const text = normalizeText(heading.textContent || "");
      if (!text || text !== expected) return;
      // Cabecalhos modernos usam o titulo como parte da hierarquia da pagina,
      // mesmo quando o shell repete o nome no topo. Neles o h1 permanece visivel.
      if (heading.closest(keepVisibleSelector)) return;
      heading.classList.add("ml-shell__redundant-title");
      heading.setAttribute("aria-hidden", "true");
    });
  }

  function mountShell() {
    const pathname = getCurrentPath();
    if (!shouldEnhance(pathname)) {
      window.__ML_RELEASE_SHELL_PENDING__?.();
      return;
    }
    if (document.querySelector(".ml-shell")) {
      window.__ML_RELEASE_SHELL_PENDING__?.();
      return;
    }

    const currentMeta = getCurrentMeta(pathname);
    const adminContext = isAdminPath(pathname);
    const groupState = normalizeGroupState(readState(STORAGE_GROUPS, {
      overview: true,
      ads: false,
      operations: false,
      advertising: false,
      promos: false,
      pricing: false,
      analytics: false,
      fiscal: false,
      account: false,
      admin: false,
    }), currentMeta?.group?.id);
    writeState(STORAGE_GROUPS, groupState);

    const shell = document.createElement("div");
    shell.className = "ml-shell";
    shell.innerHTML = `
      ${renderSidebar(currentMeta, groupState)}
      <div class="ml-shell__main">
        ${renderTopbar(currentMeta)}
        <div class="ml-shell__viewport">
          <main class="ml-shell__content-shell">
            <div class="ml-shell__content"></div>
          </main>
        </div>
      </div>
      <div class="ml-shell__overlay"></div>
    `;

    const viewport = shell.querySelector(".ml-shell__content");
    const nodes = getContentNodes();
    nodes.forEach((node) => viewport.appendChild(node));

    document.body.insertBefore(shell, document.body.firstChild);
    document.body.classList.add("ml-shell-ready");
    window.__ML_RELEASE_SHELL_PENDING__?.();

    if (readState(STORAGE_COLLAPSED, false) && window.innerWidth > 980) {
      document.body.classList.add("ml-shell-collapsed");
    }

    bindShellInteractions(groupState);
    initThemeToggle();
    applyAdminVisibility();
    hydrateAccountInfo();
    hydrateCreditWallet();
    initAlertsCenter();
    ensureStatusModal();
    hideRedundantTitles(currentMeta);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountShell, { once: true });
  } else {
    mountShell();
  }
})();
