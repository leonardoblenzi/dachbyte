import { apiFetch } from "../../core/api";
import { updateByKey } from "../../core/records";
import { addAuditEvent, buildCompanyPath } from "../utils";

function collectDynamicCustomFields(values = {}) {
  return Object.fromEntries(Object.entries(values)
    .filter(([key]) => key.startsWith("custom__"))
    .map(([key, value]) => [key.slice("custom__".length), value]));
}

export function createOpticalSubmitHandlers(context) {
  const {
    appData,
    runtimeMode,
    selectedCompanyId,
    notify,
    refreshRuntimeWorkspace,
    setAppData,
  } = context;

  return {
    async serviceOrder(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const order = {
        id: isEditing ? editKey : `OS-${2082 + appData.serviceOrders.length}`,
        customer: values.customer,
        status: values.status || "Aberta",
        due: values.due || "Hoje",
        owner: values.owner || "Balcao",
      };
      if (runtimeMode === "database") {
        const targetId = values.recordId || (isEditing ? editKey : null);
        const url = isEditing
          ? buildCompanyPath(selectedCompanyId, `/service-orders/${targetId}`)
          : buildCompanyPath(selectedCompanyId, "/service-orders");
        await apiFetch(url, {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...values, customFields: collectDynamicCustomFields(values) }),
        });
        await refreshRuntimeWorkspace();
        notify(isEditing ? "Ordem de servico atualizada." : "Ordem de servico criada.");
        return;
      }
      setAppData((current) => addAuditEvent(
        { ...current, serviceOrders: isEditing ? updateByKey(current.serviceOrders, editKey, order) : [order, ...current.serviceOrders] },
        isEditing ? "OS editada" : "OS criada",
        `${order.id} - ${order.customer}`,
      ));
      notify(isEditing ? "Ordem de servico atualizada." : "Ordem de servico criada.");
    },

    async prescription(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const prescription = {
        customer: values.customer,
        doctor: values.doctor || "-",
        prescription: `OD ${values.od || "-"} / OE ${values.oe || "-"}`,
        validUntil: values.validUntil || "12 meses",
        status: "Ativo",
      };
      if (runtimeMode === "database") {
        const url = isEditing
          ? buildCompanyPath(selectedCompanyId, `/prescriptions/${editKey}`)
          : buildCompanyPath(selectedCompanyId, "/prescriptions");
        await apiFetch(url, {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...values, customFields: collectDynamicCustomFields(values) }),
        });
        await refreshRuntimeWorkspace();
        notify(isEditing ? "Receita optica atualizada." : "Receita optica salva.");
        return;
      }
      setAppData((current) => addAuditEvent(
        { ...current, prescriptions: isEditing ? updateByKey(current.prescriptions, editKey, prescription) : [prescription, ...current.prescriptions] },
        isEditing ? "Receita editada" : "Receita salva",
        `${prescription.customer} - validade ${prescription.validUntil}`,
      ));
      notify(isEditing ? "Receita optica atualizada." : "Receita optica salva.");
    },

    async operationalRules(values) {
      const rules = {
        requireOpenCashSession: values.requireOpenCashSession === "Sim",
        allowAnonymousCustomer: values.allowAnonymousCustomer === "Sim",
        requireInventoryAdjustmentReason: values.requireInventoryAdjustmentReason === "Sim",
      };
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, "/settings"), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rules),
        });
        await refreshRuntimeWorkspace();
        notify("Regras operacionais salvas.");
        return;
      }
      setAppData((current) => ({ ...current, settings: { ...current.settings, ...rules } }));
      notify("Regras operacionais salvas.");
    },

    async opticalLab(values) {
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, "/optical-laboratories"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        await refreshRuntimeWorkspace();
        notify("Laboratorio salvo.");
        return;
      }
      setAppData((current) => ({ ...current, opticalLaboratories: [{ id: `lab-${Date.now()}`, ...values, active: true }, ...(current.opticalLaboratories || [])] }));
      notify("Laboratorio salvo para teste local.");
    },

    async opticalStatus(values) {
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, `/optical-orders/${values.opticalOrderId}/status`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: values.status, notes: values.notes }),
        });
        await refreshRuntimeWorkspace();
        notify("Etapa do pedido atualizada.");
        return;
      }
      setAppData((current) => ({ ...current, opticalOrders: (current.opticalOrders || []).map((item) => item.id === values.opticalOrderId ? { ...item, status: values.status } : item) }));
      notify("Etapa do pedido atualizada.");
    },

    async opticalMarkReady(values) {
      if (!values.opticalOrderId) throw new Error("Pedido optico nao encontrado.");
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, `/optical-orders/${values.opticalOrderId}/mark-ready`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: values.notes || null }),
        });
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

    async fiscalDocument(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const document = {
        sale: values.sale || "#",
        customer: values.customer || "Cliente avulso",
        model: values.model || "NFC-e futura",
        provider: values.provider || "-",
        accessKey: values.accessKey || "-",
        status: values.status || "Pendente",
        action: "Preparar",
      };
      if (runtimeMode === "database") {
        const url = isEditing
          ? buildCompanyPath(selectedCompanyId, `/fiscal-documents/${editKey}`)
          : buildCompanyPath(selectedCompanyId, "/fiscal-documents");
        await apiFetch(url, {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...values,
            metadata: {
              provider: values.provider,
              accessKey: values.accessKey,
              externalId: values.externalId,
              lastMessage: values.lastMessage,
            },
          }),
        });
        await refreshRuntimeWorkspace();
        notify("Documento fiscal preparado.");
        return;
      }
      setAppData((current) => addAuditEvent(
        { ...current, fiscalDocs: isEditing ? updateByKey(current.fiscalDocs, editKey, document) : [document, ...current.fiscalDocs] },
        isEditing ? "Documento fiscal editado" : "Documento fiscal preparado",
        `${document.sale} - ${document.model}`,
      ));
      notify(isEditing ? "Documento fiscal atualizado." : "Documento fiscal preparado.");
    },
  };
}
