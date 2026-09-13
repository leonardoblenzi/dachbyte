const PAID_EXCLUDED = ["CANCELLED", "UNPAID", "TO_RETURN"];

function wherePaid() {
  return { orderStatus: { notIn: PAID_EXCLUDED } };
}

function whereFeitos() {
  return {}; // sem filtro por status
}

module.exports = { wherePaid, whereFeitos, PAID_EXCLUDED };
