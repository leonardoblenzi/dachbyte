import { apiFetch } from "../../core/api";
import { updateByKey } from "../../core/records";
import { addAuditEvent, buildCompanyPath } from "../../actions/utils";

function collectDynamicCustomFields(values = {}) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith("custom__")).map(([key, value]) => [key.slice("custom__".length), value]));
}

export function createOpticalSubmitHandlers(context) {
  const { appData, runtimeMode, selectedCompanyId, notify, refreshRuntimeWorkspace, setAppData } = context;
  return {
    async prescription(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const prescription = { customer: values.customer, doctor: values.doctor || "-", prescription: `OD ${values.od || "-"} / OE ${values.oe || "-"}`, validUntil: values.validUntil || "12 meses", status: "Ativo" };
      if (runtimeMode === "database") {
        const url = isEditing ? buildCompanyPath(selectedCompanyId, `/prescriptions/${editKey}`) : buildCompanyPath(selectedCompanyId, "/prescriptions");
        await apiFetch(url, { method: isEditing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...values, customFields: collectDynamicCustomFields(values) }) });
        await refreshRuntimeWorkspace(); notify(isEditing ? "Receita optica atualizada." : "Receita optica salva."); return;
      }
      setAppData((current) => addAuditEvent({ ...current, prescriptions: isEditing ? updateByKey(current.prescriptions, editKey, prescription) : [prescription, ...current.prescriptions] }, isEditing ? "Receita editada" : "Receita salva", `${prescription.customer} - validade ${prescription.validUntil}`));
      notify(isEditing ? "Receita optica atualizada." : "Receita optica salva.");
    },
    async opticalLab(values) {
      if (runtimeMode === "database") { await apiFetch(buildCompanyPath(selectedCompanyId, "/optical-laboratories"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) }); await refreshRuntimeWorkspace(); notify("Laboratorio salvo."); return; }
      setAppData((current) => ({ ...current, opticalLaboratories: [{ id: `lab-${Date.now()}`, ...values, active: true }, ...(current.opticalLaboratories || [])] })); notify("Laboratorio salvo para teste local.");
    },
    async opticalStatus(values) {
      if (runtimeMode === "database") { await apiFetch(buildCompanyPath(selectedCompanyId, `/optical-orders/${values.opticalOrderId}/status`), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: values.status, notes: values.notes }) }); await refreshRuntimeWorkspace(); notify("Etapa do pedido atualizada."); return; }
      setAppData((current) => ({ ...current, opticalOrders: (current.opticalOrders || []).map((item) => item.id === values.opticalOrderId ? { ...item, status: values.status } : item) })); notify("Etapa do pedido atualizada.");
    },
    async opticalMarkReady(values) {
      if (!values.opticalOrderId) throw new Error("Pedido optico nao encontrado.");
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, `/optical-orders/${values.opticalOrderId}/mark-ready`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes: values.notes || null }) });
        await refreshRuntimeWorkspace({ resources: ["sales", "opticalOrders", "serviceOrders"] });
        notify("Pedido marcado como pronto para retirada.");
        return;
      }
      setAppData((current) => ({
        ...current,
        opticalOrders: (current.opticalOrders || []).map((item) => item.id === values.opticalOrderId ? { ...item, status: "ready" } : item),
        sales: (current.sales || []).map((item) => item.opticalOrderId === values.opticalOrderId ? { ...item, fulfillmentReady: true } : item),
      }));
      notify("Pedido marcado como pronto para retirada.");
    },
  };
}
