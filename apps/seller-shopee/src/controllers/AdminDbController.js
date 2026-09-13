const multer = require("multer");
const {
  listRowsForBackup,
  restoreModels,
} = require("../repositories/adminDbSqlRepository");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 }, // 80MB
});

const MODEL_ORDER = [
  "account",
  "user",
  "shop",
  "oAuthToken",
  "product",
  "productImage",
  "productModel",
  "order",
  "orderGeoAddress",
  "orderAddressSnapshot",
  "orderAddressChangeAlert",
  "orderItem",
  "adsCampaignGroup",
  "adsCampaignGroupCampaign",
];

// Campos BigInt (precisam ir/voltar como string no JSON)
const BIGINT_FIELDS = {
  shop: ["shopId"],
  product: ["itemId", "categoryId"],
  productModel: ["modelId"],
  orderItem: ["itemId", "modelId"],
};

const DATE_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "expiresAt",
  "shipByDate",
  "shopeeCreateTime",
  "shopeeUpdateTime",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
  "detectedAt",
]);

function assertAdmin(req) {
  const role = String(req?.auth?.user?.role || req?.auth?.role || "");
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

function serializeForJson(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) return value.map(serializeForJson);

  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = serializeForJson(item);
    }
    return out;
  }

  return value;
}

function reviveBigInts(modelKey, rows) {
  const fields = BIGINT_FIELDS[modelKey] || [];
  if (!fields.length) return rows;

  return (Array.isArray(rows) ? rows : []).map((row) => {
    const nextRow = { ...row };
    for (const field of fields) {
      if (nextRow[field] == null) continue;
      nextRow[field] = BigInt(nextRow[field]);
    }
    return nextRow;
  });
}

function reviveDates(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const nextRow = { ...row };

    for (const key of Object.keys(nextRow)) {
      if (!DATE_KEYS.has(key)) continue;

      const value = nextRow[key];

      // Backup antigo bugado: Date virou {}
      if (value && typeof value === "object" && Object.keys(value).length === 0) {
        delete nextRow[key];
        continue;
      }

      if (typeof value === "string" && value) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
          nextRow[key] = parsed;
        }
      }
    }

    return nextRow;
  });
}

const AdminDbController = {
  uploadMiddleware: upload.single("file"),

  async backup(req, res) {
    if (!assertAdmin(req)) return res.status(403).json({ error: "forbidden" });

    const data = {};
    for (const modelKey of MODEL_ORDER) {
      const rows = await listRowsForBackup(modelKey);
      data[modelKey] = serializeForJson(rows);
    }

    const payload = {
      meta: {
        version: 1,
        createdAt: new Date().toISOString(),
        provider: "postgresql",
        models: MODEL_ORDER,
      },
      data,
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="db-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return res.status(200).send(JSON.stringify(payload));
  },

  async restore(req, res) {
    if (!assertAdmin(req)) return res.status(403).json({ error: "forbidden" });
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Arquivo ausente (field: file)." });
    }

    let payload;
    try {
      payload = JSON.parse(req.file.buffer.toString("utf8"));
    } catch (_error) {
      return res.status(400).json({ error: "JSON invalido." });
    }

    const models = payload?.meta?.models;
    const data = payload?.data;

    if (!Array.isArray(models) || !data || typeof data !== "object") {
      return res
        .status(400)
        .json({ error: "Formato invalido (meta.models/data)." });
    }

    const same =
      models.length === MODEL_ORDER.length &&
      models.every((modelKey, index) => modelKey === MODEL_ORDER[index]);

    if (!same) {
      return res.status(400).json({
        error: "Backup incompativel com o schema atual (lista de modelos).",
        details: { expected: MODEL_ORDER, file: models },
      });
    }

    const restoredData = {};
    for (const modelKey of models) {
      const rowsRaw = Array.isArray(data[modelKey]) ? data[modelKey] : [];
      restoredData[modelKey] = reviveDates(reviveBigInts(modelKey, rowsRaw));
    }

    await restoreModels({
      models,
      data: restoredData,
    });

    return res.status(200).json({ ok: true });
  },
};

module.exports = AdminDbController;
