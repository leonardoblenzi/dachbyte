import { formatCurrency, formatMoneyInput, parseMoney } from "../core/formatters";
import { createRequestId } from "../core/ids";
import {
  DUE_DATE_SALE_PAYMENTS,
  INSTALLMENT_SALE_PAYMENTS,
  saleDefaultDueDate,
} from "../core/sales";

const OPTICAL_SALE_CATEGORIES = ["Todos", "Armacoes", "Lentes", "Servicos", "Acessorios"];

function createEmptyOpticalSaleDraft() {
  return {
    idempotencyKey: createRequestId("sale"),
    customerId: "",
    productId: "",
    cart: [],
    prescriptionMode: "later",
    prescriptionId: "",
    prescription: {},
    measurementsMode: "later",
    measurements: {},
    laboratoryMode: "later",
    laboratoryId: "",
    promisedDate: "",
    soldAt: "",
    discountType: "amount",
    discount: "",
    payments: [{ method: "pix", amount: "", installments: "1", dueDate: "", dueDateAuto: true }],
    notes: "",
  };
}

function normalizeSearchText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function productMatchesOpticalSaleCategory(product, category) {
  if (category === "Todos") return true;
  if (category === "Servicos") return product.type === "Servico";
  return normalizeSearchText(product.category).includes(normalizeSearchText(category));
}

function filterOpticalSaleProducts(products, saleFilter, productQuery) {
  const query = normalizeSearchText(productQuery);
  return products
    .filter((item) => productMatchesOpticalSaleCategory(item, saleFilter))
    .filter((item) => {
      if (!query) return true;
      return normalizeSearchText(`${item.name} ${item.sku} ${item.ean} ${item.category} ${item.brand} ${item.type} ${item.opticalType}`).includes(query);
    });
}

function isOpticalSaleCart(cart) {
  return cart.some((item) => item.opticalType || /armacao|lente|otico/i.test(`${item.category} ${item.name}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "")));
}

function deriveOpticalSaleState({ data, draft, productQuery, saleFilter }) {
  const customers = data.customers || [];
  const products = (data.products || []).filter((item) => item.status !== "Inativo");
  const customer = customers.find((item) => item.id === draft.customerId);
  const selectedProduct = products.find((item) => item.id === draft.productId);
  const visibleProducts = filterOpticalSaleProducts(products, saleFilter, productQuery);
  const prescriptions = (data.prescriptions || []).filter((item) => item.customerId === draft.customerId);
  const subtotal = draft.cart.reduce((sum, item) => sum + parseMoney(item.unitPrice ?? item.price) * item.quantity, 0);
  const discountInput = Math.max(0, parseMoney(draft.discount));
  const discount = draft.discountType === "percent"
    ? Math.min(subtotal, subtotal * Math.min(discountInput, 100) / 100)
    : Math.min(subtotal, discountInput);
  const total = Math.max(0, subtotal - discount);
  const paymentTotal = draft.payments.reduce((sum, payment) => sum + parseMoney(payment.amount), 0);
  const remaining = Math.max(0, total - paymentTotal);
  const change = draft.payments.some((payment) => payment.method === "cash") ? Math.max(0, paymentTotal - total) : 0;
  const optical = isOpticalSaleCart(draft.cart);
  const cartItemCount = draft.cart.reduce((sum, item) => sum + item.quantity, 0);
  const needsCustomerForOptical = optical && !customer;

  return {
    cartItemCount,
    change,
    customer,
    customers,
    discount,
    needsCustomerForOptical,
    optical,
    paymentTotal,
    prescriptions,
    products,
    remaining,
    selectedProduct,
    subtotal,
    total,
    visibleProducts,
  };
}

function setOpticalSaleField(current, name, value) {
  if (name !== "soldAt") return { ...current, [name]: value };
  return {
    ...current,
    soldAt: value,
    payments: current.payments.map((payment) => (
      DUE_DATE_SALE_PAYMENTS.has(payment.method) && payment.dueDateAuto
        ? { ...payment, dueDate: saleDefaultDueDate(value) }
        : payment
    )),
  };
}

function setOpticalSaleNestedField(current, group, name, value) {
  return { ...current, [group]: { ...current[group], [name]: value } };
}

function addOpticalSaleItem(current, selectedProduct) {
  if (!selectedProduct) return current;
  const unitPrice = selectedProduct.unitPrice ?? selectedProduct.price;
  const originalUnitPrice = selectedProduct.originalUnitPrice ?? selectedProduct.price;
  return {
    ...current,
    productId: "",
    cart: current.cart.some((item) => item.id === selectedProduct.id)
      ? current.cart.map((item) => item.id === selectedProduct.id ? { ...item, quantity: item.quantity + 1 } : item)
      : [...current.cart, { ...selectedProduct, quantity: 1, unitPrice, originalUnitPrice }],
  };
}

function updateOpticalSaleItemQuantity(current, id, delta) {
  return {
    ...current,
    cart: current.cart.map((item) => item.id === id ? { ...item, quantity: Math.max(1, item.quantity + delta) } : item),
  };
}

function updateOpticalSaleItemPrice(current, id, value) {
  return {
    ...current,
    cart: current.cart.map((item) => item.id === id ? { ...item, unitPrice: value } : item),
  };
}

function removeOpticalSaleItem(current, id) {
  return { ...current, cart: current.cart.filter((item) => item.id !== id) };
}

function addOpticalSalePayment(current, remaining) {
  const informed = current.payments.reduce((sum, payment) => sum + parseMoney(payment.amount), 0);
  return {
    ...current,
    payments: [...current.payments, {
      method: "pix",
      amount: informed > 0 ? formatMoneyInput(remaining) : "",
      installments: "1",
      dueDate: "",
      dueDateAuto: true,
    }],
  };
}

function updateOpticalSalePayment(current, index, name, value) {
  return {
    ...current,
    payments: current.payments.map((payment, paymentIndex) => {
      if (paymentIndex !== index) return payment;
      if (name === "method") {
        const needsDueDate = DUE_DATE_SALE_PAYMENTS.has(value);
        return {
          ...payment,
          method: value,
          installments: INSTALLMENT_SALE_PAYMENTS.has(value) ? payment.installments || "1" : "1",
          dueDate: needsDueDate ? payment.dueDate || saleDefaultDueDate(current.soldAt) : payment.dueDate,
          dueDateAuto: needsDueDate ? !payment.dueDate || payment.dueDateAuto === true : payment.dueDateAuto,
        };
      }
      if (name === "dueDate") return { ...payment, dueDate: value, dueDateAuto: false };
      return { ...payment, [name]: value };
    }),
  };
}

function removeOpticalSalePayment(current, index) {
  return { ...current, payments: current.payments.filter((_payment, paymentIndex) => paymentIndex !== index) };
}

function validateOpticalSale({ draft, customer, optical, paymentTotal, total, remaining, change, mode }) {
  if (!draft.cart.length) return "Adicione pelo menos um produto ou servico.";
  if (optical && !customer) return "Identifique o cliente para acompanhar o pedido optico.";
  if (paymentTotal > total + 0.01 && change <= 0) return `Os pagamentos ultrapassam o total em ${formatCurrency(paymentTotal - total)}.`;
  if (mode === "finish" && Math.abs(paymentTotal - total) > 0.01) {
    return paymentTotal > total
      ? `Os pagamentos ultrapassam o total em ${formatCurrency(paymentTotal - total)}.`
      : `Ainda falta informar ${formatCurrency(total - paymentTotal)} nas formas de pagamento.`;
  }
  if (mode !== "finish" && remaining > 0.01) {
    return `Ainda falta informar ${formatCurrency(remaining)} nas formas de pagamento.`;
  }
  return "";
}

function prepareOpticalSalePayments(draft, change) {
  let remainingChange = change;
  return draft.payments.map((payment) => {
    const { dueDateAuto, ...paymentData } = payment;
    let amount = parseMoney(payment.amount);
    if (payment.method === "cash" && remainingChange > 0) {
      const deduction = Math.min(amount, remainingChange);
      amount -= deduction;
      remainingChange -= deduction;
    }
    return {
      ...paymentData,
      dueDateSource: DUE_DATE_SALE_PAYMENTS.has(payment.method)
        ? (dueDateAuto === true ? "automatic_30_days" : "customer_agreement")
        : null,
      amount,
      installments: Math.max(1, Number(payment.installments || 1)),
    };
  }).filter((payment) => payment.amount > 0);
}

function buildOpticalSaleSubmitPayload({ draft, customer, discount, optical, payments }) {
  return {
    idempotencyKey: draft.idempotencyKey,
    customer: customer?.name || "Cliente avulso",
    customerId: customer?.id || null,
    discountType: draft.discountType,
    discountValue: draft.discount,
    items: draft.cart.map((item, index) => {
      const unitPrice = parseMoney(item.unitPrice ?? item.price);
      const originalUnitPrice = parseMoney(item.originalUnitPrice ?? item.price);
      return {
        productId: item.id,
        product: item.name,
        quantity: item.quantity,
        unitPrice,
        originalUnitPrice,
        priceAdjusted: Math.abs(unitPrice - originalUnitPrice) > 0.01,
        discount: index === 0 ? discount : 0,
      };
    }),
    payments,
    soldAt: draft.soldAt ? new Date(draft.soldAt).toISOString() : null,
    notes: draft.notes,
    optical: optical ? {
      prescriptionMode: draft.prescriptionMode,
      prescriptionId: draft.prescriptionMode === "existing" ? draft.prescriptionId || null : null,
      prescription: draft.prescriptionMode === "now" ? draft.prescription : null,
      measurementsMode: draft.measurementsMode,
      measurements: draft.measurementsMode === "now" ? draft.measurements : {},
      laboratoryMode: draft.laboratoryMode,
      laboratoryId: draft.laboratoryMode === "now" ? draft.laboratoryId || null : null,
      promisedDate: draft.promisedDate || null,
      frameProductId: draft.cart.find((item) => item.opticalType === "frame")?.id || null,
      lensProductId: draft.cart.find((item) => item.opticalType === "lens")?.id || null,
      notes: draft.notes,
    } : null,
  };
}

export {
  addOpticalSaleItem,
  addOpticalSalePayment,
  buildOpticalSaleSubmitPayload,
  createEmptyOpticalSaleDraft,
  deriveOpticalSaleState,
  OPTICAL_SALE_CATEGORIES,
  prepareOpticalSalePayments,
  removeOpticalSaleItem,
  removeOpticalSalePayment,
  setOpticalSaleField,
  setOpticalSaleNestedField,
  updateOpticalSaleItemPrice,
  updateOpticalSaleItemQuantity,
  updateOpticalSalePayment,
  validateOpticalSale,
};
