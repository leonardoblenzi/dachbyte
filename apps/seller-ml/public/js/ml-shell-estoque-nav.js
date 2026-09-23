(function extendSellerNavigation() {
  "use strict";

  function normalizePath(path) {
    return String(path || "/").replace(/\/+$/, "") || "/";
  }

  function getCurrentPath() {
    const pathname = normalizePath(window.location.pathname || "/");
    const base = String(window.ML?.base || window.__ML_BASE__ || "");
    if (base && pathname.startsWith(base)) {
      return normalizePath(pathname.slice(base.length) || "/");
    }
    return pathname;
  }

  function setGroupOpen(group, open) {
    if (!group) return;
    group.classList.toggle("is-open", open);
    const button = group.querySelector("[data-group-toggle]");
    const body = group.querySelector(".sidebar-category__body, .ml-shell__children");
    if (button) button.setAttribute("aria-expanded", open ? "true" : "false");
    if (body) body.hidden = !open;
  }

  function ensureCalculatorLink() {
    const pricingGroup = document.querySelector('[data-group="pricing"]');
    const pricingInner = pricingGroup?.querySelector(".sidebar-category__inner");
    if (!pricingGroup || !pricingInner) return null;

    let link = pricingInner.querySelector('[data-nav-item="financeiro-calculadora-ml"]');
    if (!link) {
      link = document.createElement("a");
      link.className = "ml-shell__link ml-shell__child-link";
      link.dataset.navItem = "financeiro-calculadora-ml";
      link.href = window.mlUrl ? window.mlUrl("/financeiro/calculadora") : "/ml/financeiro/calculadora";
      link.innerHTML = '<span class="ml-shell__label">Calculadora</span>';
      const margin = pricingInner.querySelector('[data-nav-item="financeiro-margem-ml"]');
      if (margin) margin.insertAdjacentElement("afterend", link);
      else pricingInner.appendChild(link);
    }

    const isCalculator = getCurrentPath() === "/financeiro/calculadora";
    link.classList.toggle("is-active", isCalculator);
    if (isCalculator) {
      pricingGroup.classList.add("is-active-category");
      setGroupOpen(pricingGroup, true);

      const breadcrumb = document.querySelector(".ml-shell__breadcrumb");
      const breadcrumbLabels = breadcrumb
        ? Array.from(breadcrumb.querySelectorAll("span")).filter(
            (node) => !node.classList.contains("ml-shell__page-icon"),
          )
        : [];
      const groupLabel = breadcrumbLabels[breadcrumbLabels.length - 1];
      if (groupLabel) groupLabel.textContent = "Precificação";
      const pageTitle = document.querySelector(".ml-shell__page-title");
      if (pageTitle) pageTitle.textContent = "Calculadora";
    }
    return link;
  }

  function relocateStock() {
    const stockLink = document.querySelector('[data-nav-item="estoque-alerta"]');
    const operationsGroup = document.querySelector('[data-group="operations"]');
    const adsGroup = document.querySelector('[data-group="ads"]');
    const operationsInner = operationsGroup?.querySelector(".sidebar-category__inner");
    if (!stockLink || !operationsGroup || !operationsInner) return false;

    const management = operationsInner.querySelector('[data-nav-item="excluir-massa"]');
    if (stockLink.parentElement !== operationsInner || management?.nextElementSibling !== stockLink) {
      if (management) management.insertAdjacentElement("afterend", stockLink);
      else operationsInner.prepend(stockLink);
    }

    const isStock = getCurrentPath() === "/estoque";
    if (isStock) {
      operationsGroup.classList.add("is-active-category");
      adsGroup?.classList.remove("is-active-category");
      setGroupOpen(operationsGroup, true);

      const breadcrumb = document.querySelector(".ml-shell__breadcrumb");
      const breadcrumbLabels = breadcrumb
        ? Array.from(breadcrumb.querySelectorAll("span")).filter(
            (node) => !node.classList.contains("ml-shell__page-icon"),
          )
        : [];
      const groupLabel = breadcrumbLabels[breadcrumbLabels.length - 1];
      if (groupLabel) groupLabel.textContent = "Operações";
    }
    return true;
  }

  function apply() {
    relocateStock();
    ensureCalculatorLink();
  }

  let scheduled = false;
  function scheduleApply() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  }

  const observer = new MutationObserver(scheduleApply);
  function start() {
    if (!document.body) return;
    observer.observe(document.body, { childList: true, subtree: true });
    apply();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
