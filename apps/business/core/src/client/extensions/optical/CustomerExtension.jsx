import React from "react";
import { Glasses, Wrench } from "lucide-react";
import { formatShortDate } from "../../core/formatters";
import { formatEyePrescription } from "./presentation";

function normalizeFilterText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function matchesCustomer(customer, value, id) {
  if (id && customer?.id && String(id) === String(customer.id)) return true;
  return normalizeFilterText(value) === normalizeFilterText(customer?.name);
}

function customerOpticalData(customer, data = {}) {
  const prescriptions = (data.prescriptions || []).filter((item) => matchesCustomer(customer, item.customer, item.customerId));
  const serviceOrders = (data.serviceOrders || []).filter((item) => matchesCustomer(customer, item.customer, item.customerId));
  const opticalOrders = (data.opticalOrders || []).filter((item) => matchesCustomer(customer, item.customerName, item.customerId));
  return { prescriptions, serviceOrders, opticalOrders };
}

function CustomerOpticalPanel({ customer, data, ui }) {
  const { EmptyContent, HistoryRow, Toolbar } = ui;
  const { prescriptions, serviceOrders, opticalOrders } = customerOpticalData(customer, data);
  return (
    <div className="screen-grid">
      <div className="panel panel-section">
        <Toolbar title="Receitas" description="Receitas opticas cadastradas para o cliente." icon={Glasses} />
        <div className="customer-detail-list">
          {prescriptions.map((item) => (
            <HistoryRow key={item.id} title={item.validUntil ? formatShortDate(item.validUntil) : "Sem validade"} detail={`${formatEyePrescription(item, "right")} | ${formatEyePrescription(item, "left")}`} meta={item.doctor || "-"} status="Ativo" />
          ))}
          {!prescriptions.length ? <EmptyContent icon={Glasses} title="Sem receitas" description="As receitas cadastradas aparecerao aqui." /> : null}
        </div>
      </div>
      <div className="panel panel-section">
        <Toolbar title="Pedidos e OS" description="Pedidos opticos, producao e atendimento." icon={Wrench} />
        <div className="customer-detail-list">
          {opticalOrders.map((item) => (
            <HistoryRow key={`op-${item.id}`} title={`Pedido OP-${item.number || item.id}`} detail={[item.lensName, item.frameName, item.laboratoryName].filter(Boolean).join(" + ") || item.nextAction || "Pedido optico"} meta={formatShortDate(item.promisedDate)} status={item.status} />
          ))}
          {serviceOrders.map((item) => (
            <HistoryRow key={`os-${item.id}`} title={`OS ${item.id}`} detail={item.service || item.notes || "Ordem de servico"} meta={item.due} status={item.status} />
          ))}
          {!opticalOrders.length && !serviceOrders.length ? <EmptyContent icon={Wrench} title="Sem pedidos opticos" description="OS e producao aparecerao aqui." /> : null}
        </div>
      </div>
    </div>
  );
}

function CustomerOpticalSummaryCard({ customer, data, ui }) {
  const { ReportCard } = ui;
  const { prescriptions } = customerOpticalData(customer, data);
  const lastPrescription = prescriptions[0];
  return <ReportCard icon={Glasses} title="Receita atual" value={lastPrescription?.validUntil ? formatShortDate(lastPrescription.validUntil) : "Sem receita"} detail={lastPrescription ? formatEyePrescription(lastPrescription, "right") : "Cadastre antes ou durante a venda"} />;
}

function CustomerOpticalHistorySection({ customer, data, ui }) {
  const { EmptyContent, HistoryRow, SummaryLine } = ui;
  const { prescriptions, serviceOrders, opticalOrders } = customerOpticalData(customer, data);
  const lastPrescription = prescriptions[0];
  const timeline = [
    ...opticalOrders.map((order) => ({ key: `opt-${order.id}`, title: `Pedido optico OP-${order.number || order.id}`, detail: [order.lensName, order.frameName, order.laboratoryName].filter(Boolean).join(" + ") || order.nextAction || "Pedido optico", status: order.status, date: formatShortDate(order.promisedDate) })),
    ...serviceOrders.map((order) => ({ key: `os-${order.id}`, title: `OS ${order.id}`, detail: order.service || order.notes || "Ordem de servico", status: order.status, date: order.due })),
  ];
  return (
    <>
      <section className="customer-history-card">
        <h3>Receita atual</h3>
        {lastPrescription ? (
          <>
            <SummaryLine label="Medico" value={lastPrescription.doctor || "Nao informado"} />
            <SummaryLine label="Validade" value={lastPrescription.validUntil ? formatShortDate(lastPrescription.validUntil) : "Sem validade"} />
            <SummaryLine label="OD" value={formatEyePrescription(lastPrescription, "right")} />
            <SummaryLine label="OE" value={formatEyePrescription(lastPrescription, "left")} />
          </>
        ) : <EmptyContent icon={Glasses} title="Sem receita salva" description="Cadastre uma receita antes ou durante a venda optica." />}
      </section>
      <section className="customer-history-card">
        <h3>Pedidos opticos e OS</h3>
        {timeline.slice(0, 6).map((item) => <HistoryRow key={item.key} title={item.title} detail={item.detail} meta={item.date || "Sem prazo"} status={item.status} />)}
        {!timeline.length ? <EmptyContent icon={Wrench} title="Sem producao optica" description="Pedidos opticos e OS vinculados aparecerao aqui." /> : null}
      </section>
    </>
  );
}

export { CustomerOpticalHistorySection, CustomerOpticalPanel, CustomerOpticalSummaryCard };
