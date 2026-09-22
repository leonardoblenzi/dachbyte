(function relocateStockNavigation() {
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

  function apply() {
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
