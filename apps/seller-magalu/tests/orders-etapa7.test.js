"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,"..");
const read=rel=>fs.readFileSync(path.join(root,rel),"utf8");
const maybeRead=rel=>fs.existsSync(path.join(root,rel))?read(rel):"";
const applicatorPath=path.resolve(root,"../../../APLICAR_MAGALU_MASTER_ETAPA_7.cjs");
const applicator=()=>fs.existsSync(applicatorPath)?fs.readFileSync(applicatorPath,"utf8"):"";
const payload=require("../src/services/orderPayload");

test("009 cria read model de pedidos, itens e entregas sem colunas de PII do comprador",()=>{
  const sql=read("db/migrations/009_orders_read_model.sql").toLowerCase();
  for(const table of ["magalu.orders","magalu.order_items","magalu.deliveries","magalu.delivery_items"])assert.ok(sql.includes(`create table if not exists ${table}`));
  for(const col of ["buyer_cpf","buyer_cnpj","buyer_email","buyer_phone","street_address","recipient_document"])assert.equal(sql.includes(col),false,col);
  assert.ok(sql.includes("orders_sync_status"));
});

test("sanitizer operacional remove PII e segredos em profundidade",()=>{
  const clean=payload.sanitizeOperational({code:"A",customer:{email:"x@y",phone:"1",name:"Nome"},shipping:{address:{street:"Rua",city:"A"},tracking:{code:"T"}},authorization:"Bearer secret",items:[{sku:"S",document:"123"}]});
  assert.equal(clean.customer.email,undefined);assert.equal(clean.customer.phone,undefined);assert.equal(clean.customer.name,"Nome");
  assert.equal(clean.shipping.address,undefined);assert.equal(clean.shipping.tracking.code,"T");assert.equal(clean.authorization,undefined);assert.equal(clean.items[0].document,undefined);
});

test("normalização monetária entende value/normalizer",()=>{
  const part=payload._test.moneyPart({total:{currency:"BRL",normalizer:100,value:12345}});
  assert.deepEqual(part,{total:12345,currency:"BRL",normalizer:100});
});

test("normaliza pedido e seus itens sem payload bruto",()=>{
  const order=payload.normalizeOrder({code:"LU-1",id:"oid",status:"approved",purchased_at:"2026-09-25T10:00:00Z",channel:{id:"channel"},amounts:{total:{currency:"BRL",normalizer:100,value:25990}},buyer:{document:"111",email:"x@y"},items:[{sku:"ABC",quantity:2,unit_price:{currency:"BRL",normalizer:100,value:12995}}]});
  assert.equal(order.code,"LU-1");assert.equal(order.amount_total,25990);assert.equal(order.amount_normalizer,100);assert.equal(order.items[0].sku,"ABC");
  assert.equal(order.operational_payload.buyer.document,undefined);assert.equal(order.operational_payload.buyer.email,undefined);
});

test("normaliza entrega com channel, tracking e prazos",()=>{
  const delivery=payload.normalizeDelivery({id:"d1",status:"shipped",purchased_at:"2026-09-25T10:00:00Z",order:{code:"LU-1",channel:{id:"channel"}},handling_time:{limit_date:"2026-09-26T00:00:00Z"},shipping:{deadline:{limit_date:"2026-09-30"},tracking:{code:"TRACK"},provider:{name:"Transportadora"}},amounts:{freight:{total:{value:1990}},discount:{total:{value:100}}}});
  assert.equal(delivery.order_code,"LU-1");assert.equal(delivery.channel_id,"channel");assert.equal(delivery.tracking_code,"TRACK");assert.equal(delivery.amount_freight,1990);assert.ok(delivery.handling_limit_at);
});

test("cliente remoto de pedidos é estritamente GET/read-only",()=>{
  const src=read("src/services/orderRemoteService.js");assert.match(src,/\/seller\/v1\/orders/);assert.match(src,/\/seller\/v1\/deliveries/);assert.match(src,/X-Channel-Id/);
  assert.doesNotMatch(src,/method:\s*["'](?:POST|PATCH|PUT|DELETE)/i);
});

test("serviço de pedidos exige scopes de leitura e nunca scope write",()=>{
  const src=read("src/services/orderSyncService.js");assert.match(src,/open:order-order-seller:read/);assert.match(src,/open:order-delivery-seller:read/);assert.doesNotMatch(src,/open:order-[^"']+:write/);
});

test("controller valida Hub READ e não dispara WRITE",()=>{
  const src=read("src/controllers/orderController.js");assert.match(src,/action:"READ magalu"/);assert.doesNotMatch(src,/action:"WRITE magalu"/);assert.match(src,/read_only:true/);
});

test("worker de pedidos só possui full sync e reconciliações de leitura",()=>{
  const src=read("src/jobs/ordersSync.worker.js");for(const name of ["full-sync","reconcile-order","reconcile-delivery"])assert.ok(src.includes(name));
  assert.doesNotMatch(src,/(PATCH|POST|PUT|DELETE)\s+\/seller\/v1/i);
});

test("núcleo de leitura da Etapa 7 permanece isolado das escritas da Etapa 8",()=>{
  const src=read("src/routes/order.routes.js"),controller=read("src/controllers/orderController.js");
  for(const route of ["/status","/runs","/sync","/list","/:code","/:code/reconcile"])assert.ok(src.includes(route));
  assert.match(src,/router\.use\("\/delivery-writes",deliveryWriteRoutes\)/);
  assert.doesNotMatch(controller,/action:"WRITE magalu"/);
});

test("runtime/aplicador registra fila orders, webhooks orders e separa scopes do health",()=>{
  const fallback=applicator();
  const queue=maybeRead("src/config/queueNames.js")||fallback, webhook=maybeRead("src/jobs/webhookProcess.worker.js")||fallback, health=maybeRead("src/services/integrationHealthService.js")||fallback, api=maybeRead("src/routes/api.routes.js")||fallback;
  assert.match(queue,/magalu-orders-sync/);assert.match(webhook,/orders_order/);assert.match(webhook,/orders_delivery/);assert.match(health,/_ORDER_READ_SCOPES|orders_read:/);const stage=api.match(/stage:(\d+)/);assert.ok(Number(stage?.[1]||0)>=7);
});

test("configuração interna mantém margem abaixo do rate limit oficial",()=>{
  const src=maybeRead("src/config/env.js")||applicator();assert.match(src,/MAGALU_RATE_LIMIT_ORDER_READ_PER_MINUTE/);assert.match(src,/MAGALU_RATE_LIMIT_DELIVERY_READ_PER_MINUTE/);assert.match(src,/Math\.min\(800/);
});

test("UI mantém o espelho de pedidos read-only e não solicita PII do comprador",()=>{
  const html=read("views/pedidos.html").toLowerCase(),js=read("public/js/magalu-orders.js").toLowerCase();assert.ok(html.includes("read-only"));
  for(const term of ["telefone do comprador","e-mail do comprador","endereço completo do comprador","cpf do comprador","cnpj do comprador"])assert.equal((html+js).includes(term),false,term);
});

test("Etapa 7 não depende de código seller-ml",()=>{
  const files=["src/services/orderPayload.js","src/services/orderRemoteService.js","src/services/orderSyncService.js","src/repositories/orderRepository.js","src/controllers/orderController.js","src/jobs/ordersSync.worker.js"];
  for(const f of files){const src=read(f);assert.equal(src.includes("seller-ml"),false,f);assert.equal(src.includes("meli_"),false,f);}
});
