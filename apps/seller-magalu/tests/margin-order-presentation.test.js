"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {enrichMarginRows}=require("../src/services/marginOrderPresentation");

test("returns confirmed missing-cost SKUs without duplicates",()=>{
  const rows=enrichMarginRows([{id:10,code:"A",first_sku:null,first_product:null}], [
    {order_id:10,sku:"SKU-1",name:"Produto",quantity:1,unit_cost:null},
    {order_id:10,sku:"SKU-1",name:"Produto",quantity:2,unit_cost:null},
    {order_id:10,sku:"SKU-2",name:"Outro",quantity:1,unit_cost:12}
  ],[]);
  assert.equal(rows[0].identity_state,"identified");
  assert.equal(rows[0].first_sku,"SKU-1");
  assert.deepEqual(rows[0].missing_cost_skus,[{sku:"SKU-1",name:"Produto",quantity:3}]);
});

test("delivery-only identity never becomes an actionable missing cost",()=>{
  const rows=enrichMarginRows([{id:10,code:"A",cost_complete:false}],[],[
    {order_id:10,sku:"DEL-SKU",name:"Na entrega",quantity:1}
  ]);
  assert.equal(rows[0].identity_state,"delivery_only");
  assert.equal(rows[0].first_sku,"DEL-SKU");
  assert.deepEqual(rows[0].missing_cost_skus,[]);
  assert.equal(rows[0].cost_complete,false);
});

test("unknown SKU stays unavailable and does not create a cost action",()=>{
  const rows=enrichMarginRows([{id:10,code:"A",cost_complete:false}], [
    {order_id:10,sku:null,name:"Nome parcial",quantity:1,unit_cost:null}
  ],[]);
  assert.equal(rows[0].identity_state,"unavailable");
  assert.equal(rows[0].first_product,"Nome parcial");
  assert.deepEqual(rows[0].missing_cost_skus,[]);
});

test("SKU absent from the synchronized catalog is not offered for cost editing",()=>{
  const rows=enrichMarginRows([{id:10,code:"A",cost_complete:false}], [
    {order_id:10,sku:"OLD-SKU",name:"Antigo",quantity:1,unit_cost:null,catalog_present:false}
  ],[]);
  assert.deepEqual(rows[0].missing_cost_skus,[]);
  assert.deepEqual(rows[0].unavailable_cost_skus,["OLD-SKU"]);
});
