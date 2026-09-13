import { formatMoneyInput } from "./formatters";

const SALE_PAYMENT_METHODS = [
  { value: "cash", label: "Dinheiro" },
  { value: "pix", label: "Pix" },
  { value: "debit_card", label: "Cartao de debito" },
  { value: "credit_card", label: "Cartao de credito" },
  { value: "store_credit", label: "Crediario / Carne" },
  { value: "check", label: "Cheque" },
  { value: "promissory_note", label: "Nota promissoria" },
  { value: "boleto", label: "Boleto" },
  { value: "bank_transfer", label: "Transferencia bancaria" },
];

const CUSTOMER_REQUIRED_SALE_PAYMENTS = new Set(["store_credit", "promissory_note", "check", "boleto"]);
const INSTALLMENT_SALE_PAYMENTS = new Set(["credit_card", "store_credit", "check", "boleto"]);
const DUE_DATE_SALE_PAYMENTS = new Set(["store_credit", "check", "promissory_note", "boleto"]);

function saleDefaultDueDate(baseValue = "") {
  const dateKey = String(baseValue || "").slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateKey)
    ? new Date(`${dateKey}T12:00:00Z`)
    : new Date();
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().slice(0, 10);
}

function createEmptySalePayment(amount = "") {
  return {
    method: "pix",
    amount: formatMoneyInput(amount),
    installments: "1",
    dueDate: saleDefaultDueDate(),
    dueDateAuto: true,
    cardBrand: "",
    authorizationCode: "",
    bank: "",
    checkNumber: "",
    holderName: "",
    holderDocument: "",
  };
}

function paymentMethodLabel(method) {
  return SALE_PAYMENT_METHODS.find((option) => option.value === method)?.label || method;
}

export {
  createEmptySalePayment,
  CUSTOMER_REQUIRED_SALE_PAYMENTS,
  DUE_DATE_SALE_PAYMENTS,
  INSTALLMENT_SALE_PAYMENTS,
  paymentMethodLabel,
  SALE_PAYMENT_METHODS,
  saleDefaultDueDate,
};
