function hasField(workspace, key) {
  return Object.prototype.hasOwnProperty.call(workspace || {}, key);
}

function mapFiscalWorkspace(workspace, current) {
  if (!hasField(workspace, "fiscalDocuments")) return current;
  return {
    ...current,
    fiscalDocs: (workspace.fiscalDocuments || []).map((document) => ({
      id: document.id,
      sale: document.saleId || "-",
      customer: document.customerName || "Cliente avulso",
      model: document.model,
      status: ({ pending: "Pendente", prepared: "Preparado", sent: "Enviado", issued: "Emitido", authorized: "Autorizado", rejected: "Rejeitado", canceled: "Cancelado", voided: "Inutilizado" })[document.status] || document.status,
      provider: document.metadata?.provider || "-",
      accessKey: document.metadata?.accessKey || "-",
      lastMessage: document.metadata?.lastMessage || "",
      action: document.status === "pending" ? "Preparar" : "Consultar",
    })),
  };
}

export { mapFiscalWorkspace };
