export const ORDER_PERIOD_OPTIONS = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "last7", label: "Ultimos 7 dias" },
  { value: "last15", label: "Ultimos 15 dias" },
  { value: "last30", label: "Ultimos 30 dias" },
  { value: "custom", label: "Data personalizada" },
  { value: "all", label: "Todo o periodo" },
];

export function shiftOrderDateKey(key, days) {
  const [year, month, day] = String(key || "").split("-").map(Number);
  if (!year || !month || !day) return "";
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

export function orderPeriodRange(period, todayKey) {
  if (period === "all") return { start: "", end: "" };
  if (period === "today") return { start: todayKey, end: todayKey };
  if (period === "yesterday") {
    const yesterday = shiftOrderDateKey(todayKey, -1);
    return { start: yesterday, end: yesterday };
  }
  const days = { last7: 7, last15: 15, last30: 30 }[period];
  return days ? { start: shiftOrderDateKey(todayKey, 1 - days), end: todayKey } : null;
}

export function identifyOrderPeriod(range, todayKey) {
  if (!range?.start && !range?.end) return "all";
  const end = range.end || range.start;
  for (const option of ORDER_PERIOD_OPTIONS) {
    const preset = orderPeriodRange(option.value, todayKey);
    if (preset && preset.start === range.start && preset.end === end) return option.value;
  }
  return "custom";
}
