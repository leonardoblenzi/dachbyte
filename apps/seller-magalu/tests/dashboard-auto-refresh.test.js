"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
async function controllerWith(stubs, run){
  const id=require.resolve("../src/controllers/dashboardController");
  delete require.cache[id];
  const original=Module._load;
  Module._load=function(request,parent,isMain){if(Object.prototype.hasOwnProperty.call(stubs,request))return stubs[request];return original.call(this,request,parent,isMain);};
  try{return await run(require("../src/controllers/dashboardController"));}finally{Module._load=original;delete require.cache[id];}
}
function response(){const result={};return{result,status(code){result.status=code;return this;},json(body){result.body=body;return body;}};}

test("dashboard refresh covers the selected period and its comparison period", () => {
  const { _test } = require("../src/controllers/dashboardController");
  const range = _test.syncRangeFor("7d", new Date("2026-10-29T12:00:00.000Z"));
  assert.deepEqual(range, { from: "2026-10-14", to: "2026-10-29" });
});

test("dashboard refresh waits for its own orders job before returning metrics", () => {
  const controller = read("src/controllers/dashboardController.js");
  const client = read("public/js/magalu-app.js");
  assert.match(controller, /async function refresh\(/);
  assert.match(controller, /async function refreshStatus\(/);
  assert.match(client, /\/magalu\/api\/dashboard\/refresh/);
  assert.match(client, /MagaluLoadingOverlay\?\.show/);
  assert.match(client, /state === "completed"/);
  assert.match(client, /await fetchJson\(`\/magalu\/api\/dashboard\?/);
});

test("dashboard GMV and order count exclude cancelled orders", () => {
  const repository = read("src/repositories/orderRepository.js");
  const stats = repository.slice(repository.indexOf("async function stats("), repository.indexOf("async function knownChannels("));
  assert.match(stats, /lower\(coalesce\(status,''\)\) not in \('cancelled','canceled'\)/);
});

test("dashboard refresh queues an order-only job for the authorized account", async () => {
  const account={id:7,dach_tenant_id:"tenant-7",status:"active",scopes:["order-read"]};
  let queued=null;
  await controllerWith({
    "../repositories/accountRepository":{findAccountByIdForTenant:async(id,tenant)=>{assert.equal(id,7);assert.equal(tenant,"tenant-7");return account;}},
    "../services/hubResourceAccessService":{checkAccountAccess:async()=>({allow:true})},
    "../services/orderSyncService":{ORDER_SCOPE:"order-read",hasScope:(row,scope)=>row.scopes.includes(scope)},
    "../queues/magaluQueue":{enqueueDashboardOrdersSync:async(...args)=>{queued=args;return{id:"job-7",scheduled:true};}},
  },async controller=>{
    const res=response();
    await controller.refresh({body:{account_id:7,period:"7d"},query:{},magaluIdentity:{dachTenantId:"tenant-7"}},res);
    assert.equal(res.result.status,202);
    assert.equal(res.result.body.job_id,"job-7");
    assert.equal(queued[0],7);
    assert.equal(queued[1].dachTenantId,"tenant-7");
  });
});

test("dashboard refresh status rejects a job from another account", async () => {
  await controllerWith({
    "../repositories/accountRepository":{findAccountByIdForTenant:async()=>({id:7,dach_tenant_id:"tenant-7",status:"active"})},
    "../services/hubResourceAccessService":{checkAccountAccess:async()=>({allow:true})},
    "../services/orderSyncService":{ORDER_SCOPE:"order-read",hasScope:()=>true},
    "../queues/magaluQueue":{queueNames:{ordersSync:"orders"},getQueue:async()=>({getJob:async()=>({name:"dashboard-sync",data:{accountId:8,dachTenantId:"tenant-7"}})})},
  },async controller=>{
    const res=response();
    await controller.refreshStatus({params:{jobId:"other"},query:{account_id:7},body:{},magaluIdentity:{dachTenantId:"tenant-7"}},res);
    assert.equal(res.result.status,404);
    assert.equal(res.result.body.error,"MAGALU_DASHBOARD_JOB_NOT_FOUND");
  });
});
