"use strict";
const fs=require("node:fs"),path=require("node:path"),test=require("node:test"),assert=require("node:assert/strict");
const root=path.resolve(__dirname,"..");const read=(...p)=>fs.readFileSync(path.join(root,...p),"utf8");

test("seller Magalu uses one canonical shell for Orders and SKU Management",()=>{
  const routes=read("src","routes","index.js"),html=read("views","app.html"),app=read("public","js","magalu-app.js");
  assert.doesNotMatch(routes,/ordersView|skuManagementView|sendFile\((?:ordersView|skuManagementView)\)/);
  assert.match(routes,/"\/pedidos"/);assert.match(routes,/"\/gestao-skus"/);
  assert.match(html,/id="mg-orders-page"[^>]+data-page="\/pedidos"/);
  assert.match(html,/id="mg-sku-management-page"[^>]+data-page="\/gestao-skus"/);
  assert.match(app,/"\/pedidos":\s*\{\s*title:\s*"Pedidos"/);
  assert.match(app,/MagaluSellerShell/);assert.match(app,/magalu:shellready/);
});

test("feature styles no longer define parallel application shells",()=>{
  const sku=read("public","css","magalu-sku-management.css"),orders=read("public","css","magalu-orders.css");
  for(const css of [sku,orders]){
    assert.doesNotMatch(css,/(^|[}\s])body\s*\{/m);assert.doesNotMatch(css,/\.orders-shell\s*\{|\.orders-sidebar\s*\{|\.shell\s*\{|\.sidebar\s*\{/);
    assert.match(css,/var\(--mg-(?:line|surface|text|muted|primary)/);
  }
});

test("feature scripts use the shell account instead of standalone account selectors",()=>{
  const sku=read("public","js","magalu-sku-management.js"),orders=read("public","js","magalu-orders.js");
  for(const js of [sku,orders]){assert.match(js,/MagaluSellerShell/);assert.match(js,/magalu:accountchange/);assert.doesNotMatch(js,/account-select/);}
});

test("orders page preserves protected write controls inside canonical UI",()=>{
  const html=read("views","app.html"),orders=read("public","js","magalu-orders.js");
  assert.match(html,/mg-orders-write-preview-btn/);assert.match(html,/mg-orders-write-confirm/);assert.match(html,/mg-orders-detail-reconcile/);
  assert.match(orders,/\/orders\/delivery-writes\/preview/);assert.match(orders,/\/orders\/delivery-writes\/apply/);assert.match(orders,/\/reverify/);
});

test("Master keeps admin separation but uses the DACHBYTE Magalu visual language",()=>{
  const html=read("views","master.html"),css=read("public","css","magalu-master-alignment.css"),integrations=read("public","css","magalu-master-integrations.css"),js=read("public","js","magalu-master.js");
  assert.match(html,/mark-transparent\.png/);assert.match(html,/magalu-master-alignment\.css/);assert.doesNotMatch(html,/Etapa\s*4|Compatibilidade das etapas|BASE REAL/i);
  assert.match(css,/--mm-bg:\s*#f3f8ff/);assert.match(css,/dachbyte-font-display/);assert.match(integrations,/var\(--mm-line\)/);assert.doesNotMatch(integrations,/--border-color|--surface,/);
  assert.match(js,/dachbyte_magalu_theme/);assert.doesNotMatch(js,/Aguardando etapa|Etapa 2 ainda não aplicada|Depende da etapa/i);
});

test("orphan standalone views were retired",()=>{
  assert.equal(fs.existsSync(path.join(root,"views","pedidos.html")),false);
  assert.equal(fs.existsSync(path.join(root,"views","gestao-skus.html")),false);
});
