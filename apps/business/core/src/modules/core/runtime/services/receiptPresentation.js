"use strict";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function receiptHtmlWithCompany(html, companyName) {
  const content = String(html || "");
  const name = String(companyName || "").trim();
  if (!content || !name) return content;
  const withoutLegacyTitle = content.replace(/<title>Recibo Volt Core<\/title>/i,
    `<title>Recibo - ${escapeHtml(name)}</title>`);
  if (/class=["'][^"']*\bcompany-name\b/i.test(withoutLegacyTitle)) return withoutLegacyTitle;
  return withoutLegacyTitle.replace(/<body([^>]*)>/i, (openingTag) =>
    `${openingTag}<p class="company-name" style="font-size:18px;font-weight:700;margin:0 0 18px">${escapeHtml(name)}</p>`);
}

module.exports = { receiptHtmlWithCompany };
