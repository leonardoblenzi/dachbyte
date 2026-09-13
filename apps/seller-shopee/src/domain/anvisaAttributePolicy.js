"use strict";

const ANVISA_ATTRIBUTE_LABEL =
  "Codigo de Registro, Processo ou Notificacao da ANVISA";
const ANVISA_REQUIRED_FROM = "2026-09-21";

const ANVISA_CATEGORY_IDS = new Set(
  `100141 100144 100140 100137 100441 100133 100446 100451 100435 100135
100139 100440 100453 100445 100447 100442 100443 100436 100131 100437
100450 100444 100452 100448 100008 100006 100005 100004 100003 100007
100130 100128 100127 100432 100425 100427 100122 100434 100123 100426
100423 100420 100421 100424 100430 100125 100429 100422 100428 100431
100119 102003 102004 102005 102006 102007 102008 102009 102010 102012
102013 102014 102015 102016 100891 100892 100893 100894 100895 100896
100897 100898 100901 100902 100904 100905 101669 101670 101671 101672
101673 101674 101675 101676 100868 101607 101608 101609 101610 101611
101612 101613 101614 101615 102029 102030 102031 102035 102178 100869
100870 100871 100872 100873 100874 100875 100878 100879 101616 101617
101618 101619 101620 100880 100884 101627 101628 101629 101630 101631
101632 101633 101634 101635 101636 101637 101638 101639 101640 101641
101642 101643 101644 101645 101646 101647 100666 100665 100661 101658
101213`
    .split(/\s+/)
    .filter(Boolean),
);

function normalizeToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/gi, " ")
    .trim()
    .toUpperCase();
}

function isAnvisaAffectedCategory(categoryId) {
  return ANVISA_CATEGORY_IDS.has(String(categoryId || "").trim());
}

function isAnvisaRegistrationAttribute(attribute) {
  const name = normalizeToken(
    attribute?.name ||
      attribute?.attribute_name ||
      attribute?.original_attribute_name ||
      "",
  );

  return (
    name.includes("ANVISA") &&
    name.includes("CODIGO") &&
    (name.includes("REGISTRO") ||
      name.includes("PROCESSO") ||
      name.includes("NOTIFICACAO"))
  );
}

function applyAnvisaRequirement(categoryId, attributes = []) {
  const normalized = Array.isArray(attributes) ? attributes.map((entry) => ({ ...entry })) : [];
  if (!isAnvisaAffectedCategory(categoryId)) return normalized;

  const index = normalized.findIndex(isAnvisaRegistrationAttribute);
  const requirement = {
    isMandatory: true,
    complianceRequirement: "anvisa",
    requiredFrom: ANVISA_REQUIRED_FROM,
  };

  if (index >= 0) {
    normalized[index] = { ...normalized[index], ...requirement };
    return normalized;
  }

  normalized.push({
    attributeId: null,
    name: ANVISA_ATTRIBUTE_LABEL,
    values: [],
    sourceAttribute: null,
    ...requirement,
  });
  return normalized;
}

function getAnvisaValidationError(categoryId, attributes = []) {
  if (!isAnvisaAffectedCategory(categoryId)) return null;

  const attribute = (Array.isArray(attributes) ? attributes : []).find(
    isAnvisaRegistrationAttribute,
  );
  if (!attribute || !String(attribute?.attributeId || "").trim()) {
    return "Nao foi possivel mapear o atributo oficial da ANVISA para esta categoria. Recarregue os atributos antes de publicar.";
  }

  const values = Array.isArray(attribute?.values)
    ? attribute.values.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (!values.length) {
    return `Preencha o atributo ${ANVISA_ATTRIBUTE_LABEL}.`;
  }
  return null;
}

module.exports = {
  ANVISA_ATTRIBUTE_LABEL,
  ANVISA_CATEGORY_IDS,
  ANVISA_REQUIRED_FROM,
  applyAnvisaRequirement,
  getAnvisaValidationError,
  isAnvisaAffectedCategory,
  isAnvisaRegistrationAttribute,
};
