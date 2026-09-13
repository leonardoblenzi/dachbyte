"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ANVISA_CATEGORY_IDS,
  ANVISA_REQUIRED_FROM,
  applyAnvisaRequirement,
  getAnvisaValidationError,
  isAnvisaAffectedCategory,
  isAnvisaRegistrationAttribute,
} = require("../src/domain/anvisaAttributePolicy");

test("mantem as 141 categorias obrigatorias informadas pela Shopee", () => {
  assert.equal(ANVISA_CATEGORY_IDS.size, 141);
  assert.equal(isAnvisaAffectedCategory("100141"), true);
  assert.equal(isAnvisaAffectedCategory(101213), true);
  assert.equal(isAnvisaAffectedCategory("999999"), false);
});

test("reconhece o atributo ANVISA mesmo com variacoes de acentuacao", () => {
  assert.equal(
    isAnvisaRegistrationAttribute({
      name: "Código de Registro, Processo ou Notificação da ANVISA",
    }),
    true,
  );
  assert.equal(isAnvisaRegistrationAttribute({ name: "Numero do registro" }), false);
});

test("torna o atributo ANVISA obrigatorio sem alterar o ID retornado pela Shopee", () => {
  const attributes = applyAnvisaRequirement("100141", [
    {
      attributeId: "87654",
      name: "Codigo de Registro, Processo ou Notificacao da ANVISA",
      isMandatory: false,
      values: ["25351.123456/2026-10"],
    },
  ]);

  assert.equal(attributes[0].attributeId, "87654");
  assert.equal(attributes[0].isMandatory, true);
  assert.equal(attributes[0].complianceRequirement, "anvisa");
  assert.equal(attributes[0].requiredFrom, ANVISA_REQUIRED_FROM);
  assert.equal(getAnvisaValidationError("100141", attributes), null);
});

test("bloqueia categoria afetada sem valor ou sem ID oficial do atributo", () => {
  const missingValue = applyAnvisaRequirement("100141", [
    {
      attributeId: "87654",
      name: "Codigo de Registro, Processo ou Notificacao da ANVISA",
      values: [],
    },
  ]);
  assert.match(getAnvisaValidationError("100141", missingValue), /Preencha o atributo/);

  const missingMapping = applyAnvisaRequirement("100141", []);
  assert.match(getAnvisaValidationError("100141", missingMapping), /mapear o atributo oficial/);
  assert.equal(getAnvisaValidationError("999999", []), null);
});
