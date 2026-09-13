import React from "react";
import { BadgeDollarSign, ClipboardCheck, FileCheck2, LayoutDashboard } from "lucide-react";
import { OperationalList } from "../../components/OperationalList";
import { formatShortDate } from "../../core/formatters";
import { confirmRecordPayload, editRecordPayload } from "../../core/records";

function runtimeOperationalListProps(runtimeData, resource, extraQuery = {}) {
  const state = runtimeData?.lists?.[resource];
  if (!runtimeData?.loadResource || !state?.pagination) return {};
  return {
    serverLoading: Boolean(state.loading),
    serverPagination: state.pagination,
    onServerQueryChange: (query) => runtimeData.loadResource(resource, { ...query, ...extraQuery }, { silent: true }),
  };
}

function commercialStatusLabel(status) {
  const labels = { available: "Disponivel", requested: "Solicitado", contracted: "Contratado", configuring: "Configurando", active: "Ativo", suspended: "Suspenso", coming_soon: "Em breve" };
  return labels[status] || status || "Disponivel";
}

function commercialPlanPrice(plan) {
  if (!plan) return "-";
  if (!plan.monthlyPriceCents) return "Gratis";
  return (plan.monthlyPriceCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function commercialPlanLimit(plan) {
  const limit = plan?.limits?.fiscalDocumentsPerMonth;
  if (limit === undefined || limit === null) return "Sem limite";
  return `${Number(limit).toLocaleString("pt-BR")} documentos/mes`;
}

function FiscalServiceOverview({ fiscal, ui }) {
  const { FeaturePanel, StepList, SummaryLine } = ui;
  const usage = fiscal?.usage;
  return (
    <div className="screen-grid">
      <FeaturePanel title="Plano do Volt Fiscal" icon={BadgeDollarSign} description="Franquia mensal vinculada ao servico fiscal contratado.">
        <SummaryLine label="Status" value={commercialStatusLabel(fiscal?.status)} />
        <SummaryLine label="Plano" value={fiscal?.selectedPlan?.name || "Nao definido"} />
        <SummaryLine label="Mensalidade" value={fiscal?.selectedPlan ? commercialPlanPrice(fiscal.selectedPlan) : "-"} />
        <SummaryLine label="Franquia" value={fiscal?.selectedPlan ? commercialPlanLimit(fiscal.selectedPlan) : "-"} />
      </FeaturePanel>
      <FeaturePanel title="Consumo mensal" icon={FileCheck2} description="O contador sera usado pelas emissoes fiscais do servico.">
        <SummaryLine label="Utilizado" value={usage ? `${usage.used.toLocaleString("pt-BR")} documentos` : "0 documentos"} />
        <SummaryLine label="Disponivel" value={usage?.remaining === null || usage?.remaining === undefined ? "-" : `${usage.remaining.toLocaleString("pt-BR")} documentos`} />
        <SummaryLine label="Periodo" value={usage ? `${formatShortDate(usage.periodStart)} a ${formatShortDate(usage.periodEnd)}` : "Mes atual"} />
      </FeaturePanel>
      <FeaturePanel title="Preparacao fiscal" icon={ClipboardCheck} description="Itens necessarios para a configuracao do emissor.">
        <StepList items={["CNPJ e Inscricao Estadual", "Regime tributario", "Certificado digital A1", "CSC para NFC-e", "Dados fiscais dos produtos", "Serie e numeracao"]} />
      </FeaturePanel>
    </div>
  );
}

function FiscalDocs({ fiscalDocs, onAction, runtimeData, ui }) {
  const { RowActions, StatusPill, Toolbar } = ui;
  const fiscalFilters = ["Todos", "Pendente", "Emitido", "Autorizado", "Rejeitado", "Cancelado"].map((item) => ({ value: item, label: item }));
  return (
    <div className="panel panel-section">
      <Toolbar title="Documentos fiscais" description="Notas e documentos vinculados a vendas." icon={FileCheck2} action="Novo documento" onAction={() => onAction("fiscalDocument")} />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "fiscalDocuments")}
        columns={["Venda", "Cliente", "Modelo", "Provedor", "Chave", "Status", "Acoes"]}
        emptyDescription="Ajuste a busca ou gere um novo documento fiscal."
        emptyTitle="Nenhum documento encontrado"
        filters={fiscalFilters}
        filter={(row, activeFilter) => activeFilter === "Todos" || row.status === activeFilter}
        getItemKey={(row) => row.id || `${row.sale}-${row.model}`}
        items={fiscalDocs}
        renderRow={(row) => (
          <tr key={row.id || `${row.sale}-${row.model}`}>
            <td><strong>{row.sale}</strong></td>
            <td className="entity-main-cell"><strong>{row.customer}</strong><small>{row.lastMessage || row.provider || "-"}</small></td>
            <td>{row.model}</td>
            <td>{row.provider || "-"}</td>
            <td>{row.accessKey || "-"}</td>
            <td><StatusPill status={row.status} /></td>
            <td><RowActions onEdit={() => onAction("fiscalDocument", editRecordPayload(row))} onDeactivate={() => onAction("confirmAction", confirmRecordPayload({ collection: "fiscalDocs", record: row, label: row.sale, nextStatus: "Cancelado", feedback: "Documento fiscal cancelado.", request: { path: "/fiscal-documents/:id", method: "PATCH", status: "canceled" } }))} deactivateLabel="Cancelar" /></td>
          </tr>
        )}
        searchPlaceholder="Buscar por venda, cliente, modelo, provedor, chave ou status"
        searchText={(row) => [row.sale, row.customer, row.model, row.provider, row.accessKey, row.status, row.lastMessage].join(" ")}
      />
    </div>
  );
}

export default function FiscalPage({ data, onAction, runtimeData, workspace, ui }) {
  const { ModulePage } = ui;
  const fiscal = workspace?.configuration?.commercial?.products?.find((product) => product.key === "service.fiscal") || null;
  if (!fiscal?.active) {
    return <ModulePage tabs={[{ id: "overview", label: "Configuracao", icon: ClipboardCheck, content: <FiscalServiceOverview fiscal={fiscal} ui={ui} /> }]} />;
  }
  return <ModulePage tabs={[
    { id: "overview", label: "Visao geral", icon: LayoutDashboard, content: <FiscalServiceOverview fiscal={fiscal} ui={ui} /> },
    { id: "docs", label: "Documentos", icon: FileCheck2, content: <FiscalDocs fiscalDocs={data.fiscalDocs || []} onAction={onAction} runtimeData={runtimeData} ui={ui} /> },
  ]} />;
}
