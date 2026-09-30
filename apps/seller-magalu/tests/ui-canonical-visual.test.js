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
  assert.doesNotMatch(css, /prefers-color-scheme/, 'the operating-system color scheme must not override the selected app theme');
  assert.doesNotMatch(css, /:root:not\(\[data-theme="light"\]\)/, 'theme selection belongs to the Magalu app shell');

  const template = fs.readFileSync(appTemplate, 'utf8');
  const stylesheetHrefs = [...template.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"[^>]*>/g)]
    .map((match) => match[1]);

  assert.equal(
    stylesheetHrefs.at(-1),
    '/magalu/assets/css/magalu-canonical-ui.css?v=2026093001',
    'canonical stylesheet should load after the existing Magalu stylesheets',
  );
});

test('catalogue, orders, and SKU management use the canonical commercial workspace primitives', () => {
  const template = fs.readFileSync(appTemplate, 'utf8');
  const pageMarkup = (pageId, nextPageId) => {
    const start = template.indexOf(`<section id="${pageId}"`);
    const end = nextPageId ? template.indexOf(`<section id="${nextPageId}"`, start) : -1;

    assert.notEqual(start, -1, `${pageId} should remain available in the Magalu app`);
    return template.slice(start, end === -1 ? undefined : end);
  };

  const catalogue = pageMarkup('mg-catalog-page', 'mg-orders-page');
  const orders = pageMarkup('mg-orders-page', 'mg-sku-management-page');
  const skuManagement = pageMarkup('mg-sku-management-page', 'mg-price-page');

  for (const [pageName, markup] of [
    ['catalogue', catalogue],
    ['orders', orders],
    ['SKU management', skuManagement],
  ]) {
    assert.match(markup, /class="mg-page-hero mg-ui-hero"/, `${pageName} should use the canonical hero`);
  }

  assert.match(catalogue, /class="mg-filter-card mg-ui-filter-card"/, 'catalogue should use the canonical filter card');
  assert.match(orders, /class="mg-orders-filters mg-ui-filter-card"/, 'orders should use the canonical filter card');
});

test('price, stock, and promotions workspaces use the canonical operational primitives', () => {
  const template = fs.readFileSync(appTemplate, 'utf8');
  const pageMarkup = (pageId, nextPageId) => {
    const start = template.indexOf(`<section id="${pageId}"`);
    const end = nextPageId ? template.indexOf(`<section id="${nextPageId}"`, start) : -1;

    assert.notEqual(start, -1, `${pageId} should remain available in the Magalu app`);
    return template.slice(start, end === -1 ? undefined : end);
  };

  const prices = pageMarkup('mg-price-page', 'mg-stock-page');
  const stock = pageMarkup('mg-stock-page', 'mg-promotions-page');
  const promotions = pageMarkup('mg-promotions-page', 'mg-financial-costs-page');
  const promotionsDetailId = template.indexOf('id="mg-promotions-detail"');
  const promotionsDetailStart = template.lastIndexOf('<section ', promotionsDetailId);
  const promotionsDetailEnd = template.indexOf('<section id="mg-financial-costs-page"', promotionsDetailId);
  assert.notEqual(promotionsDetailId, -1, 'mg-promotions-detail should remain available in the Magalu app');
  const promotionsDetail = template.slice(promotionsDetailStart, promotionsDetailEnd);

  for (const [pageName, markup] of [
    ['prices', prices],
    ['stock', stock],
    ['promotions', promotions],
  ]) {
    assert.match(markup, /mg-ui-hero/, `${pageName} should use the canonical hero`);
  }

  assert.match(promotions, /class="mg-promotions-filter-card mg-ui-filter-card"/, 'promotions should use the canonical filter card');
  assert.match(promotionsDetail, /class="mg-promotions-dialog mg-ui-modal"/, 'promotion detail should use the canonical modal');
});
