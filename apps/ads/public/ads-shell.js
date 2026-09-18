"use strict";

(() => {
  const THEME_KEY = "dach_ads_theme_mode";
  const COLLAPSED_KEY = "dach_ads_shell_collapsed";
  const body = document.body;
  const themeButton = document.getElementById("ads-theme-toggle");
  const identity = document.getElementById("ads-identity");

  function safeRead(key, fallback) {
    try { const value = window.localStorage.getItem(key); return value === null ? fallback : value; }
    catch { return fallback; }
  }
  function safeWrite(key, value) { try { window.localStorage.setItem(key, value); } catch {} }

  function applyTheme(theme) {
    const normalized = theme === "dark" ? "dark" : "light";
    body.classList.toggle("theme-light", normalized === "light");
    body.classList.toggle("theme-dark", normalized === "dark");
    document.documentElement.style.colorScheme = normalized;
    safeWrite(THEME_KEY, normalized);
    if (themeButton) themeButton.textContent = normalized === "light" ? "Dark Mode" : "White Mode";
    window.dispatchEvent(new CustomEvent("dach-ads-themechange", { detail: { theme: normalized } }));
  }

  function applyCollapsed(collapsed) {
    body.classList.toggle("ads-shell-collapsed", Boolean(collapsed) && window.innerWidth > 980);
    safeWrite(COLLAPSED_KEY, collapsed ? "1" : "0");
  }

  function closeMobile() { body.classList.remove("ads-shell-mobile-open"); }

  function currentView() {
    if (window.location.pathname.startsWith("/ads/app/analytics")) return "analytics";
    if (window.location.pathname.startsWith("/ads/app/google")) return "google";
    if (window.location.pathname.startsWith("/ads/app/meta")) return "meta";
    if (window.location.pathname.startsWith("/ads/app/diagnostics")) return "diagnostics";
    return "dashboard";
  }

  function applyView() {
    const view = currentView();
    document.querySelectorAll("[data-ads-view]").forEach((node) => { node.hidden = node.dataset.adsView !== view; });
    document.querySelectorAll("[data-nav-view]").forEach((node) => {
      const active = node.dataset.navView === view;
      node.classList.toggle("is-active", active);
      if (active) node.setAttribute("aria-current", "page"); else node.removeAttribute("aria-current");
    });
    document.querySelectorAll("[data-nav-group]").forEach((node) => node.classList.remove("is-active-category"));
    const group = (view === "google" || view === "meta") ? "channels" : (view === "analytics" || view === "diagnostics") ? "intelligence" : "overview";
    document.querySelector(`[data-nav-group="${group}"]`)?.classList.add("is-active-category");
    const title = document.querySelector("[data-page-title]");
    const breadcrumb = document.querySelector("[data-page-breadcrumb]");
    if (title) title.textContent = view === "google" ? "Google Ads" : view === "meta" ? "Meta Ads" : view === "analytics" ? "Analytics" : view === "diagnostics" ? "Diagnósticos FZ" : "Painel";
    if (breadcrumb) breadcrumb.textContent = (view === "google" || view === "meta") ? "Canais" : (view === "analytics" || view === "diagnostics") ? "Inteligência" : "Visão geral";
  }

  function hydrateIdentity() {
    if (!identity) return;
    fetch("/ads/api/session", { credentials: "include", headers: { accept: "application/json" } })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.reason || payload.error || "Falha de sessão");
        const current = payload.identity || {};
        const label = current.name || current.email || current.userId || "Usuário DACH";
        const strong = identity.querySelector("strong");
        const avatar = identity.querySelector(".ads-shell__identity-avatar");
        if (strong) strong.textContent = label;
        if (avatar) avatar.textContent = String(label).trim().slice(0, 1).toUpperCase() || "D";
        identity.title = current.tenantId ? `Tenant: ${current.tenantId}` : "Identidade DACH";
      })
      .catch((error) => {
        const strong = identity.querySelector("strong");
        const small = identity.querySelector("small");
        if (strong) strong.textContent = "Hub pendente";
        if (small) small.textContent = "Identidade";
        identity.title = error.message;
      });
  }

  applyTheme(safeRead(THEME_KEY, "light"));
  applyCollapsed(safeRead(COLLAPSED_KEY, "0") === "1");
  applyView();
  hydrateIdentity();

  themeButton?.addEventListener("click", () => applyTheme(body.classList.contains("theme-dark") ? "light" : "dark"));
  document.querySelectorAll("[data-ads-shell-toggle]").forEach((button) => button.addEventListener("click", () => applyCollapsed(!body.classList.contains("ads-shell-collapsed"))));
  document.querySelector("[data-ads-mobile-open]")?.addEventListener("click", () => body.classList.add("ads-shell-mobile-open"));
  document.querySelector("[data-ads-mobile-close]")?.addEventListener("click", closeMobile);
  document.querySelectorAll("[data-disabled-item]").forEach((item) => item.addEventListener("click", (event) => event.preventDefault()));
  window.addEventListener("resize", () => { if (window.innerWidth > 980) closeMobile(); });
})();
