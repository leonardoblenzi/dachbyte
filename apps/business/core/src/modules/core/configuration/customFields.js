"use strict";

const { badRequest } = require("../errors");

const ENTITY_ALIASES = Object.freeze({
  clientes: "customer",
  cliente: "customer",
  customers: "customer",
  customer: "customer",
  produtos: "product",
  produto: "product",
  products: "product",
  product: "product",
  vendas: "sale",
  venda: "sale",
  sales: "sale",
  sale: "sale",
  os: "service_order",
  "ordem de servico": "service_order",
  "ordens de servico": "service_order",
  service_order: "service_order",
  service_orders: "service_order",
  financeiro: "finance",
  finance: "finance",
  recebiveis: "receivable",
  receivable: "receivable",
  despesas: "expense",
  expense: "expense",
  "receita optica": "optical_prescription",
  "receitas opticas": "optical_prescription",
  receita: "optical_prescription",
  optical_prescription: "optical_prescription",
});

const ENTITY_LABELS = Object.freeze({
  customer: "Clientes",
  product: "Produtos",
  sale: "Vendas",
  service_order: "OS",
  receivable: "Financeiro",
  expense: "Financeiro",
  finance: "Financeiro",
  optical_prescription: "Receita optica",
});

const FIELD_TYPES = new Set(["text", "number", "date", "select", "boolean", "textarea"]);
const TYPE_ALIASES = Object.freeze({
  texto: "text",
  text: "text",
  numero: "number",
  número: "number",
  number: "number",
  data: "date",
  date: "date",
  lista: "select",
  select: "select",
  booleano: "boolean",
  boolean: "boolean",
  textarea: "textarea",
});

function normalizeEntity(value) {
  const key = String(value || "").trim().toLowerCase();
  return ENTITY_ALIASES[key] || key.replace(/[\s-]+/g, "_");
}

function entityLabel(value) {
  return ENTITY_LABELS[normalizeEntity(value)] || String(value || "").trim();
}

function normalizeType(value) {
  const key = String(value || "text").trim().toLowerCase();
  return TYPE_ALIASES[key] || key;
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

function normalizeDefinition(input = {}, id) {
  const name = String(input.name || input.label || "").trim();
  if (!name) throw badRequest("Nome do campo personalizado e obrigatorio", "CUSTOM_FIELD_NAME_REQUIRED");

  const entity = normalizeEntity(input.entity || input.module || "customer");
  if (!Object.prototype.hasOwnProperty.call(ENTITY_LABELS, entity)) {
    throw badRequest("Entidade do campo personalizado e invalida", "CUSTOM_FIELD_ENTITY_INVALID");
  }

  const type = normalizeType(input.type || input.fieldType || "text");
  if (!FIELD_TYPES.has(type)) throw badRequest("Tipo do campo personalizado e invalido", "CUSTOM_FIELD_TYPE_INVALID");

  const options = type === "select"
    ? (Array.isArray(input.options) ? input.options : String(input.options || "").split(","))
      .map((item) => String(item || "").trim()).filter(Boolean)
    : [];

  if (type === "select" && !options.length) {
    throw badRequest("Campo do tipo lista precisa ter ao menos uma opcao", "CUSTOM_FIELD_OPTIONS_REQUIRED");
  }

  return {
    id,
    key: String(input.key || id || "").trim(),
    name,
    label: name,
    entity,
    module: entityLabel(entity),
    type,
    fieldType: ({ text: "Texto", number: "Numero", date: "Data", select: "Lista", boolean: "Booleano", textarea: "Textarea" })[type],
    options,
    required: input.required === true || String(input.required || "").toLowerCase() === "sim" ? "Sim" : "Nao",
    active: input.active !== false,
    placeholder: String(input.placeholder || "").trim(),
    helpText: String(input.helpText || "").trim(),
    min: input.min ?? null,
    max: input.max ?? null,
    step: input.step ?? null,
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : 0,
  };
}

function definitionsFor(configuration, entity) {
  const wanted = normalizeEntity(entity);
  const definitions = Array.isArray(configuration?.settings?.customFields) ? configuration.settings.customFields : [];
  return definitions
    .filter((field) => {
      if (field?.active === false) return false;
      const fieldEntity = normalizeEntity(field.entity || field.module);
      return fieldEntity === wanted || (fieldEntity === "finance" && ["receivable", "expense"].includes(wanted));
    })
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || String(a.name || "").localeCompare(String(b.name || "")));
}

function normalizeValue(field, value) {
  if (isBlank(value)) return value;
  const type = normalizeType(field.type || field.fieldType);
  if (type === "number") {
    const number = Number(String(value).replace(",", "."));
    if (!Number.isFinite(number)) throw badRequest(`Valor numerico invalido: ${field.name || field.key}`, "CUSTOM_FIELD_NUMBER_INVALID");
    if (field.min !== null && field.min !== undefined && number < Number(field.min)) throw badRequest(`Valor abaixo do minimo: ${field.name || field.key}`, "CUSTOM_FIELD_MIN_INVALID");
    if (field.max !== null && field.max !== undefined && number > Number(field.max)) throw badRequest(`Valor acima do maximo: ${field.name || field.key}`, "CUSTOM_FIELD_MAX_INVALID");
    return number;
  }
  if (type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw badRequest(`Data invalida: ${field.name || field.key}`, "CUSTOM_FIELD_DATE_INVALID");
  }
  if (type === "select" && Array.isArray(field.options) && field.options.length && !field.options.map(String).includes(String(value))) {
    throw badRequest(`Opcao invalida: ${field.name || field.key}`, "CUSTOM_FIELD_OPTION_INVALID");
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (["sim", "true", "1", "yes"].includes(normalized)) return true;
    if (["nao", "não", "false", "0", "no"].includes(normalized)) return false;
    throw badRequest(`Valor booleano invalido: ${field.name || field.key}`, "CUSTOM_FIELD_BOOLEAN_INVALID");
  }
  return String(value);
}

function validateCustomFields(configuration, entity, values = {}, { requireAll = false } = {}) {
  const normalized = {};
  for (const field of definitionsFor(configuration, entity)) {
    const key = field.id || field.key;
    if (!key) continue;
    const value = values?.[key];
    const required = field.required === true || String(field.required || "").toLowerCase() === "sim";
    if (required && requireAll && isBlank(value)) {
      const error = badRequest(`Campo obrigatorio: ${field.name || field.label || key}`, "CUSTOM_FIELD_REQUIRED");
      error.field = key;
      throw error;
    }
    if (isBlank(value)) continue;
    normalized[key] = normalizeValue(field, value);
  }
  // Unknown keys are preserved for backwards compatibility/imports. Definitions
  // still drive validation for all configured fields.
  for (const [key, value] of Object.entries(values || {})) {
    if (!(key in normalized) && !isBlank(value)) normalized[key] = value;
  }
  return normalized;
}

module.exports = {
  definitionsFor,
  entityLabel,
  normalizeDefinition,
  normalizeEntity,
  normalizeType,
  validateCustomFields,
};
