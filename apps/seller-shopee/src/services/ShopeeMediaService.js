const axios = require("axios");
const FormData = require("form-data");
const crypto = require("crypto");
const shopee = require("../config/shopee");
const TokenRepository = require("../repositories/TokenRepository");
const ShopeeAuthService = require("./ShopeeAuthService");

function sign(path, timestamp) {
  return crypto
    .createHmac("sha256", shopee.PARTNER_KEY)
    .update(`${shopee.PARTNER_ID}${path}${timestamp}`)
    .digest("hex");
}

function signWithToken(path, timestamp, accessToken, shopId) {
  return crypto
    .createHmac("sha256", shopee.PARTNER_KEY)
    .update(
      `${shopee.PARTNER_ID}${path}${timestamp}${String(accessToken || "")}${String(shopId || "")}`,
    )
    .digest("hex");
}

function isShopeeError(data) {
  return typeof data?.error === "string" && data.error.trim() !== "";
}

function isExpiringSoon(date, skewSeconds = 180) {
  if (!date) return true;
  return Date.now() >= new Date(date).getTime() - skewSeconds * 1000;
}

async function getValidAccessToken(shopId) {
  const found = await TokenRepository.getTokensByShopId(shopId);
  if (!found || !found.tokens) {
    const err = new Error("Tokens nao encontrados para este shop_id");
    err.statusCode = 400;
    throw err;
  }

  const { accessToken, accessTokenExpiresAt } = found.tokens;

  if (!accessToken || isExpiringSoon(accessTokenExpiresAt)) {
    const refreshed = await ShopeeAuthService.refreshAccessToken({
      shopId: String(shopId),
    });
    return refreshed.access_token;
  }

  return accessToken;
}

async function uploadImage({ files, business, scene }) {
  const path = "/api/v2/media/upload_image";
  const timestamp = Math.floor(Date.now() / 1000);
  const form = new FormData();
  form.append("business", String(business));
  form.append("scene", String(scene));
  files.forEach((f) =>
    form.append("images", f.buffer, {
      filename: f.originalname,
      contentType: f.mimetype,
    })
  );
  try {
    const { data } = await axios.post(
      `${shopee.SHOPEE_API_BASE}${path}`,
      form,
      {
        params: {
          partner_id: Number(shopee.PARTNER_ID),
          timestamp,
          sign: sign(path, timestamp),
        },
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        timeout: 30000,
      }
    );
    if (isShopeeError(data)) {
      const e = new Error("Shopee API error");
      e.statusCode = 400;
      e.shopee = data;
      throw e;
    }
    return data?.response?.image_list || [];
  } catch (err) {
    const e = new Error("Shopee API error");
    e.statusCode = err.response?.status || 502;
    e.shopee = err.response?.data || { message: err.message };
    throw e;
  }
}

function extractVideoUploadFromResponse(data) {
  const response = data?.response || {};
  const listCandidate =
    (Array.isArray(response?.video_info_list) ? response.video_info_list[0] : null) ||
    (Array.isArray(response?.video_list) ? response.video_list[0] : null) ||
    response?.video_info ||
    null;

  const videoUploadIdCandidates = [
    response?.video_upload_id,
    Array.isArray(response?.video_upload_id_list) ? response.video_upload_id_list[0] : null,
    listCandidate?.video_upload_id,
    listCandidate?.video_id,
  ];
  const videoUploadId = videoUploadIdCandidates
    .map((value) => String(value || "").trim())
    .find(Boolean);

  return {
    videoUploadId: videoUploadId || "",
    videoUrl: String(
      response?.video_url ||
        listCandidate?.video_url ||
        listCandidate?.url ||
        listCandidate?.default_format?.url ||
        "",
    ),
    thumbnailUrl: String(
      response?.thumbnail_url ||
        listCandidate?.thumbnail_url ||
        listCandidate?.item_cover ||
        "",
    ),
    durationSeconds:
      Number(response?.duration || listCandidate?.duration || 0) > 0
        ? Number(response?.duration || listCandidate?.duration)
        : null,
    raw: response,
  };
}

async function tryUploadVideoByPath({
  path,
  fieldName,
  file,
  business,
  scene,
  accessToken,
  shopId,
}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const form = new FormData();
  form.append("business", String(business));
  form.append("scene", String(scene));
  form.append(fieldName, file.buffer, {
    filename: file.originalname,
    contentType: file.mimetype,
  });

  const { data } = await axios.post(`${shopee.SHOPEE_API_BASE}${path}`, form, {
    params: {
      partner_id: Number(shopee.PARTNER_ID),
      timestamp,
      access_token: String(accessToken),
      shop_id: String(shopId),
      sign: signWithToken(path, timestamp, accessToken, shopId),
    },
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    timeout: 60000,
  });

  if (isShopeeError(data)) {
    const err = new Error("Shopee API error");
    err.statusCode = 400;
    err.shopee = data;
    throw err;
  }

  const parsed = extractVideoUploadFromResponse(data);
  if (!parsed.videoUploadId) {
    const err = new Error("Shopee nao retornou video_upload_id.");
    err.statusCode = 502;
    err.shopee = data;
    throw err;
  }

  return parsed;
}

async function tryUploadVideoByPathCommon({
  path,
  fieldName,
  file,
  business,
  scene,
}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const form = new FormData();
  form.append("business", String(business));
  form.append("scene", String(scene));
  form.append(fieldName, file.buffer, {
    filename: file.originalname,
    contentType: file.mimetype,
  });

  const { data } = await axios.post(`${shopee.SHOPEE_API_BASE}${path}`, form, {
    params: {
      partner_id: Number(shopee.PARTNER_ID),
      timestamp,
      sign: sign(path, timestamp),
    },
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    timeout: 60000,
  });

  if (isShopeeError(data)) {
    const err = new Error("Shopee API error");
    err.statusCode = 400;
    err.shopee = data;
    throw err;
  }

  const parsed = extractVideoUploadFromResponse(data);
  if (!parsed.videoUploadId) {
    const err = new Error("Shopee nao retornou video_upload_id.");
    err.statusCode = 502;
    err.shopee = data;
    throw err;
  }

  return parsed;
}

async function uploadVideo({ file, shopId, business = 1, scene = 1 }) {
  const accessToken = await getValidAccessToken(String(shopId));
  const path = "/api/v2/media_space/upload_video";
  const fieldNames = ["video", "file", "video_file"];
  let lastError = null;

  for (const fieldName of fieldNames) {
    try {
      // Media Space video uploads use the same partner signature as image uploads.
      // eslint-disable-next-line no-await-in-loop
      return await tryUploadVideoByPathCommon({
        path,
        fieldName,
        file,
        business,
        scene,
      });
    } catch (error) {
      lastError = error;
    }
  }

  for (const fieldName of fieldNames) {
    try {
      // Some partner configurations still require the shop token for this endpoint.
      // eslint-disable-next-line no-await-in-loop
      return await tryUploadVideoByPath({
        path,
        fieldName,
        file,
        business,
        scene,
        accessToken,
        shopId: String(shopId),
      });
    } catch (error) {
      lastError = error;
    }
  }

  const e = new Error("Falha ao enviar clip para Shopee.");
  e.statusCode = lastError?.statusCode || lastError?.response?.status || 502;
  e.shopee = lastError?.shopee || lastError?.response?.data || { message: lastError?.message };
  throw e;
}
module.exports = { uploadImage, uploadVideo };
