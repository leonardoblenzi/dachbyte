const general = require("./general");
const { workflows } = require("../workflows/workflowRegistry");

module.exports = {
  segmentKey: "optical",
  name: "Otica",
  description: "Template inicial para oticas com vendas, estoque, OS e receita optica.",
  defaultModules: [
    ...general.defaultModules,
    "service_orders",
    "optical_prescriptions",
  ],
  defaultScreens: [
    ...general.defaultScreens.filter((screen) => screen !== "reports"),
    "service_orders",
    "optical_prescriptions",
    "reports",
  ],
  defaultCategories: [
    ...general.defaultCategories,
    "Armacoes",
    "Lentes",
  ],
  defaultStatuses: [
    ...general.defaultStatuses.filter((status) => status !== "cancelado"),
    "em_producao",
    "pronto",
    "entregue",
    "cancelado",
  ],
  defaultFields: [
    ...general.defaultFields,
    { entity: "optical_prescription", key: "right_eye_spherical", label: "OD Esferico", type: "number" },
    { entity: "optical_prescription", key: "right_eye_cylindrical", label: "OD Cilindrico", type: "number" },
    { entity: "optical_prescription", key: "right_eye_axis", label: "OD Eixo", type: "number" },
    { entity: "optical_prescription", key: "left_eye_spherical", label: "OE Esferico", type: "number" },
    { entity: "optical_prescription", key: "left_eye_cylindrical", label: "OE Cilindrico", type: "number" },
    { entity: "optical_prescription", key: "left_eye_axis", label: "OE Eixo", type: "number" },
    { entity: "optical_prescription", key: "addition", label: "Adicao", type: "number" },
    { entity: "optical_prescription", key: "pupillary_distance", label: "DNP/DP", type: "text" },
    { entity: "service_order", key: "laboratory", label: "Laboratorio", type: "text" },
    { entity: "service_order", key: "estimated_delivery_date", label: "Previsao de entrega", type: "date" },
  ],
  defaultWorkflows: [
    ...general.defaultWorkflows,
    workflows.optical_order,
  ],
  defaultRoles: [
    general.defaultRoles[0],
    {
      key: "seller",
      name: "Vendedor",
      permissions: [
        "customers:read",
        "customers:write",
        "products:read",
        "sales:read",
        "sales:write",
        "service_orders:read",
        "service_orders:write",
        "optical_prescriptions:read",
        "optical_prescriptions:write",
      ],
    },
    general.defaultRoles[2],
  ],
};
