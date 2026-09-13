"use strict";

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const test = require("node:test");
const assert = require("node:assert/strict");

// Os testes de services não precisam abrir PostgreSQL. Injetamos o contrato mínimo
// de db antes de carregar services que dependem dele.
const dbModulePath = require.resolve("../db/db");
const dbStub = {
  query: async () => { throw new Error("db.query não mockado neste teste"); },
  withClient: async () => { throw new Error("db.withClient não mockado neste teste"); },
};
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: dbStub };

const { normalizeItemId, payloadHash } = require("../services/anuncioCadastro/helpers");
const payloadService = require("../services/anuncioCadastro/anuncioPayloadService");
const strategy = require("../services/anuncioCadastro/anuncioPublicationStrategyService");

function baseDraft(overrides = {}) {
  const { draft_data: draftDataOverrides = {}, ...topLevelOverrides } = overrides;
  return {
    id: 1,
    meli_conta_id: 1,
    publication_model: "legacy",
    publication_target: "new_item",
    category_id: "MLB1234",
    title: "Produto de teste",
    family_name: "Família teste",
    source_type: "blank",
    source_user_product_id: null,
    source_seller_id: null,
    draft_data: {
      title: "Produto de teste",
      family_name: "Família teste",
      category_id: "MLB1234",
      price: 199.9,
      currency_id: "BRL",
      available_quantity: 5,
      buying_mode: "buy_it_now",
      listing_type_id: "gold_special",
      condition: "new",
      sku: "SKU-001",
      gtin: "7891234567890",
      attributes: [{ id: "BRAND", value_name: "Marca" }],
      sale_terms: [],
      pictures: [{ uploaded: true, id: "123-ABC" }],
      shipping: { free_shipping: true, local_pick_up: false },
      channels: ["marketplace"],
      description: "",
      ...draftDataOverrides,
    },
    ...topLevelOverrides,
  };
}

function saleConditionDraft(overrides = {}) {
  const draft = baseDraft({
    publication_model: "user_products",
    publication_target: "sale_condition",
    source_type: "own_family",
    source_user_product_id: "MLBU123",
    source_seller_id: 1234,
    status: "ready",
    validation_status: "valid",
    ...overrides,
  });
  const payload = strategy.buildPublicationPayload(draft);
  draft.validation_hash = strategy.publicationHash(draft, payload);
  return draft;
}

test("normaliza MLB a partir de id e URL", () => {
  assert.equal(normalizeItemId("MLB1234567890"), "MLB1234567890");
  assert.equal(normalizeItemId("https://produto.mercadolivre.com.br/MLB-1234567890-produto"), "MLB1234567890");
  assert.equal(normalizeItemId("sem item"), null);
});

test("payload legacy usa title, ITEM_CONDITION e nunca recria variations", () => {
  const draft = baseDraft({
    draft_data: {
      title: "Produto legacy",
      variations: [{ id: 1 }],
    },
  });
  const payload = payloadService.buildItemPayload(draft);
  assert.equal(payload.title, "Produto legacy");
  assert.equal(Object.hasOwn(payload, "family_name"), false);
  assert.equal(Object.hasOwn(payload, "variations"), false);
  assert.equal(Object.hasOwn(payload, "condition"), false);
  assert.deepEqual(payload.pictures, [{ id: "123-ABC" }]);
  assert.ok(payload.attributes.some((attr) => attr.id === "SELLER_SKU" && attr.value_name === "SKU-001"));
  assert.ok(payload.attributes.some((attr) => attr.id === "GTIN" && attr.value_name === "7891234567890"));
  assert.deepEqual(payload.attributes.find((attr) => attr.id === "ITEM_CONDITION"), {
    id: "ITEM_CONDITION", value_id: "2230284", value_name: "Novo",
  });
});

test("payload User Products para novo produto usa family_name e remove title", () => {
  const draft = baseDraft({ publication_model: "user_products" });
  const payload = payloadService.buildItemPayload(draft);
  assert.equal(payload.family_name, "Família teste");
  assert.equal(Object.hasOwn(payload, "title"), false);
  assert.equal(Object.hasOwn(payload, "variations"), false);
});

test("condição de venda usa payload reduzido do endpoint de User Product", () => {
  const draft = saleConditionDraft();
  const payload = payloadService.buildSaleConditionPayload(draft);
  assert.deepEqual(payload, {
    price: 199.9,
    category_id: "MLB1234",
    currency_id: "BRL",
    buying_mode: "buy_it_now",
    listing_type_id: "gold_special",
    shipping: { free_shipping: true, local_pick_up: false },
    channels: ["marketplace"],
  });
  for (const inherited of ["available_quantity", "attributes", "pictures", "family_name", "title", "condition"]) {
    assert.equal(Object.hasOwn(payload, inherited), false, `${inherited} deve ser herdado do User Product`);
  }
  assert.equal(strategy.publicationEndpoint(draft), "/user-products/MLBU123/items");
  assert.equal(strategy.validationEndpoint(draft), null);
});

test("MLB próprio com user_product_id continua sendo novo produto por padrão", () => {
  const draft = baseDraft({
    publication_model: "user_products",
    source_type: "own_item",
    source_user_product_id: "MLBU123",
    source_seller_id: 1234,
    publication_target: "new_item",
  });
  assert.equal(strategy.publicationTarget(draft), "new_item");
  assert.equal(strategy.publicationEndpoint(draft), "/items");
});

test("validação local bloqueia novo item sem foto e preço", () => {
  const draft = baseDraft({ draft_data: { price: "", pictures: [] } });
  const errors = payloadService.localValidation(draft, { target: "new_item" });
  assert.ok(errors.some((error) => error.field === "price"));
  assert.ok(errors.some((error) => error.field === "pictures"));
  assert.throws(() => payloadService.buildItemPayload(draft), /campos obrigatórios/i);
});

test("condição de venda não exige foto nem estoque porque são herdados do UP", () => {
  const draft = saleConditionDraft({ draft_data: { pictures: [], available_quantity: "" } });
  const errors = payloadService.localValidation(draft, { target: "sale_condition" });
  assert.equal(errors.some((error) => error.field === "pictures"), false);
  assert.equal(errors.some((error) => error.field === "available_quantity"), false);
  assert.doesNotThrow(() => payloadService.buildSaleConditionPayload(draft));
});

test("hash de payload é estável independentemente da ordem das chaves", () => {
  assert.equal(payloadHash({ b: 2, a: { d: 4, c: 3 } }), payloadHash({ a: { c: 3, d: 4 }, b: 2 }));
});

test("hash de publicação inclui destino e User Product", () => {
  const a = saleConditionDraft({ source_user_product_id: "MLBU123" });
  const b = saleConditionDraft({ source_user_product_id: "MLBU456" });
  assert.notEqual(strategy.publicationHash(a), strategy.publicationHash(b));
});

test("payload preserva sale_terms editáveis como garantia e prazo de fabricação", () => {
  const draft = baseDraft({ draft_data: { sale_terms: [
    { id: "WARRANTY_TYPE", value_id: "2230280", value_name: "Garantia do vendedor" },
    { id: "WARRANTY_TIME", value_name: "12 meses" },
    { id: "MANUFACTURING_TIME", value_name: "5 dias" },
  ] } });
  const payload = payloadService.buildItemPayload(draft);
  assert.equal(payload.sale_terms.length, 3);
  assert.ok(payload.sale_terms.some((term) => term.id === "WARRANTY_TIME" && term.value_name === "12 meses"));
});

test("família User Products aceita a resposta oficial user_products_ids quando pertence ao seller", async () => {
  const ml = require("../services/anuncioCadastro/mercadoLivreApi");
  const caps = require("../services/anuncioCadastro/anuncioCapabilitiesService");
  const sourceService = require("../services/anuncioCadastro/anuncioSourceService");
  const originalGet = ml.get;
  const originalCaps = caps.getCapabilities;
  ml.get = async (path) => {
    assert.match(path, /user-products-families\/9871232123$/);
    return { user_products_ids: ["MLBU123", "MLBU456"], family_id: 9871232123, site_id: "MLB", user_id: 1234 };
  };
  caps.getCapabilities = async () => ({ publication_model: "user_products", user_product_seller: true });
  try {
    const family = await sourceService.resolveFamily("9871232123", { siteId: "MLB", accessToken: "test", sellerId: 1234, meliContaId: 1 });
    assert.equal(family.family_id, "9871232123");
    assert.deepEqual(family.products.map((product) => product.user_product_id), ["MLBU123", "MLBU456"]);
  } finally {
    ml.get = originalGet;
    caps.getCapabilities = originalCaps;
  }
});

test("bloqueia família que pertence a outro seller", async () => {
  const ml = require("../services/anuncioCadastro/mercadoLivreApi");
  const caps = require("../services/anuncioCadastro/anuncioCapabilitiesService");
  const sourceService = require("../services/anuncioCadastro/anuncioSourceService");
  const originalGet = ml.get;
  const originalCaps = caps.getCapabilities;
  ml.get = async () => ({ user_products_ids: ["MLBU123"], family_id: 987, site_id: "MLB", user_id: 9999 });
  caps.getCapabilities = async () => ({ publication_model: "user_products", user_product_seller: true });
  try {
    await assert.rejects(
      sourceService.resolveFamily("987", { siteId: "MLB", accessToken: "test", sellerId: 1234, meliContaId: 1 }),
      (error) => error.status === 403 && error.code === "FAMILY_NOT_OWNED",
    );
  } finally {
    ml.get = originalGet;
    caps.getCapabilities = originalCaps;
  }
});

test("bloqueia família sem proprietário confirmado", async () => {
  const ml = require("../services/anuncioCadastro/mercadoLivreApi");
  const caps = require("../services/anuncioCadastro/anuncioCapabilitiesService");
  const sourceService = require("../services/anuncioCadastro/anuncioSourceService");
  const originalGet = ml.get;
  const originalCaps = caps.getCapabilities;
  ml.get = async () => ({ user_products_ids: ["MLBU123"], family_id: 987, site_id: "MLB" });
  caps.getCapabilities = async () => ({ publication_model: "user_products", user_product_seller: true });
  try {
    await assert.rejects(
      sourceService.resolveFamily("987", { siteId: "MLB", accessToken: "test", sellerId: 1234, meliContaId: 1 }),
      (error) => error.status === 422 && error.code === "FAMILY_OWNER_UNCONFIRMED",
    );
  } finally {
    ml.get = originalGet;
    caps.getCapabilities = originalCaps;
  }
});

test("validação de condição de venda faz preflight do UP e não chama /items/validate", async () => {
  const db = dbStub;
  const ml = require("../services/anuncioCadastro/mercadoLivreApi");
  const draftService = require("../services/anuncioCadastro/anuncioDraftService");
  const validationService = require("../services/anuncioCadastro/anuncioValidationService");
  const draft = saleConditionDraft();
  const originalDbQuery = db.query;
  const originalGet = ml.get;
  const originalPost = ml.post;
  const originalGetDraft = draftService.getDraft;
  let postCalls = 0;
  ml.get = async (path) => {
    if (path.startsWith("/user-products/")) return { id: "MLBU123", user_id: 1234 };
    if (path.startsWith("/users/")) return { paging: { total: 2 }, results: ["MLB1", "MLB2"] };
    throw new Error(`GET inesperado: ${path}`);
  };
  ml.post = async () => { postCalls += 1; throw new Error("POST não deveria ser chamado no preflight"); };
  draftService.getDraft = async () => draft;
  db.query = async (_sql, params) => ({ rowCount: 1, rows: [{ ...draft, validation_status: params[2], validation_hash: params[3], status: params[5] }] });
  try {
    const result = await validationService.validateDraft(draft.id, { meliContaId: 1, sellerId: 1234, accessToken: "test", userId: 7 });
    assert.equal(result.valid, true);
    assert.equal(result.target, "sale_condition");
    assert.equal(result.source, "mercadolivre_preflight");
    assert.equal(postCalls, 0);
  } finally {
    db.query = originalDbQuery;
    ml.get = originalGet;
    ml.post = originalPost;
    draftService.getDraft = originalGetDraft;
  }
});

test("publicação de condição de venda usa POST /user-products/{id}/items", async () => {
  const db = dbStub;
  const ml = require("../services/anuncioCadastro/mercadoLivreApi");
  const draftService = require("../services/anuncioCadastro/anuncioDraftService");
  const publicationService = require("../services/anuncioCadastro/anuncioPublicationService");
  const draft = saleConditionDraft();
  const originalDbQuery = db.query;
  const originalGet = ml.get;
  const originalPost = ml.post;
  const originalGetDraft = draftService.getDraft;
  const postPaths = [];
  draftService.getDraft = async () => draft;
  db.query = async (sql) => {
    if (sql.includes("set status='publishing'")) return { rowCount: 1, rows: [{ ...draft, status: "publishing" }] };
    if (sql.includes("set status='published'")) return { rowCount: 1, rows: [{ ...draft, status: "published", published_item_id: "MLB999" }] };
    throw new Error(`SQL inesperado: ${sql}`);
  };
  ml.get = async (path) => {
    assert.equal(path, "/user-products/MLBU123");
    return { id: "MLBU123", user_id: 1234 };
  };
  ml.post = async (path, payload) => {
    postPaths.push(path);
    assert.equal(Object.hasOwn(payload, "attributes"), false);
    assert.equal(Object.hasOwn(payload, "pictures"), false);
    return { status: 201, payload: { id: "MLB999", user_product_id: "MLBU123", permalink: "https://produto/MLB999" } };
  };
  try {
    const result = await publicationService.publishDraft(draft.id, { meliContaId: 1, sellerId: 1234, accessToken: "test", userId: 7 });
    assert.equal(result.item_id, "MLB999");
    assert.equal(result.target, "sale_condition");
    assert.deepEqual(postPaths, ["/user-products/MLBU123/items"]);
  } finally {
    db.query = originalDbQuery;
    ml.get = originalGet;
    ml.post = originalPost;
    draftService.getDraft = originalGetDraft;
  }
});

test("lock concorrente impede dois POSTs para o mesmo rascunho", async () => {
  const db = dbStub;
  const ml = require("../services/anuncioCadastro/mercadoLivreApi");
  const draftService = require("../services/anuncioCadastro/anuncioDraftService");
  const publicationService = require("../services/anuncioCadastro/anuncioPublicationService");
  const draft = saleConditionDraft();
  const originalDbQuery = db.query;
  const originalGet = ml.get;
  const originalPost = ml.post;
  const originalGetDraft = draftService.getDraft;
  let claimed = false;
  let published = false;
  let creationPosts = 0;

  draftService.getDraft = async () => {
    if (published) return { ...draft, status: "published", published_item_id: "MLB999" };
    if (claimed) return { ...draft, status: "publishing" };
    return { ...draft };
  };
  db.query = async (sql) => {
    if (sql.includes("set status='publishing'")) {
      if (claimed) return { rowCount: 0, rows: [] };
      claimed = true;
      return { rowCount: 1, rows: [{ ...draft, status: "publishing" }] };
    }
    if (sql.includes("set status='published'")) {
      published = true;
      return { rowCount: 1, rows: [{ ...draft, status: "published", published_item_id: "MLB999" }] };
    }
    throw new Error(`SQL inesperado: ${sql}`);
  };
  ml.get = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { id: "MLBU123", user_id: 1234 };
  };
  ml.post = async (path) => {
    if (path === "/user-products/MLBU123/items") creationPosts += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { status: 201, payload: { id: "MLB999", user_product_id: "MLBU123" } };
  };
  try {
    const results = await Promise.allSettled([
      publicationService.publishDraft(draft.id, { meliContaId: 1, sellerId: 1234, accessToken: "test", userId: 7 }),
      publicationService.publishDraft(draft.id, { meliContaId: 1, sellerId: 1234, accessToken: "test", userId: 7 }),
    ]);
    assert.equal(creationPosts, 1);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.match(results.find((r) => r.status === "rejected").reason.message, /processo de publicação/i);
  } finally {
    db.query = originalDbQuery;
    ml.get = originalGet;
    ml.post = originalPost;
    draftService.getDraft = originalGetDraft;
  }
});

// =========================
// Grupos, cópias em lote, clonagem de família e retenção
// =========================

test("cópias em lote aceitam 1 e 10; rejeitam 0, negativo, texto e acima de 10", () => {
  const groups = require("../services/anuncioCadastro/anuncioDraftGroupService");
  assert.equal(groups.validateQuantity(1), 1);
  assert.equal(groups.validateQuantity(10), 10);
  for (const invalid of [0, -1, "2", "texto", 11]) {
    assert.throws(() => groups.validateQuantity(invalid), /entre 1 e 10/i);
  }
});

test("cópias de rascunho preservam publication_target e nascem sem estado de validação/publicação herdado", async () => {
  const db = dbStub;
  const groups = require("../services/anuncioCadastro/anuncioDraftGroupService");
  const originalQuery = db.query;
  const originalWithClient = db.withClient;
  const source = {
    id: 41, empresa_id: 9, meli_conta_id: 7, source_type: "own_family", source_item_id: "MLB111",
    source_user_product_id: "MLBU1", source_family_id: "F1", source_seller_id: 123,
    source_snapshot: { id: "MLB111" }, reference_data: {}, publication_model: "user_products",
    publication_target: "sale_condition", category_id: "MLB1", family_name: "Família", title: null,
    status: "ready", validation_status: "valid", validation_hash: "hash-antigo", published_item_id: "MLBVELHO",
    last_publish_result: { ok: true }, revision: 99, draft_data: {
      family_name: "Família", price: 100, sku: "SKU", gtin: "789",
      validation_hash: "interno", published_item_id: "MLBINTERNAL", published_user_product_id: "MLBUOLD",
      published_family_id: "FOLD", published_permalink: "https://old", published_at: "2026-01-01",
      last_publish_result: { ok: true }, validated_at: "2026-01-01", lock: "x", revision: 50,
    },
  };
  const childCalls = [];
  db.query = async () => ({ rowCount: 1, rows: [source] });
  db.withClient = async (fn) => fn({ query: async (sql, params = []) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
    if (sql.includes("insert into ml.anuncio_draft_groups")) return { rowCount: 1, rows: [{ id: 501, type: "batch_copy", name: "Grupo" }] };
    if (sql.includes("insert into ml.anuncio_drafts")) {
      childCalls.push({ sql, params });
      return { rowCount: 1, rows: [{ id: 600 + childCalls.length, draft_group_id: 501 }] };
    }
    throw new Error(`SQL inesperado: ${sql}`);
  } });
  try {
    const result = await groups.createBatchCopies({ source_type: "draft", source_id: 41, quantity: 1, name: "Grupo" }, { empresaId: 9, meliContaId: 7, userId: 5, sellerId: 123 });
    assert.equal(result.drafts.length, 1);
    assert.equal(childCalls[0].params[12], "sale_condition");
    assert.match(childCalls[0].sql, /'review','pending'/);
    for (const forbidden of ["validation_hash", "published_item_id", "last_publish_result", "revision", "validated_at"]) {
      assert.equal(childCalls[0].sql.includes(forbidden), false, `${forbidden} não deve ser copiado no INSERT do filho`);
    }
    const data = JSON.parse(childCalls[0].params[16]);
    assert.equal(data.sku, "SKU");
    assert.equal(data.gtin, "789");
    for (const forbidden of ["validation_hash", "published_item_id", "published_user_product_id", "published_family_id", "published_permalink", "published_at", "last_publish_result", "validated_at", "lock", "revision"]) {
      assert.equal(Object.hasOwn(data, forbidden), false, `${forbidden} não deve existir no draft_data copiado`);
    }
  } finally {
    db.query = originalQuery;
    db.withClient = originalWithClient;
  }
});

test("cópia em lote de anúncio publicado próprio usa new_item e preserva SKU/GTIN editáveis", async () => {
  const db = dbStub;
  const groups = require("../services/anuncioCadastro/anuncioDraftGroupService");
  const sourceService = require("../services/anuncioCadastro/anuncioSourceService");
  const originalResolve = sourceService.resolveItem;
  const originalWithClient = db.withClient;
  let childParams;
  sourceService.resolveItem = async () => ({
    source_type: "own_item", publication_model: "user_products",
    source_snapshot: { id: "MLB123", user_product_id: "MLBU1", family_id: "F1", seller_id: 123, family_name: "Linha X" },
    reference_data: {},
    draft_data: { family_name: "Linha X", category_id: "MLB1", price: 120, sku: "", gtin: "", original_sku: "SKU-ORIG", original_gtin: "789123", attributes: [], pictures: [{ source: "https://img" }], description: "Desc" },
  });
  db.withClient = async (fn) => fn({ query: async (sql, params = []) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("anuncio_draft_groups")) return { rows: [{ id: 10, type: "batch_copy", name: "Grupo" }], rowCount: 1 };
    if (sql.includes("insert into ml.anuncio_drafts")) { childParams = params; return { rows: [{ id: 11 }], rowCount: 1 }; }
    throw new Error(`SQL inesperado: ${sql}`);
  } });
  try {
    await groups.createBatchCopies({ source_type: "item", source_id: "MLB123", quantity: 1 }, { empresaId: 9, meliContaId: 7, sellerId: 123, userId: 5, accessToken: "x" });
    assert.equal(childParams[12], "new_item");
    const data = JSON.parse(childParams[16]);
    assert.equal(data.sku, "SKU-ORIG");
    assert.equal(data.gtin, "789123");
  } finally {
    sourceService.resolveItem = originalResolve;
    db.withClient = originalWithClient;
  }
});

test("grupo e filhos são atômicos: falha em filho executa ROLLBACK e não COMMIT", async () => {
  const db = dbStub;
  const groups = require("../services/anuncioCadastro/anuncioDraftGroupService");
  const originalQuery = db.query;
  const originalWithClient = db.withClient;
  db.query = async () => ({ rowCount: 1, rows: [{
    id: 1, empresa_id: 9, meli_conta_id: 7, source_type: "blank", publication_model: "legacy", publication_target: "new_item",
    draft_data: { title: "A", category_id: "MLB1", price: 10 }, source_snapshot: {}, reference_data: {},
  }] });
  const commands = [];
  let child = 0;
  db.withClient = async (fn) => fn({ query: async (sql) => {
    commands.push(sql);
    if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") return { rows: [], rowCount: 0 };
    if (sql.includes("anuncio_draft_groups")) return { rows: [{ id: 77 }], rowCount: 1 };
    if (sql.includes("insert into ml.anuncio_drafts")) {
      child += 1;
      if (child === 2) throw new Error("falha simulada");
      return { rows: [{ id: 88 }], rowCount: 1 };
    }
    throw new Error("SQL inesperado");
  } });
  try {
    await assert.rejects(groups.createBatchCopies({ source_type: "draft", source_id: 1, quantity: 2 }, { empresaId: 9, meliContaId: 7, userId: 5 }), /falha simulada/);
    assert.ok(commands.includes("ROLLBACK"));
    assert.equal(commands.includes("COMMIT"), false);
  } finally {
    db.query = originalQuery;
    db.withClient = originalWithClient;
  }
});

test("filtro por grupo mantém escopo simultâneo de empresa e conta ML", async () => {
  const db = dbStub;
  const drafts = require("../services/anuncioCadastro/anuncioDraftService");
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("count(*)")) return { rows: [{ total: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  try {
    await drafts.listDrafts({ group_id: 55 }, { empresaId: 9, meliContaId: 7 });
    assert.match(calls[0].sql, /d\.empresa_id=\$1/);
    assert.match(calls[0].sql, /d\.meli_conta_id=\$2/);
    assert.match(calls[0].sql, /d\.draft_group_id=\$3/);
    assert.deepEqual(calls[0].params, [9, 7, 55]);
  } finally { db.query = originalQuery; }
});

function installFamilyApiMocks({ multipleActive = false, secondConditionStatus = "active" } = {}) {
  const ml = require("../services/anuncioCadastro/mercadoLivreApi");
  const sourceService = require("../services/anuncioCadastro/anuncioSourceService");
  const original = { get: ml.get, resolveItem: sourceService.resolveItem, resolveFamily: sourceService.resolveFamily };
  sourceService.resolveItem = async () => ({
    source_type: "own_item", item_id: "MLB1000000",
    source_snapshot: { id: "MLB1000000", user_product_id: "MLBU1", family_id: "FAM1", seller_id: 123, category_id: "MLB1" },
  });
  sourceService.resolveFamily = async () => ({
    family_id: "FAM1", family_name: "Família X",
    products: [{ user_product_id: "MLBU1" }, { user_product_id: "MLBU2" }],
    raw_summary: { user_id: 123, domain_id: "MLB-TEST", category_id: "MLB1" },
  });
  ml.get = async (path, options = {}) => {
    if (path === "/user-products/MLBU1") return { id: "MLBU1", user_id: 123, family_id: "FAM1", family_name: "Família X", category_id: "MLB1", domain_id: "MLB-TEST", attributes: [{ id: "BRAND", name: "Marca", values: [{ id: "B1", name: "Marca" }] }, { id: "COLOR", name: "Cor", values: [{ id: "C1", name: "Branco" }] }], pictures: [{ secure_url: "https://img/1" }] };
    if (path === "/user-products/MLBU2") return { id: "MLBU2", user_id: 123, family_id: "FAM1", family_name: "Família X", category_id: "MLB1", domain_id: "MLB-TEST", attributes: [{ id: "BRAND", name: "Marca", values: [{ id: "B1", name: "Marca" }] }, { id: "COLOR", name: "Cor", values: [{ id: "C2", name: "Preto" }] }], pictures: [{ secure_url: "https://img/2" }] };
    if (path === "/categories/MLB1/attributes") return [{ id: "BRAND", name: "Marca", hierarchy: "PARENT_PK" }, { id: "COLOR", name: "Cor", hierarchy: "CHILD_PK" }];
    if (path.startsWith("/users/123/items/search")) {
      const up = options.query?.user_product_id;
      if (up === "MLBU1" && multipleActive) return { results: ["MLB1100001", "MLB1100002"] };
      return { results: [up === "MLBU1" ? "MLB1100001" : "MLB1200001"] };
    }
    if (path.startsWith("/items?ids=")) {
      const decoded = decodeURIComponent(path.split("ids=")[1] || "");
      return decoded.split(",").filter(Boolean).map((id, index) => ({ body: {
        id, seller_id: 123, status: index === 1 ? secondConditionStatus : "active", title: `Item ${id}`, category_id: "MLB1", price: 100 + index,
        currency_id: "BRL", available_quantity: 5, buying_mode: "buy_it_now", listing_type_id: "gold_special", condition: "new",
        attributes: [{ id: "SELLER_SKU", value_name: `SKU-${id}` }, { id: "GTIN", value_name: `GTIN-${id}` }],
        sale_terms: [], pictures: [{ secure_url: `https://img/${id}` }], shipping: { free_shipping: true }, channels: ["marketplace"],
      } }));
    }
    if (/^\/items\/MLB\d+\/description$/.test(path)) return { plain_text: "Descrição" };
    throw new Error(`GET inesperado no mock de família: ${path}`);
  };
  return () => { ml.get = original.get; sourceService.resolveItem = original.resolveItem; sourceService.resolveFamily = original.resolveFamily; };
}

test("descobre família completa a partir do MLB e preserva blueprint PARENT_PK/CHILD_PK", async () => {
  const familyService = require("../services/anuncioCadastro/anuncioFamilyCloneService");
  const restore = installFamilyApiMocks();
  try {
    const result = await familyService.discoverFamilyFromItem("MLB1000000", { empresaId: 9, meliContaId: 7, sellerId: 123, siteId: "MLB", accessToken: "x" });
    assert.equal(result.source_family_id, "FAM1");
    assert.equal(result.variations.length, 2);
    assert.deepEqual(result.family_blueprint.parent_pk.map((a) => a.id), ["BRAND"]);
    assert.deepEqual(result.family_blueprint.child_pk.map((a) => a.id), ["COLOR"]);
  } finally { restore(); }
});

test("clonagem de família cria um new_item independente por User Product selecionado", async () => {
  const familyService = require("../services/anuncioCadastro/anuncioFamilyCloneService");
  const groups = require("../services/anuncioCadastro/anuncioDraftGroupService");
  const originalCreate = groups.createGroupWithDrafts;
  const restore = installFamilyApiMocks();
  let captured;
  groups.createGroupWithDrafts = async (payload) => { captured = payload; return { group: { id: 90 }, drafts: payload.drafts.map((draft, i) => ({ id: 100 + i, ...draft })) }; };
  try {
    const result = await familyService.createFamilyClone({ source_item_id: "MLB1000000", selected: [{ user_product_id: "MLBU1", source_item_id: "MLB1100001" }, { user_product_id: "MLBU2", source_item_id: "MLB1200001" }] }, { empresaId: 9, meliContaId: 7, sellerId: 123, siteId: "MLB", accessToken: "x", userId: 5 });
    assert.equal(result.drafts.length, 2);
    assert.equal(captured.group.type, "family_clone");
    assert.ok(captured.drafts.every((draft) => draft.publication_target === "new_item"));
    assert.ok(captured.drafts.every((draft) => draft.source_family_id === "FAM1"));
  } finally { groups.createGroupWithDrafts = originalCreate; restore(); }
});

test("clonagem de família limita a seleção a 10 variações", async () => {
  const familyService = require("../services/anuncioCadastro/anuncioFamilyCloneService");
  const selected = Array.from({ length: 11 }, (_, i) => ({ user_product_id: `MLBU${i}` }));
  await assert.rejects(
    familyService.createFamilyClone({ source_item_id: "MLB1000000", selected }, { empresaId: 9, meliContaId: 7, sellerId: 123 }),
    (error) => error.status === 400 && error.code === "FAMILY_CLONE_LIMIT",
  );
});

test("mais de uma condição de venda ativa exige seleção explícita na clonagem da variação", async () => {
  const familyService = require("../services/anuncioCadastro/anuncioFamilyCloneService");
  const groups = require("../services/anuncioCadastro/anuncioDraftGroupService");
  const originalCreate = groups.createGroupWithDrafts;
  const restore = installFamilyApiMocks({ multipleActive: true });
  groups.createGroupWithDrafts = async () => { throw new Error("não deveria criar grupo"); };
  try {
    await assert.rejects(
      familyService.createFamilyClone({ source_item_id: "MLB1000000", selected: [{ user_product_id: "MLBU1" }] }, { empresaId: 9, meliContaId: 7, sellerId: 123, siteId: "MLB", accessToken: "x", userId: 5 }),
      (error) => error.status === 409 && error.code === "CONDITION_SELECTION_REQUIRED",
    );
  } finally { groups.createGroupWithDrafts = originalCreate; restore(); }
});

test("prévia de família só oferece condições de venda ativas como origem", async () => {
  const familyService = require("../services/anuncioCadastro/anuncioFamilyCloneService");
  const restore = installFamilyApiMocks({ multipleActive: true, secondConditionStatus: "paused" });
  try {
    const result = await familyService.discoverFamilyFromItem("MLB1000000", {
      empresaId: 9, meliContaId: 7, sellerId: 123, siteId: "MLB", accessToken: "x",
    });
    const variation = result.variations.find((row) => row.user_product_id === "MLBU1");
    assert.deepEqual(variation.conditions.map((row) => row.status), ["active"]);
    assert.equal(variation.selected_condition_item_id, "MLB1100001");
    assert.equal(variation.requires_condition_choice, false);
  } finally { restore(); }
});

test("validação salva resultado sempre no escopo de empresa e conta ML", async () => {
  const db = dbStub;
  const validationService = require("../services/anuncioCadastro/anuncioValidationService");
  const draft = baseDraft();
  const originalQuery = db.query;
  let updateSql = "";
  db.query = async (sql, params) => {
    updateSql = sql;
    return { rowCount: 1, rows: [{ ...draft, validation_status: params[2], status: params[5] }] };
  };
  try {
    await validationService.saveValidation(draft, { empresaId: 9, meliContaId: 7, userId: 5 }, {
      status: "valid", hash: "hash", data: {}, draftStatus: "ready",
    });
    assert.match(updateSql, /empresa_id=\$3/);
    assert.match(updateSql, /meli_conta_id=\$2/);
  } finally { db.query = originalQuery; }
});

test("publicação recupera MLB já criado sem enviar um segundo POST ao ML", async () => {
  const db = dbStub;
  const ml = require("../services/anuncioCadastro/mercadoLivreApi");
  const draftService = require("../services/anuncioCadastro/anuncioDraftService");
  const publicationService = require("../services/anuncioCadastro/anuncioPublicationService");
  const draft = saleConditionDraft({
    status: "publish_error",
    last_publish_result: { created_item_id: "MLB998", permalink: "https://produto/MLB998", user_product_id: "MLBU123" },
  });
  const originalQuery = db.query;
  const originalGet = ml.get;
  const originalPost = ml.post;
  const originalGetDraft = draftService.getDraft;
  let posts = 0;
  draftService.getDraft = async () => draft;
  db.query = async (sql) => {
    if (sql.includes("set status='published'")) return { rowCount: 1, rows: [{ ...draft, status: "published", published_item_id: "MLB998" }] };
    throw new Error(`SQL inesperado: ${sql}`);
  };
  ml.get = async () => ({ id: "MLBU123", user_id: 1234 });
  ml.post = async () => { posts += 1; throw new Error("não deve publicar novamente"); };
  try {
    const result = await publicationService.publishDraft(draft.id, { empresaId: 9, meliContaId: 1, sellerId: 1234, accessToken: "test", userId: 7 });
    assert.equal(posts, 0);
    assert.equal(result.item_id, "MLB998");
    assert.equal(result.recovered, true);
    assert.equal(result.draft.published_item_id, "MLB998");
  } finally {
    db.query = originalQuery;
    ml.get = originalGet;
    ml.post = originalPost;
    draftService.getDraft = originalGetDraft;
  }
});

test("grupo de family_clone registra o primeiro family_id e detecta divergência posterior", async () => {
  const db = dbStub;
  const groups = require("../services/anuncioCadastro/anuncioDraftGroupService");
  const originalWithClient = db.withClient;
  let expected = null;
  db.withClient = async (fn) => fn({ query: async (sql, params = []) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("select * from ml.anuncio_draft_groups")) return { rowCount: 1, rows: [{ id: 5, type: "family_clone", expected_published_family_id: expected }] };
    if (sql.includes("set expected_published_family_id")) { expected = params[3]; return { rowCount: 1, rows: [] }; }
    if (sql.includes("set updated_at=now()")) return { rowCount: 1, rows: [] };
    throw new Error(`SQL inesperado: ${sql}`);
  } });
  try {
    const first = await groups.recordPublishedFamily(5, "NEWFAM1", { empresaId: 9, meliContaId: 7 });
    assert.equal(first.expected_family_id, "NEWFAM1");
    assert.equal(first.divergent, false);
    const second = await groups.recordPublishedFamily(5, "NEWFAM2", { empresaId: 9, meliContaId: 7 });
    assert.equal(second.expected_family_id, "NEWFAM1");
    assert.equal(second.divergent, true);
  } finally { db.withClient = originalWithClient; }
});

test("limpeza diária remove inativos, lixeira, histórico publicado e grupos vazios sem tocar publishing", async () => {
  const db = dbStub;
  const cleanup = require("../services/anuncioCadastro/anuncioDraftCleanupScheduler");
  const originalWithClient = db.withClient;
  const sqls = [];
  db.withClient = async (fn) => fn({ query: async (sql) => {
    sqls.push(sql);
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("pg_advisory_unlock")) return { rows: [], rowCount: 0 };
    if (sql.includes("deleted_at is not null")) return { rowCount: 1, rows: [] };
    if (sql.includes("published_at is not null")) return { rowCount: 2, rows: [] };
    if (sql.includes("published_item_id is null")) return { rowCount: 3, rows: [] };
    if (sql.includes("delete from ml.anuncio_draft_groups")) return { rowCount: 4, rows: [] };
    throw new Error(`SQL inesperado: ${sql}`);
  } });
  try {
    const result = await cleanup.cleanupExpiredDrafts({ now: new Date("2026-08-31T12:00:00Z") });
    assert.deepEqual({ inactive: result.inactive_drafts, trash: result.trash, published: result.published_history, groups: result.empty_groups }, { inactive: 3, trash: 1, published: 2, groups: 4 });
    const draftDeletes = sqls.filter((sql) => sql.includes("delete from ml.anuncio_drafts"));
    assert.equal(draftDeletes.length, 3);
    assert.ok(draftDeletes.some((sql) => /status <> 'publishing'/.test(sql) && /updated_at/.test(sql)));
    assert.ok(draftDeletes.some((sql) => /status <> 'publishing'/.test(sql) && /deleted_at/.test(sql)));
    assert.ok(draftDeletes.some((sql) => /status = 'published'/.test(sql)));
    assert.ok(draftDeletes.every((sql) => /limit \$2/i.test(sql)), "cada limpeza deve processar um lote limitado");
    assert.equal(require.cache[require.resolve("../services/anuncioCadastro/anuncioDraftCleanupScheduler")].exports.ml, undefined);
  } finally { db.withClient = originalWithClient; }
});


test("restauração respeita o prazo de 30 dias da lixeira", async () => {
  const db = dbStub;
  const drafts = require("../services/anuncioCadastro/anuncioDraftService");
  const originalQuery = db.query;
  let updates = 0;
  db.query = async (sql) => {
    if (sql.includes("from ml.anuncio_drafts d")) {
      return { rowCount: 1, rows: [{
        id: 91, empresa_id: 9, meli_conta_id: 7, source_type: "blank", publication_model: "legacy",
        publication_target: "new_item", status: "review", validation_status: "pending", draft_data: {},
        deleted_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), published_item_id: null,
      }] };
    }
    if (sql.startsWith("update ml.anuncio_drafts")) { updates += 1; return { rowCount: 1, rows: [] }; }
    throw new Error(`SQL inesperado: ${sql}`);
  };
  try {
    await assert.rejects(
      drafts.restore(91, { empresaId: 9, meliContaId: 7, userId: 5 }),
      (error) => error.status === 410 && error.code === "DRAFT_RESTORE_EXPIRED",
    );
    assert.equal(updates, 0);
  } finally { db.query = originalQuery; }
});
