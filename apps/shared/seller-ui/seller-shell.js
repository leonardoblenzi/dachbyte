// @ts-check
/*
 * DACHBYTE Seller UI · shell compartilhado (mesma estrutura do ml-shell do ML).
 * Uso: DachSellerShell.mount({ product, theme, basePath, brand, navGroups, user, actions }).
 * O conteúdo da página fica em <main data-shell-content> e é movido para dentro do shell.
 */
(function () {
  "use strict";

  /** @type {Record<string, string>} */
  const ICONS = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    more: '<circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/>',
    dashboard: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
    package: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m12 12 8-4.5M12 12v9M12 12 4 7.5"/>',
    stack: '<path d="m12 4 8 4-8 4-8-4z"/><path d="m4 12 8 4 8-4"/><path d="m4 16 8 4 8-4"/>',
    chart: '<path d="M4 20V11"/><path d="M10 20V5"/><path d="M16 20v-6"/><path d="M21 20H3"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    tag: '<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/>',
    messages: '<path d="M4 5h16v11H8l-4 4z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 5-5 8-5s6.5 1 8 5"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 1 1 5 2.2c-.9.7-1.6 1.2-1.6 2.8"/><path d="M12 17h.01"/>',
    logout: '<path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M20 4v16"/>',
  };

  /** @param {string} name */
  function icon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.dashboard}</svg>`;
  }

  /** @param {unknown} value */
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
  }

  /** @param {string} key @param {any} fallback */
  function readState(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); } catch (_e) { return fallback; }
  }
  /** @param {string} key @param {any} value */
  function writeState(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_e) { /* modo privado: ignora */ }
  }

  /**
   * @typedef {{ label: string, path: string }} NavItem
   * @typedef {{ id: string, label: string, hint?: string, icon?: string, items: NavItem[] }} NavGroup
   * @typedef {{
   *   product: string, theme?: string, basePath: string,
   *   brand: { name: string, sub: string, logo: string, href?: string },
   *   account?: { label: string, href?: string },
   *   navGroups: NavGroup[], footNote?: string,
   *   status?: { label: string, tone?: string, href?: string },
   *   helpHref?: string, logoutHref?: string,
   *   links?: Array<{ label: string, href: string, icon?: string }>,
   * }} ShellConfig
   */

  /** @param {string} path */
  function normalize(path) { return String(path || "/").replace(/\/+$/, "") || "/"; }

  /** @param {NavGroup[]} groups @param {string} current */
  function findActive(groups, current) {
    const cur = normalize(current);
    let best = null;
    for (const group of groups) {
      for (const item of group.items) {
        const p = normalize(item.path);
        const hit = cur === p || cur.startsWith(p + "/");
        if (hit && (!best || p.length > normalize(best.item.path).length)) best = { group, item };
      }
    }
    return best;
  }

  /** @param {ShellConfig} config @param {{group: NavGroup, item: NavItem} | null} active @param {Record<string, boolean>} openState */
  function renderSidebar(config, active, openState) {
    const groups = config.navGroups.map((group) => {
      const isActive = active && active.group.id === group.id;
      const isOpen = openState[group.id] ?? Boolean(isActive);
      const links = group.items.map((item) => {
        const current = active && active.item === item;
        return `<a class="seller-shell__link${current ? " is-active" : ""}" href="${esc(item.path)}"${current ? ' aria-current="page"' : ""}>${esc(item.label)}</a>`;
      }).join("");
      return `<div class="seller-shell__category${isActive ? " is-active" : ""}${isOpen ? " is-open" : ""}" data-group="${esc(group.id)}">
        <button class="seller-shell__category-toggle" type="button" aria-expanded="${isOpen}" data-group-toggle="${esc(group.id)}" title="${esc(group.label)}">
          <span class="seller-shell__category-icon">${icon(group.icon || "dashboard")}</span>
          <span class="seller-shell__category-meta"><strong>${esc(group.label)}</strong>${group.hint ? `<small>${esc(group.hint)}</small>` : ""}</span>
          <span class="seller-shell__chevron">${icon("chevron")}</span>
        </button>
        <div class="seller-shell__category-body"><div class="seller-shell__category-inner">${links}</div></div>
      </div>`;
    }).join("");
    return `<aside class="seller-shell__sidebar" aria-label="Navegação principal">
      <div class="seller-shell__sidebar-toolbar"><button class="seller-shell__icon-btn" type="button" data-shell-collapse aria-label="Recolher ou expandir menu">${icon("menu")}</button></div>
      <a class="seller-shell__brand" href="${esc(config.brand.href || config.basePath + "/")}">
        <span class="seller-shell__brand-logo"><img src="${esc(config.brand.logo)}" alt=""></span>
        <span class="seller-shell__brand-copy"><span class="seller-shell__brand-name">${esc(config.brand.name)}</span><span class="seller-shell__brand-sub">${esc(config.brand.sub)}</span></span>
      </a>
      ${config.account ? `<a class="seller-shell__account" href="${esc(config.account.href || "#")}"><span>${esc(config.account.label)}</span>${icon("down")}</a>` : ""}
      <div class="seller-shell__sidebar-title">Categorias</div>
      <nav class="seller-shell__nav">${groups}</nav>
      ${config.footNote ? `<div class="seller-shell__sidebar-foot">${esc(config.footNote)}</div>` : ""}
    </aside>`;
  }

  /** @param {ShellConfig} config @param {{group: NavGroup, item: NavItem} | null} active */
  function renderTopbar(config, active) {
    const group = active ? active.group : config.navGroups[0];
    const title = active ? active.item.label : document.title;
    const status = config.status ? `<a class="seller-shell__chip" data-tone="${esc(config.status.tone || "success")}" href="${esc(config.status.href || "#")}"><span class="seller-shell__dot"></span>${esc(config.status.label)}</a>` : "";
    return `<header class="seller-shell__topbar">
      <div class="seller-shell__topbar-left">
        <button class="seller-shell__icon-btn seller-shell__mobile-toggle" type="button" data-shell-mobile aria-label="Abrir menu">${icon("menu")}</button>
        <div class="seller-shell__page-context">
          <div class="seller-shell__breadcrumb">${icon((group && group.icon) || "dashboard")}<span>${esc(group ? group.label : "")}</span></div>
          <h1 class="seller-shell__page-title">${esc(title)}</h1>
        </div>
      </div>
      <div class="seller-shell__topbar-right">
        <div class="seller-shell__actions" id="seller-shell-actions">
          ${status}
          <button class="seller-shell__chip" type="button" data-shell-theme>${icon("sun")}<span data-shell-theme-label>Tema</span></button>
          ${(config.links || []).map((link) => `<a class="seller-shell__chip" href="${esc(link.href)}">${icon(link.icon || "link")}${esc(link.label)}</a>`).join("")}
          ${config.helpHref ? `<a class="seller-shell__chip" href="${esc(config.helpHref)}">${icon("help")}Ajuda</a>` : ""}
          ${config.logoutHref ? `<a class="seller-shell__chip" href="${esc(config.logoutHref)}">${icon("logout")}Sair</a>` : ""}
        </div>
        <button class="seller-shell__icon-btn seller-shell__more-toggle" type="button" data-shell-more aria-label="Mais opções" aria-controls="seller-shell-actions" aria-expanded="false">${icon("more")}</button>
      </div>
    </header>`;
  }

  /** @param {ShellConfig} config */
  function mount(config) {
    const root = document.documentElement;
    const body = document.body;
    const key = (/** @type {string} */ name) => `dachbyte:${config.product}:shell:${name}`;
    if (config.theme) root.setAttribute("data-seller-theme", config.theme);
    const savedTheme = readState(key("theme"), null);
    const prefersDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", savedTheme || (prefersDark ? "dark" : "light"));

    const content = document.querySelector("[data-shell-content]");
    const active = findActive(config.navGroups, location.pathname);
    const openState = readState(key("groups"), {});
    if (active) openState[active.group.id] = true;

    const shell = document.createElement("div");
    shell.className = "seller-shell";
    shell.innerHTML = `${renderSidebar(config, active, openState)}<div class="seller-shell__overlay" data-shell-overlay></div>
      <div class="seller-shell__main">${renderTopbar(config, active)}<div class="seller-shell__viewport" data-shell-viewport></div></div>`;
    const viewport = /** @type {HTMLElement} */ (shell.querySelector("[data-shell-viewport]"));
    if (content) viewport.append(content);
    body.prepend(shell);
    body.classList.add("seller-shell-ready");
    if (readState(key("collapsed"), false)) body.classList.add("seller-shell-collapsed");

    const themeLabel = () => {
      const el = shell.querySelector("[data-shell-theme-label]");
      if (el) el.textContent = root.getAttribute("data-theme") === "dark" ? "Modo claro" : "Modo escuro";
    };
    themeLabel();

    const setMore = (/** @type {boolean} */ open) => {
      body.classList.toggle("seller-shell-more-open", open);
      shell.querySelector("[data-shell-more]")?.setAttribute("aria-expanded", String(open));
    };

    shell.addEventListener("click", (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      const toggle = target.closest("[data-group-toggle]");
      if (toggle) {
        const id = toggle.getAttribute("data-group-toggle") || "";
        const wasOpen = toggle.getAttribute("aria-expanded") === "true";
        shell.querySelectorAll("[data-group]").forEach((node) => {
          const open = node.getAttribute("data-group") === id ? !wasOpen : false;
          node.classList.toggle("is-open", open);
          node.querySelector("[data-group-toggle]")?.setAttribute("aria-expanded", String(open));
          openState[node.getAttribute("data-group") || ""] = open;
        });
        writeState(key("groups"), openState);
        if (body.classList.contains("seller-shell-collapsed")) {
          body.classList.remove("seller-shell-collapsed");
          writeState(key("collapsed"), false);
        }
        return;
      }
      if (target.closest("[data-shell-collapse]")) {
        body.classList.toggle("seller-shell-collapsed");
        writeState(key("collapsed"), body.classList.contains("seller-shell-collapsed"));
        return;
      }
      if (target.closest("[data-shell-mobile]")) { body.classList.add("seller-shell-mobile-open"); return; }
      if (target.closest("[data-shell-overlay]")) { body.classList.remove("seller-shell-mobile-open"); return; }
      if (target.closest("[data-shell-more]")) { event.stopPropagation(); setMore(!body.classList.contains("seller-shell-more-open")); return; }
      if (target.closest("[data-shell-theme]")) {
        const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
        root.setAttribute("data-theme", next);
        writeState(key("theme"), next);
        themeLabel();
        setMore(false);
      }
    });
    document.addEventListener("click", (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      if (body.classList.contains("seller-shell-more-open") && !target.closest("#seller-shell-actions")) setMore(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      setMore(false);
      body.classList.remove("seller-shell-mobile-open");
    });
    return { shell, viewport, active };
  }

  const api = { mount, _test: { findActive, normalize, esc } };
  if (typeof window !== "undefined") /** @type {any} */ (window).DachSellerShell = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
