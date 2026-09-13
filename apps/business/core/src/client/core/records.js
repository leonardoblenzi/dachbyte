function productStatus(product) {
  if (product.type === "Servico" || product.category === "Servico") return "Servico";
  return Number(product.stock || 0) < Number(product.min || 0) ? "Critico" : "Ok";
}

function recordKey(record) {
  if (!record) return "";
  return String(
    record.id ||
    record.sku ||
    record.name ||
    record.sale ||
    record.origin ||
    record.label ||
    [record.product, record.date, record.quantity, record.reason].filter(Boolean).join("-") ||
    [record.customer, record.due, record.value].filter(Boolean).join("-")
  );
}

function editRecordPayload(record, key) {
  return { ...record, mode: "edit", editKey: key || recordKey(record) };
}

function confirmRecordPayload({ collection, record, label, actionKind = "deactivate", nextStatus = "Inativo", feedback, request }) {
  const targetLabel = label || record?.name || record?.id || record?.sale || record?.origin || record?.label || "registro";
  return {
    collection,
    actionKind,
    targetKey: recordKey(record),
    targetId: record?.recordId || record?.id || null,
    label: targetLabel,
    nextStatus,
    feedback: feedback || (actionKind === "delete" ? "Registro excluido." : "Registro atualizado."),
    ...(request ? { request } : {}),
  };
}

function updateByKey(items, key, nextItem) {
  return items.map((item) => (recordKey(item) === key ? { ...item, ...nextItem } : item));
}

export {
  confirmRecordPayload,
  editRecordPayload,
  productStatus,
  recordKey,
  updateByKey,
};
