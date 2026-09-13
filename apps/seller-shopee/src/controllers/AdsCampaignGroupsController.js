const {
  createAdsCampaignGroup,
  deleteAdsCampaignGroup,
  findAdsCampaignGroup,
  listAdsCampaignGroups,
  updateAdsCampaignGroup,
} = require("../repositories/adsCampaignGroupsSqlRepository");
const { resolveShop } = require("../utils/resolveShop");

function toStrList(v) {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];

  const seen = new Set();
  return arr
    .map(String)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

async function list(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);

    const groups = await listAdsCampaignGroups(shop.id);

    const payload = groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description || null,
      campaign_ids: g.campaignIds.map(String),
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    }));

    return res.json({ response: { groups: payload } });
  } catch (e) {
    return next(e);
  }
}

async function create(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);

    const name = String(req.body?.name || "").trim();
    const description =
      req.body?.description != null ? String(req.body.description) : null;
    const campaignIds = toStrList(req.body?.campaignIds);

    if (!name) {
      return res
        .status(400)
        .json({ error: { message: "name e obrigatorio." } });
    }
    if (!campaignIds.length) {
      return res.status(400).json({
        error: { message: "campaignIds e obrigatorio (array ou csv)." },
      });
    }
    if (campaignIds.length > 500) {
      return res
        .status(400)
        .json({ error: { message: "Maximo 500 campaignIds por grupo." } });
    }

    const created = await createAdsCampaignGroup({
      shopId: shop.id,
      name,
      description,
      campaignIds,
    });

    return res.status(201).json({
      response: {
        group: {
          id: created.id,
          name: created.name,
          description: created.description || null,
          campaign_ids: created.campaignIds.map(String),
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
      },
    });
  } catch (e) {
    return next(e);
  }
}

async function update(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);

    const groupId = Number(req.params.groupId);
    if (!Number.isFinite(groupId)) {
      return res.status(400).json({ error: { message: "groupId invalido." } });
    }

    const name = req.body?.name != null ? String(req.body.name).trim() : null;
    const description =
      req.body?.description != null ? String(req.body.description) : null;
    const campaignIds =
      req.body?.campaignIds != null ? toStrList(req.body.campaignIds) : null;

    const existing = await findAdsCampaignGroup(shop.id, groupId);

    if (!existing) {
      return res
        .status(404)
        .json({ error: { message: "Grupo nao encontrado." } });
    }
    if (campaignIds != null && !campaignIds.length) {
      return res.status(400).json({
        error: { message: "campaignIds nao pode ser vazio quando enviado." },
      });
    }

    const updated = await updateAdsCampaignGroup({
      groupId,
      name,
      description,
      campaignIds,
    });

    return res.json({
      response: {
        group: {
          id: updated.id,
          name: updated.name,
          description: updated.description || null,
          campaign_ids: updated.campaignIds.map(String),
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        },
      },
    });
  } catch (e) {
    return next(e);
  }
}

async function remove(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);

    const groupId = Number(req.params.groupId);
    if (!Number.isFinite(groupId)) {
      return res.status(400).json({ error: { message: "groupId invalido." } });
    }

    const existing = await findAdsCampaignGroup(shop.id, groupId);

    if (!existing) {
      return res
        .status(404)
        .json({ error: { message: "Grupo nao encontrado." } });
    }

    await deleteAdsCampaignGroup(groupId);

    return res.json({ response: { ok: true } });
  } catch (e) {
    return next(e);
  }
}

module.exports = {
  list,
  create,
  update,
  remove,
};
