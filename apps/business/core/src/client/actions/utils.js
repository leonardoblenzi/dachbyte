function makeSaleId(size) {
  return `#${String(1029 + size).padStart(4, "0")}`;
}

function addAuditEvent(current, title, description) {
  const event = {
    title,
    description,
    actor: "Usuario atual",
    time: "Agora",
    status: "info",
    metadata: { source: "interface" },
  };
  return { ...current, auditEvents: [event, ...(current.auditEvents || [])].slice(0, 20) };
}

function buildCompanyPath(selectedCompanyId, path) {
  return `/core/runtime/companies/${selectedCompanyId}${path}`;
}

export {
  addAuditEvent,
  buildCompanyPath,
  makeSaleId,
};
