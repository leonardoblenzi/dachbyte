"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const ListingCloneService = require("../src/services/ListingCloneService");

const { enrichDraftAttributesForCategory, extractMercadoLivreItemId, extractShopeeListingIds, mergeWithCategoryAttributes, normalizePublishAttributes, parseGenericProductListing, parseMadeiraMadeiraListing, parseShopeePublicListing, stripClipFromDraft } =
  ListingCloneService._test;
const ShopeeProductService = require("../src/services/ShopeeProductService");

test("extracts Shopee ids from canonical and product URLs", () => {
  assert.deepEqual(
    extractShopeeListingIds("https://shopee.com.br/name-i.348584331.58266351557"),
    { shopId: "348584331", itemId: "58266351557" },
  );
  assert.deepEqual(
    extractShopeeListingIds("https://shopee.com.br/product/348584331/58266351557"),
    { shopId: "348584331", itemId: "58266351557" },
  );
});

test("extracts the real Mercado Livre item from product-group URLs", () => {
  assert.equal(
    extractMercadoLivreItemId("https://www.mercadolivre.com.br/up/MLBU3645134793?pdp_filters=item_id:MLB5997110044&matt_tool=38524122#origin=share"),
    "MLB5997110044",
  );
  assert.equal(extractMercadoLivreItemId("https://www.mercadolivre.com.br/MLB-5997110044"), "MLB5997110044");
});
test("imports complete listing data from Shopee MFE initial state", () => {
  const item = {
    item_id: 58266351557,
    shop_id: 348584331,
    name: "Produto completo",
    description: "Descricao completa do anuncio",
    cat_id: 100123,
    brand: "Marca teste",
    images: ["image-a", "image-b"],
    attributes: [{ id: 1, name: "Material", value: "Madeira" }],
    categories: [
      { display_name: "Casa" },
      { display_name: "Moveis" },
    ],
    tier_variations: [{ name: "Cor", options: ["Preto", "Branco"] }],
    models: [
      { model_id: 1, name: "Preto", price: 99.9, stock: 3, extinfo: { tier_index: [0] } },
      { model_id: 2, name: "Branco", price: 109.9, stock: 2, extinfo: { tier_index: [1] } },
    ],
    video_info_list: [{ default_format: { url: "https://cdn.example/clip.mp4" } }],
  };
  const html = `<script type="text/mfe-initial-data">${JSON.stringify({
    initialState: {
      DOMAIN_PDP: {
        data: { PDP_BFF_DATA: { cachedMap: { "348584331/58266351557": { item } } } },
      },
    },
  })}</script>`;

  const source = parseShopeePublicListing(
    html,
    "https://shopee.com.br/product/348584331/58266351557",
  );

  assert.equal(source.itemName, "Produto completo");
  assert.equal(source.description, "Descricao completa do anuncio");
  assert.equal(source.externalShopId, "348584331");
  assert.equal(source.externalItemId, "58266351557");
  assert.equal(source.categoryId, 100123);
  assert.equal(source.categoryPath, "Casa > Moveis");
  assert.equal(source.images.length, 2);
  assert.equal(source.sourceAttributes[0].name, "Material");
  assert.equal(source.variations.models.length, 2);
  assert.equal(source.video.sourceUrl, "https://cdn.example/clip.mp4");
});

test("imports the usable public metadata when Shopee returns a partial page", () => {
  const source = parseShopeePublicListing(
    '<meta property="og:title" content="Produto parcial" /><meta property="og:description" content="Descricao publica" /><meta property="og:image" content="https://cf.shopee.com.br/file/image-a" />',
    "https://shopee.com.br/product/348584331/58266351557",
  );

  assert.equal(source.itemName, "Produto parcial");
  assert.equal(source.description, "Descricao publica");
  assert.equal(source.images.length, 1);
});

test("imports a MadeiraMadeira listing from its public JSON-LD", () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Poltrona Stella",
    description: "Estrutura: Madeira Eucalipto&lt;br/&gt;Peso: 21 kg&lt;br/&gt;Largura total: 77 cm&lt;br/&gt;Profundidade total: 60 cm&lt;br/&gt;Altura total: 81 cm",
    sku: "668676889",
    image: ["https://images.example/poltrona-1.jpg", "https://images.example/poltrona-2.jpg"],
    brand: { name: "D&apos;Rossi" },
    color: "Branco",
    offers: [{ price: 540.72 }],
  })}</script><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [{ name: "Moveis" }, { name: "Poltronas" }, { name: "Poltrona Stella" }],
  })}</script>`;
  const source = parseMadeiraMadeiraListing(
    html,
    "https://www.madeiramadeira.com.br/poltrona-stella-668676889.html",
  );

  assert.equal(source.itemName, "Poltrona Stella");
  assert.equal(source.externalItemId, "668676889");
  assert.equal(source.brandName, "D'Rossi");
  assert.equal(source.price, 540.72);
  assert.equal(source.images.length, 2);
  assert.equal(source.weight, 21);
  assert.equal(source.dimension.package_width, 77);
  assert.equal(source.categoryPath, "Moveis > Poltronas");
});

test("imports a generic public listing from JSON-LD in an @graph", () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [{
      "@type": "Product",
      name: "Buffet Visari",
      description: "Buffet de madeira com quatro portas",
      sku: "90901",
      brand: { name: "D'Rossi" },
      image: ["https://images.example/buffet.jpg"],
      offers: { price: "749.90", availability: "https://schema.org/InStock" },
      additionalProperty: [{ name: "Material", value: "MDF" }],
    }],
  })}</script>`;
  const source = parseGenericProductListing(html, "https://loja.exemplo.com.br/produto.php?IdProd=90901");

  assert.equal(source.itemName, "Buffet Visari");
  assert.equal(source.externalItemId, "90901");
  assert.equal(source.price, 749.9);
  assert.equal(source.stock, 1);
  assert.equal(source.images.length, 1);
  assert.equal(source.sourceAttributes.find((attribute) => attribute.name === "Material")?.values[0], "MDF");
});
test("maps assembly and the explicit Inmetro N/A option to Shopee attribute ids", () => {
  const attributes = mergeWithCategoryAttributes(
    [
      {
        attribute_id: 100730,
        original_attribute_name: "Assembly",
        is_mandatory: true,
        attribute_value_list: [
          { value_id: 3823, original_value_name: "Assembly Required" },
          { value_id: 3807, original_value_name: "Fully Assembled" },
        ],
      },
      {
        attribute_id: 102292,
        original_attribute_name: "Inmetro Certification",
        is_mandatory: true,
        attribute_value_list: [
          { value_id: 17633, original_value_name: "N/A - NBR not applicable" },
        ],
      },
    ],
    [{ name: "Requer montagem", values: ["Sim"] }],
    [],
  );
  const payloadAttributes = normalizePublishAttributes(attributes);

  assert.deepEqual(
    payloadAttributes.find((attribute) => attribute.attribute_id === 100730)?.attribute_value_list,
    [{ value_id: 3823, original_value_name: "Assembly Required", value_name: "Assembly Required" }],
  );
  assert.deepEqual(
    payloadAttributes.find((attribute) => attribute.attribute_id === 102292)?.attribute_value_list,
    [{ value_id: 17633, original_value_name: "N/A - NBR not applicable", value_name: "N/A - NBR not applicable" }],
  );
});

test("reuses official draft attributes when Shopee category attributes are temporarily unavailable", async () => {
  const originalGetAttributeTree = ShopeeProductService.getAttributeTree;
  const originalGetAttributes = ShopeeProductService.getAttributes;
  ShopeeProductService.getAttributeTree = async () => {
    throw new Error("attribute tree unavailable");
  };
  ShopeeProductService.getAttributes = async () => {
    throw new Error("legacy attributes unavailable");
  };

  try {
    const draft = {
      categoryId: "100500",
      attributes: [{
        attributeId: "100730",
        name: "Assembly",
        isMandatory: true,
        values: ["Fully Assembled"],
        sourceAttribute: {
          attribute_id: 100730,
          original_attribute_name: "Assembly",
          is_mandatory: true,
          attribute_value_list: [
            { value_id: 3807, original_value_name: "Fully Assembled" },
          ],
        },
      }],
    };

    const enriched = await enrichDraftAttributesForCategory({ shopId: "348584331" }, draft);

    assert.equal(enriched.attributes.length, 1);
    assert.equal(enriched.attributes[0].attributeId, "100730");
    assert.deepEqual(enriched.attributes[0].values, ["Fully Assembled"]);
  } finally {
    ShopeeProductService.getAttributeTree = originalGetAttributeTree;
    ShopeeProductService.getAttributes = originalGetAttributes;
  }
});

test("uses the legacy category attributes endpoint when the attribute tree is empty", async () => {
  const originalGetAttributeTree = ShopeeProductService.getAttributeTree;
  const originalGetAttributes = ShopeeProductService.getAttributes;
  ShopeeProductService.getAttributeTree = async () => ({ response: { attribute_tree: [] } });
  ShopeeProductService.getAttributes = async () => ({
    response: {
      attribute_list: [{
        attribute_id: 100730,
        original_attribute_name: "Assembly",
        is_mandatory: true,
        attribute_value_list: [
          { value_id: 3807, original_value_name: "Fully Assembled" },
        ],
      }],
    },
  });

  try {
    const enriched = await enrichDraftAttributesForCategory(
      { shopId: "348584331" },
      { categoryId: "100500", attributes: [{ name: "Assembly", values: ["Fully Assembled"] }] },
    );

    assert.equal(enriched.attributes[0].attributeId, "100730");
    assert.deepEqual(enriched.attributes[0].values, ["Fully Assembled"]);
  } finally {
    ShopeeProductService.getAttributeTree = originalGetAttributeTree;
    ShopeeProductService.getAttributes = originalGetAttributes;
  }
});

test("blocks publish fallback when the draft has no official attribute ids", async () => {
  const originalGetAttributeTree = ShopeeProductService.getAttributeTree;
  const originalGetAttributes = ShopeeProductService.getAttributes;
  ShopeeProductService.getAttributeTree = async () => {
    throw new Error("attribute tree unavailable");
  };
  ShopeeProductService.getAttributes = async () => {
    throw new Error("legacy attributes unavailable");
  };

  try {
    await assert.rejects(
      enrichDraftAttributesForCategory(
        { shopId: "348584331" },
        { categoryId: "100500", attributes: [{ name: "Material", values: ["MDF"] }] },
      ),
      (error) => error?.statusCode === 424 && error?.code === "category_attributes_unavailable",
    );
  } finally {
    ShopeeProductService.getAttributeTree = originalGetAttributeTree;
    ShopeeProductService.getAttributes = originalGetAttributes;
  }
});

test("keeps reusable clip data when saving a draft", () => {
  const draft = stripClipFromDraft({
    itemName: "Produto",
    clip: {
      sourceUrl: "https://cdn.example/clip.mp4",
      thumbnailUrl: "https://cdn.example/thumb.jpg",
      videoUploadId: "upload-123",
      previewUrl: "blob:https://app.local/temporary",
    },
  });

  assert.equal(draft.clip.sourceUrl, "https://cdn.example/clip.mp4");
  assert.equal(draft.clip.thumbnailUrl, "https://cdn.example/thumb.jpg");
  assert.equal(draft.clip.videoUploadId, "upload-123");
  assert.equal(draft.clip.previewUrl, undefined);
});
