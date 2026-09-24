"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const entryGate = require("../src/services/entryGate");

test("primeiro acesso sem organização Magalu inicia OAuth e preserva a página de retorno", () => {
  assert.equal(
    entryGate.resolveEntryRedirect({ accounts: [], returnPath: "/magalu/catalogo" }),
    "/magalu/auth/start?return=%2Fmagalu%2Fcatalogo",
  );
});

test("uma organização ativa permite abrir o aplicativo sem novo OAuth", () => {
  assert.equal(
    entryGate.resolveEntryRedirect({ accounts: [{ id: 7, status: "active" }], returnPath: "/magalu/" }),
    null,
  );
});

test("falha ou cancelamento do primeiro OAuth leva para Contas sem reiniciar o consentimento", () => {
  assert.equal(
    entryGate.resolveEntryRedirect({
      accounts: [],
      returnPath: "/magalu/",
      oauth: { status: "error", reason: "access_denied" },
    }),
    "/magalu/contas?oauth=error&reason=access_denied",
  );
});
