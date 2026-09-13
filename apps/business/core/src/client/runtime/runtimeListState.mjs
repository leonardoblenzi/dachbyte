function markRuntimeResourceFailed(current, resource, message) {
  return {
    ...current,
    [resource]: {
      ...(current[resource] || {}),
      loading: false,
      loaded: false,
      error: message || "Falha ao carregar dados.",
    },
  };
}

const SALE_MUTATION_REFRESH_RESOURCES = Object.freeze([
  "sales",
  "receivables",
  "cashMovements",
  "receipts",
  "serviceOrders",
  "opticalOrders",
]);

const STOCK_MUTATION_REFRESH_RESOURCES = Object.freeze([
  "products",
  "inventoryMovements",
  "stockReservations",
]);

function applyConfirmedSaleCancellation(current, targetId, sale = {}) {
  const expectedId = String(targetId || sale.id || "");
  const sales = Array.isArray(current.sales) ? current.sales : [];
  return {
    ...current,
    sales: sales.map((item) => {
      const itemId = String(item.recordId || item.id || "");
      if (!expectedId || itemId !== expectedId) return item;
      return {
        ...item,
        status: "Cancelada",
        ...(sale.canceledAt ? { canceledAt: sale.canceledAt } : {}),
      };
    }),
  };
}

export { applyConfirmedSaleCancellation, markRuntimeResourceFailed, SALE_MUTATION_REFRESH_RESOURCES, STOCK_MUTATION_REFRESH_RESOURCES };
