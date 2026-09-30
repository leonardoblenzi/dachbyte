const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const canonicalStylesheet = path.join(appRoot, 'public', 'css', 'magalu-canonical-ui.css');
const appTemplate = path.join(appRoot, 'views', 'app.html');

test('canonical visual stylesheet exposes the reusable Magalu primitives and loads last', () => {
  assert.equal(fs.existsSync(canonicalStylesheet), true, 'canonical visual stylesheet should exist');

  const css = fs.readFileSync(canonicalStylesheet, 'utf8');
  for (const primitive of [
    '.mg-ui-hero',
    '.mg-ui-filter-card',
    '.mg-ui-surface',
    '.mg-ui-tabs',
    '.mg-ui-state',
    '.mg-ui-modal',
    '.mg-ui-modal[hidden]{display:none!important}',
  ]) {
    assert.match(css, new RegExp(primitive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(css, /@media\s*\(max-width:\s*760px\)/, 'canonical primitives should adapt at the mobile breakpoint');
  assert.match(css, /\.mg-app\[data-theme="dark"\]/, 'canonical primitives should explicitly support the Magalu dark theme');

  const template = fs.readFileSync(appTemplate, 'utf8');
  const stylesheetHrefs = [...template.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"[^>]*>/g)]
    .map((match) => match[1]);

  assert.equal(
    stylesheetHrefs.at(-1),
    '/magalu/assets/css/magalu-canonical-ui.css?v=2026093001',
    'canonical stylesheet should load after the existing Magalu stylesheets',
  );
});
