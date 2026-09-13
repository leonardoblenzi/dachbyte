"use strict";

const INMETRO_ATTRIBUTE_LABEL = "Certificacao ou registro INMETRO";
const INMETRO_REQUIRED_FROM = "2025-09-12";

function normalizeToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/gi, " ")
    .trim()
    .toUpperCase();
}

function isInmetroRegistrationAttribute(attribute) {
  const name = normalizeToken(
    attribute?.name ||
      attribute?.attribute_name ||
      attribute?.original_attribute_name ||
      "",
  );

  return name.includes("INMETRO") && (
    name.includes("REGISTRO") ||
    name.includes("NUMERO") ||
    name.includes("CERTIFICATION") ||
    name.includes("CERTIFICACAO")
  );
}

function applyInmetroRequirement(attributes = []) {
  const normalized = Array.isArray(attributes) ? attributes.map((entry) => ({ ...entry })) : [];
  const index = normalized.findIndex(isInmetroRegistrationAttribute);
  if (index < 0) return normalized;

  normalized[index] = {
    ...normalized[index],
    isMandatory: true,
    complianceRequirement: "inmetro",
    requiredFrom: INMETRO_REQUIRED_FROM,
  };
  return normalized;
}

function getInmetroValidationError(attributes = []) {
  const attribute = (Array.isArray(attributes) ? attributes : []).find(
    isInmetroRegistrationAttribute,
  );
  if (!attribute) return null;

  if (!String(attribute?.attributeId || "").trim()) {
    return "Nao foi possivel mapear o atributo oficial do INMETRO para esta categoria. Recarregue os atributos antes de publicar.";
  }

  const values = Array.isArray(attribute?.values)
    ? attribute.values.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (!values.length) return `Preencha o atributo ${INMETRO_ATTRIBUTE_LABEL}.`;
  return null;
}

module.exports = {
  INMETRO_ATTRIBUTE_LABEL,
  INMETRO_REQUIRED_FROM,
  applyInmetroRequirement,
  getInmetroValidationError,
  isInmetroRegistrationAttribute,
};
