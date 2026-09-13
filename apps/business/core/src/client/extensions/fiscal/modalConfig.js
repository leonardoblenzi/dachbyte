import { FileCheck2 } from "lucide-react";
function contributeFiscalModalConfig(type, base, ctx) {
  if (type !== "fiscalDocument") return base;
  const { data, payload, editing, editMeta, customerOptions } = ctx;
  return { title: editing ? "Editar documento fiscal" : "Preparar documento fiscal", description: "Controle preparacao, emissao externa, chave fiscal e retorno do provedor.", icon: FileCheck2, submitLabel: editing ? "Salvar alteracoes" : "Preparar documento", fields: [
    { name: "sale", label: "Venda", required: true }, { name: "customer", label: "Cliente", type: "select", options: customerOptions }, { name: "model", label: "Modelo", type: "select", options: ["NFC-e futura", "NF-e futura", "NFS-e futura"] }, { name: "status", label: "Status", type: "select", options: ["Pendente", "Preparado", "Enviado", "Emitido", "Autorizado", "Rejeitado", "Cancelado", "Inutilizado"] }, { name: "provider", label: "Provedor", type: "select", options: ["Nuvem Fiscal", "Focus NFe", "PlugNotas", "Manual"] }, { name: "externalId", label: "ID externo" }, { name: "accessKey", label: "Chave fiscal", wide: true }, { name: "lastMessage", label: "Ultimo retorno", type: "textarea", wide: true },
  ], defaults: { ...editMeta, sale: payload.sale || data.sales[0]?.id || "#", customer: payload.customer || customerOptions[0], model: payload.model || "NFC-e futura", status: payload.status || "Pendente", provider: payload.provider || "Nuvem Fiscal", externalId: payload.externalId || "", accessKey: payload.accessKey === "-" ? "" : payload.accessKey || "", lastMessage: payload.lastMessage || "" } };
}
export { contributeFiscalModalConfig };
