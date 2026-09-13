const PAID_EXCLUDED_STATUSES = ["CANCELLED", "UNPAID", "TO_RETURN"];

function paidOrderWhere() {
  return {
    AND: [
      { orderStatus: { not: null } },
      { orderStatus: { notIn: PAID_EXCLUDED_STATUSES } },
    ],
  };
}

module.exports = { PAID_EXCLUDED_STATUSES, paidOrderWhere };
