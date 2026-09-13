"use strict";

const { httpError } = require("./helpers");

async function uploadPicture(file, ctx) {
  if (!file?.buffer?.length) throw httpError("Selecione uma imagem para enviar.", 400);
  const allowed = new Set(["image/jpeg", "image/png"]);
  if (!allowed.has(String(file.mimetype || "").toLowerCase())) {
    throw httpError("Formato de imagem não suportado. Use JPG, JPEG ou PNG.", 415);
  }
  if (file.size > 10 * 1024 * 1024) throw httpError("A imagem excede o limite de 10 MB do Mercado Livre.", 413);

  const form = new FormData();
  form.append("file", new Blob([file.buffer], { type: file.mimetype }), file.originalname || "imagem.jpg");
  const response = await fetch("https://api.mercadolibre.com/pictures/items/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.accessToken}` },
    body: form,
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    throw httpError(payload?.message || payload?.error || `Falha ao enviar imagem (HTTP ${response.status}).`, response.status, payload, payload?.error || "ML_PICTURE_UPLOAD_ERROR");
  }
  const variations = Array.isArray(payload?.variations) ? payload.variations : [];
  const preview = variations.find((v) => String(v?.size || "").startsWith("500x")) || variations[0] || {};
  return {
    id: payload?.id || null,
    url: preview?.secure_url || preview?.url || null,
    secure_url: preview?.secure_url || null,
    max_size: payload?.max_size || null,
    uploaded: true,
  };
}

module.exports = { uploadPicture };
