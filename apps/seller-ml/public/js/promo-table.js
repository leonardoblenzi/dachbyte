// promo-table.js
// Helpers leves de renderizacao para tabela/paginacao da central de promocoes.
(function initPromoTable(global) {
  "use strict";

  if (!global || global.PromoTable) return;

  function renderEmptyState(tbody, message) {
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="9" class="muted">${message}</td></tr>`;
  }

  function renderPagination({
    mount,
    paging,
    pageSize,
    loading,
    onPageName = "goPage",
  }) {
    if (!mount) return;

    const total = Number(paging?.total || 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const cur = Math.min(
      pages,
      Math.max(1, Number(paging?.currentPage || 1)),
    );
    const isLoading = !!loading;

    const MAX_BTNS = 9;
    let start = Math.max(1, cur - Math.floor(MAX_BTNS / 2));
    let end = Math.min(pages, start + MAX_BTNS - 1);
    start = Math.max(1, end - MAX_BTNS + 1);

    const btn = (p, label = String(p), disabled = false, active = false) =>
      `<button class="page-btn${active ? " active" : ""}" ${
        disabled || isLoading ? "disabled" : ""
      } onclick="${onPageName}(${p})">${label}</button>`;

    let html = `<span class="pagination-summary">Pagina ${cur} de ${pages} • ${total} item(ns)</span>`;
    html += btn(Math.max(1, cur - 1), "&lsaquo;", cur === 1);

    if (start > 1) {
      html += btn(1, "1", false, cur === 1);
      if (start > 2) {
        html += `<span class="muted" style="padding:0 6px">&hellip;</span>`;
      }
    }

    for (let p = start; p <= end; p += 1) {
      html += btn(p, String(p), false, p === cur);
    }

    if (end < pages) {
      if (end < pages - 1) {
        html += `<span class="muted" style="padding:0 6px">&hellip;</span>`;
      }
      html += btn(pages, String(pages), false, cur === pages);
    }

    html += btn(Math.min(pages, cur + 1), "&rsaquo;", cur === pages);
    mount.innerHTML = html;
  }

  global.PromoTable = {
    renderEmptyState,
    renderPagination,
  };
})(window);
