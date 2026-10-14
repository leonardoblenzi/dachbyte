"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const view=fs.readFileSync(path.join(root,"views/app.html"),"utf8");
const js=fs.readFileSync(path.join(root,"public/js/magalu-financial.js"),"utf8");
const css=fs.readFileSync(path.join(root,"public/css/magalu-financial.css"),"utf8");
const parity=fs.readFileSync(path.join(root,"public/css/magalu-margin-parity.css"),"utf8");

test("period orders use compact accessible disclosures and a cost chooser",()=>{
  assert.match(view,/id="mg-financial-margin-body" class="mg-margin-period-list" role="list"/);
  assert.match(view,/id="mg-margin-missing-cost-dialog"/);
  assert.match(js,/<details class="mg-margin-period-details"/);
  assert.match(js,/data-margin-cost-sku/);
  assert.match(js,/data-margin-cost-choose/);
  assert.match(js,/data-margin-identify-order/);
});

test("period costs refresh locally after save without another financial sync",()=>{
  assert.match(js,/async function refreshLocalMarginAfterCost/);
  assert.match(js,/loadMargins\(\),loadEquilibrium\(\)/);
});

test("a failed identity lookup remains visibly retryable",()=>{
  assert.match(js,/identityFailed:new Set\(\)/);
  assert.match(js,/Consulta do produto falhou/);
});

test("automatic identity enrichment runs only for the opened period view",()=>{
  assert.match(js,/if\(state\.marginTab==="period"\)void identifyMissingRows\(data\.rows\)/);
});

test("filter and order layout fit the content width without a 2100px table",()=>{
  assert.doesNotMatch(css,/min-width:2100px/);
  assert.doesNotMatch(parity,/repeat\(11,\s*minmax/);
  assert.match(parity,/repeat\(auto-fit,\s*minmax/);
  assert.match(parity,/\.mg-margin-filter-actions \.mg-primary-btn\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(css,/\.mg-margin-period-list/);
});
