const withBase = (path) => (window.mlUrl ? window.mlUrl(path) : path);
const $ = (id) => document.getElementById(id);

let RAW_CASES = [];
let RAW_ALL_CASES = [];
let ACTIVE_IMPACT_FILTER = "";
let ACTIVE_GOAL_TAB = "sales";
let ACTIVE_TREND_KEY = "claims";
let LAST_TRENDS = {};
let LAST_GOAL_CONTEXT = { salesWindow: {}, goals: {} };
let LAST_METRIC_CARDS = {};
let LAST_MODAL_TRIGGER = null;

const IMPACT_FILTER_LABELS = {
  claims: "Reclamacoes",
  mediations: "Mediacoes",
  cancellations: "Cancelamentos",
  delayed: "Atrasos envio",
};

const METRIC_HELPERS = {
  claims: "Reclamacoes saem da reputacao 60 dias apos a criacao. Clique para ver as vendas.",
  mediations: "Mediacoes exigem tratativa separada e tendem a pesar mais na reputacao.",
  cancellations: "Cancelamentos por falha operacional aparecem aqui quando retornados pela leitura.",
  delayed: "Atrasos de envio indicam risco operacional antes de virar reclamacao.",
};

const LOADING_TEXTS = [
  "Obtendo informacoes de reputacao...",
  "Consultando claims e pedidos...",
  "Consolidando impactos da janela de 60 dias...",
  "Preparando indicadores e evolução...",
];

let LOADING_TIMER = null;
let LOADING_INDEX = 0;

function fmtNum(v) {
  return new Intl.NumberFormat("pt-BR").format(Number(v || 0));
}

function fmtDecimal(v, digits = 1) {
  return Number(v || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtCurrency(v) {
  return Number(v || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  });
}

function fmtDate(v) {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("pt-BR");
}

function fmtDateOnly(v) {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("pt-BR");
}

function addDaysIso(v, days) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

function fmtPct(v) {
  const n = Number(v || 0);
  return `${n.toLocaleString("pt-BR", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}%`;
}

function fmtSignedPct(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || Math.abs(n) < 0.5) return "Estavel";
  return `${n > 0 ? "+" : "-"}${Math.abs(Math.round(n))}%`;
}

function formatUpdatedAt(value) {
  if (!value) return "agora";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "agora";
  const diffMin = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (diffMin < 2) return "agora";
  if (diffMin < 60) return `ha ${diffMin} min`;
  return `ha ${Math.round(diffMin / 60)}h`;
}

function metricTone(status) {
  if (status === "critical" || status === "red") return "critical";
  if (status === "warning" || status === "orange") return "warning";
  return "healthy";
}

function safeText(v) {
  return String(v || "-").replace(/[<>]/g, "");
}

function safeHref(v) {
  const text = String(v || "");
  return /^https:\/\/www\.mercadolivre\.com\.br\/vendas\//.test(text) ? text : "";
}

function showAlert(text, kind = "warn") {
  const el = $("rep-alert");
  if (!el) return;
  const isLight = document.body.classList.contains("theme-light") || !document.body.classList.contains("theme-dark");
  el.style.display = "block";
  el.textContent = text;
  if (kind === "error") {
    el.style.background = isLight ? "#fff0ed" : "rgba(239,68,68,.14)";
    el.style.color = isLight ? "#912018" : "#fca5a5";
    el.style.borderColor = isLight ? "#f7b5a7" : "rgba(248,113,113,.28)";
    return;
  }
  el.style.background = isLight ? "#fff8ea" : "rgba(245,158,11,.14)";
  el.style.color = isLight ? "#9a6700" : "#fcd34d";
  el.style.borderColor = isLight ? "#f7d79e" : "rgba(251,191,36,.28)";
}

function hideAlert() {
  const el = $("rep-alert");
  if (!el) return;
  el.style.display = "none";
  el.textContent = "";
}

function showLoading() {
  window.MLLoadingOverlay?.show({
    context: "Reputacao",
    label: "Loading...",
    texts: LOADING_TEXTS,
    message: LOADING_TEXTS[0],
    initialProgress: 18,
    maxProgress: 92,
  });
  LOADING_INDEX = 0;
  clearInterval(LOADING_TIMER);
  LOADING_TIMER = setInterval(() => {
    LOADING_INDEX = (LOADING_INDEX + 1) % LOADING_TEXTS.length;
    window.MLLoadingOverlay?.update({
      message: LOADING_TEXTS[LOADING_INDEX],
    });
  }, 2600);
}

function hideLoading() {
  window.MLLoadingOverlay?.hide();
  clearInterval(LOADING_TIMER);
  LOADING_TIMER = null;
}

async function carregarContaAtual() {
  try {
    await window.AccountBar?.ensure?.();
  } catch {}
}

function metricCaseLabel(filterKey = "") {
  return IMPACT_FILTER_LABELS[filterKey] || "Casos";
}

function shortWeekLabel(week = {}, index = 0, total = 4) {
  const raw = String(week.label || "").trim().toLowerCase();
  if (raw === "atual") return "Atual";
  if (raw.includes("s-3")) return "3 sem atras";
  if (raw.includes("s-2")) return "2 sem atras";
  if (raw.includes("s-1")) return "Sem. ant.";
  if (index === total - 1) return "Atual";
  const weeksBack = Math.max(1, total - index - 1);
  return weeksBack === 1 ? "Sem. ant." : `${weeksBack} sem atras`;
}

function popularityTone(level) {
  const text = String(level || "").toLowerCase();
  if (text.includes("green")) return { bg: "#e8f7ef", color: "#067647" };
  if (text.includes("yellow")) return { bg: "#fff4e8", color: "#b54708" };
  if (text.includes("orange") || text.includes("red")) return { bg: "#fff0ed", color: "#c4320a" };
  return { bg: "#edf4ff", color: "#3483fa" };
}

function getMetricTone(value, limit) {
  const n = Number(value || 0);
  const l = Number(limit || 0);
  if (!l) return "healthy";
  if (n >= l) return "critical";
  if (n >= l * 0.8) return "warning";
  return "healthy";
}

function ensureMetricProgress(cardEl) {
  let progress = cardEl.querySelector(".rep-metric-progress");
  if (progress) return progress;
  progress = document.createElement("div");
  progress.className = "rep-metric-progress";
  progress.innerHTML = '<span></span>';
  const helper = cardEl.querySelector("p");
  if (helper) cardEl.insertBefore(progress, helper);
  else cardEl.appendChild(progress);
  return progress;
}

function paintImpactCard(key, data = {}, limits = {}) {
  const valueEl = $(`impact-${key}-value`);
  const countEl = $(`impact-${key}-count`);
  const pillEl = $(`impact-${key}-limit`);
  const helperEl = $(`impact-${key}-helper`);
  const cardEl = $(`impact-${key}-card`);
  const totalEl = $(`impact-${key}-total`);
  if (!valueEl || !pillEl || !helperEl || !cardEl) return;

  const value = Number(data?.value || 0);
  const limit = Number(data?.limit || limits?.[key] || 0);
  const tone = metricTone(data?.status || getMetricTone(value, limit));
  const delta = Number(data?.delta_7d_pct || 0);
  const detailedCount = casesForMetric(key).length;
  const officialCount = Number(data?.count || data?.amount || data?.total || 0);
  const caseCount = Math.max(detailedCount, officialCount);

  valueEl.textContent = fmtPct(value);
  if (countEl) {
    countEl.textContent = data?.delta_7d_label || `${fmtSignedPct(delta)} vs 7d ant.`;
    countEl.dataset.tone = delta > 0 ? "up" : delta < 0 ? "down" : "stable";
  }
  if (totalEl) totalEl.textContent = fmtNum(caseCount);

  pillEl.textContent = limit ? fmtPct(limit) : "-";
  const progress = ensureMetricProgress(cardEl);
  const progressPct = limit ? Math.max(0, Math.min(100, (value / limit) * 100)) : 0;
  progress.style.setProperty("--metric-progress", `${progressPct}%`);
  progress.dataset.tone = tone;
  helperEl.textContent =
    tone === "critical"
      ? `${data?.status_label || "Acima do limite"}. ${METRIC_HELPERS[key] || ""}`
      : tone === "warning"
        ? `${data?.status_label || "Proximo do limite"}. ${METRIC_HELPERS[key] || ""}`
        : `${data?.status_label || "Dentro do limite"}. ${METRIC_HELPERS[key] || ""}`;

  cardEl.dataset.tone = tone;
}

function renderSmartAlert(intelligence = {}) {
  const alert = intelligence.alert || {};
  const status = intelligence.status || {};
  const tone = metricTone(status.tone || alert.tone);
  const pill = $("rep-status-pill");
  const box = $("rep-smart-alert");

  if (pill) {
    pill.dataset.tone = tone;
    pill.textContent = status.label || "Dentro dos limites";
  }
  if (box) box.dataset.tone = tone;
  $("rep-alert-title").textContent = alert.title || "Reputacao dentro dos limites monitorados";
  $("rep-alert-summary").textContent = alert.summary || "As metricas principais estao sendo acompanhadas.";
  $("rep-alert-detail").textContent = alert.detail || "";
}

function renderTrends(metrics = {}) {
  LAST_TRENDS = metrics || {};
  const slot = $("rep-trend-grid");
  const tabs = $("rep-trend-tabs");
  if (!slot) return;

  const order = ["claims", "cancellations", "delayed", "mediations"];
  if (!order.includes(ACTIVE_TREND_KEY)) ACTIVE_TREND_KEY = "claims";

  if (tabs) {
    tabs.innerHTML = order.map((key) => {
      const metric = metrics[key] || {};
      return `<button type="button" data-trend-key="${key}" class="${ACTIVE_TREND_KEY === key ? "is-active" : ""}">${safeText(metric.label || IMPACT_FILTER_LABELS[key] || key)}</button>`;
    }).join("");
  }

  const key = ACTIVE_TREND_KEY;
  const metric = metrics[key] || {};
  const weeks = Array.isArray(metric.weeks) && metric.weeks.length
    ? metric.weeks
    : [{ count: 0 }, { count: 0 }, { count: 0 }, { count: 0 }];
  const max = Math.max(...weeks.map((week) => Number(week.count || 0)), 1);
  const delta = Number(metric.delta_7d_pct || 0);
  const tone = delta > 0 ? "up" : delta < 0 ? "down" : "stable";
  const current = weeks[weeks.length - 1] || {};
  const previous = weeks[weeks.length - 2] || {};

  slot.innerHTML = `
    <article class="rep-trend-card rep-trend-card--single" data-metric="${key}" data-tone="${tone}">
      <div class="rep-trend-card__head">
        <div>
          <strong>${safeText(metric.label || IMPACT_FILTER_LABELS[key] || key)}</strong>
          <small>Últimas ${fmtNum(weeks.length)} leituras semanais</small>
        </div>
        <span data-tone="${tone}">${safeText(metric.delta_7d_label || "Estável")}</span>
      </div>
      <div class="rep-bars" aria-label="Gráfico semanal de ${safeText(metric.label || key)}">
        ${weeks.map((week, index) => {
          const count = Number(week.count || 0);
          const height = Math.max(10, (count / max) * 92);
          const currentBar = index === weeks.length - 1;
          return `
            <div class="rep-bar-item" data-current="${currentBar ? "true" : "false"}">
              <span>${fmtNum(count)}</span>
              <i style="height:${height}px"></i>
              <small>${safeText(shortWeekLabel(week, index, weeks.length))}</small>
            </div>
          `;
        }).join("")}
      </div>
      <div class="rep-trend-summary">
        <span><b>${fmtNum(current.count || 0)}</b> atual</span>
        <span><b>${fmtNum(previous.count || 0)}</b> semana anterior</span>
        <span><b>${fmtPct(metric.limit || 0)}</b> limite ML</span>
      </div>
    </article>
  `;
}

function renderSalesWindow(salesWindow = {}) {
  LAST_GOAL_CONTEXT.salesWindow = salesWindow || {};
  const goals = LAST_GOAL_CONTEXT.goals || {};
  const currentEl = $("rep-goal-current");
  if (!currentEl) return;

  const fetched = Number(salesWindow.fetched_orders_count || 0);
  const available = Number(salesWindow.total_available || salesWindow.orders_count || 0);
  const capped = Boolean(salesWindow.capped);
  const isRevenue = ACTIVE_GOAL_TAB === "revenue";
  const format = isRevenue ? fmtCurrency : fmtNum;
  const current = isRevenue
    ? Number(salesWindow.revenue || 0)
    : Number(salesWindow.orders_count || salesWindow.total_available || 0);
  const dailyAverage = isRevenue
    ? Number(salesWindow.daily_revenue_average || 0)
    : Number(salesWindow.daily_average || 0);
  const last7 = isRevenue
    ? Number(salesWindow.current_7d_revenue || 0)
    : Number(salesWindow.current_7d_count || 0);
  const deltaLabel = isRevenue
    ? salesWindow.revenue_delta_7d_label || "Estavel"
    : salesWindow.delta_7d_label || "Estavel";
  const tiers = Array.isArray(goals.tiers) ? goals.tiers : [];
  const currentTier = tiers.find((tier) => tier.key === goals.current_key);
  const nextTier = tiers.find((tier) => tier.key === goals.next_key);
  const targetTier = currentTier || nextTier || tiers[0] || {};
  const targetKey = isRevenue ? "revenue" : "sales";
  const target = Number(targetTier?.[targetKey] || 0);
  const gap = current - target;
  const hasMedal = Boolean(goals.current_key);

  currentEl.textContent = format(current);
  $("rep-goal-current-label").textContent = isRevenue ? "Faturamento 60d" : "Concluidas 60d";
  $("rep-goal-target-label").textContent = isRevenue ? "Meta de faturamento" : "Meta de vendas";
  $("rep-goal-target").textContent = format(target);
  $("rep-goal-medal").textContent = hasMedal
    ? `Manter ${goals.current_label || targetTier.label || "-"}`
    : `Objetivo: ${goals.next_label || targetTier.label || "MercadoLider"}`;
  $("rep-goal-gap").textContent = `${gap >= 0 ? "+" : ""}${format(gap)}`;
  $("rep-goal-gap-detail").textContent = gap >= 0 ? "acima da meta" : "abaixo da meta";
  $("rep-goal-pace").textContent = isRevenue ? format(dailyAverage) : fmtDecimal(dailyAverage, 1);
  $("rep-goal-pace-detail").textContent = `/dia - ultimos 7d: ${format(last7)} (${deltaLabel})`;
  $("rep-goal-tooltip-medal").textContent = goals.current_label || goals.next_label || targetTier.label || "-";
  $("rep-goal-tooltip-target").textContent = format(target);
  $("rep-goal-tooltip-current").textContent = format(current);
  $("rep-goal-tooltip-required").textContent = isRevenue
    ? `${format(Math.max(0, target / 60))}/dia`
    : `${fmtDecimal(Math.max(0, target / 60), 1)}/dia`;
  $("rep-goal-title").textContent = hasMedal
    ? (goals.current_label || "Mercado Líder")
    : (goals.next_label || "Mercado Líder");

  $("rep-sales-range").textContent = `${fmtDateOnly(salesWindow.from)} ate ${fmtDateOnly(salesWindow.to)}`;
  $("rep-sales-source").textContent = `${safeText(salesWindow.source || "orders/search")} - ${safeText(salesWindow.status || "paid")}`;
  $("rep-sales-read-detail").textContent = capped
    ? `${fmtNum(fetched)} lidas de ${fmtNum(available)} disponiveis`
    : `${fmtNum(fetched || available)} pedido(s) lido(s)`;

  const forecastEl = $("rep-sales-forecast");
  const forecast = Array.isArray(salesWindow.forecast) ? salesWindow.forecast : [];
  if (!forecastEl) return;
  if (!forecast.length) {
    forecastEl.innerHTML = `<div class="rep-empty">Sem previsao disponivel para a janela.</div>`;
    return;
  }

  forecastEl.innerHTML = forecast.map((item) => {
    const delta = Number(isRevenue ? item.delta_revenue || 0 : item.delta_orders_count || 0);
    const projected = Number(isRevenue ? item.projected_revenue || 0 : item.projected_orders_count || 0);
    const tone = delta > 0 ? "up" : delta < 0 ? "down" : "stable";
    const label = delta === 0 ? "sem variacao" : `${delta > 0 ? "+" : ""}${format(delta)} vs hoje`;
    const replacedDays = fmtNum(Math.min(60, Number(item.days_ahead || 0)));
    return `
      <article class="rep-sales-forecast__item" data-tone="${tone}">
        <div class="rank-tooltip rep-forecast-tooltip" tabindex="0">
          <span class="rep-forecast-label">Em ${fmtNum(item.days_ahead)} dias</span>
          <div class="rank-tooltip__box">
            <div class="rank-tooltip__title">Previsao da janela movel</div>
            <div class="rank-tooltip__row"><span>Valor exibido</span><strong>${format(projected)}</strong></div>
            <div class="rank-tooltip__row"><span>Comparacao</span><strong>${safeText(label)}</strong></div>
            <div class="rank-tooltip__row"><span>Dias simulados</span><strong>${replacedDays}</strong></div>
            <div class="rank-tooltip__row"><span>Regra</span><strong>Janela movel + media atual</strong></div>
          </div>
        </div>
        <strong>${format(projected)}</strong>
        <small>${safeText(label)}</small>
      </article>
    `;
  }).join("");

  const tiersEl = $("rep-goal-tiers");
  if (!tiersEl) return;
  const selectedTierKeys = new Set([goals.current_key, goals.next_key].filter(Boolean));
  let visibleTiers = tiers.filter((row) => selectedTierKeys.has(row.key));
  if (!visibleTiers.length) visibleTiers = tiers.slice(0, 2);
  tiersEl.innerHTML = visibleTiers.map((row) => {
    const rowTarget = Number(row?.[targetKey] || 0);
    const ok = current >= rowTarget;
    const active = row.key === goals.current_key;
    return `
      <article data-ok="${ok ? "true" : "false"}" data-active="${active ? "true" : "false"}">
        <span>${active ? "Nível atual" : "Próximo nível"} · ${safeText(row.label || row.key)}</span>
        <strong>${format(rowTarget)}</strong>
        <small>${ok ? "requisito atendido" : "objetivo"}</small>
      </article>
    `;
  }).join("");
}

function casesForMetric(filterKey = "") {
  const source = RAW_ALL_CASES.length ? RAW_ALL_CASES : RAW_CASES;
  return source.filter((item) => resolveImpactBucket(item) === filterKey);
}

function buildRemovalDate(item = {}) {
  return item.exits_reputation_at || item.expires_at || addDaysIso(item.created_at, 60);
}

function renderMetricCases(filterKey = "") {
  const list = $("metric-cases-list");
  const count = $("metric-cases-count");
  const title = $("metric-cases-title");
  const kicker = $("metric-cases-kicker");
  const summary = $("metric-cases-summary");
  if (!list || !count || !title || !kicker || !summary) return;

  const label = metricCaseLabel(filterKey);
  const rows = casesForMetric(filterKey);
  const officialCount = Number(LAST_METRIC_CARDS?.[filterKey]?.count || 0);
  title.textContent = label;
  kicker.textContent = "Vendas impactadas";
  count.textContent = `${fmtNum(Math.max(rows.length, officialCount))} venda(s) impactada(s)`;
  summary.textContent = "Vendas que ainda fazem parte da janela atual desta metrica na reputacao.";

  if (!rows.length) {
    list.innerHTML = `
      <div class="rep-empty">
        ${officialCount > 0
          ? `O Mercado Livre informa ${fmtNum(officialCount)} venda(s) impactada(s), mas nao disponibilizou os dados individuais nesta leitura.`
          : "Nenhum caso atual foi retornado para esta metrica."}
      </div>
    `;
    return;
  }

  list.innerHTML = rows.map((item) => {
    const removalDate = buildRemovalDate(item);
    const link = safeHref(item.marketplace_link);
    const saleLabel = item.order_id && item.order_id !== "-" ? item.order_id : "Nao identificada";
    const saleDate = item.sale_date || item.order_date || item.order_created_at;
    return `
      <article class="rep-case-row">
        <div class="rep-case-row__main">
          <span class="rep-case-row__eyebrow">Numero da venda</span>
          <strong>${safeText(saleLabel)}</strong>
          <p>${safeText(item.item_title || item.category_label || "Venda impactada")}</p>
        </div>
        <div class="rep-case-row__date">
          <span>Data da venda</span>
          <strong>${fmtDateOnly(saleDate)}</strong>
        </div>
        <div class="rep-case-row__date">
          <span>Data da ocorrência</span>
          <strong>${fmtDateOnly(item.created_at)}</strong>
        </div>
        <div class="rep-case-row__date">
          <span>Data de expiracao</span>
          <strong>${fmtDateOnly(removalDate)}</strong>
        </div>
        <div class="rep-case-row__status">
          ${link ? `<a href="${link}" target="_blank" rel="noopener noreferrer">Ver venda</a>` : '<span>Sem link</span>'}
        </div>
      </article>
    `;
  }).join("");
}

function openMetricCasesModal(filterKey = "claims") {
  LAST_MODAL_TRIGGER = document.activeElement;
  ACTIVE_IMPACT_FILTER = filterKey;
  updateImpactCardsState();
  renderMetricCases(filterKey);
  const modal = $("metric-cases-modal");
  if (!modal) return;
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("rep-modal-open");
  requestAnimationFrame(() => $("metric-cases-close")?.focus());
}

function closeMetricCasesModal() {
  const modal = $("metric-cases-modal");
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("rep-modal-open");
  if (LAST_MODAL_TRIGGER instanceof HTMLElement) LAST_MODAL_TRIGGER.focus();
  LAST_MODAL_TRIGGER = null;
}

function popularResumo(data) {
  const intelligence = data?.intelligence || {};
  const cards = intelligence.metrics || data?.seller?.metric_cards || {};
  const limits = data?.seller?.limits || {};
  LAST_METRIC_CARDS = cards || {};
  LAST_GOAL_CONTEXT.goals = data?.power_seller_goals || data?.seller?.power_seller_goals || {};
  $("seller-nickname").textContent = data?.seller?.nickname || intelligence?.header?.seller_nickname || "-";
  $("seller-id").textContent = data?.seller?.id || intelligence?.header?.seller_id || "-";
  $("rep-updated-at").textContent = formatUpdatedAt(intelligence.generated_at);

  renderSmartAlert(intelligence);
  paintImpactCard("claims", cards.claims, limits);
  paintImpactCard("mediations", cards.mediations, limits);
  paintImpactCard("cancellations", cards.cancellations, limits);
  paintImpactCard("delayed", cards.delayed, limits);
  renderTrends(intelligence.trends || cards);
  renderSalesWindow(data?.sales_window || data?.seller?.sales_window || {});

  const warnings = Array.isArray(data?.warnings) ? data.warnings.filter(Boolean) : [];
  if (warnings.length) showAlert(warnings.join(" | "));
  else hideAlert();
}
function lowerText(v) {
  return String(v || "").trim().toLowerCase();
}

function resolveImpactBucket(item = {}) {
  const direct = lowerText(
    item.impact_bucket || item.metric_bucket || item.impact_metric || item.case_group || item.metric_key || item.filter_key
  );

  if (direct.includes("mediation") || direct.includes("mediacao") || direct.includes("dispute")) return "mediations";
  if (direct.includes("cancel")) return "cancellations";
  if (direct.includes("delay") || direct.includes("dispatch") || direct.includes("handling") || direct.includes("atraso")) return "delayed";
  if (direct.includes("claim") || direct.includes("reclam")) return "claims";

  const kind = lowerText(item.case_kind || item.case_kind_label);
  const stage = lowerText(item.stage);
  const status = lowerText(item.status);
  const type = lowerText(item.type);
  const reason = lowerText(item.reason_id || item.category_label);

  if (kind.includes("cancel")) return "cancellations";
  if (stage.includes("dispute") || stage.includes("mediation") || stage.includes("mediacao")) return "mediations";
  if (stage.includes("cancellation") || status.includes("cancel") || type.includes("cancel")) return "cancellations";
  if (reason.includes("delay") || reason.includes("atraso")) return "delayed";
  return "claims";
}

function updateImpactCardsState() {
  document.querySelectorAll("[data-impact-filter]").forEach((card) => {
    const filter = card.dataset.impactFilter || "";
    const selected = !!ACTIVE_IMPACT_FILTER && filter === ACTIVE_IMPACT_FILTER;
    card.classList.toggle("is-selected", selected);
    card.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

async function carregarReputacao({ forceRefresh = false } = {}) {
  showLoading();

  try {
    const params = new URLSearchParams({
      page: "1",
      pageSize: "25",
    });
    if (forceRefresh) params.set("forceRefresh", "true");

    const response = await fetch(withBase(`/api/reputacao/overview?${params.toString()}`), {
      credentials: "include",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok || !data?.success) throw new Error(data?.error || `HTTP ${response.status}`);


    RAW_ALL_CASES = Array.isArray(data.all_cases) ? data.all_cases : [];
    RAW_CASES = RAW_ALL_CASES.length ? RAW_ALL_CASES : (Array.isArray(data.cases) ? data.cases : []);
    popularResumo(data);
  } catch (error) {
    showAlert(`Erro ao carregar reputacao: ${error.message}`, "error");
  } finally {
    hideLoading();
  }
}

function bindEvents() {
  $("btn-refresh")?.addEventListener("click", () => carregarReputacao({ forceRefresh: true }));
  $("rep-trend-tabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-trend-key]");
    if (!button) return;
    ACTIVE_TREND_KEY = button.dataset.trendKey || "claims";
    renderTrends(LAST_TRENDS);
  });
  document.querySelectorAll("[data-impact-filter]").forEach((card) => {
    const activate = () => openMetricCasesModal(card.dataset.impactFilter || "claims");
    card.addEventListener("click", activate);
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activate();
    });
  });
  document.querySelectorAll("[data-alert-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.alertAction || "";
      if (action === "claims") {
        openMetricCasesModal("claims");
      }
    });
  });
  document.querySelectorAll("[data-goal-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      ACTIVE_GOAL_TAB = button.dataset.goalTab || "sales";
      document.querySelectorAll("[data-goal-tab]").forEach((tab) => {
        tab.classList.toggle("is-active", tab === button);
      });
      renderSalesWindow(LAST_GOAL_CONTEXT.salesWindow || {});
    });
  });
  $("metric-cases-close")?.addEventListener("click", closeMetricCasesModal);
  window.addEventListener("click", (ev) => {
    if (ev.target === $("metric-cases-modal")) closeMetricCasesModal();
  });
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeMetricCasesModal();
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  updateImpactCardsState();
  await carregarContaAtual();
  await carregarReputacao();
});

