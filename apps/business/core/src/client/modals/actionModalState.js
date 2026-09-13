import { parseMoney } from "../core/formatters";
import {
  createEmptySalePayment,
  CUSTOMER_REQUIRED_SALE_PAYMENTS,
  DUE_DATE_SALE_PAYMENTS,
  INSTALLMENT_SALE_PAYMENTS,
  saleDefaultDueDate,
} from "../core/sales";
import {
  accessPresetForRole,
  NEW_PRODUCT_BRAND_VALUE,
} from "./config";

function isModalFieldVisible(field, currentValues) {
  if (!field.visibleWhen) return true;
  const expectedValues = Array.isArray(field.visibleWhen.value)
    ? field.visibleWhen.value
    : [field.visibleWhen.value];
  return expectedValues.includes(currentValues[field.visibleWhen.name]);
}

function deriveActionModalState({ type, config, data, values }) {
  const saleCartItems = type === "sale" && Array.isArray(values.items)
    ? values.items
      .map((item) => {
        const product = data.products.find((candidate) => candidate.id === item.productId || candidate.name === item.product);
        const quantity = Math.max(1, Number(item.quantity || 1));
        if (!product) return null;
        const unitPrice = item.unitPrice === undefined ? parseMoney(product.price) : parseMoney(item.unitPrice);
        return { product, quantity, unitPrice, discount: Math.max(0, parseMoney(item.discount || 0)) };
      })
      .filter(Boolean)
    : [];
  const selectedProduct = data.products.find((product) => product.name === values.product);
  const saleTotal = type === "saleEdit"
    ? parseMoney(values.total || 0)
    : type === "sale"
    ? saleCartItems.length
      ? saleCartItems.reduce((sum, item) => sum + item.unitPrice * item.quantity - item.discount, 0)
      : selectedProduct
        ? parseMoney(selectedProduct.price) * Number(values.quantity || 1)
        : 0
    : 0;
  const payments = Array.isArray(values.payments) ? values.payments : [];
  const paymentTotal = payments.reduce((sum, payment) => sum + parseMoney(payment.amount || 0), 0);
  const paymentRemaining = saleTotal - paymentTotal;
  const visibleFields = config.fields.filter((field) => isModalFieldVisible(field, values));

  return {
    payments,
    paymentRemaining,
    paymentTotal,
    saleCartItems,
    saleTotal,
    selectedProduct,
    visibleFields,
  };
}

function updateActionModalValue({ type, config, data, current, name, value }) {
  if (type === "user" && (name === "role" || name === "companyId")) {
    const accessField = config.fields.find((field) => field.type === "access_matrix");
    const companyId = name === "companyId" ? value : current.companyId;
    const role = name === "role" ? value : current.role;
    const enabledScreens = accessField?.companyScreens?.[companyId] || accessField?.enabledScreens || [];
    return { ...current, [name]: value, ...accessPresetForRole(role, enabledScreens) };
  }

  const changedField = config.fields.find((field) => field.name === name);
  const valuePreset = changedField?.valuePresets?.[value];
  if (valuePreset && typeof valuePreset === "object") {
    return { ...current, [name]: value, ...valuePreset };
  }

  if (type === "product" && name === "type") {
    return {
      ...current,
      type: value,
      ...(value === "Servico"
        ? { category: "Servicos", ean: "", brand: "", newBrandName: "", newBrandDescription: "", stock: "0", min: "0" }
        : { category: current.category === "Servicos" ? "Produtos" : current.category }),
    };
  }

  if (type === "product" && name === "brand" && value !== NEW_PRODUCT_BRAND_VALUE) {
    return { ...current, brand: value, newBrandName: "", newBrandDescription: "" };
  }

  if ((type === "sale" || type === "saleEdit") && name === "soldAt") {
    return {
      ...current,
      soldAt: value,
      payments: (current.payments || []).map((payment) => (
        DUE_DATE_SALE_PAYMENTS.has(payment.method) && payment.dueDateAuto === true
          ? { ...payment, dueDate: saleDefaultDueDate(value) }
          : payment
      )),
    };
  }

  if (type === "sale" && (name === "product" || name === "quantity") && !(Array.isArray(current.items) && current.items.length)) {
    const previousProduct = data.products.find((product) => product.name === current.product);
    const previousTotal = previousProduct
      ? parseMoney(previousProduct.price) * Number(current.quantity || 1)
      : 0;
    const nextProductName = name === "product" ? value : current.product;
    const nextQuantity = name === "quantity" ? value : current.quantity;
    const nextProduct = data.products.find((product) => product.name === nextProductName);
    const nextTotal = nextProduct ? parseMoney(nextProduct.price) * Number(nextQuantity || 1) : 0;
    const currentPayments = Array.isArray(current.payments) ? current.payments : [];
    const shouldSyncSinglePayment = currentPayments.length === 1
      && (!currentPayments[0].amount || Math.abs(parseMoney(currentPayments[0].amount) - previousTotal) < 0.01);
    return {
      ...current,
      [name]: value,
      payments: shouldSyncSinglePayment
        ? [{ ...currentPayments[0], amount: nextTotal ? String(nextTotal) : "" }]
        : currentPayments,
    };
  }

  return { ...current, [name]: value };
}

function updateActionModalPayment({ current, index, name, value }) {
  return {
    ...current,
    payments: (current.payments || []).map((payment, paymentIndex) => {
      if (paymentIndex !== index) return payment;
      if (name === "method") {
        const needsDueDate = DUE_DATE_SALE_PAYMENTS.has(value);
        return {
          ...payment,
          method: value,
          installments: INSTALLMENT_SALE_PAYMENTS.has(value) ? payment.installments || "1" : "1",
          dueDate: needsDueDate
            ? (payment.dueDateAuto === true ? saleDefaultDueDate(current.soldAt) : payment.dueDate || saleDefaultDueDate(current.soldAt))
            : payment.dueDate,
          dueDateAuto: needsDueDate ? !payment.dueDate || payment.dueDateAuto === true : payment.dueDateAuto,
        };
      }
      if (name === "dueDate") return { ...payment, dueDate: value, dueDateAuto: false };
      return { ...payment, [name]: value };
    }),
  };
}

function addActionModalPayment({ current, saleTotal }) {
  const informed = (current.payments || []).reduce((sum, payment) => sum + parseMoney(payment.amount || 0), 0);
  const remaining = Math.max(0, saleTotal - informed);
  const suggestedAmount = informed > 0 ? remaining : "";
  return {
    ...current,
    payments: [...(current.payments || []), createEmptySalePayment(suggestedAmount)],
  };
}

function removeActionModalPayment({ current, index }) {
  return {
    ...current,
    payments: (current.payments || []).filter((_payment, paymentIndex) => paymentIndex !== index),
  };
}

function validateActionModal({ type, data, values, visibleFields, saleCartItems, selectedProduct, payments, paymentRemaining }) {
  const hasCartItems = Array.isArray(values.items) && values.items.length > 0;
  const missingField = visibleFields.find((field) => {
    const hiddenByCart = type === "sale" && hasCartItems && ["product", "quantity"].includes(field.name);
    return !hiddenByCart && field.required && !String(values[field.name] || "").trim();
  });
  if (missingField) return missingField.label + " e obrigatorio.";

  const missingLookupSelection = visibleFields.find((field) => (
    ["customer_lookup", "product_lookup"].includes(field.type)
      && field.required
      && !String(values[field.idField] || "").trim()
  ));
  if (missingLookupSelection) return `Selecione ${missingLookupSelection.label.toLowerCase()} na lista de resultados.`;

  const invalidNumberField = visibleFields.find((field) => {
    if (field.type !== "number") return false;
    const raw = values[field.name];
    if (raw === "" || raw === null || raw === undefined) return false;
    return !Number.isFinite(Number(String(raw).replace(",", ".")));
  });
  if (invalidNumberField) return invalidNumberField.label + " deve ser um numero valido.";

  const outOfRangeNumberField = visibleFields.find((field) => {
    if (field.type !== "number") return false;
    const raw = values[field.name];
    if (raw === "" || raw === null || raw === undefined) return false;
    const number = Number(String(raw).replace(",", "."));
    if (!Number.isFinite(number)) return false;
    if (field.min !== undefined && number < Number(field.min)) return true;
    if (field.max !== undefined && number > Number(field.max)) return true;
    return false;
  });
  if (outOfRangeNumberField) {
    const limits = [
      outOfRangeNumberField.min !== undefined ? `minimo ${outOfRangeNumberField.min}` : "",
      outOfRangeNumberField.max !== undefined ? `maximo ${outOfRangeNumberField.max}` : "",
    ].filter(Boolean).join(" e ");
    return `${outOfRangeNumberField.label} deve respeitar ${limits}.`;
  }

  if (type !== "sale" && type !== "saleEdit") return "";

  if (hasCartItems && saleCartItems.length !== values.items.length) return "Revise os itens do carrinho antes de finalizar.";
  if (type === "sale" && !hasCartItems && !selectedProduct) return "Selecione um produto cadastrado na busca.";
  if (!payments.length) return "Adicione ao menos uma forma de pagamento.";
  if (payments.some((payment) => parseMoney(payment.amount || 0) <= 0)) return "Informe um valor maior que zero em cada pagamento.";
  if (Math.abs(paymentRemaining) > 0.01) return "A soma dos pagamentos precisa ser igual ao total da venda.";

  const customerIsRegistered = Boolean(values.customerId) || data.customers.some((customer) => customer.name === values.customer);
  if (!customerIsRegistered && payments.some((payment) => CUSTOMER_REQUIRED_SALE_PAYMENTS.has(payment.method))) {
    return "Venda a prazo exige um cliente cadastrado.";
  }

  const invalidDueDate = payments.find((payment) => DUE_DATE_SALE_PAYMENTS.has(payment.method) && !payment.dueDate);
  if (invalidDueDate) return "Informe a data do primeiro vencimento.";

  const invalidCard = payments.find((payment) => payment.method === "credit_card" && !payment.cardBrand);
  if (invalidCard) return "Informe a bandeira do cartao de credito.";

  const invalidCheck = payments.find((payment) => payment.method === "check" && (!payment.bank || !payment.checkNumber));
  if (invalidCheck) return "Informe banco e numero de cada cheque.";

  return "";
}

function prepareActionModalValues({ type, values, payments }) {
  if (type !== "sale" && type !== "saleEdit") return values;
  return {
    ...values,
    payments: payments.map((payment) => {
      const { dueDateAuto, ...paymentData } = payment;
      return {
        ...paymentData,
        dueDateSource: DUE_DATE_SALE_PAYMENTS.has(payment.method)
          ? (dueDateAuto === true ? "automatic_30_days" : "customer_agreement")
          : null,
        amount: parseMoney(payment.amount),
        installments: Math.max(1, Number.parseInt(payment.installments || "1", 10)),
      };
    }),
  };
}

export {
  addActionModalPayment,
  deriveActionModalState,
  isModalFieldVisible,
  prepareActionModalValues,
  removeActionModalPayment,
  updateActionModalPayment,
  updateActionModalValue,
  validateActionModal,
};
