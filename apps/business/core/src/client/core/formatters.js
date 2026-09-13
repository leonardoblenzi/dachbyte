function formatCurrency(value) {
  const number = typeof value === "number" ? value : parseMoney(value);
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number.isFinite(number) ? number : 0);
}

function parseMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value || "0").trim();
  const cleaned = raw.replace(/[^\d,.-]/g, "");
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

function formatMoneyInput(value) {
  const number = typeof value === "number" ? value : parseMoney(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  return number.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatShortDate(value) {
  if (!value) return "-";
  const [year, month, day] = String(value).slice(0, 10).split("-");
  return day && month && year ? `${day}/${month}/${year}` : String(value);
}

function formatShortTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(value) {
  if (!value) return "Sem registro";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("pt-BR");
}

function normalizeReportDate(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value).slice(0, 10);
  const match = String(value).match(/(\d{2})\/(\d{2})(?:\/(\d{4}))?/);
  if (!match) return "";
  return `${match[3] || "2026"}-${match[2]}-${match[1]}`;
}

function matchesReportDate(value, filters) {
  const date = normalizeReportDate(value);
  if (!date) return true;
  if (filters.dateFrom && date < filters.dateFrom) return false;
  if (filters.dateTo && date > filters.dateTo) return false;
  return true;
}

export {
  formatCurrency,
  formatDateTime,
  formatMoneyInput,
  formatShortDate,
  formatShortTime,
  matchesReportDate,
  normalizeReportDate,
  parseMoney,
};
