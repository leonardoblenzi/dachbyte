(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CompactPagination = api;
})(typeof globalThis !== "undefined" ? globalThis : null, function () {
  "use strict";

  function normalizePage(value, totalPages) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(Math.max(parsed, 1), totalPages);
  }

  function buildCompactPagination({ currentPage = 1, totalPages = 1 } = {}) {
    const total = Math.max(1, Number.parseInt(totalPages, 10) || 1);
    const current = normalizePage(currentPage, total);
    const wanted = new Set([1, total, current - 1, current, current + 1]);
    const pages = Array.from(wanted)
      .filter((page) => page >= 1 && page <= total)
      .sort((left, right) => left - right);
    const items = [];
    let previous = 0;

    for (const page of pages) {
      if (previous && page - previous > 1) items.push({ type: "ellipsis" });
      items.push({ type: "page", page });
      previous = page;
    }

    return {
      currentPage: current,
      totalPages: total,
      previousPage: current > 1 ? current - 1 : null,
      nextPage: current < total ? current + 1 : null,
      items,
    };
  }

  return { buildCompactPagination };
});
