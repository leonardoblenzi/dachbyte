"use strict";

const crypto = require("crypto");
const db = require("../../../../../db/db");
const { createId } = require("../../id");
const { validateCustomFields } = require("../../configuration/customFields");
const { getCompanyConfigurationWithClient } = require("./configurationService");
const { insertAuditWithClient, insertEventWithClient, nextOperationalNumber } = require("./persistenceHelpers");
const { extensionRegistry } = require("../../../../platform/extensions/extensionRegistry");
const {
  assertAvailableStockWithClient,
  consumeSaleReservationsWithClient,
  createSaleReservationsWithClient,
  releaseSaleReservationsWithClient,
} = require("./stockReservationService");

const IMMEDIATE_PAYMENT_METHODS = new Set(["cash", "pix", "debit_card", "credit_card", "bank_transfer"]);
const RECEIVABLE_PAYMENT_METHODS = new Set(["store_credit", "promissory_note", "check", "boleto"]);
const CUSTOMER_REQUIRED_PAYMENT_METHODS = new Set(["store_credit", "promissory_note", "check", "boleto"]);

function toMoney(value) {
  const number = parseMoneyValue(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function parseMoneyValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value || "0").trim().replace(/[^\d,.-]/g, "");
  if (!cleaned) return 0;
  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");
  let normalized = cleaned;
  if (hasComma && hasDot) {
    normalized = cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")
      ? cleaned.replace(/\./g, "").replace(",", ".")
      : cleaned.replace(/,/g, "");
  } else if (hasComma) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (hasDot && /^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    normalized = cleaned.replace(/\./g, "");
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function toQuantity(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizeEan(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || null;
}

function validateConfiguredCustomFields(configuration, moduleName, values = {}, options = {}) {
  return validateCustomFields(configuration, moduleName, values, options);
}

function productEanDuplicateError() {
  const error = new Error("Este EAN ja esta cadastrado em outro produto desta empresa.");
  error.statusCode = 409;
  error.code = "PRODUCT_EAN_DUPLICATE";
  return error;
}

async function assertProductEanAvailable(companyId, ean, productId = null, client = db) {
  if (!ean) return;
  const result = await client.query(`
    select id
    from volt_core.products
    where company_id = $1 and ean = $2 and ($3::text is null or id <> $3)
    limit 1;
  `, [companyId, ean, productId]);
  if (result.rowCount) throw productEanDuplicateError();
}

function normalizePaymentMethod(method) {
  const normalized = String(method || "pix").trim().toLowerCase();
  const aliases = {
    dinheiro: "cash",
    cash: "cash",
    pix: "pix",
    debito: "debit_card",
    debit: "debit_card",
    debit_card: "debit_card",
    cartao: "credit_card",
    card: "credit_card",
    credito: "credit_card",
    credit: "credit_card",
    credit_card: "credit_card",
    crediario: "store_credit",
    carne: "store_credit",
    store_credit: "store_credit",
    promissory: "promissory_note",
    promissory_note: "promissory_note",
    cheque: "check",
    check: "check",
    boleto: "boleto",
    transferencia: "bank_transfer",
    transfer: "bank_transfer",
    bank_transfer: "bank_transfer",
  };
  return aliases[normalized] || normalized;
}

function isImmediatePayment(method) {
  return IMMEDIATE_PAYMENT_METHODS.has(normalizePaymentMethod(method));
}

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(value || 0));
}

function todayPlus(days = 0) {
  const date = new Date();
  date.setDate(date.getDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function normalizeDateInput(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  let normalized = text;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const match = text.match(/^(\d{2})\/(\d{2})(?:\/(\d{4}))?$/);
    if (!match) return null;
    normalized = `${match[3] || new Date().getFullYear()}-${match[2]}-${match[1]}`;
  }
  const [year, month, day] = normalized.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? normalized
    : null;
}

function deliveryError(message, code) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

function isDeliveryPayment(input = {}) {
  return String(input.paymentTiming || input.payment_timing || "").trim().toLowerCase() === "delivery";
}

function assertDeliveryOrderInput({ customer, promisedDeliveryDate }) {
  if (!customer) {
    throw deliveryError("Pedido com pagamento na entrega exige cliente cadastrado", "DELIVERY_CUSTOMER_REQUIRED");
  }
  if (!normalizeDateInput(promisedDeliveryDate)) {
    throw deliveryError("Informe a previsao de entrega", "DELIVERY_DATE_REQUIRED");
  }
}

function defaultReceivableDueDate(soldAt) {
  const dateKey = normalizeDateInput(String(soldAt || "").slice(0, 10));
  const date = dateKey ? new Date(`${dateKey}T12:00:00Z`) : new Date();
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().slice(0, 10);
}

function resolveReceivableDueDateDetails(payment = {}, soldAt) {
  const declaredSource = String(payment.dueDateSource || "").trim();
  const agreedDueDate = String(payment.dueDate || payment.firstDueDate || payment.installmentSchedule?.[0]?.dueDate || "").trim();
  const source = declaredSource === "automatic_30_days" || payment.dueDateAuto === true
    ? "automatic_30_days"
    : declaredSource === "customer_agreement"
      ? "customer_agreement"
      : agreedDueDate
        ? "customer_agreement"
        : "automatic_30_days";

  if (source === "automatic_30_days") {
    return { dueDate: defaultReceivableDueDate(soldAt), source };
  }

  const dueDate = normalizeDateInput(agreedDueDate);
  if (!dueDate) {
    throw Object.assign(new Error("Informe um vencimento valido para o pagamento a prazo"), {
      statusCode: 400,
      code: "PAYMENT_DUE_DATE_INVALID",
    });
  }
  return { dueDate, source };
}

function resolveReceivableDueDate(payment = {}, soldAt) {
  return resolveReceivableDueDateDetails(payment, soldAt).dueDate;
}

function normalizeInstallmentSchedule(payment, amount, installments, firstDueDate) {
  const rawSchedule = Array.isArray(payment.installmentSchedule) ? payment.installmentSchedule : [];
  if (!rawSchedule.length) {
    return splitMoney(amount, installments).map((installmentAmount, index) => ({
      amount: installmentAmount,
      dueDate: addMonthsToDate(firstDueDate, index),
    }));
  }
  if (rawSchedule.length !== installments) {
    throw Object.assign(new Error("A quantidade de parcelas detalhadas deve ser igual ao parcelamento informado"), {
      statusCode: 400,
      code: "PAYMENT_INSTALLMENT_COUNT_MISMATCH",
    });
  }
  const normalized = rawSchedule.map((installment, index) => {
    const installmentAmount = assertPositive(
      toMoney(installment?.amount),
      `Informe um valor valido para a parcela ${index + 1}`,
      "PAYMENT_INSTALLMENT_AMOUNT_INVALID",
    );
    const dueDate = normalizeDateInput(installment?.dueDate || addMonthsToDate(firstDueDate, index));
    if (!dueDate) {
      throw Object.assign(new Error(`Informe um vencimento valido para a parcela ${index + 1}`), {
        statusCode: 400,
        code: "PAYMENT_INSTALLMENT_DUE_DATE_INVALID",
      });
    }
    return { amount: installmentAmount, dueDate };
  });
  const scheduleTotal = toMoney(normalized.reduce((sum, installment) => sum + installment.amount, 0));
  if (Math.abs(scheduleTotal - amount) > 0.01) {
    throw Object.assign(new Error("A soma das parcelas deve ser igual ao saldo financiado"), {
      statusCode: 400,
      code: "PAYMENT_INSTALLMENT_TOTAL_MISMATCH",
    });
  }
  return normalized;
}

function normalizeSalePayments(payments, total, soldAt) {
  const normalizedPayments = (payments || []).map((payment) => {
    const method = normalizePaymentMethod(payment.method || payment.paymentMethod);
    if (!IMMEDIATE_PAYMENT_METHODS.has(method) && !RECEIVABLE_PAYMENT_METHODS.has(method)) {
      throw Object.assign(new Error(`Forma de pagamento invalida: ${method}`), { statusCode: 400, code: "PAYMENT_METHOD_INVALID" });
    }
    const amount = assertPositive(toMoney(payment.amount ?? total / payments.length), "Valor do pagamento deve ser maior que zero", "PAYMENT_AMOUNT_INVALID");
    const installments = Math.max(1, Number.parseInt(payment.installments || payment.installmentSchedule?.length || 1, 10));
    const dueDateDetails = RECEIVABLE_PAYMENT_METHODS.has(method)
      ? resolveReceivableDueDateDetails(payment, soldAt)
      : { dueDate: null, source: null };
    const installmentSchedule = RECEIVABLE_PAYMENT_METHODS.has(method)
      ? normalizeInstallmentSchedule(payment, amount, installments, dueDateDetails.dueDate)
      : [];
    return {
      method,
      amount,
      installments,
      dueDate: dueDateDetails.dueDate,
      dueDateSource: dueDateDetails.source,
      installmentSchedule,
      cardBrand: payment.cardBrand || null,
      authorizationCode: payment.authorizationCode || null,
      bank: payment.bank || null,
      checkNumber: payment.checkNumber || null,
      holderName: payment.holderName || null,
      holderDocument: payment.holderDocument || null,
    };
  });
  const paymentTotal = toMoney(normalizedPayments.reduce((sum, payment) => sum + payment.amount, 0));
  if (Math.abs(paymentTotal - total) > 0.01) {
    throw Object.assign(new Error("A soma dos pagamentos deve ser igual ao total da venda"), { statusCode: 400, code: "PAYMENT_TOTAL_MISMATCH" });
  }
  return normalizedPayments;
}

async function createSaleFinancialRecords(client, companyId, sale, customer, payments, soldAt, actorUserId, sourceType = "sale") {
  for (const payment of payments) {
    if (isImmediatePayment(payment.method)) {
      await client.query(`
        insert into volt_core.cash_movements (
          id, company_id, type, source_type, source_id, payment_method, amount, description, actor_user_id, operational_at
        ) values ($1, $2, 'entry', $3, $4, $5, $6, $7, $8, $9);
      `, [
        createId("mov"), companyId, sourceType, sale.id, payment.method, payment.amount,
        `Venda #${sale.number}`, actorUserId || null, soldAt,
      ]);
    } else if (RECEIVABLE_PAYMENT_METHODS.has(payment.method)) {
      const installmentSchedule = payment.installmentSchedule?.length
        ? payment.installmentSchedule
        : splitMoney(payment.amount, payment.installments).map((amount, index) => ({ amount, dueDate: addMonthsToDate(payment.dueDate, index) }));
      for (let index = 0; index < installmentSchedule.length; index += 1) {
        const installment = installmentSchedule[index];
        const dueDate = installment.dueDate;
        await client.query(`
          insert into volt_core.receivables (
            id, company_id, customer_id, sale_id, type, status, due_date, amount, description, metadata
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb);
        `, [createId("rec"), companyId, customer?.id || null, sale.id, payment.method,
          payment.method === "check" ? "awaiting_deposit" : "open",
          dueDate, installment.amount,
          `Venda #${sale.number} - parcela ${index + 1}/${installmentSchedule.length}`,
          JSON.stringify({
            installment: index + 1,
            installments: installmentSchedule.length,
            dueDateSource: payment.dueDateSource,
            currentDueDateSource: payment.dueDateSource,
            originalDueDate: dueDate,
            firstDueDate: installmentSchedule[0]?.dueDate || payment.dueDate,
            customInstallmentSchedule: Array.isArray(payment.installmentSchedule) && payment.installmentSchedule.length > 0,
            basedOnSoldAt: payment.dueDateSource === "automatic_30_days" ? String(soldAt).slice(0, 10) : null,
            cardBrand: payment.cardBrand,
            authorizationCode: payment.authorizationCode,
            bank: payment.bank,
            checkNumber: payment.checkNumber,
            holderName: payment.holderName,
            holderDocument: payment.holderDocument,
          })]);
      }
    }
  }
}
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function addMonthsToDate(value, months) {
  const dateKey = normalizeDateInput(value) || todayPlus(30);
  const [year, month, day] = dateKey.split("-").map(Number);
  const offset = Number.parseInt(months || 0, 10) || 0;
  const targetMonthIndex = (month - 1) + offset;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedMonthIndex = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonthIndex + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return new Date(Date.UTC(targetYear, normalizedMonthIndex, targetDay)).toISOString().slice(0, 10);
}

function splitMoney(value, parts) {
  const cents = Math.round(Number(value) * 100);
  const base = Math.floor(cents / parts);
  const remainder = cents - base * parts;
  return Array.from({ length: parts }, (_, index) => (base + (index < remainder ? 1 : 0)) / 100);
}

function assertPositive(value, message, code) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    const error = new Error(message);
    error.statusCode = 400;
    error.code = code;
    throw error;
  }
  return number;
}
async function listSales(companyId) {
  const result = await db.query(`
    select
      s.id,
      s.number,
      s.status,
      s.subtotal,
      s.discount_total as "discountTotal",
      s.total,
      s.payments,
      s.custom_fields as "customFields",
      s.sold_at as "soldAt",
      s.payment_timing as "paymentTiming",
      s.promised_delivery_date as "promisedDeliveryDate",
      s.delivered_at as "deliveredAt",
      s.created_at as "createdAt",
      c.id as "customerId",
      c.name as "customerName",
      c.document as "customerDocument",
      c.phone as "customerPhone",
      c.email as "customerEmail",
      coalesce(count(i.id), 0)::int as "itemCount",
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'description', i.description,
            'quantity', i.quantity,
            'unitPrice', i.unit_price,
            'discount', i.discount,
            'total', i.total
          )
          order by i.description
        ) filter (where i.id is not null),
        '[]'::jsonb
      ) as items
    from volt_core.sales s
    left join volt_core.customers c on c.id = s.customer_id and c.company_id = s.company_id
    left join volt_core.sale_items i on i.sale_id = s.id and i.company_id = s.company_id
    where s.company_id = $1
    group by s.id, c.id, c.name, c.document, c.phone, c.email
    order by s.sold_at desc, s.created_at desc
    limit 100;
  `, [companyId]);

  return result.rows;
}

function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key) return null;
  if (key.length > 160) {
    throw Object.assign(new Error("Chave de idempotencia invalida"), {
      statusCode: 400,
      code: "IDEMPOTENCY_KEY_INVALID",
    });
  }
  return key;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function saleIdempotencyFingerprint(input = {}) {
  const payload = { ...input };
  delete payload.idempotencyKey;
  delete payload.requestId;
  delete payload.actorUserId;
  return crypto.createHash("sha256").update(stableJson(payload)).digest("hex");
}

function collectHookArtifacts(results = []) {
  const response = {};
  const receiptExtensions = {};
  const receiptLegacyPayload = {};
  const receiptHtmlSections = [];
  const diagnostics = [];
  for (const result of results) {
    const value = result?.value || {};
    if (value.response && typeof value.response === "object") Object.assign(response, value.response);
    if (value.receipt?.extensionPayload !== undefined) receiptExtensions[result.extensionKey] = value.receipt.extensionPayload;
    if (value.receipt?.legacyPayload && typeof value.receipt.legacyPayload === "object") Object.assign(receiptLegacyPayload, value.receipt.legacyPayload);
    if (value.receipt?.html) receiptHtmlSections.push(String(value.receipt.html));
    diagnostics.push({ extensionKey: result.extensionKey, durationMs: result.durationMs });
  }
  return { response, receiptExtensions, receiptLegacyPayload, receiptHtmlSections, diagnostics };
}

async function findSaleByIdempotencyWithClient(client, companyId, idempotencyKey, configuration = {}) {
  if (!idempotencyKey) return null;
  const saleResult = await client.query(`
    select id, number, customer_id as "customerId", status, subtotal,
      discount_total as "discountTotal", total, payments, sold_at as "soldAt",
      payment_timing as "paymentTiming", promised_delivery_date as "promisedDeliveryDate", delivered_at as "deliveredAt", created_at as "createdAt",
      idempotency_fingerprint as "idempotencyFingerprint"
    from volt_core.sales
    where company_id = $1 and idempotency_key = $2
    limit 1;
  `, [companyId, idempotencyKey]);
  if (!saleResult.rowCount) return null;

  const sale = saleResult.rows[0];
  const receiptResult = await client.query(`
    select id, number, sale_id as "saleId", html, payload, created_at as "createdAt"
    from volt_core.receipts
    where company_id = $1 and sale_id = $2
    order by created_at desc
    limit 1;
  `, [companyId, sale.id]);
  const receipt = receiptResult.rows[0] || null;
  const hookResults = await extensionRegistry.runHook("sale.decorateIdempotent", { client, companyId, sale, receipt }, configuration);
  const artifacts = collectHookArtifacts(hookResults);
  return {
    sale,
    receipt,
    ...artifacts.response,
    extensionDiagnostics: artifacts.diagnostics,
    idempotent: true,
  };
}

async function createSale(companyId, input = {}) {
  const deliveryPayment = isDeliveryPayment(input);
  const rawItems = Array.isArray(input.items) && input.items.length
    ? input.items
    : [{ productId: input.productId, product: input.product, quantity: input.quantity || 1 }];
  const payments = !deliveryPayment && Array.isArray(input.payments) && input.payments.length
    ? input.payments
    : deliveryPayment ? [] : [{ method: input.paymentMethod || input.payment || "pix" }];

  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const companyConfiguration = await getCompanyConfigurationWithClient(client, companyId);
      const saleCustomFields = validateConfiguredCustomFields(companyConfiguration, "sale", input.customFields || {}, { requireAll: true });
      const extensionPayloads = extensionRegistry.inputPayloads("sale", input, companyConfiguration);
      const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey || input.requestId);
      const idempotencyFingerprint = idempotencyKey ? saleIdempotencyFingerprint(input) : null;
      if (idempotencyKey) {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${companyId}:${idempotencyKey}`]);
        const existingSale = await findSaleByIdempotencyWithClient(client, companyId, idempotencyKey, companyConfiguration);
        if (existingSale) {
          if (existingSale.sale?.idempotencyFingerprint
            && existingSale.sale.idempotencyFingerprint !== idempotencyFingerprint) {
            throw Object.assign(new Error("Esta chave de idempotencia ja foi usada em outra venda"), {
              statusCode: 409,
              code: "IDEMPOTENCY_KEY_REUSED",
            });
          }
          if (existingSale.sale) delete existingSale.sale.idempotencyFingerprint;
          await client.query("commit");
          return existingSale;
        }
      }
      const customer = await findCustomerWithClient(client, companyId, input.customerId, input.customer);
      const operationalRules = companyConfiguration.settings || {};
      const promisedDeliveryDate = normalizeDateInput(input.promisedDeliveryDate || input.promised_delivery_date);
      if (deliveryPayment) {
        assertDeliveryOrderInput({ customer, promisedDeliveryDate });
      } else if (operationalRules.requireOpenCashSession === true) {
        const openCash = await client.query("select id from volt_core.cash_sessions where company_id=$1 and status='open' limit 1", [companyId]);
        if (!openCash.rowCount) throw Object.assign(new Error("Abra o caixa antes de finalizar a venda"), { statusCode: 409, code: "OPEN_CASH_SESSION_REQUIRED" });
      }
      if (!customer && operationalRules.allowAnonymousCustomer === false) {
        throw Object.assign(new Error("Esta empresa exige cliente identificado na venda"), { statusCode: 400, code: "SALE_CUSTOMER_REQUIRED" });
      }
      const preparedItems = [];

      for (const item of rawItems) {
        const product = await findProductWithClient(client, companyId, item.productId, item.product, true);
        if (!product) {
          const error = new Error("Produto da venda nao encontrado");
          error.statusCode = 404;
          error.code = "SALE_PRODUCT_NOT_FOUND";
          throw error;
        }
        if (!product.active) throw Object.assign(new Error("Produto inativo nao pode ser vendido"), { statusCode: 409, code: "SALE_PRODUCT_INACTIVE" });
        const quantity = assertPositive(toQuantity(item.quantity || 1), "Quantidade da venda deve ser maior que zero", "SALE_QUANTITY_INVALID");
        const originalUnitPrice = toMoney(item.originalUnitPrice ?? product.salePrice);
        const unitPrice = toMoney(item.unitPrice ?? product.salePrice);
        if (unitPrice < 0) throw Object.assign(new Error("Preco unitario invalido"), { statusCode: 400, code: "SALE_UNIT_PRICE_INVALID" });
        const discount = Math.max(0, toMoney(item.discount || 0));
        const total = toMoney(quantity * unitPrice - discount);
        if (total < 0) throw Object.assign(new Error("Desconto maior que o valor do item"), { statusCode: 400, code: "SALE_DISCOUNT_INVALID" });
        preparedItems.push({
          product,
          quantity,
          originalUnitPrice,
          unitPrice,
          priceAdjusted: Math.abs(unitPrice - originalUnitPrice) > 0.01,
          discount,
          total,
        });
      }
      await extensionRegistry.runHook("product.decorateRows", {
        client,
        companyId,
        rows: preparedItems.map((entry) => entry.product),
      }, companyConfiguration);

      const requestedStock = new Map();
      for (const item of preparedItems.filter((entry) => entry.product.trackStock)) {
        requestedStock.set(item.product.id, (requestedStock.get(item.product.id) || 0) + item.quantity);
      }
      for (const [productId, requested] of requestedStock) {
        await assertAvailableStockWithClient(
          client,
          companyId,
          productId,
          requested,
          "Estoque disponivel insuficiente para finalizar a venda",
        );
      }

      const subtotal = toMoney(preparedItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
      const discountTotal = toMoney(preparedItems.reduce((sum, item) => sum + item.discount, 0));
      const total = toMoney(subtotal - discountTotal);
      if (total <= 0) throw Object.assign(new Error("Total da venda deve ser maior que zero"), { statusCode: 400, code: "SALE_TOTAL_INVALID" });
      const soldAt = input.soldAt || input.sold_at || new Date().toISOString();
      const normalizedPayments = deliveryPayment ? [] : normalizeSalePayments(payments, total, soldAt);
      if (!customer && normalizedPayments.some((payment) => CUSTOMER_REQUIRED_PAYMENT_METHODS.has(payment.method))) {
        throw Object.assign(new Error("Venda a prazo exige cliente cadastrado"), { statusCode: 400, code: "RECEIVABLE_CUSTOMER_REQUIRED" });
      }

      const saleId = createId("sal");
      const saleNumber = await nextOperationalNumber(client, companyId, "sales");
      const saleResult = await client.query(`
        insert into volt_core.sales (
          id, company_id, number, customer_id, status, subtotal, discount_total, total, payments, notes, sold_at,
          idempotency_key, idempotency_fingerprint, custom_fields, payment_timing, promised_delivery_date
        )
        values ($2, $1, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14::jsonb, $15, $16)
        returning id, number, customer_id as "customerId", status, subtotal,
          discount_total as "discountTotal", total, payments, custom_fields as "customFields", sold_at as "soldAt",
          payment_timing as "paymentTiming", promised_delivery_date as "promisedDeliveryDate", created_at as "createdAt";
      `, [
        companyId,
        saleId,
        saleNumber,
        customer?.id || null,
        deliveryPayment ? "pending_delivery" : "finalized",
        subtotal,
        discountTotal,
        total,
        JSON.stringify(normalizedPayments),
        input.notes || null,
        soldAt,
        idempotencyKey,
        idempotencyFingerprint,
        JSON.stringify(saleCustomFields),
        deliveryPayment ? "delivery" : "immediate",
        promisedDeliveryDate,
      ]);

      for (const item of preparedItems) {
        await client.query(`
          insert into volt_core.sale_items (
            id, company_id, sale_id, product_id, description, quantity, unit_price, discount, total
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9);
        `, [
          createId("sit"),
          companyId,
          saleId,
          item.product.id,
          item.product.name,
          item.quantity,
          item.unitPrice,
          item.discount,
          item.total,
        ]);

        if (item.product.trackStock && !deliveryPayment) {
          await client.query(`
            insert into volt_core.inventory_movements (
              id, company_id, product_id, type, quantity, reason, source_type, source_id, actor_user_id, operational_at
            )
            values ($1, $2, $3, 'exit', $4, $5, 'sale', $6, $7, $8);
          `, [
            createId("inv"),
            companyId,
            item.product.id,
            -item.quantity,
            `Venda #${saleResult.rows[0].number}`,
            saleId,
            input.actorUserId || null,
            soldAt,
          ]);
        }
      }

      if (deliveryPayment) {
        await createSaleReservationsWithClient(
          client,
          companyId,
          saleResult.rows[0],
          preparedItems,
          input.actorUserId,
        );
      } else {
        await createSaleFinancialRecords(
          client,
          companyId,
          saleResult.rows[0],
          customer,
          normalizedPayments,
          soldAt,
          input.actorUserId,
        );
      }

      const hookResults = await extensionRegistry.runHook("sale.afterCreated", {
        client,
        companyId,
        configuration: companyConfiguration,
        sale: saleResult.rows[0],
        customer,
        items: preparedItems,
        payments: normalizedPayments,
        input,
        extensionPayloads,
        actorUserId: input.actorUserId || null,
      }, companyConfiguration);
      const artifacts = collectHookArtifacts(hookResults);

      const receipt = deliveryPayment ? null : await createReceiptWithClient(client, companyId, saleResult.rows[0], {
        customer,
        items: preparedItems,
        payments: normalizedPayments,
        discountType: input.discountType || "amount",
        discountValue: input.discountValue ?? input.discount ?? null,
        extensions: artifacts.receiptExtensions,
        legacyPayload: artifacts.receiptLegacyPayload,
        extensionHtmlSections: artifacts.receiptHtmlSections,
      });

      const eventType = deliveryPayment ? "sale.pending_delivery_created" : "sale.created";
      await insertEventWithClient(client, companyId, eventType, { saleId, receiptId: receipt?.id || null, total, extensions: Object.keys(extensionPayloads) });
      await insertAuditWithClient(client, companyId, input.actorUserId, eventType, "sale", saleId, null, saleResult.rows[0], { total, extensions: Object.keys(extensionPayloads) });

      await client.query("commit");
      return { sale: saleResult.rows[0], receipt, ...artifacts.response, extensionDiagnostics: artifacts.diagnostics };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function completeSaleDelivery(companyId, saleId, input = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const saleResult = await client.query(`
        select id, number, customer_id as "customerId", status, subtotal,
          discount_total as "discountTotal", total, payments, notes,
          custom_fields as "customFields", sold_at as "soldAt", payment_timing as "paymentTiming",
          promised_delivery_date as "promisedDeliveryDate", delivered_at as "deliveredAt", created_at as "createdAt"
        from volt_core.sales
        where company_id = $1 and id = $2
        for update;
      `, [companyId, saleId]);
      if (!saleResult.rowCount) throw Object.assign(new Error("Pedido nao encontrado"), { statusCode: 404, code: "SALE_NOT_FOUND" });
      const sale = saleResult.rows[0];
      if (sale.status === "finalized") {
        const receiptResult = await client.query(`
          select id, number, sale_id as "saleId", html, payload, created_at as "createdAt"
          from volt_core.receipts
          where company_id = $1 and sale_id = $2
          order by created_at desc
          limit 1;
        `, [companyId, saleId]);
        await client.query("commit");
        return { sale, receipt: receiptResult.rows[0] || null, idempotent: true };
      }
      if (sale.status !== "pending_delivery" || sale.paymentTiming !== "delivery") {
        throw Object.assign(new Error("Este pedido nao esta aguardando pagamento na entrega"), {
          statusCode: 409,
          code: "SALE_NOT_PENDING_DELIVERY",
        });
      }

      const companyConfiguration = await getCompanyConfigurationWithClient(client, companyId);
      const operationalRules = companyConfiguration.settings || {};
      if (operationalRules.requireOpenCashSession === true) {
        const openCash = await client.query("select id from volt_core.cash_sessions where company_id=$1 and status='open' limit 1", [companyId]);
        if (!openCash.rowCount) {
          throw Object.assign(new Error("Abra o caixa antes de concluir a retirada"), { statusCode: 409, code: "OPEN_CASH_SESSION_REQUIRED" });
        }
      }

      const customer = await findCustomerWithClient(client, companyId, sale.customerId);
      if (!customer) throw deliveryError("Pedido com pagamento na entrega exige cliente cadastrado", "DELIVERY_CUSTOMER_REQUIRED");
      const payments = Array.isArray(input.payments) ? input.payments : [];
      // A data comercial da venda permanece imutavel. A conclusao da entrega usa
      // um instante operacional proprio para caixa, vencimentos automaticos e estoque.
      const deliveryAt = new Date().toISOString();
      const normalizedPayments = normalizeSalePayments(payments, toMoney(sale.total), deliveryAt);

      const itemsResult = await client.query(`
        select i.product_id as "productId", i.description, i.quantity,
          i.unit_price as "unitPrice", i.discount, i.total,
          p.id, p.name, p.sku, p.track_stock as "trackStock"
        from volt_core.sale_items i
        left join volt_core.products p on p.id = i.product_id and p.company_id = i.company_id
        where i.company_id = $1 and i.sale_id = $2
        order by i.id;
      `, [companyId, saleId]);
      const receiptItems = itemsResult.rows.map((item) => ({
        product: {
          id: item.productId || item.id || "-",
          name: item.name || item.description,
          sku: item.sku || null,
          trackStock: Boolean(item.trackStock),
        },
        quantity: Number(item.quantity),
        originalUnitPrice: Number(item.unitPrice),
        unitPrice: Number(item.unitPrice),
        priceAdjusted: false,
        discount: Number(item.discount || 0),
        total: Number(item.total),
      }));

      const updatedResult = await client.query(`
        update volt_core.sales
        set status = 'finalized', payments = $3::jsonb, delivered_at = $4, updated_at = now()
        where company_id = $1 and id = $2
        returning id, number, customer_id as "customerId", status, subtotal,
          discount_total as "discountTotal", total, payments, notes,
          custom_fields as "customFields", sold_at as "soldAt", payment_timing as "paymentTiming",
          promised_delivery_date as "promisedDeliveryDate", delivered_at as "deliveredAt", created_at as "createdAt";
      `, [companyId, saleId, JSON.stringify(normalizedPayments), deliveryAt]);
      const updatedSale = updatedResult.rows[0];

      const hookResults = await extensionRegistry.runHook("sale.afterDeliveryCompleted", {
        client,
        companyId,
        configuration: companyConfiguration,
        sale: updatedSale,
        customer,
        payments: normalizedPayments,
        input,
        actorUserId: input.actorUserId || null,
      }, companyConfiguration);
      const artifacts = collectHookArtifacts(hookResults);
      await consumeSaleReservationsWithClient(
        client,
        companyId,
        updatedSale,
        input.actorUserId,
        deliveryAt,
      );
      await createSaleFinancialRecords(client, companyId, updatedSale, customer, normalizedPayments, deliveryAt, input.actorUserId);
      const receipt = await createReceiptWithClient(client, companyId, updatedSale, {
        customer,
        items: receiptItems,
        payments: normalizedPayments,
        discountType: "amount",
        discountValue: sale.discountTotal,
        extensions: artifacts.receiptExtensions,
        legacyPayload: artifacts.receiptLegacyPayload,
        extensionHtmlSections: artifacts.receiptHtmlSections,
      });
      await insertEventWithClient(client, companyId, "sale.delivery_completed", { saleId, receiptId: receipt.id, total: updatedSale.total });
      await insertAuditWithClient(client, companyId, input.actorUserId, "sale.delivery_completed", "sale", saleId, sale, updatedSale, {
        paymentCount: normalizedPayments.length,
      });
      await client.query("commit");
      return { sale: updatedSale, receipt, ...artifacts.response, extensionDiagnostics: artifacts.diagnostics };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function updateSale(companyId, saleId, input = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const saleResult = await client.query(`
        select id, number, customer_id as "customerId", status, subtotal,
          discount_total as "discountTotal", total, payments, notes,
          custom_fields as "customFields", sold_at as "soldAt", created_at as "createdAt"
        from volt_core.sales
        where company_id = $1 and id = $2
        for update;
      `, [companyId, saleId]);
      if (!saleResult.rowCount) throw Object.assign(new Error("Venda nao encontrada"), { statusCode: 404, code: "SALE_NOT_FOUND" });
      const sale = saleResult.rows[0];
      if (sale.status === "canceled") {
        throw Object.assign(new Error("Venda cancelada nao pode ser editada"), { statusCode: 409, code: "SALE_CANCELED" });
      }

      const settled = await client.query(`
        select id
        from volt_core.receivables
        where company_id = $1 and sale_id = $2
          and (paid_amount > 0 or status in ('paid','received','compensated'))
        limit 1;
      `, [companyId, saleId]);
      if (settled.rowCount) {
        throw Object.assign(new Error("Venda possui recebimento baixado e nao pode ser editada"), {
          statusCode: 409,
          code: "SALE_EDIT_HAS_SETTLED_RECEIVABLE",
        });
      }

      const companyConfiguration = await getCompanyConfigurationWithClient(client, companyId);
      await extensionRegistry.runHook("sale.beforeUpdated", {
        client,
        companyId,
        saleId,
        sale,
        input,
        actorUserId: input.actorUserId || null,
      }, companyConfiguration);
      const customFields = validateConfiguredCustomFields(companyConfiguration, "sale", input.customFields || {}, { requireAll: true });
      const customer = await findCustomerWithClient(client, companyId, input.customerId, input.customer);
      const customerWasRequested = Boolean(input.customerId)
        || (input.customer && String(input.customer).trim().toLowerCase() !== "cliente avulso");
      if (customerWasRequested && !customer) {
        throw Object.assign(new Error("Cliente informado nao foi encontrado"), { statusCode: 404, code: "SALE_CUSTOMER_NOT_FOUND" });
      }
      const soldAt = input.soldAt || input.sold_at || sale.soldAt;
      const payments = Array.isArray(input.payments) && input.payments.length ? input.payments : sale.payments;
      const normalizedPayments = normalizeSalePayments(payments, toMoney(sale.total), soldAt);
      if (!customer && normalizedPayments.some((payment) => CUSTOMER_REQUIRED_PAYMENT_METHODS.has(payment.method))) {
        throw Object.assign(new Error("Venda a prazo exige cliente cadastrado"), { statusCode: 400, code: "RECEIVABLE_CUSTOMER_REQUIRED" });
      }

      const itemsResult = await client.query(`
        select i.product_id as "productId", i.description, i.quantity,
          i.unit_price as "unitPrice", i.discount, i.total,
          p.id, p.name, p.sku, p.track_stock as "trackStock"
        from volt_core.sale_items i
        left join volt_core.products p on p.id = i.product_id and p.company_id = i.company_id
        where i.company_id = $1 and i.sale_id = $2
        order by i.id;
      `, [companyId, saleId]);
      const receiptItems = itemsResult.rows.map((item) => ({
        product: {
          id: item.productId || item.id || "-",
          name: item.name || item.description,
          sku: item.sku || null,
          trackStock: Boolean(item.trackStock),
        },
        quantity: Number(item.quantity),
        originalUnitPrice: Number(item.unitPrice),
        unitPrice: Number(item.unitPrice),
        priceAdjusted: false,
        discount: Number(item.discount || 0),
        total: Number(item.total),
      }));

      const cash = await client.query(`
        select payment_method as "paymentMethod",
          coalesce(sum(case when type = 'entry' then amount else -amount end), 0)::numeric as amount
        from volt_core.cash_movements
        where company_id = $1 and source_id = $2
          and source_type in ('sale', 'sale_edit', 'sale_edit_reversal')
        group by payment_method;
      `, [companyId, saleId]);
      for (const movement of cash.rows) {
        const amount = Number(movement.amount || 0);
        if (Math.abs(amount) < 0.01) continue;
        await client.query(`
          insert into volt_core.cash_movements (
            id, company_id, type, source_type, source_id, payment_method, amount, description, actor_user_id, operational_at
          ) values ($1, $2, $3, 'sale_edit_reversal', $4, $5, $6, $7, $8, $9);
        `, [
          createId("mov"), companyId, amount > 0 ? "exit" : "entry", saleId, movement.paymentMethod,
          Math.abs(amount), `Correcao venda #${sale.number}`, input.actorUserId || null, soldAt,
        ]);
      }
      await client.query(`
        update volt_core.receivables
        set status = 'canceled', updated_at = now()
        where company_id = $1 and sale_id = $2 and status <> 'canceled';
      `, [companyId, saleId]);

      const updatedResult = await client.query(`
        update volt_core.sales
        set customer_id = $3, payments = $4::jsonb, notes = $5, sold_at = $6,
          custom_fields = $7::jsonb, updated_at = now()
        where company_id = $1 and id = $2
        returning id, number, customer_id as "customerId", status, subtotal,
          discount_total as "discountTotal", total, payments, notes,
          custom_fields as "customFields", sold_at as "soldAt", created_at as "createdAt";
      `, [
        companyId, saleId, customer?.id || null, JSON.stringify(normalizedPayments), input.notes || null,
        soldAt, JSON.stringify(customFields),
      ]);
      const updatedSale = updatedResult.rows[0];
      await createSaleFinancialRecords(
        client,
        companyId,
        updatedSale,
        customer,
        normalizedPayments,
        soldAt,
        input.actorUserId,
        "sale_edit",
      );
      const receipt = await createReceiptWithClient(client, companyId, updatedSale, {
        customer,
        items: receiptItems,
        payments: normalizedPayments,
        discountType: "amount",
        discountValue: sale.discountTotal,
        replaceExisting: true,
      });
      await insertEventWithClient(client, companyId, "sale.updated", { saleId, receiptId: receipt.id });
      await insertAuditWithClient(client, companyId, input.actorUserId, "sale.updated", "sale", saleId, sale, updatedSale, {
        correctedFields: ["customer", "soldAt", "payments", "notes", "customFields"],
      });
      await client.query("commit");
      return { sale: updatedSale, receipt };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}









async function cancelSale(companyId, saleId, input = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const saleResult = await client.query(`select id, number, status, total, payment_timing as "paymentTiming" from volt_core.sales where company_id = $1 and id = $2 for update`, [companyId, saleId]);
      if (!saleResult.rowCount) throw Object.assign(new Error("Venda nao encontrada"), { statusCode: 404, code: "SALE_NOT_FOUND" });
      const sale = saleResult.rows[0];
      if (sale.status === "canceled") throw Object.assign(new Error("Venda ja cancelada"), { statusCode: 409, code: "SALE_ALREADY_CANCELED" });

      const settled = await client.query(`select id from volt_core.receivables where company_id = $1 and sale_id = $2
        and (paid_amount > 0 or status in ('paid','received','compensated')) limit 1;`, [companyId, saleId]);
      if (settled.rowCount) throw Object.assign(new Error("Venda possui recebimento baixado e nao pode ser cancelada"), { statusCode: 409, code: "SALE_HAS_SETTLED_RECEIVABLE" });

      await releaseSaleReservationsWithClient(client, companyId, saleId, input.actorUserId, "sale_canceled");

      const inventory = await client.query("select product_id, quantity from volt_core.inventory_movements where company_id = $1 and source_type = 'sale' and source_id = $2", [companyId, saleId]);
      for (const movement of inventory.rows) {
        await client.query(`insert into volt_core.inventory_movements
          (id, company_id, product_id, type, quantity, reason, source_type, source_id, actor_user_id)
          values ($1,$2,$3,'entry',$4,$5,'sale_reversal',$6,$7);`,
        [createId("inv"), companyId, movement.product_id, Math.abs(Number(movement.quantity)),
          `Estorno venda #${sale.number}`, saleId, input.actorUserId || null]);
      }

      const cash = await client.query(`
        select payment_method, coalesce(sum(case when type = 'entry' then amount else -amount end), 0)::numeric as amount
        from volt_core.cash_movements
        where company_id = $1 and source_id = $2
          and source_type in ('sale', 'sale_edit', 'sale_edit_reversal')
        group by payment_method;
      `, [companyId, saleId]);
      for (const movement of cash.rows) {
        const amount = Number(movement.amount || 0);
        if (Math.abs(amount) < 0.01) continue;
        await client.query(`insert into volt_core.cash_movements
          (id, company_id, type, source_type, source_id, payment_method, amount, description, actor_user_id)
          values ($1,$2,$3,'sale_reversal',$4,$5,$6,$7,$8);`,
        [createId("mov"), companyId, amount > 0 ? "exit" : "entry", saleId, movement.payment_method, Math.abs(amount),
          `Estorno venda #${sale.number}`, input.actorUserId || null]);
      }

      await client.query("update volt_core.receivables set status = 'canceled', updated_at = now() where company_id = $1 and sale_id = $2", [companyId, saleId]);

      const companyConfiguration = await getCompanyConfigurationWithClient(client, companyId);
      await extensionRegistry.runHook("sale.beforeCanceled", {
        client,
        companyId,
        saleId,
        sale,
        input,
      }, companyConfiguration);
      const updated = await client.query(`update volt_core.sales set status = 'canceled', canceled_at = now(), cancel_reason = $3, updated_at = now()
        where company_id = $1 and id = $2 returning id, number, status, total, cancel_reason as "cancelReason";`,
      [companyId, saleId, input.reason || "Cancelamento solicitado"]);
      await insertEventWithClient(client, companyId, "sale.canceled", { saleId, reason: input.reason });
      await insertAuditWithClient(client, companyId, input.actorUserId, "sale.canceled", "sale", saleId, sale, updated.rows[0], { reason: input.reason });
      await client.query("commit");
      return updated.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function deleteCanceledSale(companyId, saleId, input = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const saleResult = await client.query(
        "select id, number, status, total, cancel_reason as \"cancelReason\" from volt_core.sales where company_id = $1 and id = $2 for update",
        [companyId, saleId],
      );
      if (!saleResult.rowCount) throw Object.assign(new Error("Venda nao encontrada"), { statusCode: 404, code: "SALE_NOT_FOUND" });
      const sale = saleResult.rows[0];
      if (sale.status !== "canceled") {
        throw Object.assign(new Error("Somente vendas canceladas podem ser excluidas."), { statusCode: 400, code: "SALE_MUST_BE_CANCELED" });
      }

      const companyConfiguration = await getCompanyConfigurationWithClient(client, companyId);
      await extensionRegistry.runHook("sale.beforeDeleteCanceled", { client, companyId, saleId, sale, input }, companyConfiguration);
      await client.query("delete from volt_core.receipts where company_id = $1 and sale_id = $2", [companyId, saleId]);
      await client.query("delete from volt_core.receivables where company_id = $1 and sale_id = $2 and status = 'canceled'", [companyId, saleId]);
      await client.query("delete from volt_core.sales where company_id = $1 and id = $2", [companyId, saleId]);
      await insertEventWithClient(client, companyId, "sale.deleted", { saleId, saleNumber: sale.number });
      await insertAuditWithClient(client, companyId, input.actorUserId, "sale.deleted", "sale", saleId, sale, null, { reason: input.reason });
      await client.query("commit");
      return sale;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}













async function listReceipts(companyId) {
  const result = await db.query(`
    select r.id, r.number, r.sale_id as "saleId", r.html, r.payload, r.created_at as "createdAt",
      s.total, c.id as "customerId", c.name as "customerName"
    from volt_core.receipts r
    left join volt_core.sales s on s.id = r.sale_id and s.company_id = r.company_id
    left join volt_core.customers c on c.id = s.customer_id and c.company_id = s.company_id
    where r.company_id = $1
    order by r.created_at desc
    limit 100;
  `, [companyId]);

  return result.rows;
}
async function findProductWithClient(client, companyId, productId, productName, lock = false) {
  const result = await client.query(`
    select id, sku, name, category, type, sale_price as "salePrice",
      cost_price as "costPrice", minimum_stock as "minimumStock",
      track_stock as "trackStock", active
    from volt_core.products
    where company_id = $1
      and ($2::text is not null and id = $2
        or $3::text is not null and lower(name) = lower($3)
        or $3::text is not null and lower(sku) = lower($3))
    order by number asc
    limit 1
    ${lock ? "for update" : ""};
  `, [companyId, productId || null, productName || null]);

  return result.rows[0] || null;
}

async function findCustomerWithClient(client, companyId, customerId, customerName) {
  if (!customerId && (!customerName || String(customerName).toLowerCase() === "cliente avulso")) {
    return null;
  }

  const result = await client.query(`
    select id, name, document, phone, email
    from volt_core.customers
    where company_id = $1
      and ($2::text is not null and id = $2
        or $3::text is not null and lower(name) = lower($3))
    order by number asc
    limit 1;
  `, [companyId, customerId || null, customerName || null]);

  return result.rows[0] || null;
}

async function createReceiptWithClient(client, companyId, sale, context) {
  const existingReceipt = context.replaceExisting
    ? (await client.query(`
      select id, number
      from volt_core.receipts
      where company_id = $1 and sale_id = $2
      order by created_at desc
      limit 1
      for update;
    `, [companyId, sale.id])).rows[0]
    : null;
  const receiptId = existingReceipt?.id || createId("rct");
  const receiptNumber = existingReceipt?.number || await nextOperationalNumber(client, companyId, "receipts");
  const payload = {
    saleId: sale.id,
    saleNumber: sale.number,
    customer: context.customer?.name || "Cliente avulso",
    items: context.items.map((item) => ({
      productId: item.product.id,
      description: item.product.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      originalUnitPrice: item.originalUnitPrice,
      priceAdjusted: item.priceAdjusted,
      discount: item.discount,
      total: item.total,
    })),
    payments: context.payments,
    discountType: context.discountType || "amount",
    discountValue: context.discountValue,
    total: Number(sale.total),
    ...(context.extensions && Object.keys(context.extensions).length ? { extensions: context.extensions } : {}),
    ...(context.legacyPayload || {}),
  };
  const paymentNames = {
    cash: "Dinheiro",
    pix: "Pix",
    debit_card: "Cartao de debito",
    credit_card: "Cartao de credito",
    store_credit: "Crediario interno",
    promissory_note: "Nota promissoria",
    check: "Cheque",
    boleto: "Boleto",
    bank_transfer: "Transferencia bancaria",
  };
  const formatDateTime = (value) => {
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? escapeHtml(value || "-") : date.toLocaleString("pt-BR");
  };
  const itemRows = payload.items.map((item) => `
    <tr>
      <td>${escapeHtml(item.description)}</td>
      <td>${escapeHtml(item.quantity)}</td>
      <td>${formatCurrency(item.unitPrice)}</td>
      <td>${formatCurrency(item.total)}</td>
    </tr>
  `).join("");
  const paymentRows = payload.payments.map((payment, index) => {
    const details = [
      payment.installments && Number(payment.installments) > 1 ? `${payment.installments} parcelas` : "",
      payment.installmentSchedule?.length > 1 ? payment.installmentSchedule.map((installment) => formatCurrency(installment.amount)).join(" + ") : "",
      payment.dueDate ? `Venc. ${formatDateTime(payment.dueDate).slice(0, 10)}` : "",
      payment.cardBrand ? `Bandeira ${payment.cardBrand}` : "",
      payment.authorizationCode ? `Aut. ${payment.authorizationCode}` : "",
      payment.checkNumber ? `Cheque ${payment.checkNumber}` : "",
      payment.bank ? `Banco ${payment.bank}` : "",
    ].filter(Boolean).join(" | ");
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(paymentNames[payment.method] || payment.method)}</td>
        <td>${escapeHtml(details || "Recebido na venda")}</td>
        <td>${formatCurrency(payment.amount)}</td>
      </tr>
    `;
  }).join("");
  const html = [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><title>Recibo Volt Core</title><style>body{font-family:Arial,sans-serif;color:#0f172a;margin:28px}h1{margin:0 0 4px}h2{font-size:16px;margin-top:24px}.muted{color:#64748b}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border-bottom:1px solid #dbe5f0;padding:9px 6px;text-align:left}th{font-size:12px;color:#52657f;text-transform:uppercase}.total{font-size:20px;text-align:right;margin-top:18px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px}</style></head>",
    "<body>",
    `<h1>Recibo #${receiptNumber}</h1>`,
    `<p class="muted">Venda #${sale.number} | Emitido em ${formatDateTime(sale.createdAt || new Date())}</p>`,
    `<div class="meta"><p><strong>Cliente</strong><br>${escapeHtml(payload.customer)}</p><p><strong>Data da venda</strong><br>${formatDateTime(sale.soldAt || sale.createdAt)}</p></div>`,
    "<h2>Itens</h2>",
    `<table><thead><tr><th>Descricao</th><th>Qtd.</th><th>Unitario</th><th>Total</th></tr></thead><tbody>${itemRows}</tbody></table>`,
    "<h2>Pagamentos</h2>",
    `<table><thead><tr><th>#</th><th>Forma</th><th>Detalhes</th><th>Valor</th></tr></thead><tbody>${paymentRows}</tbody></table>`,
    `<p class="total"><strong>Total: ${formatCurrency(sale.total)}</strong></p>`,
    ...(context.extensionHtmlSections || []),
    "</body></html>",
  ].join("");

  const result = existingReceipt
    ? await client.query(`
      update volt_core.receipts
      set html = $3, payload = $4::jsonb
      where company_id = $1 and id = $2
      returning id, number, sale_id as "saleId", html, payload, created_at as "createdAt";
    `, [companyId, receiptId, html, JSON.stringify(payload)])
    : await client.query(`
      insert into volt_core.receipts (id, company_id, sale_id, number, html, payload)
      values ($1, $2, $3, $4, $5, $6::jsonb)
      returning id, number, sale_id as "saleId", html, payload, created_at as "createdAt";
    `, [receiptId, companyId, sale.id, receiptNumber, html, JSON.stringify(payload)]);

  return result.rows[0];
}

module.exports = {
  __test: {
    addMonthsToDate,
    assertPositive,
    defaultReceivableDueDate,
    isImmediatePayment,
    isDeliveryPayment,
    normalizeDateInput,
    normalizePaymentMethod,
    normalizeInstallmentSchedule,
    normalizeSalePayments,
    resolveReceivableDueDate,
    resolveReceivableDueDateDetails,
    saleIdempotencyFingerprint,
  },
  cancelSale, completeSaleDelivery, createSale, deleteCanceledSale, listReceipts, listSales, updateSale,
};
