const receivableTransitions = {
  open: ["partial", "received", "awaiting_deposit", "deposited", "canceled"],
  partial: ["received", "canceled"],
  awaiting_deposit: ["deposited", "returned", "canceled"],
  deposited: ["compensated", "returned"],
  returned: ["awaiting_deposit", "canceled"],
  received: [],
  compensated: [],
  canceled: [],
};

const saleTransitions = {
  finalized: ["canceled"],
  canceled: [],
};

const cashSessionTransitions = {
  open: ["closed"],
  closed: [],
};

function canTransition(machine, from, to) {
  return Boolean(machine[from] && machine[from].includes(to));
}

function assertReceivableTransition(from, to) {
  if (from === to) return;
  if (!canTransition(receivableTransitions, from, to)) {
    const err = new Error(`Transicao de recebivel invalida: ${from} -> ${to}`);
    err.statusCode = 400;
    err.code = "RECEIVABLE_TRANSITION_INVALID";
    throw err;
  }
}

function assertSaleTransition(from, to) {
  if (from === to) return;
  if (!canTransition(saleTransitions, from, to)) {
    const err = new Error(`Transicao de venda invalida: ${from} -> ${to}`);
    err.statusCode = 400;
    err.code = "SALE_TRANSITION_INVALID";
    throw err;
  }
}

function assertCashSessionTransition(from, to) {
  if (from === to) return;
  if (!canTransition(cashSessionTransitions, from, to)) {
    const err = new Error(`Transicao de caixa invalida: ${from} -> ${to}`);
    err.statusCode = 400;
    err.code = "CASH_SESSION_TRANSITION_INVALID";
    throw err;
  }
}

module.exports = {
  assertCashSessionTransition,
  assertReceivableTransition,
  assertSaleTransition,
  cashSessionTransitions,
  receivableTransitions,
  saleTransitions,
};
