"use strict";

const { env } = require("../../config/env");

function normalizeCustomerId(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function extractCustomerId(resourceName) {
  const match = String(resourceName || "").match(/customers\/(\d+)/);
  return match ? match[1] : normalizeCustomerId(resourceName);
}

class GoogleAdsClient {
  constructor({ accessToken, apiVersion = env.googleAdsApiVersion, developerToken = env.googleAdsDeveloperToken }) {
    this.accessToken = accessToken;
    this.apiVersion = apiVersion || "v25";
    this.developerToken = developerToken || "";
  }

  headers(loginCustomerId) {
    const headers = {
      authorization: `Bearer ${this.accessToken}`,
      accept: "application/json",
      "content-type": "application/json",
    };
    if (this.developerToken) headers["developer-token"] = this.developerToken;
    const login = normalizeCustomerId(loginCustomerId);
    if (login) headers["login-customer-id"] = login;
    return headers;
  }

  async request(url, options = {}, loginCustomerId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        ...options,
        headers: { ...this.headers(loginCustomerId), ...(options.headers || {}) },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const details = Array.isArray(payload?.error?.details) ? payload.error.details : [];
        const error = new Error(payload?.error?.message || `Google Ads API HTTP ${response.status}`);
        error.code = "GOOGLE_ADS_API_ERROR";
        error.status = response.status;
        error.details = details;
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async listAccessibleCustomers() {
    const url = `https://googleads.googleapis.com/${this.apiVersion}/customers:listAccessibleCustomers`;
    const payload = await this.request(url, { method: "GET" });
    return (payload.resourceNames || []).map(extractCustomerId).filter(Boolean);
  }

  async searchPage(customerId, query, { loginCustomerId, pageToken, pageSize = 10_000 } = {}) {
    const normalizedCustomer = normalizeCustomerId(customerId);
    const url = `https://googleads.googleapis.com/${this.apiVersion}/customers/${normalizedCustomer}/googleAds:search`;
    const body = { query, pageSize };
    if (pageToken) body.pageToken = pageToken;
    return this.request(url, { method: "POST", body: JSON.stringify(body) }, loginCustomerId);
  }

  async searchAll(customerId, query, options = {}) {
    const rows = [];
    let pageToken;
    let pageCount = 0;
    const maxPages = Number(options.maxPages || 200);
    do {
      const payload = await this.searchPage(customerId, query, { ...options, pageToken });
      rows.push(...(payload.results || []));
      pageToken = payload.nextPageToken || null;
      pageCount += 1;
      if (pageCount >= maxPages && pageToken) {
        const error = new Error(`Google Ads query exceeded ${maxPages} pages`);
        error.code = "GOOGLE_ADS_PAGE_LIMIT";
        throw error;
      }
    } while (pageToken);
    return rows;
  }

  async discoverAccounts() {
    const directIds = await this.listAccessibleCustomers();
    const accounts = new Map();
    const errors = [];

    for (const directId of directIds) {
      try {
        const detailRows = await this.searchAll(
          directId,
          `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account, customer.status FROM customer LIMIT 1`,
          { loginCustomerId: null, maxPages: 2 },
        );
        const customer = detailRows[0]?.customer || {};
        const direct = {
          externalAccountId: String(customer.id || directId),
          name: customer.descriptiveName || `Google Ads ${directId}`,
          currencyCode: customer.currencyCode || null,
          timezone: customer.timeZone || null,
          manager: Boolean(customer.manager),
          testAccount: Boolean(customer.testAccount),
          status: customer.status || "UNKNOWN",
          level: 0,
          loginCustomerId: customer.manager ? String(customer.id || directId) : null,
          sourceDirectAccountId: directId,
        };
        accounts.set(direct.externalAccountId, direct);

        if (!direct.manager) continue;

        const clientRows = await this.searchAll(
          directId,
          `SELECT customer_client.client_customer, customer_client.level, customer_client.manager, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.status, customer_client.test_account FROM customer_client`,
          { loginCustomerId: directId },
        );

        for (const row of clientRows) {
          const client = row.customerClient || {};
          const id = extractCustomerId(client.clientCustomer);
          if (!id) continue;
          const next = {
            externalAccountId: id,
            name: client.descriptiveName || `Google Ads ${id}`,
            currencyCode: client.currencyCode || null,
            timezone: client.timeZone || null,
            manager: Boolean(client.manager),
            testAccount: Boolean(client.testAccount),
            status: client.status || "UNKNOWN",
            level: Number(client.level || 0),
            loginCustomerId: directId,
            sourceDirectAccountId: directId,
          };
          const current = accounts.get(id);
          if (!current || next.level < current.level || (!current.loginCustomerId && next.loginCustomerId)) {
            accounts.set(id, next);
          }
        }
      } catch (error) {
        errors.push({ customerId: directId, message: error.message, code: error.code || "error" });
      }
    }

    return { accounts: [...accounts.values()], errors };
  }
}

module.exports = { GoogleAdsClient, normalizeCustomerId, extractCustomerId };
