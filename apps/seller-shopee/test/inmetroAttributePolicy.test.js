"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  applyInmetroRequirement,
  getInmetroValidationError,
  isInmetroRegistrationAttribute,
} = require("../src/domain/inmetroAttributePolicy");

test("reconhece as variacoes do atributo de registro INMETRO", () => {
  assert.equal(
    isInmetroRegistrationAttribute({ name: "Número de Registro INMETRO" }),
    true,
  );
  assert.equal(isInmetroRegistrationAttribute({ name: "Certificacao do produto" }), false);
});

test("torna INMETRO obrigatorio somente quando a categoria retorna o atributo", () => {
  const attributes = applyInmetroRequirement([
    {
      attributeId: "505",
      name: "Numero de registro INMETRO",
      isMandatory: false,
      values: ["001234/2026"],
    },
  ]);

  assert.equal(attributes[0].attributeId, "505");
  assert.equal(attributes[0].isMandatory, true);
  assert.equal(attributes[0].complianceRequirement, "inmetro");
  assert.equal(getInmetroValidationError(attributes), null);

  const unrelated = [{ attributeId: "10", name: "Cor", values: [] }];
  assert.deepEqual(applyInmetroRequirement(unrelated), unrelated);
  assert.equal(getInmetroValidationError(unrelated), null);
});

test("bloqueia INMETRO presente sem valor ou sem ID oficial", () => {
  assert.match(
    getInmetroValidationError([
      { attributeId: "505", name: "Numero de registro INMETRO", values: [] },
    ]),
    /Preencha o atributo/,
  );
  assert.match(
    getInmetroValidationError([
      { attributeId: null, name: "Numero de registro INMETRO", values: ["123"] },
    ]),
    /mapear o atributo oficial/,
  );
});
