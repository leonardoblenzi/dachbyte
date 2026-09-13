function meaningful(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function buildOpticalProductExtensionPayload(values = {}) {
  const opticalSpecs = {
    size: values.opticalSize || "",
    color: values.opticalColor || "",
    material: values.opticalMaterial || "",
    refractiveIndex: values.refractiveIndex || "",
    treatment: values.opticalTreatment || "",
  };
  const itemKind = String(values.itemKind || "").trim();
  const inferredType = itemKind === "frame" ? "frame" : ["lens_stock", "lens_order"].includes(itemKind) ? "lens" : "";
  const opticalType = String(values.opticalType || inferredType || "").trim();
  const catalogType = ({ frame: "Armacao", lens_stock: "Lente em estoque", lens_order: "Lente encomendada", accessory: "Acessorio" })[itemKind] || null;
  if (!opticalType && !catalogType && !Object.values(opticalSpecs).some(meaningful)) return null;
  return { opticalType: opticalType || null, opticalSpecs, ...(catalogType ? { catalogType } : {}) };
}

export { buildOpticalProductExtensionPayload };
