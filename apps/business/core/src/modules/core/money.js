function toMoney(value) {
  const numberValue = parseMoneyValue(value);
  return Math.round((numberValue + Number.EPSILON) * 100) / 100;
}

function sumMoney(values) {
  return toMoney(values.reduce((total, value) => total + parseMoneyValue(value), 0));
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

module.exports = {
  sumMoney,
  toMoney,
};
