import { apiFetch } from "../../core/api";
import { formatCurrency, formatShortDate, parseMoney } from "../../core/formatters";
import { recordKey } from "../../core/records";
import { applyConfirmedSaleCancellation, SALE_MUTATION_REFRESH_RESOURCES, STOCK_MUTATION_REFRESH_RESOURCES } from "../../runtime/runtimeListState.mjs";
import { addAuditEvent, buildCompanyPath } from "../utils";

export function createSharedSubmitHandlers(context) {
  const {
    runtimeMode,
    selectedCompanyId,
    isMasterUser,
    databaseAvailable,
    notify,
    refreshRuntimeWorkspace,
    setAppData,
    setWorkspace,
    workspace,
  } = context;

  return {
    async confirmAction(values) {
      if (runtimeMode === "database" || (isMasterUser && databaseAvailable)) {
        const operation = values.actionKind === "delete" ? "delete" : values.actionKind === "activate" ? "activate" : "deactivate";
        const catalogAction = (basePath) => {
          if (!values.targetId) return null;
          if (operation === "delete") return { url: buildCompanyPath(selectedCompanyId, basePath), method: "DELETE" };
          return { url: buildCompanyPath(selectedCompanyId, `${basePath}/${operation}`), method: "POST" };
        };
        const actions = {
          customers: catalogAction(`/customers/${values.targetId}`),
          products: catalogAction(`/products/${values.targetId}`),
          productCategories: values.targetId ? { url: buildCompanyPath(selectedCompanyId, `/product-categories/${values.targetId}/deactivate`), method: "POST" } : null,
          productBrands: values.targetId ? { url: buildCompanyPath(selectedCompanyId, `/product-brands/${values.targetId}/deactivate`), method: "POST" } : null,
          sales: values.targetId ? {
            url: buildCompanyPath(selectedCompanyId, `/sales/${values.targetId}${operation === "delete" ? "" : "/cancel"}`),
            method: operation === "delete" ? "DELETE" : "POST",
          } : null,
          receivables: values.targetId ? { url: buildCompanyPath(selectedCompanyId, `/receivables/${values.targetId}/cancel`), method: "POST" } : null,
          expenses: values.targetId ? {
            url: buildCompanyPath(selectedCompanyId, `/expenses/${values.targetId}/${values.nextStatus === "Pago" ? "pay" : "cancel"}`),
            method: "POST",
          } : null,
          serviceOrders: values.targetId ? { url: buildCompanyPath(selectedCompanyId, `/service-orders/${values.targetId}`), method: "PATCH", status: "canceled" } : null,
          customFields: values.targetId ? { url: buildCompanyPath(selectedCompanyId, `/configuration/customFields/${values.targetId}`), method: "DELETE" } : null,
          workflows: values.targetId ? { url: buildCompanyPath(selectedCompanyId, `/configuration/workflows/${values.targetId}`), method: "DELETE" } : null,
        };
        const extensionRequest = values.request && values.targetId
          ? {
            url: buildCompanyPath(selectedCompanyId, String(values.request.path || "").replace(":id", values.targetId)),
            method: values.request.method || "PATCH",
            status: values.request.status,
          }
          : null;
        const action = extensionRequest || actions[values.collection];
        if (!action) throw new Error("Este registro e historico e nao pode ser excluido do banco.");
        const response = await apiFetch(action.url, {
          method: action.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: values.reason, status: action.status, paymentMethod: "cash" }),
        });
        if (values.collection === "sales" && operation !== "delete" && response?.sale) {
          setAppData((current) => applyConfirmedSaleCancellation(current, values.targetId, response.sale));
        }
        await refreshRuntimeWorkspace({
          resources: values.collection === "sales" ? SALE_MUTATION_REFRESH_RESOURCES : [],
        });
        if (values.collection === "sales") {
          await refreshRuntimeWorkspace({ resources: STOCK_MUTATION_REFRESH_RESOURCES });
        }
        notify(values.feedback || "Acao confirmada.");
        return;
      }

      setAppData((current) => {
        const collection = values.collection;
        const currentRows = current[collection] || [];
        const shouldToggleActive = collection === "customers" || collection === "products";
        const nextRows = values.actionKind === "delete"
          ? currentRows.filter((item) => recordKey(item) !== values.targetKey)
          : currentRows.map((item) => (
            recordKey(item) === values.targetKey
              ? {
                ...item,
                ...(shouldToggleActive ? { active: values.actionKind === "activate" } : {}),
                status: values.nextStatus || (values.actionKind === "activate" ? "Ativo" : "Inativo"),
              }
              : item
          ));

        return addAuditEvent(
          { ...current, [collection]: nextRows },
          values.auditTitle || "Acao sensivel confirmada",
          `${values.label || "Registro"} - ${values.reason || values.notes || values.nextStatus || "confirmado"}`,
        );
      });
      notify(values.feedback || "Acao confirmada.");
    },

    async settings(values) {
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, "/settings"), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        await refreshRuntimeWorkspace();
        notify("Configuracoes salvas.");
        return;
      }

      setAppData((current) => ({ ...current, settings: { ...current.settings, ...values } }));
      setWorkspace((current) => ({
        ...current,
        configuration: { ...current.configuration, name: values.companyName || current.configuration.name },
        companies: (current.companies || []).map((company) => (
          company.id === selectedCompanyId ? { ...company, name: values.companyName || company.name } : company
        )),
      }));
      notify("Configuracoes salvas.");
    },

    async cashMovement(values) {
      const sessionId = values.sessionId
        || workspace?.cashSummary?.sessionId
        || (workspace?.cashSessions || []).find((session) => session.status === "open")?.id
        || null;
      const payload = {
        ...values,
        sessionId,
        operationalAt: values.operationalAt ? new Date(values.operationalAt).toISOString() : null,
      };
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, "/cash/movements"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        await refreshRuntimeWorkspace();
        notify("Caixa atualizado.");
        return;
      }

      const row = {
        label: payload.description || (payload.type === "exit" ? "Sangria" : "Reforco"),
        type: payload.type === "exit" ? "Saida" : "Entrada",
        value: formatCurrency(parseMoney(payload.amount)),
        time: payload.operationalAt ? formatShortDate(payload.operationalAt) : "Agora",
        operator: "Admin",
      };
      setAppData((current) => addAuditEvent(
        { ...current, cashRows: [row, ...current.cashRows] },
        "Caixa atualizado",
        `${row.type} de ${row.value} - ${row.label}`,
      ));
      notify("Caixa atualizado.");
    },

    async cashSession(values) {
      const closing = values.sessionMode === "close";
      if (runtimeMode === "database") {
        const url = closing
          ? buildCompanyPath(selectedCompanyId, `/cash/sessions/${values.sessionId}/close`)
          : buildCompanyPath(selectedCompanyId, "/cash/sessions");
        await apiFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        await refreshRuntimeWorkspace();
        notify(closing ? "Caixa fechado." : "Caixa aberto.");
        return;
      }

      notify(closing ? "Caixa fechado no modo local." : "Caixa aberto no modo local.");
    },

    async genericConfig(values) {
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, "/configuration/genericConfigs"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        await refreshRuntimeWorkspace();
      }
      notify(values.feedback || "Configuracao salva.");
    },
  };
}
