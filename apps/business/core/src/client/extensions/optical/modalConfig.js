import { Building2, Glasses, Wrench } from "lucide-react";

function contributeOpticalModalConfig(type, base, ctx) {
  const { data, payload, editing, editMeta, customerOptions, buildDynamicFields, workflowStatusOptions, buildDynamicDefaults, productModalCategoryOptions } = ctx;
  const prescriptionDynamicFields = buildDynamicFields(data.customFields, "Receita optica");
  const opticalOrderStatusOptions = workflowStatusOptions(data, "optical_order", [
    { value: "awaiting_prescription", label: "Aguardando receita" },
    { value: "awaiting_measurements", label: "Aguardando medidas" },
    { value: "awaiting_lab", label: "Aguardando laboratorio" },
    { value: "ready_for_production", label: "Pronto para producao" },
    { value: "sent_to_lab", label: "Enviado ao laboratorio" },
    { value: "in_production", label: "Em producao" },
    { value: "received_from_lab", label: "Recebido do laboratorio" },
    { value: "quality_check", label: "Conferencia" },
    { value: "ready", label: "Pronto" },
    { value: "delivered", label: "Entregue" },
    { value: "rework", label: "Retrabalho" },
    { value: "canceled", label: "Cancelado" },
  ]);
  if (type === "product" && base) {
    const opticalProduct = payload.extensions?.["vertical.optical"] || payload;
    const natureIndex = base.fields.findIndex((field) => field.name === "type");
    const itemKindField = { name: "itemKind", label: "O que voce esta cadastrando?", type: "select", options: [
      { value: "frame", label: "Armacao" }, { value: "lens_stock", label: "Lente que tenho em estoque" },
      { value: "lens_order", label: "Lente encomendada quando vendo" }, { value: "service", label: "Servico optico" },
      { value: "accessory", label: "Acessorio" }, { value: "product", label: "Outro produto" },
    ], valuePresets: {
      frame: { type: "Produto", category: "Armacoes", opticalType: "frame" },
      lens_stock: { type: "Produto", category: "Lentes", opticalType: "lens" },
      lens_order: { type: "Servico", category: "Lentes", opticalType: "lens", stock: "0", min: "0" },
      service: { type: "Servico", category: "Servicos", opticalType: "", stock: "0", min: "0" },
      accessory: { type: "Produto", category: "Acessorios", opticalType: "" },
      product: { type: "Produto", category: "Produtos", opticalType: "" },
    }, wide: true };
    const opticalFields = [
      ...(editing ? [{ name: "opticalType", label: "Classificacao optica", type: "select", options: [{ value: "", label: "Item geral" }, { value: "frame", label: "Armacao" }, { value: "lens", label: "Lente" }, { value: "treatment", label: "Tratamento" }] }] : []),
      { name: "opticalSize", label: "Tamanho / calibre", visibleWhen: { name: "itemKind", value: "frame" } },
      { name: "opticalColor", label: "Cor", visibleWhen: { name: "itemKind", value: ["frame", "accessory"] } },
      { name: "opticalMaterial", label: "Material", visibleWhen: { name: "itemKind", value: ["frame", "lens_stock", "lens_order"] } },
      { name: "refractiveIndex", label: "Indice de refracao", visibleWhen: { name: "itemKind", value: ["lens_stock", "lens_order"] } },
      { name: "opticalTreatment", label: "Tratamento", visibleWhen: { name: "itemKind", value: ["lens_stock", "lens_order"] } },
    ];
    const fields = [...base.fields];
    if (!editing) fields.splice(Math.max(0, natureIndex), 1, itemKindField);
    const categoryIndex = fields.findIndex((field) => field.name === "category");
    fields.splice(categoryIndex + 1, 0, ...opticalFields);
    return {
      ...base,
      fields,
      defaults: {
        ...base.defaults,
        itemKind: payload.itemKind || (opticalProduct.opticalType === "frame" ? "frame" : opticalProduct.opticalType === "lens" ? (opticalProduct.catalogType === "Lente encomendada" ? "lens_order" : "lens_stock") : payload.type === "Servico" ? "service" : "frame"),
        category: payload.category || (payload.status === "Servico" ? "Servicos" : "Armacoes" || productModalCategoryOptions[0] || ""),
        opticalType: opticalProduct.opticalType || (!editing ? "frame" : ""),
        opticalSize: opticalProduct.opticalSpecs?.size || "",
        opticalColor: opticalProduct.opticalSpecs?.color || "",
        opticalMaterial: opticalProduct.opticalSpecs?.material || "",
        refractiveIndex: opticalProduct.opticalSpecs?.refractiveIndex || "",
        opticalTreatment: opticalProduct.opticalSpecs?.treatment || "",
      },
    };
  }
  if (type === "prescription") {
    const selectedCustomer = data.customers.find((customer) => (
      customer.id === payload.customerId || customer.name === payload.customer
    ));
    return {
      title: editing ? "Editar receita optica" : "Nova receita optica", description: "Registre a receita e deixe pronta para vincular a uma OS.", icon: Glasses, submitLabel: editing ? "Salvar alteracoes" : "Salvar receita",
      fields: [
      { name: "customer", label: "Cliente", type: "customer_lookup", resource: "customers", idField: "customerId", required: true }, { name: "doctor", label: "Medico" }, { name: "doctorCrm", label: "CRM" }, { name: "doctorUf", label: "UF" },
      { name: "examDate", label: "Data do exame", type: "date" }, { name: "validUntil", label: "Validade", type: "date" }, { name: "prescriptionType", label: "Tipo", type: "select", options: ["distance", "near", "multifocal"] },
      { name: "rightSpherical", label: "OD esferico", type: "number", step: "0.25" }, { name: "rightCylindrical", label: "OD cilindrico", type: "number", step: "0.25" }, { name: "rightAxis", label: "OD eixo", type: "number", min: "0", max: "180", step: "1" }, { name: "rightAddition", label: "OD adicao", type: "number", min: "0", step: "0.25" }, { name: "rightDnp", label: "DNP OD", type: "number", min: "0", step: "0.5" }, { name: "rightHeight", label: "Altura OD", type: "number", min: "0", step: "0.5" },
      { name: "leftSpherical", label: "OE esferico", type: "number", step: "0.25" }, { name: "leftCylindrical", label: "OE cilindrico", type: "number", step: "0.25" }, { name: "leftAxis", label: "OE eixo", type: "number", min: "0", max: "180", step: "1" }, { name: "leftAddition", label: "OE adicao", type: "number", min: "0", step: "0.25" }, { name: "leftDnp", label: "DNP OE", type: "number", min: "0", step: "0.5" }, { name: "leftHeight", label: "Altura OE", type: "number", min: "0", step: "0.5" }, { name: "pupillaryDistance", label: "DP total", type: "number", min: "0", step: "0.5" },
      ...prescriptionDynamicFields, { name: "notes", label: "Observacoes tecnicas", type: "textarea", wide: true },
    ],
      defaults: { ...editMeta, customer: payload.customer || selectedCustomer?.name || "", customerId: payload.customerId || selectedCustomer?.id || "", doctor: payload.doctor || "", doctorCrm: payload.doctorCrm || "", doctorUf: payload.doctorUf || "", examDate: payload.examDate || "", validUntil: payload.validUntil || "", prescriptionType: payload.prescriptionType || "distance", rightSpherical: payload.rightSpherical ?? "", rightCylindrical: payload.rightCylindrical ?? "", rightAxis: payload.rightAxis ?? "", rightAddition: payload.rightAddition ?? "", rightDnp: payload.rightDnp ?? "", rightHeight: payload.rightHeight ?? "", leftSpherical: payload.leftSpherical ?? "", leftCylindrical: payload.leftCylindrical ?? "", leftAxis: payload.leftAxis ?? "", leftAddition: payload.leftAddition ?? "", leftDnp: payload.leftDnp ?? "", leftHeight: payload.leftHeight ?? "", pupillaryDistance: payload.pupillaryDistance ?? "", ...buildDynamicDefaults(prescriptionDynamicFields, payload.customFields), notes: payload.notes || "" },
    };
  }
  if (type === "opticalLab") return { title: "Novo laboratorio", description: "Cadastre contato e prazo padrao de producao.", icon: Building2, submitLabel: "Salvar laboratorio", fields: [{ name: "name", label: "Nome", required: true }, { name: "document", label: "CNPJ" }, { name: "contactName", label: "Contato" }, { name: "phone", label: "Telefone" }, { name: "email", label: "E-mail", type: "email" }, { name: "defaultLeadDays", label: "Prazo em dias", type: "number", min: "0", step: "1", required: true }, { name: "notes", label: "Observacoes", type: "textarea", wide: true }], defaults: { name: "", document: "", contactName: "", phone: "", email: "", defaultLeadDays: "7", notes: "" } };
  if (type === "opticalStatus") return { title: `Atualizar pedido OP-${payload.number || ""}`, description: "Avance a producao e mantenha a equipe informada.", icon: Wrench, submitLabel: "Atualizar etapa", fields: [{ name: "status", label: "Etapa", type: "select", options: opticalOrderStatusOptions }, { name: "notes", label: "Observacao", type: "textarea", wide: true }], defaults: { opticalOrderId: payload.id, status: payload.statusKey || "awaiting_lab", notes: payload.notes || "" } };
  return base;
}

export { contributeOpticalModalConfig };
