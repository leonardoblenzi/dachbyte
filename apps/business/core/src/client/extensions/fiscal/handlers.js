import { apiFetch } from "../../core/api";
import { updateByKey } from "../../core/records";
import { addAuditEvent, buildCompanyPath } from "../../actions/utils";

export function createFiscalSubmitHandlers(context) {
  const { runtimeMode, selectedCompanyId, notify, refreshRuntimeWorkspace, setAppData } = context;
  return {
    async fiscalDocument(values) {
      const isEditing = values.mode === "edit"; const editKey = values.editKey;
      const document = { sale: values.sale || "#", customer: values.customer || "Cliente avulso", model: values.model || "NFC-e futura", provider: values.provider || "-", accessKey: values.accessKey || "-", status: values.status || "Pendente", action: "Preparar" };
      if (runtimeMode === "database") {
        const url = isEditing ? buildCompanyPath(selectedCompanyId, `/fiscal-documents/${editKey}`) : buildCompanyPath(selectedCompanyId, "/fiscal-documents");
        await apiFetch(url, { method: isEditing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...values, metadata: { provider: values.provider, accessKey: values.accessKey, externalId: values.externalId, lastMessage: values.lastMessage } }) });
        await refreshRuntimeWorkspace(); notify(isEditing ? "Documento fiscal atualizado." : "Documento fiscal preparado."); return;
      }
      setAppData((current) => addAuditEvent({ ...current, fiscalDocs: isEditing ? updateByKey(current.fiscalDocs, editKey, document) : [document, ...current.fiscalDocs] }, isEditing ? "Documento fiscal editado" : "Documento fiscal preparado", `${document.sale} - ${document.model}`));
      notify(isEditing ? "Documento fiscal atualizado." : "Documento fiscal preparado.");
    },
  };
}
