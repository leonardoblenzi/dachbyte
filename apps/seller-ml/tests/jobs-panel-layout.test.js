const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('painel coloca identificador acima do nome sem competir pela mesma linha', () => {
  const js = fs.readFileSync(path.join(__dirname, '../public/js/jobs-panel.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/css/promo-jobs.css'), 'utf8');

  assert.match(js, /<div class="job-id-row">\s*\$\{jobNumber\}\s*\$\{dismissButton\}\s*<\/div>/);
  assert.match(js, /<div class="job-name-row">\s*<div class="job-name">\$\{esc\(title\)\}<\/div>\s*<\/div>/);
  assert.match(css, /\.job-id-row \.job-number\s*\{[^}]*max-width:\s*100%/);
  assert.match(css, /\.job-name\s*\{[^}]*white-space:\s*normal/);
});
