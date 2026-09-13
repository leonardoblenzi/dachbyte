const { badRequest } = require("./errors");
const { getPaymentMethod, isReceivablePayment } = require("./paymentMethods");
const { toMoney } = require("./money");

function validateCustomerInput(input) {
  if (!input || !String(input.name || "").trim()) {
    throw badRequest("Nome do cliente e obrigatorio", "CUSTOMER_NAME_REQUIRED");
  }
}

function validateProductInput(input) {
  if (!input || !String(input.name || "").trim()) {
    throw badRequest("Nome do produto e obrigatorio", "PRODUCT_NAME_REQUIRED");
  }
  if (input.salePrice !== undefined && toMoney(input.salePrice) < 0) {
    throw badRequest("Preco de venda invalido", "PRODUCT_SALE_PRICE_INVALID");
  }
}

function validateSaleInput(input) {
  if (!input || !Array.isArray(input.items) || input.items.length === 0) {
    throw badRequest("Venda precisa ter ao menos um item", "SALE_ITEMS_REQUIRED");
  }
}

function validatePaymentInput(payment) {
  const methodKey = payment.method || "cash";
  const method = getPaymentMethod(methodKey);

  if (!method) {
    throw badRequest("Forma de pagamento invalida", "PAYMENT_METHOD_INVALID");
  }

  const amount = toMoney(payment.amount);
  if (amount <= 0) {
    throw badRequest("Valor do pagamento deve ser positivo", "PAYMENT_AMOUNT_INVALID");
  }

  if (method.allowsInstallments) {
    const installments = Number(payment.installments || 1);
    if (!Number.isInteger(installments) || installments <= 0) {
      throw badRequest("Quantidade de parcelas invalida", "PAYMENT_INSTALLMENTS_INVALID");
    }
  }

  if (isReceivablePayment(method.key)) {
    const dueDate = payment.dueDate || payment.firstDueDate || payment.depositDate;
    if (method.requiresDueDate && !dueDate) {
      throw badRequest("Data de vencimento/deposito e obrigatoria", "PAYMENT_DUE_DATE_REQUIRED");
    }
  }

  return method;
}

function validateCashSessionOpen(input = {}) {
  if (input.openingAmount !== undefined && toMoney(input.openingAmount) < 0) {
    throw badRequest("Saldo inicial nao pode ser negativo", "CASH_OPENING_AMOUNT_INVALID");
  }
}

function validateCashSessionClose(input = {}) {
  if (input.closingAmount === undefined) {
    throw badRequest("Valor contado no fechamento e obrigatorio", "CASH_CLOSING_AMOUNT_REQUIRED");
  }
}

module.exports = {
  validateCashSessionClose,
  validateCashSessionOpen,
  validateCustomerInput,
  validatePaymentInput,
  validateProductInput,
  validateSaleInput,
};
