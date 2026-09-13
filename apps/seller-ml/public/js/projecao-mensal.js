"use strict";

const $ = (id) => document.getElementById(id);

let projectionFallbackLoading = null;

function showProjectionLoading(message = "Carregando projeção mensal...") {
  if (window.MLLoadingOverlay?.show) {
    window.MLLoadingOverlay.show({
      label: "Projeção mensal",
      message,
      initialProgress: 8,
      maxProgress: 94,
    });
    return;
  }
  if (projectionFallbackLoading) return;
  const overlay = document.createElement("div");
  overlay.className = "projection-loading-fallback";
  overlay.innerHTML = `
    <div class="projection-loading-fallback__card" role="status" aria-live="polite">
      <span class="projection-loading-fallback__spinner" aria-hidden="true"></span>
      <div><strong>Projeção mensal</strong><span>${message}</span></div>
    </div>
  `;
  document.body.appendChild(overlay);
  projectionFallbackLoading = overlay;
}

function updateProjectionLoading(message, percent) {
  if (window.MLLoadingOverlay?.update) {
    window.MLLoadingOverlay.update({ message, ...(Number.isFinite(percent) ? { progress: percent } : {}) });
    return;
  }
  const text = projectionFallbackLoading?.querySelector(".projection-loading-fallback__card span:last-child");
  if (text && message) text.textContent = message;
}

function hideProjectionLoading() {
  if (window.MLLoadingOverlay?.hide) window.MLLoadingOverlay.hide();
  projectionFallbackLoading?.remove();
  projectionFallbackLoading = null;
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

const fmtBRL = (value) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(value || 0));

const fmtNum = (value) => new Intl.NumberFormat("pt-BR").format(Number(value || 0));

function fmtPct(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n.toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

function fmtRatioX(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n.toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}x`;
}

function fmtDecimal(value, digits = 2) {
  return Number(value || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function closedDaysMetrics(rows = [], period = {}) {
  const daysInMonth = Math.max(0, Number(period.days_in_month || 0));
  const dayOfMonth = Math.max(0, Number(period.day_of_month || 0));
  const closedDays = period.is_current_month
    ? Math.max(0, Math.min(daysInMonth, dayOfMonth - 1))
    : daysInMonth;
  const closedRows = Array.isArray(rows)
    ? rows.slice(0, closedDays)
    : [];
  const revenue = closedRows.reduce((sum, row) => sum + Number(row?.revenue || 0), 0);
  const orders = closedRows.reduce((sum, row) => sum + Number(row?.orders || 0), 0);

  return {
    days: closedDays,
    revenue,
    orders,
    avgRevenue: closedDays > 0 ? revenue / closedDays : 0,
    avgOrders: closedDays > 0 ? orders / closedDays : 0,
  };
}

function renderAverageComparison({
  valueIds = [],
  deltaIds = [],
  label,
  current = 0,
  previous = 0,
  currentDays = 0,
  previousDays = 0,
  format,
}) {
  const hasBase = currentDays > 0 && previousDays > 0;
  const delta = hasBase && previous !== 0
    ? ((Number(current || 0) - Number(previous || 0)) / Math.abs(Number(previous))) * 100
    : null;
  const tone = delta == null ? "neutral" : delta >= 0 ? "positive" : "negative";
  const deltaText = delta == null
    ? "Sem comparativo"
    : `${delta >= 0 ? "↑ +" : "↓ -"}${fmtPct(Math.abs(delta), 1)} vs mes anterior`;
  const tooltip = `
    <span class="projection-comparison__box" role="tooltip">
      <span class="projection-comparison__title">Comparativo das medias</span>
      <span class="projection-comparison__row"><span>${label} atual</span><b>${format(current)}</b></span>
      <span class="projection-comparison__row"><span>Dias fechados atuais</span><b>${fmtNum(currentDays)}</b></span>
      <span class="projection-comparison__row"><span>${label} anterior</span><b>${format(previous)}</b></span>
      <span class="projection-comparison__row"><span>Dias do mes anterior</span><b>${fmtNum(previousDays)}</b></span>
      <span class="projection-comparison__row"><span>Variacao</span><b data-tone="${tone}">${deltaText}</b></span>
    </span>
  `;

  valueIds.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.classList.add("projection-comparison");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", `${label}: ${format(current)}. ${deltaText}.`);
    el.innerHTML = `<span>${format(current)}</span>${tooltip}`;
  });
  deltaIds.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.dataset.tone = tone;
    el.textContent = deltaText;
  });
}

function renderPeriodComparison({
  valueId,
  deltaId,
  label,
  current = 0,
  previous = 0,
  currentLabel = "Atual",
  previousLabel = "Mes anterior",
  format,
}) {
  const currentValue = Number(current || 0);
  const previousValue = Number(previous || 0);
  const hasBase = previousValue !== 0;
  const delta = hasBase
    ? ((currentValue - previousValue) / Math.abs(previousValue)) * 100
    : null;
  const tone = delta == null ? "neutral" : delta >= 0 ? "positive" : "negative";
  const deltaText = delta == null
    ? "Sem comparativo"
    : `${delta >= 0 ? "+" : "-"}${fmtPct(Math.abs(delta), 1)} vs mes anterior`;
  const valueEl = $(valueId);
  const deltaEl = $(deltaId);

  if (valueEl) {
    valueEl.classList.add("projection-comparison");
    valueEl.setAttribute("tabindex", "0");
    valueEl.setAttribute("aria-label", `${label}: ${format(currentValue)}. ${deltaText}.`);
    valueEl.innerHTML = `
      <span>${format(currentValue)}</span>
      <span class="projection-comparison__box" role="tooltip">
        <span class="projection-comparison__title">Comparativo do periodo</span>
        <span class="projection-comparison__row"><span>${currentLabel}</span><b>${format(currentValue)}</b></span>
        <span class="projection-comparison__row"><span>${previousLabel}</span><b>${format(previousValue)}</b></span>
        <span class="projection-comparison__row"><span>Variacao</span><b data-tone="${tone}">${deltaText}</b></span>
      </span>
    `;
  }

  if (deltaEl) {
    deltaEl.dataset.tone = tone;
    deltaEl.textContent = deltaText;
  }
}

const projectionState = {
  chart: null,
  selectedPeriod: "",
  compareSameDayPrevMonthEnabled: true,
  dailyOrders: [],
  previousDailyOrders: [],
  previousDaysInMonth: 0,
  dayOfMonth: 1,
  daysInMonth: 30,
};

const PROJECTION_COMPARE_STORAGE_KEY = "ml.projecao_mensal.compare_prev_month_same_day";
const PROJECTION_COMPARE_STORAGE_KEY_LEGACY = "ml.projecao_mensal.compare_prev_day";

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function readProjectionComparePreference() {
  try {
    const raw = String(window.localStorage.getItem(PROJECTION_COMPARE_STORAGE_KEY) || "").trim();
    if (!raw) {
      const legacyRaw = String(
        window.localStorage.getItem(PROJECTION_COMPARE_STORAGE_KEY_LEGACY) || "",
      ).trim();
      if (!legacyRaw) return true;
      return !["0", "false", "off", "no"].includes(legacyRaw.toLowerCase());
    }
    return !["0", "false", "off", "no"].includes(raw.toLowerCase());
  } catch {
    return true;
  }
}

function writeProjectionComparePreference(enabled) {
  try {
    window.localStorage.setItem(PROJECTION_COMPARE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {}
}

function syncProjectionCompareToggle() {
  const input = $("projection-compare-prev-month-same-day");
  if (!input) return;
  input.checked = !!projectionState.compareSameDayPrevMonthEnabled;
  input.setAttribute(
    "aria-checked",
    projectionState.compareSameDayPrevMonthEnabled ? "true" : "false",
  );
}

function showProjectionAlert(type, text) {
  const el = $("projection-alert");
  if (!el) return;
  el.className = `projection-alert ${type === "error" ? "projection-alert--error" : "projection-alert--info"}`;
  el.style.display = "block";
  el.textContent = text;
}

function hideProjectionAlert() {
  const el = $("projection-alert");
  if (!el) return;
  el.style.display = "none";
  el.textContent = "";
  el.className = "projection-alert";
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text().catch(() => "");
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }

  return data;
}

function buildAdsSummary({ roas, tacos, cost, revenue }) {
  const roasNum = Number(roas || 0);
  const tacosNum = Number(tacos || 0);

  let roasTone = "ROAS em construcao";
  if (roasNum >= 6) roasTone = "ROAS muito forte";
  else if (roasNum >= 4) roasTone = "ROAS saudavel";
  else if (roasNum >= 2.5) roasTone = "ROAS aceitavel";
  else if (roasNum > 0) roasTone = "ROAS pressionado";

  let tacosTone = "TACOS indefinido";
  if (tacosNum > 0 && tacosNum <= 8) tacosTone = "TACOS controlado";
  else if (tacosNum <= 12) tacosTone = "TACOS equilibrado";
  else if (tacosNum <= 18) tacosTone = "TACOS de atencao";
  else if (tacosNum > 18) tacosTone = "TACOS elevado";

  if (!(cost > 0) || !(revenue > 0)) {
    return "Sem investimento ou receita Ads suficientes no periodo para resumir a eficiencia de midia.";
  }

  return `${roasTone} no periodo, com TACOS em ${fmtPct(tacosNum, 1)}. Foram ${fmtBRL(
    cost,
  )} investidos para gerar ${fmtBRL(revenue)} em receita Ads.`;
}

async function carregarContaAtual() {
  const setBoth = (text) => {
    setText("account-name-inline", text);
  };

  try {
    const response = await fetch("/api/account/current", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { accept: "application/json" },
    });

    const contentType = String(response.headers.get("content-type") || "");
    if (!contentType.includes("application/json")) {
      setBoth("Indisponivel");
      return;
    }

    const data = await response.json().catch(() => null);
    if ((data?.ok || data?.success) && data?.accountKey) {
      setBoth(String(data?.label || "").trim() || "Conta selecionada");
      return;
    }

    setBoth("Nao selecionada");
  } catch {
    setBoth("Indisponivel");
  }
}

function parseDayIndexFromDate(value) {
  const m = String(value || "").match(/^\d{4}-\d{2}-(\d{2})/);
  if (!m) return null;
  const day = Number(m[1]);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  return day;
}

function previousMonthPeriodKey(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return "";
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
}

function normalizeDailyOrders(dailyOrders, dayOfMonth, daysInMonth) {
  const arr = Array.isArray(dailyOrders) ? dailyOrders : [];
  const safeDay = Math.max(1, Number(dayOfMonth || 1));
  const safeDays = Math.max(1, Number(daysInMonth || 30));
  const totalDays = Math.max(safeDays, safeDay, arr.length, 1);

  const byDay = new Map();
  arr.forEach((item, index) => {
    const fallbackDay = index + 1;
    const parsedDay = parseDayIndexFromDate(item?.date);
    const day = parsedDay || fallbackDay;
    if (day < 1 || day > totalDays) return;
    byDay.set(day, {
      date: String(item?.date || ""),
      revenue: toFiniteNumber(item?.revenue),
      orders: toFiniteNumber(item?.orders),
      units: toFiniteNumber(item?.units),
    });
  });

  const out = [];
  for (let day = 1; day <= totalDays; day += 1) {
    const item = byDay.get(day) || {};
    out.push({
      day,
      date: String(item.date || ""),
      revenue: toFiniteNumber(item.revenue),
      orders: toFiniteNumber(item.orders),
      units: toFiniteNumber(item.units),
    });
  }

  return out;
}

function setProjectionProgress(dayOfMonth, daysInMonth) {
  const safeDay = Math.max(1, Number(dayOfMonth || 1));
  const safeDays = Math.max(1, Number(daysInMonth || 30));
  const progress = Math.min(100, Math.max(0, (safeDay / safeDays) * 100));

  const fill = $("projection-progress-fill");
  if (fill) fill.style.width = `${progress.toFixed(2)}%`;

}

function ensureProjectionCanvas(wrap) {
  if (!wrap) return null;
  let canvas = $("projection-spark-canvas");
  if (!canvas) {
    wrap.innerHTML = "";
    canvas = document.createElement("canvas");
    canvas.id = "projection-spark-canvas";
    canvas.setAttribute("aria-label", "Grafico diario da projecao mensal");
    wrap.appendChild(canvas);
  }
  return canvas;
}

function renderSparklineBarsFallback(rows, dayOfMonth) {
  const wrap = $("projection-sparkline");
  if (!wrap) return;

  wrap.innerHTML = "";
  wrap.style.alignItems = "flex-end";
  wrap.style.gap = "6px";
  wrap.style.padding = "18px 16px 12px";

  const max = Math.max(1, ...rows.map((item) => toFiniteNumber(item.revenue)));
  rows.forEach((item) => {
    const pct = Math.max(0.04, toFiniteNumber(item.revenue) / max);
    const bar = document.createElement("div");
    bar.className = "projection-sparkline__bar";

    if (item.day > dayOfMonth) bar.classList.add("is-future");
    if (item.day === dayOfMonth) bar.classList.add("is-today");

    bar.style.height = `${Math.round(pct * 100)}%`;
    bar.title = `Dia ${String(item.day).padStart(2, "0")}\nVendas: ${fmtBRL(item.revenue)}\nPedidos: ${fmtNum(
      item.orders,
    )}\nUnidades: ${fmtNum(item.units)}`;
    wrap.appendChild(bar);
  });
}

const projectionBackdropPlugin = {
  id: "projectionBackdrop",
  beforeDraw(chart, args, pluginOptions) {
    const { ctx, chartArea } = chart;
    if (!chartArea) return;

    const { left, top, width, height, right, bottom } = chartArea;
    const grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, "rgba(59,130,246,0.10)");
    grad.addColorStop(0.45, "rgba(56,189,248,0.06)");
    grad.addColorStop(1, "rgba(59,130,246,0.01)");

    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(left, top, width, height);

    const columns = Math.max(4, Number(pluginOptions?.columns || 8));
    ctx.strokeStyle = "rgba(148,163,184,0.10)";
    ctx.lineWidth = 1;
    for (let i = 1; i < columns; i += 1) {
      const x = left + (width * i) / columns;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }

    const halo = ctx.createRadialGradient(
      right - width * 0.15,
      top + height * 0.1,
      10,
      right - width * 0.15,
      top + height * 0.1,
      Math.max(width, height) * 0.55,
    );
    halo.addColorStop(0, "rgba(59,130,246,0.18)");
    halo.addColorStop(1, "rgba(59,130,246,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(left, top, width, height);
    ctx.restore();
  },
};

const projectionTodayMarkerPlugin = {
  id: "projectionTodayMarker",
  afterDatasetsDraw(chart, args, pluginOptions) {
    const todayIndex = Number(pluginOptions?.todayIndex || 0);
    if (!todayIndex || todayIndex < 1) return;

    const meta = chart.getDatasetMeta(0);
    const point = meta?.data?.[todayIndex - 1];
    if (!point) return;

    const { ctx, chartArea } = chart;
    if (!chartArea) return;

    ctx.save();
    ctx.strokeStyle = "rgba(37,99,235,0.42)";
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.moveTo(point.x, chartArea.top + 2);
    ctx.lineTo(point.x, chartArea.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(37,99,235,0.9)";
    ctx.font = "700 10px Segoe UI, Tahoma, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("Hoje", point.x, chartArea.top + 4);
    ctx.restore();
  },
};

function renderNoSparkline() {
  const wrap = $("projection-sparkline");
  const empty = $("projection-spark-empty");

  if (projectionState.chart) {
    projectionState.chart.destroy();
    projectionState.chart = null;
  }

  if (wrap) wrap.innerHTML = "";
  if (empty) empty.style.display = "block";
}

function renderSparkline(
  dailyOrders,
  dayOfMonth,
  daysInMonth,
  previousDailyOrders = [],
  previousDaysInMonth = 0,
) {
  projectionState.dailyOrders = Array.isArray(dailyOrders) ? dailyOrders : [];
  projectionState.previousDailyOrders = Array.isArray(previousDailyOrders)
    ? previousDailyOrders
    : [];
  projectionState.previousDaysInMonth = Math.max(0, Number(previousDaysInMonth || 0));
  projectionState.dayOfMonth = Math.max(1, Number(dayOfMonth || 1));
  projectionState.daysInMonth = Math.max(1, Number(daysInMonth || 30));

  setProjectionProgress(projectionState.dayOfMonth, projectionState.daysInMonth);

  const wrap = $("projection-sparkline");
  const empty = $("projection-spark-empty");
  if (!wrap) return;

  const rows = normalizeDailyOrders(
    projectionState.dailyOrders,
    projectionState.dayOfMonth,
    projectionState.daysInMonth,
  );

  if (!rows.length) {
    renderNoSparkline();
    return;
  }

  if (empty) empty.style.display = "none";

  if (typeof Chart === "undefined") {
    if (projectionState.chart) {
      projectionState.chart.destroy();
      projectionState.chart = null;
    }
    renderSparklineBarsFallback(rows, projectionState.dayOfMonth);
    return;
  }

  wrap.style.alignItems = "stretch";
  wrap.style.gap = "0";
  wrap.style.padding = "10px";

  const canvas = ensureProjectionCanvas(wrap);
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const isLight = document.body.classList.contains("theme-light");
  const tickColor = isLight ? "#64748b" : "#94a3b8";
  const gridColor = isLight ? "rgba(148,163,184,0.16)" : "rgba(148,163,184,0.12)";
  const tooltipBg = isLight ? "rgba(255,255,255,0.98)" : "rgba(15,23,42,0.96)";
  const tooltipBorder = isLight ? "rgba(15,23,42,0.10)" : "rgba(148,163,184,0.16)";
  const tooltipTitle = isLight ? "rgba(15,23,42,0.92)" : "#f8fafc";
  const tooltipBody = isLight ? "rgba(15,23,42,0.86)" : "#dbe7f5";
  const primaryStart = isLight ? "#f97316" : "#60a5fa";
  const primaryEnd = isLight ? "#fb923c" : "#8b5cf6";
  const primaryPoint = isLight ? "#f97316" : "#60a5fa";
  const primaryPointBorder = isLight ? "#ffffff" : "#0f172a";
  const compareLine = isLight ? "rgba(59,130,246,0.55)" : "rgba(148,163,184,0.72)";
  const comparePoint = isLight ? "rgba(59,130,246,0.45)" : "rgba(148,163,184,0.72)";
  const comparePointBorder = isLight ? "#dbeafe" : "#0f172a";
  const labels = rows.map((row) => String(row.day).padStart(2, "0"));
  const currentData = rows.map((row) =>
    row.day <= projectionState.dayOfMonth ? toFiniteNumber(row.revenue) : null,
  );
  const previousMonthRows = normalizeDailyOrders(
    projectionState.previousDailyOrders,
    projectionState.dayOfMonth,
    Math.max(
      projectionState.previousDaysInMonth || 0,
      projectionState.daysInMonth,
      projectionState.dayOfMonth,
    ),
  );
  const previousMonthData = rows.map((row) => {
    if (row.day > projectionState.dayOfMonth) return null;
    if (
      projectionState.previousDaysInMonth > 0 &&
      row.day > projectionState.previousDaysInMonth
    ) {
      return null;
    }
    const prev = previousMonthRows[row.day - 1];
    if (!prev) return null;
    return toFiniteNumber(prev.revenue);
  });

  const datasets = [
    {
      label: "Receita diaria",
      data: currentData,
      borderColor(context) {
        const { chart } = context;
        if (!chart.chartArea) return primaryStart;
        const gradient = chart.ctx.createLinearGradient(0, chart.chartArea.top, chart.chartArea.right, 0);
        gradient.addColorStop(0, primaryStart);
        gradient.addColorStop(1, primaryEnd);
        return gradient;
      },
      borderWidth: 2.8,
      tension: 0.42,
      fill: "origin",
      pointRadius: 2.8,
      pointHoverRadius: 6,
      pointBackgroundColor: primaryPoint,
      pointBorderColor: primaryPointBorder,
      pointBorderWidth: 1.5,
      pointHoverBorderWidth: 2,
      backgroundColor(context) {
        const { chart } = context;
        const { ctx: chartCtx, chartArea } = chart;
        if (!chartArea) return isLight ? "rgba(249,115,22,0.20)" : "rgba(96,165,250,0.20)";
        const gradient = chartCtx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        gradient.addColorStop(0, isLight ? "rgba(249,115,22,0.24)" : "rgba(96,165,250,0.24)");
        gradient.addColorStop(0.55, isLight ? "rgba(249,115,22,0.10)" : "rgba(96,165,250,0.10)");
        gradient.addColorStop(1, isLight ? "rgba(249,115,22,0.02)" : "rgba(96,165,250,0.02)");
        return gradient;
      },
    },
  ];

  if (projectionState.compareSameDayPrevMonthEnabled) {
    datasets.push({
      label: "Mesmo dia mes passado",
      data: previousMonthData,
      borderColor: compareLine,
      borderWidth: 2,
      borderDash: [7, 6],
      tension: 0.42,
      fill: false,
      pointRadius: 2,
      pointHoverRadius: 4,
      pointBackgroundColor: comparePoint,
      pointBorderColor: comparePointBorder,
      pointBorderWidth: 1.2,
    });
  }

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    layout: { padding: { top: 12, right: 10, left: 8, bottom: 6 } },
    elements: {
      line: { capBezierPoints: true },
    },
    plugins: {
      legend: {
        position: "bottom",
        labels: {
          usePointStyle: true,
          boxWidth: 9,
          boxHeight: 9,
          color: tickColor,
          padding: 16,
          font: { size: 11, weight: "700" },
        },
      },
      tooltip: {
        backgroundColor: tooltipBg,
        borderColor: tooltipBorder,
        borderWidth: 1,
        titleColor: tooltipTitle,
        bodyColor: tooltipBody,
        displayColors: true,
        titleFont: { size: 11, weight: "700" },
        bodyFont: { size: 11, weight: "600" },
        padding: 12,
        callbacks: {
          title(items) {
            const index = items?.[0]?.dataIndex ?? 0;
            const row = rows[index];
            if (!row) return "Dia";
            return row.date ? `Dia ${row.date}` : `Dia ${String(row.day).padStart(2, "0")}`;
          },
          label(context) {
            const val = Number(context.parsed?.y || 0);
            return `${context.dataset.label}: ${fmtBRL(val)}`;
          },
          afterBody(items) {
            const index = items?.[0]?.dataIndex;
            if (!Number.isInteger(index) || index < 0) return "";
            const current = Number(currentData[index]);
            const prev = Number(previousMonthData[index]);
            if (!Number.isFinite(current) || !Number.isFinite(prev)) return "";
            const delta = current - prev;
            const signal = delta >= 0 ? "+" : "";
            const pct = prev > 0 ? ` (${signal}${fmtPct((delta / prev) * 100, 1)})` : "";
            return `Variacao vs mesmo dia do mes passado: ${signal}${fmtBRL(delta)}${pct}`;
          },
        },
      },
      projectionBackdrop: {
        columns: 8,
      },
      projectionTodayMarker: {
        todayIndex: projectionState.dayOfMonth,
      },
    },
    scales: {
      x: {
        title: { display: false },
        grid: {
          display: false,
          drawBorder: false,
          tickLength: 0,
        },
        ticks: {
          color: tickColor,
          autoSkip: true,
          maxTicksLimit: 16,
          font: { size: 10, weight: "600" },
          callback: (val) => String(labels[val] ?? ""),
        },
      },
      y: {
        beginAtZero: true,
        title: { display: false },
        grid: {
          color: gridColor,
          drawBorder: false,
          borderDash: [4, 4],
        },
        ticks: {
          color: tickColor,
          font: { size: 10, weight: "600" },
          callback(value) {
            return Number(value).toLocaleString("pt-BR");
          },
        },
      },
    },
  };

  if (projectionState.chart) {
    projectionState.chart.data.labels = labels;
    projectionState.chart.data.datasets = datasets;
    projectionState.chart.options = options;
    projectionState.chart.update();
    return;
  }

  projectionState.chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options,
    plugins: [projectionBackdropPlugin, projectionTodayMarkerPlugin],
  });
}

async function carregarProjecaoMensal({ manageLoading = true } = {}) {
  hideProjectionAlert();
  if (manageLoading) showProjectionLoading("Lendo vendas e ritmo do mês...");

  try {
    updateProjectionLoading("Consolidando vendas do período...", 24);
    const requestedPeriod = String($("projection-month")?.value || projectionState.selectedPeriod || "").trim();
    const params = new URLSearchParams({ tz: "America/Sao_Paulo" });
    if (/^\d{4}-\d{2}$/.test(requestedPeriod)) params.set("period", requestedPeriod);
    const response = await fetch(`/api/dashboard/summary?${params.toString()}`, {
      cache: "no-store",
    });
    const text = await response.text().catch(() => "");
    const data = text ? JSON.parse(text) : null;

    if (!response.ok || !data || !data.ok) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }

    updateProjectionLoading("Calculando projeção e comparativos...", 48);

    const period = data.period || {};
    const totals = data.totals || {};
    const series = data.series || {};
    const breakdown = data.breakdown || {};

    const month = String(period.month || "").padStart(2, "0");
    const year = String(period.year || "");
    const monthKey = period.month_key || (year && month ? `${year}-${month}` : "-");
    projectionState.selectedPeriod = monthKey !== "-" ? monthKey : requestedPeriod;
    const monthInput = $("projection-month");
    if (monthInput && /^\d{4}-\d{2}$/.test(monthKey)) monthInput.value = monthKey;

    setText("projection-period", monthKey);
    setText(
      "projection-day",
      `${period.day_of_month || "-"}/${period.days_in_month || "-"}`,
    );

    const totalAll = Number(breakdown.total_all || totals.revenue_month_to_date || 0);

    setText("projection-total", fmtBRL(totalAll));
    setText("projection-projected", fmtBRL(totals.revenue_projected_month || 0));
    setText("projection-ticket-side", fmtBRL(totals.ticket_medio || 0));
    setText("projection-orders-card", fmtNum(totals.orders_count || 0));
    setText("projection-units", fmtNum(totals.units_sold || 0));

    setText(
      "projection-formula-hint",
      `Ex: (${fmtBRL(totals.revenue_month_to_date || 0)} / ${period.day_of_month || 1}) x ${
        period.days_in_month || 30
      }`,
    );

    const previousPeriod = previousMonthPeriodKey(period.year, period.month);
    let previousDailyOrders = [];
    let previousDaysInMonth = 0;
    let previousPeriodData = null;
    if (previousPeriod) {
      try {
        const previousResponse = await fetch(
          `/api/dashboard/summary?tz=America%2FSao_Paulo&period=${encodeURIComponent(previousPeriod)}`,
          { cache: "no-store" },
        );
        const previousText = await previousResponse.text().catch(() => "");
        const previousData = previousText ? JSON.parse(previousText) : null;
        if (previousResponse.ok && previousData?.ok) {
          previousPeriodData = previousData;
          previousDailyOrders = Array.isArray(previousData?.series?.daily_orders)
            ? previousData.series.daily_orders
            : [];
          previousDaysInMonth = Number(previousData?.period?.days_in_month || 0);
        }
      } catch (previousError) {
        console.warn(
          "Falha ao carregar serie comparativa do mes passado:",
          previousError?.message || previousError,
        );
      }
    }

    const currentClosed = closedDaysMetrics(series.daily_orders || [], period);
    const previousClosed = closedDaysMetrics(
      previousDailyOrders,
      previousPeriodData?.period || {
        days_in_month: previousDaysInMonth,
        day_of_month: previousDaysInMonth,
        is_current_month: false,
      },
    );
    const comparableDays = Math.max(
      0,
      Math.min(Number(period.day_of_month || 0), previousDaysInMonth),
    );
    const previousComparableRows = previousDailyOrders.slice(0, comparableDays);
    const previousComparableRevenue = previousComparableRows.reduce(
      (sum, row) => sum + Number(row?.revenue || 0),
      0,
    );
    const previousComparableOrders = previousComparableRows.reduce(
      (sum, row) => sum + Number(row?.orders || 0),
      0,
    );
    const previousComparableTicket = previousComparableOrders > 0
      ? previousComparableRevenue / previousComparableOrders
      : 0;
    const previousTotals = previousPeriodData?.totals || {};
    const samePeriodLabel = comparableDays > 0
      ? `Mes anterior ate o dia ${comparableDays}`
      : "Mesmo periodo anterior";

    renderPeriodComparison({
      valueId: "projection-total",
      deltaId: "projection-total-delta",
      label: "Faturamento do mes",
      current: totalAll,
      previous: previousComparableRevenue,
      currentLabel: `Mes atual ate o dia ${period.day_of_month || "-"}`,
      previousLabel: samePeriodLabel,
      format: fmtBRL,
    });
    renderPeriodComparison({
      valueId: "projection-projected",
      deltaId: "projection-projected-delta",
      label: "Projecao mensal",
      current: totals.revenue_projected_month,
      previous: previousTotals.revenue_month_to_date,
      currentLabel: "Projecao de fechamento atual",
      previousLabel: "Fechamento do mes anterior",
      format: fmtBRL,
    });
    renderPeriodComparison({
      valueId: "projection-orders-card",
      deltaId: "projection-orders-delta",
      label: "Pedidos do mes",
      current: totals.orders_count,
      previous: previousComparableOrders,
      currentLabel: `Mes atual ate o dia ${period.day_of_month || "-"}`,
      previousLabel: samePeriodLabel,
      format: fmtNum,
    });
    renderPeriodComparison({
      valueId: "projection-ticket-side",
      deltaId: "projection-ticket-delta",
      label: "Ticket medio",
      current: totals.ticket_medio,
      previous: previousComparableTicket,
      currentLabel: `Ticket atual ate o dia ${period.day_of_month || "-"}`,
      previousLabel: `Ticket anterior ate o dia ${comparableDays || "-"}`,
      format: fmtBRL,
    });
    renderAverageComparison({
      valueIds: ["projection-avg-revenue-card"],
      deltaIds: ["projection-avg-revenue-delta"],
      label: "Media de faturamento",
      current: currentClosed.avgRevenue,
      previous: previousClosed.avgRevenue,
      currentDays: currentClosed.days,
      previousDays: previousClosed.days,
      format: fmtBRL,
    });
    renderAverageComparison({
      valueIds: ["projection-avg-orders-card"],
      deltaIds: ["projection-avg-orders-delta"],
      label: "Media de pedidos",
      current: currentClosed.avgOrders,
      previous: previousClosed.avgOrders,
      currentDays: currentClosed.days,
      previousDays: previousClosed.days,
      format: (value) => fmtDecimal(value, 2),
    });
    renderSparkline(
      series.daily_orders || [],
      period.day_of_month || 1,
      period.days_in_month || 30,
      previousDailyOrders,
      previousDaysInMonth,
    );

    updateProjectionLoading("Carregando composição de publicidade...", 76);
    try {
      const firstDay = `${monthKey}-01`;
      const today = period.is_current_month
        ? (period.today || `${monthKey}-${String(period.day_of_month || 1).padStart(2, "0")}`)
        : `${monthKey}-${String(period.days_in_month || period.day_of_month || 1).padStart(2, "0")}`;
      const adsData = await fetchJson(
        `/api/publicidade/product-ads/summary?date_from=${encodeURIComponent(
          firstDay,
        )}&date_to=${encodeURIComponent(today)}`,
        {
          credentials: "same-origin",
          cache: "no-store",
        },
      );

      const summary = adsData?.summary || {};
      const adsAmount = Number(summary.amount || 0);
      const adsSpend = Number(summary.cost || 0);

      const roas = adsSpend > 0 ? adsAmount / adsSpend : 0;
      const tacos = totalAll > 0 ? (adsSpend / totalAll) * 100 : 0;
      const organic = Math.max(0, totalAll - adsAmount);

      setText("projection-ads", fmtBRL(adsAmount));
      setText("projection-organic", fmtBRL(organic));
      setText("projection-ads-spend", fmtBRL(adsSpend));
      setText("projection-ads-revenue", fmtBRL(adsAmount));
      setText("projection-roas", fmtRatioX(roas, 2));
      setText("projection-tacos", fmtPct(tacos, 1));
      setText(
        "projection-ads-summary",
        buildAdsSummary({ roas, tacos, cost: adsSpend, revenue: adsAmount }),
      );
    } catch (adsError) {
      setText("projection-ads", fmtBRL(0));
      setText("projection-organic", fmtBRL(totalAll));
      setText("projection-ads-spend", fmtBRL(0));
      setText("projection-ads-revenue", fmtBRL(0));
      setText("projection-roas", "-");
      setText("projection-tacos", "-");
      setText(
        "projection-ads-summary",
        "Os indicadores de midia nao ficaram disponiveis neste carregamento.",
      );
      showProjectionAlert("info", `Ads indisponivel: ${adsError.message || adsError}`);
    }
  } catch (error) {
    renderNoSparkline();
    setProjectionProgress(projectionState.dayOfMonth, projectionState.daysInMonth);
    showProjectionAlert(
      "error",
      `Nao foi possivel carregar a projecao mensal: ${error.message || String(error)}`,
    );
  } finally {
    if (manageLoading) hideProjectionLoading();
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  projectionState.compareSameDayPrevMonthEnabled = readProjectionComparePreference();
  syncProjectionCompareToggle();
  showProjectionLoading("Preparando projeção mensal...");

  try {
    updateProjectionLoading("Identificando conta ativa...", 12);
    await carregarContaAtual();
  } catch (accountError) {
    console.warn("Falha ao carregar conta atual na projeção:", accountError?.message || accountError);
  }

  $("projection-refresh")?.addEventListener("click", () => carregarProjecaoMensal());

  const monthInput = $("projection-month");
  if (monthInput) {
    const now = new Date();
    monthInput.max = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    monthInput.addEventListener("change", () => {
      projectionState.selectedPeriod = monthInput.value || "";
      carregarProjecaoMensal();
    });
  }

  $("projection-compare-prev-month-same-day")?.addEventListener("change", (event) => {
    projectionState.compareSameDayPrevMonthEnabled = !!event?.target?.checked;
    writeProjectionComparePreference(projectionState.compareSameDayPrevMonthEnabled);
    syncProjectionCompareToggle();
    renderSparkline(
      projectionState.dailyOrders,
      projectionState.dayOfMonth,
      projectionState.daysInMonth,
      projectionState.previousDailyOrders,
      projectionState.previousDaysInMonth,
    );
  });

  window.addEventListener("ml-themechange", () => {
    if (!projectionState.dailyOrders.length) return;
    renderSparkline(
      projectionState.dailyOrders,
      projectionState.dayOfMonth,
      projectionState.daysInMonth,
      projectionState.previousDailyOrders,
      projectionState.previousDaysInMonth,
    );
  });


  try {
    await carregarProjecaoMensal({ manageLoading: false });
  } finally {
    hideProjectionLoading();
  }
});

