import { apiFetch } from "../../core/api";
import { updateByKey } from "../../core/records";
import { addAuditEvent, buildCompanyPath } from "../utils";

function collectDynamicCustomFields(values = {}) {
  return Object.fromEntries(Object.entries(values)
    .filter(([key]) => key.startsWith("custom__"))
    .map(([key, value]) => [key.slice("custom__".length), value]));
}

export function createOperationsSubmitHandlers(context) {
  const { appData, runtimeMode, selectedCompanyId, notify, refreshRuntimeWorkspace, setAppData } = context;
  return {
    async serviceOrder(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const order = { id: isEditing ? editKey : `OS-${2082 + appData.serviceOrders.length}`, customer: values.customer, status: values.status || "Aberta", due: values.due || "Hoje", owner: values.owner || "Balcao" };
      if (runtimeMode === "database") {
        const targetId = values.recordId || (isEditing ? editKey : null);
        const url = isEditing ? buildCompanyPath(selectedCompanyId, `/service-orders/${targetId}`) : buildCompanyPath(selectedCompanyId, "/service-orders");
        await apiFetch(url, { method: isEditing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...values, customFields: collectDynamicCustomFields(values) }) });
        await refreshRuntimeWorkspace();
        notify(isEditing ? "Ordem de servico atualizada." : "Ordem de servico criada.");
        return;
      }
      setAppData((current) => addAuditEvent({ ...current, serviceOrders: isEditing ? updateByKey(current.serviceOrders, editKey, order) : [order, ...current.serviceOrders] }, isEditing ? "OS editada" : "OS criada", `${order.id} - ${order.customer}`));
      notify(isEditing ? "Ordem de servico atualizada." : "Ordem de servico criada.");
    },
    async operationalRules(values) {
      const rules = { requireOpenCashSession: values.requireOpenCashSession === "Sim", allowAnonymousCustomer: values.allowAnonymousCustomer === "Sim", requireInventoryAdjustmentReason: values.requireInventoryAdjustmentReason === "Sim" };
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, "/settings"), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rules) });
        await refreshRuntimeWorkspace();
        notify("Regras operacionais salvas.");
        return;
      }
      setAppData((current) => ({ ...current, settings: { ...current.settings, ...rules } }));
      notify("Regras operacionais salvas.");
    },
  };
}
