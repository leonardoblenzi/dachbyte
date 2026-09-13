import { apiFetch } from "../../core/api";
import { formatCurrency, formatShortDate, parseMoney } from "../../core/formatters";
import { recordKey, updateByKey } from "../../core/records";
import { addAuditEvent, buildCompanyPath } from "../utils";

function collectDynamicCustomFields(values = {}) {
  return Object.fromEntries(Object.entries(values)
    .filter(([key]) => key.startsWith("custom__"))
    .map(([key, value]) => [key.slice("custom__".length), value]));
}

export function createFinanceSubmitHandlers(context) {
  const {
    runtimeMode,
    selectedCompanyId,
    notify,
    refreshRuntimeWorkspace,
    setAppData,
  } = context;

  return {
    async receivableReceive(values) {
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, `/receivables/${values.receivableId}/receive`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        await refreshRuntimeWorkspace();
        notify("Recebivel baixado.");
        return;
      }

      setAppData((current) => ({
        ...current,
        receivables: current.receivables.map((item) => (
          recordKey(item) === values.receivableId ? { ...item, status: "Pago", value: "R$ 0,00" } : item
        )),
      }));
      notify("Recebivel baixado.");
    },

    async receivableDueDate(values) {
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, `/receivables/${values.receivableId}/due-date`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        await refreshRuntimeWorkspace();
        notify("Vencimento corrigido e registrado na auditoria.");
        return;
      }

      setAppData((current) => addAuditEvent(
        {
          ...current,
          receivables: current.receivables.map((item) => (
            recordKey(item) === values.receivableId
              ? { ...item, dueDate: values.dueDate, due: formatShortDate(values.dueDate) }
              : item
          )),
        },
        "Vencimento de recebivel corrigido",
        `${values.receivableId} - ${values.reason}`,
      ));
      notify("Vencimento corrigido e registrado na auditoria.");
    },

    async receivable(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const receivable = {
        id: values.recordId || editKey || ("rec-" + Date.now()),
        customer: values.customer,
        origin: values.description || "Recebivel manual",
        method: values.method,
        due: formatShortDate(values.dueDate),
        value: formatCurrency(parseMoney(values.amount)),
        status: values.method === "check" ? "Compensar" : "Aberto",
      };
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, "/receivables"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...values, customFields: collectDynamicCustomFields(values) }),
        });
        await refreshRuntimeWorkspace();
        notify("Recebivel cadastrado.");
        return;
      }

      setAppData((current) => addAuditEvent(
        { ...current, receivables: [receivable, ...current.receivables] },
        "Recebivel cadastrado",
        `${receivable.customer} - ${receivable.value}`,
      ));
      notify("Recebivel cadastrado.");
    },

    async receivableStatus(values) {
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, `/receivables/${values.receivableId}/${values.action}`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        await refreshRuntimeWorkspace();
        notify(values.feedback || "Recebivel atualizado.");
        return;
      }

      const status = values.action === "deposit-check" ? "Depositado" : "Devolvido";
      setAppData((current) => ({
        ...current,
        receivables: current.receivables.map((item) => (
          recordKey(item) === values.receivableId ? { ...item, status } : item
        )),
      }));
      notify(values.feedback || "Recebivel atualizado.");
    },

    async paymentMethod(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const method = {
        name: values.name,
        type: values.type,
        fee: values.fee || "0,00%",
        settlement: values.settlement || "Na hora",
        status: "Ativo",
      };
      if (runtimeMode === "database") {
        const payload = await apiFetch(buildCompanyPath(selectedCompanyId, "/payment-methods"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...values, id: isEditing ? editKey : undefined }),
        });
        const saved = payload.paymentMethod || {};
        const persistedMethod = {
          id: saved.id || editKey || method.name,
          name: saved.name || method.name,
          type: saved.kind === "receivable" ? "Recebivel" : "Imediato",
          fee: `${Number(saved.fee || 0).toFixed(2).replace(".", ",")}%`,
          settlement: Number(saved.settlementDays || 0) ? `D+${saved.settlementDays}` : "Na hora",
          status: saved.active === false ? "Inativo" : "Ativo",
        };
        setAppData((current) => ({
          ...current,
          paymentMethods: isEditing
            ? updateByKey(current.paymentMethods || [], editKey, persistedMethod)
            : [persistedMethod, ...(current.paymentMethods || []).filter((item) => item.id !== persistedMethod.id)],
        }));
        notify(isEditing ? "Forma de pagamento atualizada." : "Forma de pagamento salva.");
        return;
      }
      setAppData((current) => addAuditEvent(
        { ...current, paymentMethods: isEditing ? updateByKey(current.paymentMethods, editKey, method) : [method, ...current.paymentMethods] },
        isEditing ? "Forma de pagamento editada" : "Forma de pagamento criada",
        `${method.name} - ${method.settlement}`,
      ));
      notify(isEditing ? "Forma de pagamento atualizada." : "Forma de pagamento salva.");
    },

    async expense(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const expense = {
        name: values.name,
        category: values.category || "Operacional",
        due: values.due || "Hoje",
        value: formatCurrency(parseMoney(values.value)),
        status: "Aberto",
      };
      if (runtimeMode === "database") {
        const url = isEditing
          ? buildCompanyPath(selectedCompanyId, `/expenses/${editKey}`)
          : buildCompanyPath(selectedCompanyId, "/expenses");
        await apiFetch(url, {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...values, customFields: collectDynamicCustomFields(values) }),
        });
        await refreshRuntimeWorkspace();
        notify(isEditing ? "Despesa atualizada." : "Despesa cadastrada.");
        return;
      }
      setAppData((current) => addAuditEvent(
        { ...current, expenses: isEditing ? updateByKey(current.expenses, editKey, expense) : [expense, ...current.expenses] },
        isEditing ? "Despesa editada" : "Despesa cadastrada",
        `${expense.name} - ${expense.value}`,
      ));
      notify(isEditing ? "Despesa atualizada." : "Despesa cadastrada.");
    },
  };
}
