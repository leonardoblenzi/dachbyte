function opticalOrderStatusLabel(status) {
  return ({
    awaiting_lab: "Aguardando laboratorio",
    awaiting_measurements: "Aguardando medidas",
    awaiting_prescription: "Aguardando receita",
    canceled: "Cancelado",
    delivered: "Entregue",
    in_production: "Em producao",
    quality_check: "Conferencia",
    ready: "Pronto",
    ready_for_production: "Pronto para producao",
    received_from_lab: "Recebido do laboratorio",
    rework: "Retrabalho",
    sent_to_lab: "Enviado ao laboratorio",
  })[String(status || "").toLowerCase()] || status || "Em aberto";
}

const opticalOrderTransitions = Object.freeze({
  awaiting_prescription: ["awaiting_measurements", "awaiting_lab"],
  awaiting_measurements: ["awaiting_lab", "ready_for_production"],
  awaiting_lab: ["ready_for_production", "sent_to_lab"],
  ready_for_production: ["sent_to_lab", "in_production"],
  sent_to_lab: ["in_production", "received_from_lab"],
  in_production: ["received_from_lab", "rework"],
  received_from_lab: ["quality_check", "rework"],
  quality_check: ["ready", "rework"],
  ready: ["rework"],
  rework: ["sent_to_lab", "in_production", "received_from_lab", "quality_check"],
});

function opticalServiceOrderStatusLabel(status) {
  return ({
    awaiting_lab: "Aguardando laboratorio",
    awaiting_measurements: "Aguardando medidas",
    awaiting_prescription: "Aguardando receita",
    canceled: "Cancelada",
    delivered: "Entregue",
    in_production: "Em producao",
    open: "Aberta",
    quality_check: "Conferencia",
    ready: "Pronto",
    ready_for_production: "Pronto para producao",
    received_from_lab: "Recebido do laboratorio",
    rework: "Retrabalho",
    sent_to_lab: "Enviado ao laboratorio",
    waiting_part: "Aguardando peca",
  })[String(status || "").toLowerCase()] || status || "Aberta";
}

function hasField(workspace, key) {
  return Object.prototype.hasOwnProperty.call(workspace || {}, key);
}

function dateInputValue(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || "";
}

function mapOpticalWorkspace(workspace, current) {
  const next = { ...current };
  if (hasField(workspace, "prescriptions")) next.prescriptions = (workspace.prescriptions || []).map((prescription) => ({
    ...prescription,
    id: prescription.id,
    customerId: prescription.customerId || null,
    customer: prescription.customerName || "-",
    doctor: prescription.doctor || "-",
    od: prescription.rightEye || "",
    oe: prescription.leftEye || "",
    prescription: `OD ${prescription.rightEye || "-"} / OE ${prescription.leftEye || "-"}`,
    examDate: dateInputValue(prescription.examDate),
    validUntil: dateInputValue(prescription.validUntil),
    status: prescription.status === "active" ? "Ativo" : prescription.status,
  }));
  if (hasField(workspace, "opticalLaboratories")) next.opticalLaboratories = workspace.opticalLaboratories || [];
  if (hasField(workspace, "opticalOrders")) next.opticalOrders = (workspace.opticalOrders || []).map((order) => ({
    ...order,
    statusKey: order.status || "",
    status: opticalOrderStatusLabel(order.status),
  }));
  if (Array.isArray(next.sales)) next.sales = next.sales.map((sale) => {
    if (!sale.opticalOrderId || !sale.opticalOrderStatus) return sale;
    const current = sale.opticalOrderStatus;
    const options = [current, ...(opticalOrderTransitions[current] || [])]
      .filter((status) => !["delivered", "canceled"].includes(status))
      .map((status) => ({ value: status, label: opticalOrderStatusLabel(status) }));
    return {
      ...sale,
      fulfillmentReady: current === "ready",
      workflowProgress: {
        current,
        entityId: sale.opticalOrderId,
        entityKey: "opticalOrderId",
        submitType: "opticalStatus",
        options,
        summaryLabel: opticalOrderStatusLabel(current),
        readyLabel: "Pronto para retirada",
        helper: current === "ready" ? "Aguardando retirada" : "Andamento do pedido",
      },
    };
  });
  if (hasField(workspace, "serviceOrders") && Array.isArray(next.serviceOrders)) next.serviceOrders = next.serviceOrders.map((order) => ({
    ...order,
    status: opticalServiceOrderStatusLabel(order.statusKey || order.status),
  }));
  return next;
}

export { mapOpticalWorkspace };
