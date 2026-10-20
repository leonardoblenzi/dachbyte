const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('seletor de planilha mantém input acessível e mostra o nome escolhido', () => {
  const view = fs.readFileSync(path.join(__dirname, '../views/alteracao-skus.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../public/js/alteracao-skus.js'), 'utf8');
  const style = fs.readFileSync(path.join(__dirname, '../public/css/alteracao-skus.css'), 'utf8');

  assert.match(view, /<label[^>]*for="skuFile"[^>]*class="sku-file-picker"/);
  assert.match(view, /id="skuFile"[^>]*type="file"/);
  assert.match(view, /id="skuFileName"[^>]*>Nenhuma planilha selecionada/);
  assert.match(script, /\$\("skuFile"\)\.addEventListener\("change"/);
  assert.match(script, /\$\("skuFileName"\)\.textContent\s*=/);
  assert.match(style, /body\.sku-app \.sku-file-picker:focus-within/);
});
