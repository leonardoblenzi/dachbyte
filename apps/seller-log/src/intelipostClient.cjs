"use strict";

const DEFAULT_REST_BASE_URL = "https://api.intelipost.com.br/api/v1";
const DEFAULT_TRACKING_GRAPHQL_URL = "https://tracking-graphql.intelipost.com.br/";

const TRACKING_QUERY = `
query ($clientId: ID, $orderNumber: String, $orderHash: String) {
  trackingStatus(clientId: $clientId, orderNumber: $orderNumber, orderHash: $orderHash) {
    client { id }
    order { order_number }
    tracking {
      status
      status_label
      estimated_delivery_date_lp
      history {
        event_date
        status_label
        provider_message
        macro_state { code }
      }
    }
    logistic_provider { name }
    end_customer { address { city state } }
  }
}
`;

function safeString(value) {
  return String(value || "").trim();
}

function safeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = String(value)
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function pickString(...values) {
  const value = firstValue(...values);
  return value === null ? null : safeString(value) || null;
}

function pickNumber(...values) {
  for (const value of values) {
    const parsed = safeNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function normalizeInvoiceKey(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  return digits.length >= 30 ? digits : "";
}

function extractVolumes(order) {
  return Array.isArray(order?.shipment_order_volume_array)
    ? order.shipment_order_volume_array
    : Array.isArray(order?.volumes)
      ? order.volumes
      : [];
}

function firstVolume(order) {
  return extractVolumes(order)[0] || {};
}

function normalizeIntelipostShipmentOrder(rawOrder, source = "intelipost") {
  const order = Array.isArray(rawOrder?.content) ? rawOrder.content[0] : rawOrder;
  if (!order || typeof order !== "object") return null;

  const volume = firstVolume(order);
  const invoice = volume?.shipment_order_volume_invoice || order?.shipment_order_invoice || {};
  const endCustomer = order?.end_customer || {};
  const externalNumbers = order?.external_order_numbers || {};

  const orderNumber = pickString(
    order.order_number,
    order.sales_order_number,
    externalNumbers.marketplace,
    externalNumbers.sales,
    externalNumbers.erp,
    volume.order_number,
  );
  const invoiceKey = pickString(
    invoice.invoice_key,
    invoice.key,
    order.invoice_key,
    order.nfe_key,
  );

  const tmsExpectedAmount = pickNumber(
    order.quoted_shipping_cost,
    order.quoted_freight_value,
    order.shipment_cost,
    order.freight_value,
    order.final_shipping_cost,
    volume.quoted_shipping_cost,
    volume.shipment_cost,
    invoice.freight_value,
  );

  return {
    id: `IP-${order.id || orderNumber || invoiceKey || Date.now()}`,
    order_id: orderNumber || invoiceKey || `IP-${Date.now()}`,
    marketplace_order_number: pickString(
      externalNumbers.marketplace,
      externalNumbers.sales,
      order.sales_order_number,
      order.external_order_number,
    ),
    intelipost_order_number: orderNumber,
    sales_channel: pickString(order.sales_channel, order.channel, order.origin, source) || "Intelipost",
    customer_name: pickString(endCustomer.first_name, endCustomer.name, order.customer_name) || "Cliente",
    carrier_name: pickString(
      order.logistic_provider_name,
      order.logistic_provider?.name,
      volume.logistic_provider_name,
      volume.logistic_provider?.name,
    ) || "Transportadora",
    delivery_service: pickString(
      order.delivery_method_name,
      order.delivery_method?.name,
      order.service_name,
      volume.delivery_method_name,
    ),
    destination_uf: pickString(
      endCustomer.shipping_state_code,
      endCustomer.shipping_state,
      endCustomer.address?.state,
      order.destination_state,
      order.shipping_state_code,
    ),
    destination_zipcode: pickString(
      endCustomer.shipping_zip_code,
      endCustomer.zip_code,
      endCustomer.address?.zip_code,
      order.destination_zipcode,
    ),
    order_amount: pickNumber(order.order_value, order.invoice_value, invoice.invoice_total_value),
    customer_paid_shipping_amount: pickNumber(
      order.customer_shipping_cost,
      order.customer_paid_shipping_amount,
      order.shipping_amount,
    ),
    tms_expected_amount: tmsExpectedAmount,
    carrier_charged_amount: pickNumber(
      order.carrier_charged_amount,
      order.invoice_shipping_cost,
      invoice.freight_value,
      invoice.shipping_cost,
    ),
    cte_key: pickString(order.cte_key, volume.cte_key, invoice.cte_key),
    invoice_key: invoiceKey,
    tracking_code: pickString(volume.tracking_code, volume.logistic_provider_tracking_code, order.tracking_code),
    billing_document: pickString(order.billing_document, order.invoice_number, invoice.invoice_number),
    status: tmsExpectedAmount === null ? "dados_incompletos" : "aguardando_conciliacao",
    rule: {
      id: "rule-use-tms",
      name: "Usar valor TMS",
      version: 1,
      operation: "use_tms",
      value: 0,
      source: "intelipost_sync_default",
      captured_at: new Date().toISOString(),
    },
    evidence: [
      {
        type: "Intelipost",
        label: source === "invoice_key" ? "Consulta por chave NF-e" : "Pedido sincronizado",
        captured_at: new Date().toISOString(),
      },
    ],
    source_payload_snapshot: {
      source,
      captured_at: new Date().toISOString(),
      raw: order,
    },
  };
}

function normalizeIntelipostTracking(trackingStatus, orderNumber) {
  if (!trackingStatus) return null;
  const history = Array.isArray(trackingStatus?.tracking?.history)
    ? trackingStatus.tracking.history
    : [];
  const latestEvent = history[0] || null;
  return {
    id: `IP-TRK-${orderNumber}`,
    order_id: safeString(trackingStatus?.order?.order_number) || orderNumber,
    marketplace_order_number: orderNumber,
    intelipost_order_number: safeString(trackingStatus?.order?.order_number) || orderNumber,
    sales_channel: "Intelipost",
    customer_name: "Cliente",
    carrier_name: safeString(trackingStatus?.logistic_provider?.name) || "Transportadora",
    delivery_service: safeString(trackingStatus?.tracking?.status_label) || safeString(trackingStatus?.tracking?.status),
    destination_uf: safeString(trackingStatus?.end_customer?.address?.state) || null,
    destination_zipcode: null,
    order_amount: null,
    customer_paid_shipping_amount: null,
    tms_expected_amount: null,
    carrier_charged_amount: null,
    cte_key: null,
    invoice_key: null,
    tracking_code: null,
    billing_document: null,
    status: "dados_incompletos",
    rule: {
      id: "rule-use-tms",
      name: "Usar valor TMS",
      version: 1,
      operation: "use_tms",
      value: 0,
      source: "intelipost_tracking_default",
      captured_at: new Date().toISOString(),
    },
    evidence: [
      {
        type: "Intelipost",
        label: `Tracking ${safeString(trackingStatus?.tracking?.status_label) || "sincronizado"}`,
        captured_at: safeString(latestEvent?.event_date) || new Date().toISOString(),
      },
    ],
    source_payload_snapshot: {
      source: "tracking_graphql",
      captured_at: new Date().toISOString(),
      raw: trackingStatus,
    },
  };
}

class IntelipostClient {
  constructor(config = {}) {
    this.apiKey = safeString(config.apiKey);
    this.clientId = safeString(config.clientId);
    this.restBaseUrl = safeString(config.restBaseUrl) || DEFAULT_REST_BASE_URL;
    this.trackingGraphqlUrl = safeString(config.trackingGraphqlUrl) || DEFAULT_TRACKING_GRAPHQL_URL;
    this.timeoutMs = Number(config.timeoutMs || 20000);
    this.shipmentSearchPath = safeString(config.shipmentSearchPath) || "/shipment_order";
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  assertConfigured() {
    if (!this.isConfigured()) {
      const error = new Error("API Key Intelipost nao configurada.");
      error.code = "INTELIPOST_API_KEY_MISSING";
      throw error;
    }
  }

  async request(path, options = {}) {
    this.assertConfigured();
    const url = new URL(`${this.restBaseUrl.replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`);
    Object.entries(options.query || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        url.searchParams.set(key, String(value));
      }
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "api-key": this.apiKey,
          ...(options.headers || {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(`Intelipost HTTP ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getShipmentOrderByInvoiceKey(invoiceKey) {
    const normalized = normalizeInvoiceKey(invoiceKey);
    if (!normalized) {
      const error = new Error("Chave NF-e invalida.");
      error.code = "INVALID_INVOICE_KEY";
      throw error;
    }
    const payload = await this.request(`/shipment_order/invoice_key/${encodeURIComponent(normalized)}`);
    const item = normalizeIntelipostShipmentOrder(payload, "invoice_key");
    return { payload, item };
  }

  async searchShipmentOrders(params = {}) {
    const payload = await this.request(this.shipmentSearchPath, {
      query: {
        created_after: params.start_date,
        created_before: params.end_date,
        date_from: params.start_date,
        date_to: params.end_date,
        order_number: params.order_number,
        page: params.page || 1,
        limit: params.limit || 50,
      },
    });
    const content = Array.isArray(payload?.content)
      ? payload.content
      : Array.isArray(payload?.results)
        ? payload.results
        : Array.isArray(payload)
          ? payload
          : [];
    return {
      payload,
      items: content.map((entry) => normalizeIntelipostShipmentOrder(entry, "period_search")).filter(Boolean),
    };
  }

  async getTrackingByOrderNumber(orderNumber) {
    const normalizedOrderNumber = safeString(orderNumber);
    if (!normalizedOrderNumber) {
      const error = new Error("Numero do pedido obrigatorio.");
      error.code = "ORDER_NUMBER_MISSING";
      throw error;
    }
    const payload = {
      operationName: null,
      query: TRACKING_QUERY,
      variables: {
        clientId: this.clientId,
        orderHash: this.clientId,
        orderNumber: normalizedOrderNumber,
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.trackingGraphqlUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://status.ondeestameupedido.com",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json.errors) {
        const error = new Error(`Intelipost tracking HTTP ${response.status}`);
        error.status = response.status;
        error.payload = json;
        throw error;
      }
      const tracking = json?.data?.trackingStatus || null;
      return {
        payload: json,
        item: normalizeIntelipostTracking(tracking, normalizedOrderNumber),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function createIntelipostClient(config) {
  return new IntelipostClient(config);
}

module.exports = {
  createIntelipostClient,
  normalizeIntelipostShipmentOrder,
  normalizeIntelipostTracking,
  normalizeInvoiceKey,
  safeNumber,
  safeString,
};
