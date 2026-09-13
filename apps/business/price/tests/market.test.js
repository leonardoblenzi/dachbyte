"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { matchListing, marketRange, detectListingSignals, summarizeProductMarket, missingFromCompleteSnapshot } = require("../src/market/analytics");
const { normalizeMeliListing, normalizeImportedListing } = require("../src/market/normalization");

test("EAN exato produz match automatico de alta confianca", () => {
  const result = matchListing(
    { externalId: "MLB-1", title: "Fone Pro", gtin: "7891234567890", brand: "Volt", mpn: "VP1" },
    [
      { id: "p1", sku: "A", name: "Outro", metadata: { gtin: "7890000000000" } },
      { id: "p2", sku: "B", name: "Fone Pro", metadata: { ean: "7891234567890" } },
    ],
  );
  assert.deepEqual(result, { status: "matched", productId: "p2", confidence: 1, reason: "exact_gtin" });
});

test("marca e MPN exatos produzem match automatico sem depender do titulo", () => {
  const result = matchListing(
    { title: "Nome comercial diferente", brand: "ACME", mpn: "ZX-90" },
    [{ id: "p1", name: "Produto interno", metadata: { brand: "Acme", mpn: "zx-90" } }],
  );
  assert.equal(result.status, "matched");
  assert.equal(result.productId, "p1");
  assert.equal(result.reason, "exact_brand_mpn");
  assert.equal(result.confidence, 0.98);
});

test("titulo parecido nunca e aceito automaticamente", () => {
  const result = matchListing(
    { title: "Fone Bluetooth Pro X3 Preto" },
    [{ id: "p1", name: "Fone Bluetooth Pro X3", metadata: {} }],
  );
  assert.equal(result.status, "review");
  assert.equal(result.productId, "p1");
  assert.equal(result.reason, "title_similarity_requires_review");
  assert.ok(result.confidence >= 0.7 && result.confidence < 0.9);
});

test("candidatos fortes ambiguos vao para revisao humana", () => {
  const result = matchListing(
    { gtin: "7891234567890", title: "Produto" },
    [
      { id: "p1", name: "Produto A", metadata: { gtin: "7891234567890" } },
      { id: "p2", name: "Produto B", metadata: { ean: "7891234567890" } },
    ],
  );
  assert.equal(result.status, "review");
  assert.equal(result.productId, null);
  assert.equal(result.reason, "ambiguous_exact_gtin");
});

test("faixa de mercado calcula mediana, quartis e posicao do preco proprio", () => {
  const result = marketRange([80, 100, 120, 140, 200], 150);
  assert.deepEqual(result, { count: 5, minimum: 80, p25: 100, median: 120, p75: 140, maximum: 200, ownVsMedian: 0.25, position: "above_market" });
});

test("ruptura, retorno, novo listing e mudanca relevante de preco geram sinais", () => {
  assert.deepEqual(detectListingSignals(null, { available: true, price: 100 }).map((item) => item.type), ["new_listing"]);
  assert.deepEqual(detectListingSignals({ available: true, price: 100 }, { available: false, price: 100 }).map((item) => item.type), ["out_of_stock"]);
  assert.deepEqual(detectListingSignals({ available: false, price: 100 }, { available: true, price: 90 }).map((item) => item.type), ["back_in_stock", "price_drop"]);
});

test("resumo por produto ignora listings indisponiveis na faixa de preco", () => {
  const summary = summarizeProductMarket([
    { observed_price: 90, available: true },
    { observed_price: 110, available: true },
    { observed_price: 20, available: false },
  ], 100);
  assert.equal(summary.availableCompetitors, 2);
  assert.equal(summary.outOfStock, 1);
  assert.equal(summary.range.median, 100);
});

test("normaliza listing oficial do Mercado Livre e extrai identificadores", () => {
  const listing = normalizeMeliListing({
    id: "MLB123", title: "Fone X", price: 199.9, available_quantity: 0, permalink: "https://produto.mercadolivre.com.br/MLB123",
    seller: { id: 321, nickname: "CONCORRENTE" },
    attributes: [{ id: "GTIN", value_name: "7891234567890" }, { id: "BRAND", value_name: "Volt" }, { id: "MODEL", value_name: "X-1" }],
  });
  assert.deepEqual(listing, { externalId:"MLB123",title:"Fone X",price:199.9,currency:"BRL",available:false,url:"https://produto.mercadolivre.com.br/MLB123",sellerId:"321",sellerName:"CONCORRENTE",gtin:"7891234567890",brand:"Volt",mpn:"X-1",categoryId:null,payload:{listingType:null,condition:null} });
});

test("importacao exige identificador externo e preco valido", () => {
  assert.throws(()=>normalizeImportedListing({ title:"Sem ID",price:10 }),/identificador externo/i);
  assert.throws(()=>normalizeImportedListing({ externalId:"A",title:"Preco ruim",price:"x" }),/preco valido/i);
  assert.equal(normalizeImportedListing({ externalId:"A",title:"Produto",price:"10,50",available:"false" }).price,10.5);
  assert.equal(normalizeImportedListing({ externalId:"A",title:"Produto",price:"10,50",available:"false" }).available,false);
});

test("somente snapshot completo transforma listings ausentes em ruptura", () => {
  const existing=[{external_listing_id:"A",available:true},{external_listing_id:"B",available:true},{external_listing_id:"C",available:false}];
  assert.deepEqual(missingFromCompleteSnapshot(existing,["A"],false),[]);
  assert.deepEqual(missingFromCompleteSnapshot(existing,["A"],true).map((row)=>row.external_listing_id),["B"]);
});
