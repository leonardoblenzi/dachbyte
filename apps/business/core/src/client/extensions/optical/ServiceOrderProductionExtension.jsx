import React from "react";
import { Glasses } from "lucide-react";
import { editRecordPayload } from "../../core/records";

function statusKey(order) {
  return String(order?.statusKey || order?.status || "open");
}

function nextStep(order) {
  const status = statusKey(order);
  if (["ready", "delivered"].includes(status)) return { queue: "delivery", action: "Entregar" };
  if (["in_production", "sent_to_lab", "received_from_lab", "quality_check", "rework"].includes(status)) return { queue: "production", action: "Atualizar" };
  if (["waiting_part", "awaiting_lab"].includes(status)) return { queue: "lab", action: "Resolver" };
  return { queue: "triage", action: "Triar" };
}

function buildQueues(serviceOrders) {
  const queues = [
    { id: "triage", title: "Aguardando triagem", description: "Conferir receita, medidas e produtos.", items: [] },
    { id: "lab", title: "Aguardando laboratorio", description: "Definir laboratorio, peca ou material.", items: [] },
    { id: "production", title: "Em producao", description: "Acompanhar execucao e prazo.", items: [] },
    { id: "delivery", title: "Pronto para entrega", description: "Avisar cliente e concluir OS.", items: [] },
  ];
  const byId = Object.fromEntries(queues.map((queue) => [queue.id, queue]));
  for (const order of serviceOrders || []) {
    if (statusKey(order) === "canceled") continue;
    const step = nextStep(order);
    byId[step.queue].items.push({ ...order, nextStep: step });
  }
  return queues;
}

export default function OpticalServiceOrderProduction({ serviceOrders = [], onAction, ui = {} }) {
  const { EmptyContent, Toolbar } = ui;
  const queues = buildQueues(serviceOrders);
  const total = queues.reduce((sum, queue) => sum + queue.items.length, 0);
  return (
    <div className="panel panel-section">
      {Toolbar ? (
        <Toolbar
          title="Fila optica"
          description="Receita, laboratorio, producao, conferencia e entrega das OS opticas."
          icon={Glasses}
        />
      ) : <h3>Fila optica</h3>}
      <div className="production-queue-grid">
        {queues.map((queue) => (
          <div className="production-queue-column" key={queue.id}>
            <div className="kanban-title">
              <div><strong>{queue.title}</strong><small>{queue.description}</small></div>
              <span>{queue.items.length}</span>
            </div>
            {queue.items.map((order) => (
              <div className="production-queue-card" key={order.id}>
                <div>
                  <strong>{order.id} - {order.customer}</strong>
                  <small>{order.service || "Servico nao informado"} | Prazo: {order.due || "nao informado"}</small>
                </div>
                <span className="status-pill">{order.status}</span>
                <button className="table-action" type="button" onClick={() => onAction?.("serviceOrder", editRecordPayload(order))}>
                  {order.nextStep.action}
                </button>
              </div>
            ))}
            {!queue.items.length ? <span className="production-queue-empty">Sem pendencias agora.</span> : null}
          </div>
        ))}
      </div>
      {!total && EmptyContent ? <EmptyContent icon={Glasses} title="Nenhuma OS optica em producao" description="As OS opticas ativas aparecerao aqui." /> : null}
    </div>
  );
}
