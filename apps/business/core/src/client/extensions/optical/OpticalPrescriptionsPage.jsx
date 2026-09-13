import React from "react";
import { Building2, Glasses, Wrench } from "lucide-react";
import { OperationalList } from "../../components/OperationalList";
import { formatShortDate } from "../../core/formatters";
import { editRecordPayload } from "../../core/records";
import { formatEyePrescription, formatPrescriptionMeasures } from "./presentation";

function runtimeOperationalListProps(runtimeData, resource, extraQuery = {}) {
  const state = runtimeData?.lists?.[resource];
  if (!runtimeData?.loadResource || !state?.pagination) return {};
  return {
    serverLoading: Boolean(state.loading),
    serverPagination: state.pagination,
    onServerQueryChange: (query) => runtimeData.loadResource(resource, { ...query, ...extraQuery }, { silent: true }),
  };
}

function prescriptionMatchesFilter(prescription, activeFilter) {
  if (activeFilter === "Todos") return true;
  if (activeFilter === "Sem validade") return !prescription.validUntil;
  if (!prescription.validUntil) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (activeFilter === "Vencidas") return prescription.validUntil < today;
  if (activeFilter === "Validas") return prescription.validUntil >= today;
  return true;
}

function opticalOrderNextStep(order) {
  switch (order.statusKey || order.status) {
    case "awaiting_prescription": return { label: "Vincular receita", action: "Resolver" };
    case "awaiting_measurements": return { label: "Informar medidas", action: "Resolver" };
    case "awaiting_lab": return { label: "Escolher laboratorio", action: "Resolver" };
    case "ready_for_production": return { label: "Enviar ao laboratorio", action: "Enviar" };
    case "sent_to_lab":
    case "in_production": return { label: "Acompanhar producao", action: "Atualizar" };
    case "received_from_lab":
    case "quality_check": return { label: "Conferir qualidade", action: "Conferir" };
    case "ready": return { label: "Avisar cliente", action: "Avisar" };
    case "delivered": return { label: "Entregue", action: "Ver" };
    case "rework": return { label: "Tratar retrabalho", action: "Resolver" };
    case "canceled": return { label: "Cancelado", action: "Ver" };
    default: return { label: "Atualizar etapa", action: "Atualizar" };
  }
}

function OpticalForm({ prescriptions, onAction, runtimeData, ui }) {
  const { Toolbar } = ui;
  return (
    <div className="panel panel-section">
      <Toolbar title="Receitas opticas" description="Receitas estruturadas por cliente, medico e validade." icon={Glasses} action="Nova receita" onAction={() => onAction("prescription")} />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "prescriptions")}
        columns={["Cliente", "Medico", "OD", "OE", "DNP/DP", "Validade", "Acoes"]}
        emptyDescription="Cadastre uma receita pelo botao Nova receita ou pelo PDV optico quando a venda precisar."
        emptyTitle="Nenhuma receita cadastrada"
        filters={["Todos", "Validas", "Sem validade", "Vencidas"].map((item) => ({ value: item, label: item }))}
        filter={prescriptionMatchesFilter}
        getItemKey={(prescription) => prescription.id || `${prescription.customer}-${prescription.validUntil}`}
        items={prescriptions}
        renderRow={(prescription) => (
          <tr key={prescription.id || `${prescription.customer}-${prescription.validUntil}`}>
            <td className="entity-main-cell"><strong>{prescription.customer || "Cliente nao informado"}</strong><small>{prescription.prescriptionType || "Receita optica"}</small></td>
            <td>{prescription.doctor || "Nao informado"}</td>
            <td>{formatEyePrescription(prescription, "right")}</td>
            <td>{formatEyePrescription(prescription, "left")}</td>
            <td>{formatPrescriptionMeasures(prescription)}</td>
            <td>{prescription.validUntil ? formatShortDate(prescription.validUntil) : "Sem validade"}</td>
            <td><button className="table-action" type="button" onClick={() => onAction("prescription", editRecordPayload(prescription))}>Editar</button></td>
          </tr>
        )}
        searchPlaceholder="Buscar por cliente, medico, validade ou grau"
        searchText={(prescription) => [
          prescription.customer,
          prescription.doctor,
          prescription.doctorCrm,
          prescription.validUntil,
          prescription.prescriptionType,
          formatEyePrescription(prescription, "right"),
          formatEyePrescription(prescription, "left"),
          formatPrescriptionMeasures(prescription),
        ].join(" ")}
      />
    </div>
  );
}

function OpticalWorkflow({ data, onAction, runtimeData, ui }) {
  const { StatusPill, Toolbar } = ui;
  const opticalOrders = data.opticalOrders || [];
  const opticalFilters = ["Todos", "Aguardando receita", "Aguardando medidas", "Aguardando laboratorio", "Pronto para producao", "Enviado ao laboratorio", "Em producao", "Conferencia", "Pronto", "Entregue"]
    .map((item) => ({ value: item, label: item }));
  return (
    <div className="panel panel-section">
      <Toolbar title="Producao optica" description="Pedidos opticos criados pelo PDV, do laboratorio ate a entrega." icon={Wrench} />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "opticalOrders")}
        columns={["Pedido", "Cliente", "Venda/OS", "Produtos", "Laboratorio", "Entrega", "Status", "Proximo passo", "Acoes"]}
        emptyDescription="Pedidos serao criados automaticamente pelo PDV optico."
        emptyTitle="Nenhum pedido optico"
        filters={opticalFilters}
        filter={(order, activeFilter) => activeFilter === "Todos" || order.status === activeFilter}
        getItemKey={(order) => order.id}
        items={opticalOrders}
        renderRow={(order) => {
          const nextStep = opticalOrderNextStep(order);
          return (
            <tr key={order.id}>
              <td><strong>OP-{order.number}</strong></td>
              <td className="entity-main-cell"><strong>{order.customerName}</strong><small>{order.laboratoryName || "Laboratorio a definir"}</small></td>
              <td>#{order.saleNumber} / OS-{order.serviceOrderNumber}</td>
              <td>{[order.frameName, order.lensName].filter(Boolean).join(" + ") || "-"}</td>
              <td>{order.laboratoryName || "A definir"}</td>
              <td>{formatShortDate(order.promisedDate)}</td>
              <td><StatusPill status={order.status} /></td>
              <td><span className="next-step-pill">{nextStep.label}</span></td>
              <td><button className="button-secondary" type="button" onClick={() => onAction("opticalStatus", { ...order, nextAction: nextStep.label })}>{nextStep.action}</button></td>
            </tr>
          );
        }}
        searchPlaceholder="Buscar por pedido, cliente, OS, produto, laboratorio, entrega ou status"
        searchText={(order) => [opticalOrderNextStep(order).label, `OP-${order.number}`, order.customerName, order.saleNumber, order.serviceOrderNumber, order.frameName, order.lensName, order.laboratoryName, formatShortDate(order.promisedDate), order.status].join(" ")}
      />
    </div>
  );
}

function OpticalLaboratories({ laboratories, onAction, ui }) {
  const { StatusPill, Toolbar } = ui;
  return (
    <div className="panel panel-section">
      <Toolbar title="Laboratorios parceiros" description="Contatos e prazos usados na producao optica." icon={Building2} action="Novo laboratorio" onAction={() => onAction("opticalLab")} />
      <OperationalList
        columns={["Laboratorio", "Contato", "Telefone", "Prazo padrao", "Status"]}
        emptyDescription="Cadastre laboratorios para usar nos pedidos opticos."
        emptyTitle="Nenhum laboratorio encontrado"
        filters={["Todos", "Ativos", "Inativos"].map((item) => ({ value: item, label: item }))}
        filter={(lab, activeFilter) => activeFilter === "Todos" || (activeFilter === "Ativos" && lab.active) || (activeFilter === "Inativos" && !lab.active)}
        getItemKey={(lab) => lab.id || lab.name}
        items={laboratories}
        renderRow={(lab) => (
          <tr key={lab.id || lab.name}>
            <td className="entity-main-cell"><strong>{lab.name}</strong><small>{lab.email || "Sem e-mail"}</small></td>
            <td>{lab.contactName || lab.email || "-"}</td>
            <td>{lab.phone || "-"}</td>
            <td>{lab.defaultLeadDays} dias</td>
            <td><StatusPill status={lab.active ? "Ativo" : "Inativo"} /></td>
          </tr>
        )}
        searchPlaceholder="Buscar por laboratorio, contato, telefone, prazo ou status"
        searchText={(lab) => [lab.name, lab.contactName, lab.email, lab.phone, lab.defaultLeadDays, lab.active ? "Ativo" : "Inativo"].join(" ")}
      />
    </div>
  );
}

export default function OpticalPrescriptionsPage({ data, onAction, runtimeData, ui }) {
  const { ModulePage } = ui;
  return (
    <ModulePage tabs={[
      { id: "prescription", label: "Receita", icon: Glasses, content: <OpticalForm prescriptions={data.prescriptions || []} onAction={onAction} runtimeData={runtimeData} ui={ui} /> },
      { id: "orders", label: "Pedidos opticos", icon: Wrench, content: <OpticalWorkflow data={data} onAction={onAction} runtimeData={runtimeData} ui={ui} /> },
      { id: "labs", label: "Laboratorios", icon: Building2, content: <OpticalLaboratories laboratories={data.opticalLaboratories || []} onAction={onAction} ui={ui} /> },
    ]} />
  );
}
