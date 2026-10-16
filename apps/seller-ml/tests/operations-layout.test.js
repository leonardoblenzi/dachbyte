const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const css = (file) => fs.readFileSync(path.join(__dirname, "..", "public", "css", file), "utf8");
const view = (file) => fs.readFileSync(path.join(__dirname, "..", "views", file), "utf8");

test("operacoes usam uma margem superior compacta e uniforme", () => {
  const operationsCss = css("operacoes.css");
  const atacadoCss = css("atacado.css");

  assert.match(operationsCss, /margin:32px auto 44px!important/);
  assert.doesNotMatch(atacadoCss, /\.atacado-page\s*\{\s*padding:/);
});

test("telas de operacoes recebem a versao atual do CSS compartilhado", () => {
  for (const file of ["atacado.html", "caracteristicas.html", "excluir-anuncio.html", "modelo-massa.html", "prazo.html", "validar-dimensoes.html"]) {
    assert.match(view(file), /operacoes\.css\?v=2026101601/);
  }
  assert.match(view("atacado.html"), /atacado\.css\?v=2026101601/);
});
