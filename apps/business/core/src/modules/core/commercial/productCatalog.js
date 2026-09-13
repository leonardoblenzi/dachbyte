"use strict";

const PRODUCT_KINDS = Object.freeze({
  BASE: "base",
  VERTICAL: "vertical",
  SERVICE: "service",
  CHANNEL: "channel",
});

const SUBSCRIPTION_STATUSES = Object.freeze([
  "contracted",
  "configuring",
  "active",
  "suspended",
]);

const fiscalPlans = Object.freeze([
  {
    key: "free",
    name: "Gratuito",
    monthlyPriceCents: 0,
    limits: { fiscalDocumentsPerMonth: 5 },
    description: "Para conhecer o emissor e validar o fluxo fiscal.",
  },
  {
    key: "start",
    name: "Comecar",
    monthlyPriceCents: 1990,
    limits: { fiscalDocumentsPerMonth: 50 },
    description: "Para operacoes com baixo volume mensal.",
  },
  {
    key: "accelerate",
    name: "Acelerar",
    monthlyPriceCents: 4990,
    limits: { fiscalDocumentsPerMonth: 500 },
    description: "Plano indicado para operacoes em crescimento.",
    featured: true,
  },
  {
    key: "grow",
    name: "Crescer",
    monthlyPriceCents: 9990,
    limits: { fiscalDocumentsPerMonth: 2000 },
    description: "Para operacoes com maior volume fiscal.",
  },
  {
    key: "scale",
    name: "Escalar",
    monthlyPriceCents: 19990,
    limits: { fiscalDocumentsPerMonth: 5000 },
    description: "Para alto volume de documentos fiscais.",
  },
]);

const products = Object.freeze([
  {
    key: "core",
    kind: PRODUCT_KINDS.BASE,
    name: "Volt Core",
    shortName: "Core",
    description: "Base operacional do Volt: clientes, produtos, vendas, estoque, financeiro e gestao.",
    alwaysActive: true,
    comingSoon: false,
    moduleKeys: [],
    ownedModuleKeys: [],
    screenKeys: ["services"],
    ownedScreenKeys: ["services"],
    capabilities: ["core.base", "services.catalog"],
    activeCapabilities: [],
    plans: [],
  },
  {
    key: "vertical.optical",
    kind: PRODUCT_KINDS.VERTICAL,
    name: "Volt Otica",
    shortName: "Otica",
    description: "Receitas opticas, pedidos, laboratorios e fluxo de producao integrado ao Volt Core.",
    comingSoon: false,
    defaultPlanKey: "standard",
    moduleKeys: ["service_orders", "optical_prescriptions"],
    ownedModuleKeys: ["optical_prescriptions"],
    screenKeys: ["service_orders", "optical_prescriptions"],
    ownedScreenKeys: ["optical_prescriptions"],
    capabilities: ["vertical.optical"],
    activeCapabilities: ["vertical.optical.active"],
    plans: [
      {
        key: "standard",
        name: "Volt Otica",
        monthlyPriceCents: null,
        limits: {},
        description: "Vertical optico completo sobre o Volt Core.",
      },
    ],
  },
  {
    key: "service.fiscal",
    kind: PRODUCT_KINDS.SERVICE,
    name: "Volt Fiscal",
    shortName: "Emissor Fiscal",
    description: "NF-e e NFC-e integradas as vendas do Volt, com XML, DANFE e acompanhamento fiscal.",
    comingSoon: false,
    defaultPlanKey: "free",
    moduleKeys: ["fiscal"],
    ownedModuleKeys: ["fiscal"],
    screenKeys: ["fiscal"],
    ownedScreenKeys: ["fiscal"],
    capabilities: ["service.fiscal"],
    activeCapabilities: ["service.fiscal.active"],
    usageMetricKey: "fiscal_documents",
    usageLimitKey: "fiscalDocumentsPerMonth",
    usageUnit: "documentos",
    plans: fiscalPlans,
  },
  {
    key: "channel.mercado_livre",
    kind: PRODUCT_KINDS.CHANNEL,
    name: "Mercado Livre",
    shortName: "Mercado Livre",
    description: "Pedidos, produtos e estoque sincronizados com o Mercado Livre.",
    comingSoon: true,
    defaultPlanKey: null,
    moduleKeys: [],
    ownedModuleKeys: [],
    screenKeys: [],
    ownedScreenKeys: [],
    capabilities: [],
    activeCapabilities: [],
    plans: [],
  },
  {
    key: "channel.shopee",
    kind: PRODUCT_KINDS.CHANNEL,
    name: "Shopee",
    shortName: "Shopee",
    description: "Pedidos e estoque sincronizados com a Shopee.",
    comingSoon: true,
    defaultPlanKey: null,
    moduleKeys: [],
    ownedModuleKeys: [],
    screenKeys: [],
    ownedScreenKeys: [],
    capabilities: [],
    activeCapabilities: [],
    plans: [],
  },
]);

const productByKey = Object.freeze(Object.fromEntries(products.map((product) => [product.key, product])));

function getCommercialProduct(productKey) {
  return productByKey[String(productKey || "").trim()] || null;
}

function getCommercialPlan(productOrKey, planKey) {
  const product = typeof productOrKey === "string" ? getCommercialProduct(productOrKey) : productOrKey;
  if (!product) return null;
  const key = String(planKey || product.defaultPlanKey || "").trim().toLowerCase();
  return (product.plans || []).find((plan) => plan.key === key) || null;
}

module.exports = {
  PRODUCT_KINDS,
  SUBSCRIPTION_STATUSES,
  fiscalPlans,
  getCommercialPlan,
  getCommercialProduct,
  products,
};
