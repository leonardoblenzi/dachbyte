const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const screens = require('../packages/design-system/screens.json');

test('brand icons are RGBA PNGs and Seller favicons have no background rectangle', () => {
  for (const line of ['seller', 'business']) {
    const png = fs.readFileSync(path.join(root, `public/brand/dachbyte/${line}/mark-transparent.png`));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png[25], 6, `${line}: expected RGBA PNG`);
  }
  for (const file of [
    'apps/seller-ml/public/img/dachbyte-seller-mark.svg',
    'apps/seller-shopee/public/img/dachbyte-seller-mark.svg',
    'apps/seller-madeira/public/dachbyte-seller-mark.svg',
    'apps/seller-tracking/public/dachbyte-seller-mark.svg',
    'apps/seller-log/public/dachbyte-seller-mark.svg',
    'apps/seller-leader/public/assets/dachbyte-seller-mark.svg',
  ]) assert.doesNotMatch(read(file), /<rect\b/);
});

for (const screen of screens) {
  test(`DACHBYTE identity: ${screen.path}`, () => {
    const html = read(screen.path);
    assert.match(html, new RegExp(`data-dachbyte-line="${screen.line}"`));
    assert.equal((html.match(/href="\/brand\/dachbyte\/theme.css\?v=20260904"/g) || []).length, 1);
  });
}
test('Next layout includes the Business identity for every route', () => {
  const layout = read('apps/business/stock/apps/web/app/layout.tsx');
  assert.match(layout, /data-dachbyte-line="business"/);
  assert.match(layout, /\/brand\/dachbyte\/theme.css/);
});
test('public tokens exactly match the canonical design system', () => {
  const normalize = text => text.replace(/\r\n/g, '\n').trim();
  assert.equal(normalize(read('public/brand/dachbyte/tokens.css')), normalize(read('packages/design-system/src/tokens.css')));
});
test('theme references real supplied artwork and preserves accessibility hooks', () => {
  const css = read('public/brand/dachbyte/theme.css');
  for (const match of css.matchAll(/url\(['"](.+?)['"]\)/g)) {
    assert.ok(fs.existsSync(path.resolve(root, 'public/brand/dachbyte', match[1])), match[1]);
  }
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /!important/);
});
test('Seller sidebar matches the selected White or Dark mode', () => {
  const css = read('public/brand/dachbyte/theme.css');
  assert.match(css, /html\[data-dachbyte-line="seller"\] body\.theme-light \.ml-shell__sidebar\s*\{\s*background:\s*#ffffff;/);
  assert.match(css, /html\[data-dachbyte-line="seller"\] body\.theme-dark \.ml-shell__sidebar\s*\{\s*background:\s*linear-gradient\(165deg, #102b3d, #07131d 65%\);/);
});
test('header wordmarks use live text without rectangular image backgrounds', () => {
  const css = read('public/brand/dachbyte/theme.css');
  for (const block of css.matchAll(/([^{}]*dachbyte-signature__wordmark[^{}]*)\{([^{}]*)\}/g)) {
    assert.doesNotMatch(block[2], /url\(/);
  }
  for (const file of ['apps/seller-ml/views/login.html', 'apps/seller-ml/views/landing.html']) {
    assert.match(read(file), /dachbyte-signature__wordmark"><span>DACH<\/span><span>BYTE<\/span>/);
  }
  assert.match(read('apps/business/public/landing.html'), /data-dx-shell="business"/);
});
