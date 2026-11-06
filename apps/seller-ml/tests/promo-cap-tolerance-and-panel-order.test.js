"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:1/test";
const { _test } = require("../services/promoJobsService");

test("teto do desconto aceita ate 1 ponto a mais (arredondamento do ML)", () => {
  assert.equal(_test.PROMO_DISCOUNT_CAP_TOLERANCE_PP, 1);
  assert.equal(_test.isWithinDiscountCap(23.01, 23), true, "caso real: 23,01% com teto de 23%");
  assert.equal(_test.isWithinDiscountCap(23.5, 23), true);
  assert.equal(_test.isWithinDiscountCap(24, 23), true);
  assert.equal(_test.isWithinDiscountCap(24.2, 23), false, "acima de teto + 1 continua revertendo");
  assert.equal(_test.isWithinDiscountCap(10, 23), true, "desconto menor nunca bloqueia");
  assert.equal(_test.isWithinDiscountCap(null, 23), false);
});

test("painel: ativos pela ordem de inicio, fila pela posicao (FIFO) e concluidos mais recentes primeiro", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public/js/jobs-panel.js"), "utf8");
  assert.match(js, /runningJobs\.sort\(\(a, b\) => \(Number\(a\.startedAt \|\| 0\) - Number\(b\.startedAt \|\| 0\)\)/);
  assert.match(js, /queuedJobs\.sort\(/);
  assert.match(js, /return creationOrder\(a\) - creationOrder\(b\);/, "fila: mais antigo (proximo a rodar) em cima");
  assert.doesNotMatch(js, /job\.startedAt = null/, "voltar para a fila nao muda a ordem");
});
