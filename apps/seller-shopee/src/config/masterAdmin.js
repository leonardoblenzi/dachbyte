"use strict";

const DEFAULT_MASTER_ADMIN_EMAILS = [
  "cadastro6@drossiinteriores.com.br",
  "admin@davanttishp.com.br",
];

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function splitEmails(value) {
  return String(value || "")
    .split(/[;,\s]+/)
    .map(normalizeEmail)
    .filter(Boolean);
}

function getMasterAdminEmails() {
  return Array.from(
    new Set([
      ...DEFAULT_MASTER_ADMIN_EMAILS,
      ...splitEmails(process.env.SHOPEE_MASTER_ADMIN_EMAILS),
      ...splitEmails(process.env.MASTER_ADMIN_EMAILS),
      ...splitEmails(process.env.MASTER_ADMIN_EMAIL),
    ]),
  );
}

function isMasterAdminEmail(email) {
  const normalized = normalizeEmail(email);
  return Boolean(normalized && getMasterAdminEmails().includes(normalized));
}

function isMasterAdminAuth(auth) {
  if (!auth) return false;
  return (
    String(auth.role || "").toUpperCase() === "SUPER_ADMIN" &&
    isMasterAdminEmail(auth.email)
  );
}

function getEffectiveShopeeRole(user) {
  return isMasterAdminEmail(user?.email) ? "SUPER_ADMIN" : user?.role || null;
}

module.exports = {
  DEFAULT_MASTER_ADMIN_EMAILS,
  getEffectiveShopeeRole,
  getMasterAdminEmails,
  isMasterAdminAuth,
  isMasterAdminEmail,
};
