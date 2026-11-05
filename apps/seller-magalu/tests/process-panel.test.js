"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("painel compartilhado aparece em gestão, estoque e preços e reage aos enfileiramentos", () => {
  const root = path.join(__dirname,"..");
  const html = fs.readFileSync(path.join(root,"views/app.html"),"utf8");
  const panel = fs.readFileSync(path.join(root,"public/js/magalu-process-panel.js"),"utf8");
  const styles = fs.readFileSync(path.join(root,"public/css/magalu-process-panel.css"),"utf8");
  const app = fs.readFileSync(path.join(root,"public/js/magalu-app.js"),"utf8");
  const sku = fs.readFileSync(path.join(root,"public/js/magalu-sku-management.js"),"utf8");
  assert.match(html,/magalu-process-panel\.js/);
  for (const route of ["/gestao-skus","/estoque","/precos"]) assert.ok(panel.includes(route));
  assert.match(panel,/magalu:accountchange/);
  assert.match(panel,/magalu:shellready/);
  assert.match(panel,/magalu:processqueued/);
  assert.match(app,/magalu:processqueued/);
  assert.match(sku,/magalu:processqueued/);
  for (const section of ["EM ANDAMENTO","NA FILA","CONCLUÍDOS"]) assert.ok(panel.includes(section));
  for (const token of ["width:330px","max-height:min(430px","background:#13151f","padding:14px"]) assert.ok(styles.includes(token));
});

test("painel tem acionador flutuante nas operações e na precificação promocional",()=>{
  const root=path.join(__dirname,"..");
  const html=fs.readFileSync(path.join(root,"views/app.html"),"utf8");
  const panel=fs.readFileSync(path.join(root,"public/js/magalu-process-panel.js"),"utf8");
  const styles=fs.readFileSync(path.join(root,"public/css/magalu-process-panel.css"),"utf8");
  assert.match(panel,/"\/precificacao-promocional"/);
  assert.match(styles,/#mg-process-toggle\{position:fixed/);
  assert.ok(html.indexOf('id="mg-process-toggle"')>html.indexOf('id="mg-process-panel"'));
});

test("job promocional apresenta um progresso global sem expor outra conta",async()=>{
  const panel=require("../src/controllers/processPanelController");
  const job={id:"job-1",name:"promo-prices",data:{accountId:7,dachTenantId:"T"},progress:{total:10001,processed:5000,updated:4990,failed:10},getState:async()=>"active"};
  const row=await panel.promoJobRow(job,{accountId:7,tenantId:"T",userId:"U"});
  assert.equal(row.total_count,10001);
  assert.equal(row.pending_count,5001);
  assert.equal(row.success_count,4990);
  assert.equal(await panel.promoJobRow(job,{accountId:8,tenantId:"T",userId:"U"}),null);
  const preview={...job,name:"promo-preview",data:{identity:{accountId:7,tenantId:"T",userId:"U"}}};
  assert.equal(await panel.promoJobRow(preview,{accountId:7,tenantId:"T",userId:"other"}),null);
});

test("listagem agrega grupos de escrita e restringe conta e tenant", async () => {
  const db = require("../src/config/postgres");
  const sku = require("../src/repositories/skuMassRepository");
  const repository = require("../src/repositories/processPanelRepository");
  const originalQuery = db.query, originalBatches = sku.listBatches, calls = [];
  sku.listBatches = async (_tenant, options) => ({ rows:[{id:"batch-1",account_id:7,action:"activate",total_count:2,success_count:1,pending_count:1,created_at:"2026-11-04T10:00:00Z"}] });
  db.query = async (sql, params) => { calls.push({sql,params}); return { rows:sql.includes("from magalu.sku_bulk_groups")||sql.includes("from magalu.sync_runs")?[]:[{id:"preview-1",resource:"price",total_count:2,success_count:1,pending_count:1,created_at:"2026-11-04T11:00:00Z"}] }; };
  try {
    const rows = await repository.list(7,"tenant-1");
    assert.deepEqual(rows.map(row => row.kind),["write","catalog"]);
    assert.ok(calls.some(call=>call.params?.[0]===7&&call.params?.[1]==="tenant-1"&&/w\.account_id=\$1 and w\.dach_tenant_id=\$2/.test(call.sql)));
    assert.ok(calls.some(call=>call.params?.[0]===7&&/from magalu\.sync_runs where account_id=\$1/.test(call.sql)));
  } finally { db.query = originalQuery; sku.listBatches = originalBatches; }
});

test("detalhe de lote de outra conta não é entregue", async () => {
  const sku = require("../src/repositories/skuMassRepository");
  const repository = require("../src/repositories/processPanelRepository");
  const original = sku.batchDetail;
  sku.batchDetail = async () => ({ batch:{account_id:8}, items:[{sku:"SEGREDO"}] });
  try { assert.equal(await repository.detail(7,"tenant-1","catalog","batch-1"),null); }
  finally { sku.batchDetail = original; }
});
