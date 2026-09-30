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
  assert.match(promotionsDetail, /class="mg-promotions-dialog__card mg-ui-modal__dialog"/, 'promotion detail card should use the canonical modal dialog');

  const canonicalCss = fs.readFileSync(canonicalStylesheet, 'utf8');
  assert.match(
    canonicalCss,
    /\.mg-ui-modal__dialog\s*\{[^}]*max-height:\s*[^;]+;[^}]*overflow:\s*auto;/s,
    'the canonical modal dialog should constrain height and scroll its content safely',
  );
});

test('pricing and account workspaces use the canonical visual primitives', () => {
  const template = fs.readFileSync(appTemplate, 'utf8');
  const pageMarkup = (pageId) => {
    const match = template.match(new RegExp(`<section id="${pageId}"[^>]*>[\\s\\S]*?(?=<section id="|$)`));

    assert.ok(match, `${pageId} should remain available in the Magalu app`);
    return match[0];
  };

  const financialCosts = pageMarkup('mg-financial-costs-page');
  const financialMargin = pageMarkup('mg-financial-margin-page');
  const financialCalculator = pageMarkup('mg-financial-calculator-page');
  const accounts = pageMarkup('mg-accounts-page');
  const sync = pageMarkup('mg-sync-page');

  for (const [pageName, markup] of [
    ['financial costs', financialCosts],
    ['financial margin', financialMargin],
    ['financial calculator', financialCalculator],
    ['accounts', accounts],
    ['integrations', sync],
  ]) {
    assert.match(markup, /mg-ui-hero/, `${pageName} should use the canonical hero`);
  }

  assert.doesNotMatch(financialMargin, /id="mg-financial-calculator-page"/, 'financial margin markup must stop at the next page boundary');
  assert.match(financialMargin, /class="mg-margin-filter-card mg-ui-filter-card"/, 'financial margin should use the canonical filter card');
  assert.match(financialCosts, /class="mg-section-card mg-ui-surface"/, 'financial costs should use the canonical surface');
  assert.equal((financialMargin.match(/class="mg-section-card mg-ui-surface"/g) || []).length, 3, 'financial margin should use canonical surfaces for its insight and result sections');
  assert.equal((sync.match(/class="mg-section-card(?: mg-sync-history)? mg-ui-surface"/g) || []).length, 3, 'integrations should use canonical surfaces for connection, diagnostics, and history');
  assert.match(accounts, /class="mg-accounts-list-card mg-ui-surface"/, 'accounts should use the canonical surface');

  const calculatorResult = financialCalculator.match(/<aside class="mg-calculator-result mg-calculator-card"[^>]*>/);
  assert.ok(calculatorResult, 'calculator result card should remain available');
  assert.doesNotMatch(
    calculatorResult[0],
    /mg-ui-surface/,
    'calculator result intentionally stays a specialized sticky card; adding the surface primitive would duplicate its existing padding',
  );
});

test('canonical surfaces override legacy card geometry when the canonical class is attached', () => {
  const canonicalCss = fs.readFileSync(canonicalStylesheet, 'utf8');
  const surfaceRule = canonicalCss.match(/\.mg-ui-surface\s*\{([^}]*)\}/);

  assert.ok(surfaceRule, 'the canonical surface rule should remain available');
  for (const property of ['padding', 'border', 'border-radius', 'background', 'box-shadow']) {
    assert.match(
      surfaceRule[1],
      new RegExp(`${property}:\\s*[^;]+!important;`),
      `canonical surfaces should win legacy !important ${property} declarations`,
    );
  }
  assert.match(
    canonicalCss,
    /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.mg-ui-surface\s*\{\s*padding:\s*15px!important;\s*\}/,
    'canonical surface padding should retain its responsive override',
  );
});

test('promotions use the shell fetch helper for canonical route loading', () => {
  const promotionsScript = fs.readFileSync(
    path.join(appRoot, 'public', 'js', 'magalu-promotions.js'),
    'utf8',
  );

  assert.match(
    promotionsScript,
    /window\.MagaluSellerShell\.fetchJson\(\s*`\/magalu\/api\/promotions\?account_id=/,
    'promotions should use the shell fetch helper for its account-scoped read',
  );
  assert.doesNotMatch(
    promotionsScript,
    /fetch\(\s*`\/magalu\/api\/promotions\?account_id=/,
    'promotions should not bypass the shell fetch helper',
  );
});
