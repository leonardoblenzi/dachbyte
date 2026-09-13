const paymentMethods = [
  {
    key: "cash",
    name: "Dinheiro",
    behavior: "immediate",
    requiresDueDate: false,
    allowsInstallments: false,
  },
  {
    key: "pix",
    name: "Pix",
    behavior: "immediate",
    requiresDueDate: false,
    allowsInstallments: false,
  },
  {
    key: "debit_card",
    name: "Cartao de debito",
    behavior: "immediate",
    requiresDueDate: false,
    allowsInstallments: false,
  },
  {
    key: "credit_card",
    name: "Cartao de credito",
    behavior: "immediate",
    requiresDueDate: false,
    allowsInstallments: true,
  },
  {
    key: "promissory_note",
    name: "Nota promissoria",
    behavior: "receivable",
    requiresDueDate: true,
    allowsInstallments: false,
  },
  {
    key: "check",
    name: "Cheque",
    behavior: "receivable",
    requiresDueDate: true,
    allowsInstallments: false,
  },
  {
    key: "store_credit",
    name: "Crediario / Carne",
    behavior: "receivable",
    requiresDueDate: true,
    allowsInstallments: true,
  },
  {
    key: "boleto",
    name: "Boleto",
    behavior: "receivable",
    requiresDueDate: true,
    allowsInstallments: true,
  },
  {
    key: "bank_transfer",
    name: "Transferencia bancaria",
    behavior: "immediate",
    requiresDueDate: false,
    allowsInstallments: false,
  },
];

const paymentMethodMap = new Map(paymentMethods.map((method) => [method.key, method]));

function listPaymentMethods() {
  return paymentMethods;
}

function getPaymentMethod(methodKey) {
  return paymentMethodMap.get(methodKey) || null;
}

function isImmediatePayment(methodKey) {
  return getPaymentMethod(methodKey)?.behavior === "immediate";
}

function isReceivablePayment(methodKey) {
  return getPaymentMethod(methodKey)?.behavior === "receivable";
}

module.exports = {
  getPaymentMethod,
  isImmediatePayment,
  isReceivablePayment,
  listPaymentMethods,
};
