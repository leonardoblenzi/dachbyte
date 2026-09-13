import { mapFiscalWorkspace } from "./workspaceMapper";
import { contributeFiscalModalConfig } from "./modalConfig";
const fiscalManifest = Object.freeze({
  key: "service.fiscal",
  kind: "service",
  activationCapability: "service.fiscal",
  runtimeResources: Object.freeze({
    fiscalDocuments: Object.freeze({ path: "fiscal-documents", capability: "fiscal.documents", paged: true }),
  }),
  pageResources: Object.freeze({
    fiscal: Object.freeze(["fiscalDocuments", "customers", "sales"]),
  }),
  accessAreas: Object.freeze([{ screen: "fiscal", label: "Emissor Fiscal", read: "fiscal:read", write: "fiscal:write" }]),
  rolePermissions: Object.freeze({
    manager: Object.freeze(["fiscal:read", "fiscal:write"]),
    finance: Object.freeze(["fiscal:read"]),
  }),
  nav: Object.freeze({ group: "services", id: "fiscal", name: "Emissor Fiscal", icon: "file-check", capability: "service.fiscal" }),
  pages: Object.freeze({
    fiscal: Object.freeze({
      capability: "service.fiscal",
      readPermission: "fiscal:read",
      title: "Emissor Fiscal",
      description: "Documentos fiscais e configuracao do Volt Fiscal.",
      load: () => import("./FiscalPage.jsx"),
    }),
  }),
  mapWorkspace: mapFiscalWorkspace,
  contributeModalConfig: contributeFiscalModalConfig,
  async loadSubmitHandlers() {
    const module = await import("./handlers.js");
    return module.createFiscalSubmitHandlers;
  },
});

export default fiscalManifest;
