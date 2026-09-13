// public/js/ia-analytics-curva-abc.js
// UI da página Curva ABC (tempo real via API do ML) — NOVO PADRÃO (cookie meli_conta_id)
// ✅ não manda accounts no querystring
// ✅ defaults: últimos 7 dias (via body[data-default-days]) + métricas pesadas OFF
// ✅ toggles: Ads / Visitas / Promo
// ✅ export CSV respeita toggles (não força Ads/Visits ON)
// ✅ timeout com mensagem humana + evita 100% em falha
// ✅ bloqueia duplo clique no export

(() => {
  console.log("🚀 Curva ABC • ML tempo real");

  const qs = (s, el = document) => el.querySelector(s);
  const qsa = (s, el = document) => Array.from(el.querySelectorAll(s));
  const $ = (id) => document.getElementById(id);

  // Base path (/ml) support
  const BASE =
    (window.__APP_BASE_PATH || window.__ML_BASE_PATH || "").trim() ||
    (location.pathname.startsWith("/ml") ? "/ml" : "");
  const withBase = (p) => (p && p.startsWith("/") ? BASE + p : p);

  const fmtMoneyCents = (c) =>
    (Number(c || 0) / 100).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });

  const fmtPct = (x) =>
    `${(Number(x || 0) * 100).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}%`;

  // =========================================================
  // PROGRESS UI (barra lateral) — (mantida)
  // =========================================================
  function ensureProgressPanel() {
    let panel = $("reportProgressPanel");
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = "reportProgressPanel";
    panel.className = "abc-floating-panel abc-floating-panel--report";
    panel.innerHTML = `
      <div class="abc-floating-panel__head">
        <strong>Processando relatório</strong>
        <button type="button" id="rpClose" class="abc-floating-panel__close">Fechar</button>
      </div>
      <div class="abc-floating-panel__body">
        <div id="rpTitle" class="abc-floating-panel__msg">Iniciando…</div>
        <div class="abc-floating-panel__track">
          <div id="rpBar" class="abc-floating-panel__fill abc-floating-panel__fill--indigo"></div>
        </div>
        <div id="rpPct" class="abc-floating-panel__pct">0%</div>
        <div id="rpLog" class="abc-floating-panel__log"></div>
      </div>
    `;
    document.body.appendChild(panel);
    panel
      .querySelector("#rpClose")
      .addEventListener("click", () => hideProgress());
    return panel;
  }

  function showProgress(title) {
    const p = ensureProgressPanel();
    p.classList.add("is-open");
    qs("#rpTitle", p).textContent = title || "Processando…";
    qs("#rpBar", p).style.width = "0%";
    qs("#rpPct", p).textContent = "0%";
    qs("#rpLog", p).innerHTML = "";
  }
  function hideProgress() {
    const p = $("reportProgressPanel");
    if (p) p.classList.remove("is-open");
  }
  function logProgress(msg, type = "info") {
    const p = $("reportProgressPanel");
    if (!p) return;
    const el = document.createElement("div");
    el.textContent = msg;
    el.className = `abc-floating-panel__log-item abc-floating-panel__log-item--${type}`;
    qs("#rpLog", p).appendChild(el);
    qs("#rpLog", p).scrollTop = qs("#rpLog", p).scrollHeight;
  }
  function updateProgress(pct) {
    const p = $("reportProgressPanel");
    if (!p) return;
    const clamped = Math.max(0, Math.min(100, pct));
    qs("#rpBar", p).style.width = clamped + "%";
    qs("#rpPct", p).textContent = clamped.toFixed(0) + "%";
  }

  // =========================================================
  // Helpers
  // =========================================================
  function keepOnlySold(row) {
    return Number(row?.units || 0) > 0;
  }

  function isAbortError(err) {
    return (
      err && (err.name === "AbortError" || String(err).includes("AbortError"))
    );
  }

  function getAbortReason(signal) {
    try {
      return signal?.reason || null;
    } catch {
      return null;
    }
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
    const outerSignal = options.signal;
    const ctrl = new AbortController();

    let outerAbortHandler = null;
    if (outerSignal) {
      if (outerSignal.aborted) {
        ctrl.abort(getAbortReason(outerSignal) || "aborted");
      } else {
        outerAbortHandler = () =>
          ctrl.abort(getAbortReason(outerSignal) || "aborted");
        outerSignal.addEventListener("abort", outerAbortHandler, {
          once: true,
        });
      }
    }

    const timeoutId = setTimeout(() => {
      try {
        ctrl.abort("timeout");
      } catch {
        ctrl.abort();
      }
    }, timeoutMs);

    try {
      const r = await fetch(url, {
        ...options,
        signal: ctrl.signal,
        cache: "no-store",
      });
      return r;
    } catch (err) {
      if (isAbortError(err)) {
        const reason = getAbortReason(ctrl.signal);
        if (reason === "timeout") {
          throw new Error(
            `Tempo excedido (>${Math.round(timeoutMs / 1000)}s) ao consultar a API.`,
          );
        }
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      if (outerSignal && outerAbortHandler) {
        try {
          outerSignal.removeEventListener("abort", outerAbortHandler);
        } catch {}
      }
    }
  }

  function adsBadgeHTML(statusCode, statusText, hasActivity) {
    const cls =
      statusCode === "active"
        ? "ads-yes"
        : statusCode === "paused"
          ? "ads-paused"
          : "ads-no";

    const hint =
      statusCode === "active"
        ? hasActivity
          ? "Em campanha (com atividade no período)"
          : "Em campanha (sem atividade no período)"
        : statusCode === "paused"
          ? "Em campanha (pausado no período)"
          : hasActivity
            ? "Sem campanha (houve atividade registrada — verifique atribuição)"
            : "Sem campanha no período";

    return `<span class="ads-badge ${cls}" title="${hint}"><span class="dot"></span>${statusText}</span>`;
  }

  function clampInt(x, min, max, fallback) {
    const n = Number(x);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }

  function getDefaultDaysFromBody() {
    const raw = document.body?.dataset?.defaultDays;
    const n = clampInt(raw, 1, 365, 7);
    return n;
  }

  function toYMDLocal(d) {
    const x = new Date(d);
    const yyyy = x.getFullYear();
    const mm = String(x.getMonth() + 1).padStart(2, "0");
    const dd = String(x.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  const state = {
    curveTab: "ALL",
    loading: false,
    loadingCount: 0,
    loadingIndex: 0,
    loadingTimer: null,
    loadingTexts: [
      "Obtendo informações da Curva ABC...",
      "Consultando vendas e consolidando curvas...",
      "Carregando itens, visitas, promoções e ads...",
      "Preparando a tabela e os cards...",
    ],
    exporting: false,
    exportController: null,

    groupBy: "mlb",
    metric: "revenue",
    aCut: 0.75,
    bCut: 0.92,
    minUnits: 1,

    limit: 20,
    page: 1,
    sort: null,

    // ✅ métricas pesadas (OFF por padrão)
    includeAds: false,
    includeVisits: false,
    includePromos: false,

    lastItems: [],
    totals: null,
    curveCards: null,
    accountKey: null,
  };

  // =========================================================
  // Progress FAB (exportação)
  // =========================================================
  const progressFab = (() => {
    let el = null;

    function ensure() {
      if (el) return el;

      el = document.createElement("div");
      el.id = "progressFab";
      el.className = "abc-floating-panel abc-floating-panel--export";
      el.innerHTML = `
        <div class="abc-floating-panel__head">
          <div class="abc-floating-panel__title">Exportação</div>
          <button type="button" id="pfClose" class="abc-floating-panel__close">Fechar</button>
        </div>
        <div class="abc-floating-panel__body">
          <div id="pfMsg" class="abc-floating-panel__msg">Preparando…</div>
          <div class="abc-floating-panel__track">
            <div id="pfBar" class="abc-floating-panel__fill abc-floating-panel__fill--green"></div>
          </div>
          <div id="pfPct" class="abc-floating-panel__pct">0%</div>
          <div id="pfMeta" class="abc-floating-panel__meta"></div>
        </div>
      `;
      document.body.appendChild(el);

      el.querySelector("#pfClose").addEventListener("click", () => {
        el.classList.remove("is-open");
      });

      return el;
    }

    function show(msg = "Preparando…") {
      const p = ensure();
      p.classList.add("is-open");
      p.querySelector("#pfMsg").textContent = msg;
      p.querySelector("#pfBar").style.width = "0%";
      p.querySelector("#pfPct").textContent = "0%";
      p.querySelector("#pfMeta").textContent = "";
    }

    function message(msg) {
      const p = ensure();
      p.querySelector("#pfMsg").textContent = msg;
    }

    function progress(cur, total, opts = {}) {
      const p = ensure();
      const pct = total > 0 ? Math.round((cur / total) * 100) : 0;
      const safePct = Math.max(0, Math.min(100, pct));
      p.querySelector("#pfBar").style.width = `${safePct}%`;
      p.querySelector("#pfPct").textContent = `${safePct}%`;

      const metaBits = [];
      metaBits.push(`Ads: ${opts.withAds ? "ON" : "OFF"}`);
      metaBits.push(`Visits: ${opts.withVisits ? "ON" : "OFF"}`);
      metaBits.push(`Promo: ${opts.withPromos ? "ON" : "OFF"}`);
      if (opts.limit) metaBits.push(`limit=${opts.limit}`);

      p.querySelector("#pfMeta").textContent = metaBits.join(" • ");
    }

    function doneOk() {
      const p = ensure();
      p.querySelector("#pfBar").style.width = "100%";
      p.querySelector("#pfPct").textContent = "100%";
      p.querySelector("#pfMsg").textContent = "Concluído ✅";
    }

    function doneFail(msg) {
      const p = ensure();
      p.querySelector("#pfMsg").textContent = msg || "Falhou ❌";
    }

    return { show, message, progress, doneOk, doneFail };
  })();

  // =========================================================
  // Topbar / Account
  // =========================================================
  async function initTopBar() {
    try {
      const r = await fetch("/api/account/current", {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const j = await r.json().catch(() => null);
      state.accountKey = j?.accountKey || j?.current?.id || null;
      const shown = j?.label || j?.accountKey || j?.current?.label || "—";
      const el = $("account-current");
      if (el) el.textContent = shown;
    } catch {
      // silencioso
    }

    const btnSwitch = $("account-switch");
    if (btnSwitch) {
      btnSwitch.addEventListener("click", async () => {
        try {
          await fetch("/api/account/clear", {
            method: "POST",
            credentials: "include",
          });
        } catch {}
        location.href = withBase("/select-conta");
      });
    }

    const btnStatus = $("btn-status");
    if (btnStatus) {
      btnStatus.addEventListener("click", async () => {
        try {
          const r = await fetch("/api/tokens/verificar-token", {
            credentials: "include",
            cache: "no-store",
          });
          const d = await r.json();
          alert(
            d.success
              ? `✅ ${d.message}\nUser: ${d.nickname}`
              : `❌ ${d.error || "Falha ao verificar"}`,
          );
        } catch (e) {
          alert("❌ " + (e?.message || e));
        }
      });
    }
  }

  // ✅ agora usa o data-default-days do <body>, padrão 7
  function setDefaultDates() {
    const days = getDefaultDaysFromBody(); // ex: 7
    const to = new Date();
    const from = new Date(to);
    from.setDate(to.getDate() - (days - 1));

    const f1 = $("fDateFrom");
    const f2 = $("fDateTo");
    if (f1) f1.value = toYMDLocal(from);
    if (f2) f2.value = toYMDLocal(to);

    const hint = $("dateDefaultHint");
    if (hint)
      hint.textContent = `Padrão: últimos ${days} dias (carrega mais rápido)`;
  }

  async function ensureCurrentAccountContext() {
    const r = await fetch("/api/account/current", {
      credentials: "include",
      cache: "no-store",
    });

    if (!r.ok) {
      location.href = withBase("/select-conta");
      return;
    }

    const j = await r.json().catch(() => null);
    const key = j?.accountKey || j?.current?.id || null;

    if (!key) {
      location.href = withBase("/select-conta");
      return null;
    }

    state.accountKey = key;
    return key;
  }

  // =========================================================
  // Filters (✅ sem accounts)
  // =========================================================
  function getFilters(extra = {}) {
    const base = {
      date_from: $("fDateFrom")?.value,
      date_to: $("fDateTo")?.value,
      full: $("fFull")?.value || "all",
      metric: state.metric,
      group_by: state.groupBy,
      a_cut: state.aCut,
      b_cut: state.bCut,
      min_units: state.minUnits,
      limit: state.limit,
      page: state.page,
    };

    if (state.sort) base.sort = state.sort;
    return Object.assign(base, extra);
  }

  // =========================================================
  // Loading overlay
  // =========================================================
  function setLoading(on) {
    if (on) {
      state.loadingCount += 1;
      state.loading = true;
      state.loadingIndex = 0;
      if (state.loadingCount === 1) {
        window.MLLoadingOverlay?.show({
          context: "Curva ABC",
          label: "Loading...",
          texts: state.loadingTexts,
          message: state.loadingTexts[0],
          initialProgress: 18,
          maxProgress: 92,
        });
      } else {
        window.MLLoadingOverlay?.update({
          message: state.loadingTexts[0],
        });
      }
      if (!state.loadingTimer) {
        state.loadingTimer = setInterval(() => {
          state.loadingIndex =
            (state.loadingIndex + 1) % state.loadingTexts.length;
          window.MLLoadingOverlay?.update({
            message: state.loadingTexts[state.loadingIndex],
          });
        }, 2600);
      }
      return;
    }

    state.loadingCount = Math.max(0, state.loadingCount - 1);
    if (state.loadingCount > 0) return;

    state.loading = false;
    window.MLLoadingOverlay?.hide();
    clearInterval(state.loadingTimer);
    state.loadingTimer = null;
  }

  // =========================================================
  // Cards / UI
  // =========================================================
  function renderMiniCards() {
    const cc = state.curveCards || {};
    const T = state.totals || {};

    const fill = (pref, data) => {
      if (!data) return;
      const units = Number(data.units || data.units_total || 0);
      const revCts = Number(
        data.revenue_cents || data.revenue_cents_total || 0,
      );
      const items = Number(data.items_count ?? data.count_items ?? 0);
      const ticket = Number(
        data.ticket_avg_cents ?? (units > 0 ? Math.round(revCts / units) : 0),
      );
      const rShare = Number(data.revenue_share ?? data.share ?? 0);

      $(`k${pref}_units`).textContent = units.toLocaleString("pt-BR");
      $(`k${pref}_value`).textContent = fmtMoneyCents(revCts);
      $(`k${pref}_items`).textContent = items.toLocaleString("pt-BR");
      $(`k${pref}_ticket`).textContent = fmtMoneyCents(ticket);
      $(`k${pref}_share`).textContent = fmtPct(rShare);
    };

    fill("A", cc.A);
    fill("B", cc.B);
    fill("C", cc.C);

    const tUnits = Number(T.units_total || 0);
    const tRev = Number(T.revenue_cents_total || 0);
    $("kT_units").textContent = tUnits.toLocaleString("pt-BR");
    $("kT_value").textContent = fmtMoneyCents(tRev);
    $("kT_items").textContent = Number(T.items_total || 0).toLocaleString(
      "pt-BR",
    );
    $("kT_ticket").textContent = fmtMoneyCents(
      tUnits > 0 ? Math.round(tRev / tUnits) : 0,
    );
  }

  function renderCardsMeta(curves) {
    const safe = (obj) => obj || { share: 0, count_items: 0 };
    const A = safe(curves?.A),
      B = safe(curves?.B),
      C = safe(curves?.C);
    const aEl = $("cardAmeta");
    const bEl = $("cardBmeta");
    const cEl = $("cardCmeta");
    if (aEl)
      aEl.textContent = `${(A.share * 100).toFixed(1)}% • ${A.count_items} itens`;
    if (bEl)
      bEl.textContent = `${(B.share * 100).toFixed(1)}% • ${B.count_items} itens`;
    if (cEl)
      cEl.textContent = `${(C.share * 100).toFixed(1)}% • ${C.count_items} itens`;
  }

  function fillUL(id, arr) {
    const ul = $(id);
    if (!ul) return;
    ul.innerHTML = "";
    const items = Array.isArray(arr) ? arr : [];
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "abc-top-empty";
      li.innerHTML = `<span class="muted">Nenhum item nesta curva no período.</span>`;
      ul.appendChild(li);
      return;
    }
    items.forEach((i) => {
      const li = document.createElement("li");
      const identity = [i.mlb, i.sku].filter(Boolean).join(" • ");
      const title = String(i.title || "").trim();
      li.innerHTML = `
        <span class="abc-top-item">
          <span class="abc-top-item__title">${title || identity || "Item"}</span>
          <span class="muted">${identity}</span>
        </span>
        <span class="abc-top-item__metric"><b>${Number(i.units || 0).toLocaleString("pt-BR")}</b> un. • ${fmtMoneyCents(i.revenue_cents || 0)}</span>
      `;
      ul.appendChild(li);
    });
  }

  // =========================================================
  // API calls
  // =========================================================
  async function loadSummary() {
    setLoading(true);
    try {
      const params = new URLSearchParams(getFilters()).toString();
      const r = await fetch(`/api/analytics/abc-ml/summary?${params}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(
          `summary HTTP ${r.status} ${t ? "• " + t.slice(0, 180) : ""}`,
        );
      }
      const j = await r.json();

      state.totals = j.totals || null;
      state.curveCards = j.curve_cards || null;

      renderMiniCards();
      renderCardsMeta(j.curves);
      fillUL("listA", j.top5?.A);
      fillUL("listB", j.top5?.B);
      fillUL("listC", j.top5?.C);
    } catch (e) {
      console.error(e);
      alert("❌ Falha ao carregar resumo da Curva ABC.\n" + (e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  function setSelection(tag) {
    qsa(".abc-kpi-card").forEach((c) => c.classList.remove("selected"));
    if (tag === "TOTAL") {
      const t = $("cardTotal");
      t && t.classList.add("selected");
    } else if (tag === "A" || tag === "B" || tag === "C") {
      const el = qs(`.abc-kpi-card[data-curve="${tag}"]`);
      el && el.classList.add("selected");
    }
  }

  function renderTable(rows, page, total, limit) {
    state.lastItems = Array.isArray(rows) ? rows : [];
    state.page = page;

    const tb = qs("#grid tbody");
    if (!tb) return;
    tb.innerHTML = "";

    const T = state.totals || {};
    const uTotal = Number(T.units_total || 0);
    const rTotal = Number(T.revenue_cents_total || 0);

    state.lastItems.forEach((r, idx) => {
      try {
        const curve = r.curve || "-";
        const pillClass = curve ? `idx-${curve}` : "";

        const unitShare =
          typeof r.unit_share === "number"
            ? r.unit_share
            : uTotal > 0
              ? (r.units || 0) / uTotal
              : 0;

        const revShare =
          typeof r.revenue_share === "number"
            ? r.revenue_share
            : rTotal > 0
              ? (r.revenue_cents || 0) / rTotal
              : 0;

        // PROMO: se toggle OFF, mostra "—" pra não confundir (não é "Não", é "não consultado")
        const promoActive = !!(r.promo && r.promo.active);
        const promoPct =
          r.promo && r.promo.percent != null ? Number(r.promo.percent) : null;

        const promoTxt = state.includePromos
          ? promoActive
            ? "Sim"
            : "Não"
          : "—";
        const promoPctTxt =
          state.includePromos && promoActive && promoPct != null
            ? fmtPct(promoPct)
            : "—";

        const ads = r.ads || {};
        const statusCode =
          ads.status_code || (ads.in_campaign ? "active" : "none");
        const statusText =
          ads.status_text || (ads.in_campaign ? "Ativo" : "Não");

        const clicks = state.includeAds ? Number(ads.clicks || 0) : 0;
        const imps = state.includeAds ? Number(ads.impressions || 0) : 0;
        const spendC = state.includeAds ? Number(ads.spend_cents || 0) : 0;
        const aRevC = state.includeAds ? Number(ads.revenue_cents || 0) : 0;

        const hasActivity =
          state.includeAds &&
          (!!ads.had_activity || clicks + imps + spendC + aRevC > 0);

        const acosVal = aRevC > 0 ? spendC / aRevC : null;

        // VISITS: se toggle OFF, mostra "—"
        const visitsRaw = Number(r.visits || r.visits_total || 0);
        const visits = state.includeVisits ? visitsRaw : null;
        const conv =
          state.includeVisits && visitsRaw > 0
            ? Number(r.units || 0) / visitsRaw
            : null;

        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><span class="idx-pill ${pillClass}">${curve}</span></td>
          <td>${r.mlb || ""}</td>
          <td>${r.title || ""}</td>

          <td>${(r.units || 0).toLocaleString("pt-BR")}</td>
          <td class="percent">${fmtPct(unitShare)}</td>

          <td class="num">${fmtMoneyCents(r.revenue_cents || 0)}</td>
          <td class="percent">${fmtPct(revShare)}</td>

          <td class="promo">${promoTxt}</td>
          <td class="percent">${promoPctTxt}</td>

          <td>${state.includeAds ? adsBadgeHTML(statusCode, statusText, hasActivity) : `<span class="ads-badge ads-no" title="Ads desligado">—</span>`}</td>
          <td class="num">${state.includeAds ? clicks.toLocaleString("pt-BR") : "—"}</td>
          <td class="num">${state.includeAds ? imps.toLocaleString("pt-BR") : "—"}</td>

          <td class="num">${visits == null ? "—" : visits.toLocaleString("pt-BR")}</td>
          <td class="percent">${conv != null ? fmtPct(conv) : "—"}</td>

          <td class="num">${state.includeAds ? fmtMoneyCents(spendC) : "—"}</td>
          <td class="percent">${state.includeAds && hasActivity && acosVal !== null ? fmtPct(acosVal) : "—"}</td>
          <td class="num">${state.includeAds ? fmtMoneyCents(aRevC) : "—"}</td>
        `;
        tb.appendChild(tr);
      } catch (rowErr) {
        console.error("Falha ao renderizar linha", idx, rowErr, r);
      }
    });

    renderPagination(page, total, limit);
  }

  async function loadItems(curve = state.curveTab || "ALL", page = 1) {
    setLoading(true);
    try {
      state.curveTab = curve;
      state.page = page;

      if (curve === "ALL" && state.sort === "share") {
        setSelection("TOTAL");
      } else if (curve === "ALL") {
        qsa(".abc-kpi-card").forEach((c) => c.classList.remove("selected"));
      } else {
        setSelection(curve);
      }

      // ✅ respeita toggles
      const base = getFilters({
        curve,
        page,
        limit: state.limit,
        include_ads: state.includeAds ? "1" : "0",
        include_visits: state.includeVisits ? "1" : "0",
        include_promos: state.includePromos ? "1" : "0",
      });

      const s = $("fSearch")?.value?.trim();
      if (s) base.search = s;

      const params = new URLSearchParams(base).toString();
      const url = `/api/analytics/abc-ml/items?${params}`;

      const resp = await fetchWithTimeout(
        url,
        { credentials: "same-origin" },
        90000,
      );
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(
          `items HTTP ${resp.status} ${t ? "• " + t.slice(0, 180) : ""}`,
        );
      }
      const j = await resp.json();

      if (!j || !Array.isArray(j.data)) {
        console.warn("Resposta inesperada de /items", j);
        renderTable(
          [],
          j?.page || page,
          j?.total || 0,
          j?.limit || state.limit,
        );
        return;
      }

      let rows = j.data.slice();
      rows = rows.filter(keepOnlySold);

      if (state.sort === "share") {
        const T = state.totals || {};
        const rTotal = Number(T.revenue_cents_total || 0);
        rows = rows
          .map((it) => {
            const share =
              typeof it.revenue_share === "number"
                ? it.revenue_share
                : rTotal > 0
                  ? (it.revenue_cents || 0) / rTotal
                  : 0;
            return { ...it, __share__: share };
          })
          .sort((a, b) => b.__share__ - a.__share__);
      } else if (state.metric === "revenue") {
        rows.sort((a, b) => (b.revenue_cents || 0) - (a.revenue_cents || 0));
      } else {
        rows.sort((a, b) => (b.units || 0) - (a.units || 0));
      }

      renderTable(
        rows,
        j.page || page,
        j.total ?? rows.length,
        j.limit || state.limit,
      );
    } catch (e) {
      console.error(e);
      alert("❌ Falha ao carregar itens da Curva ABC:\n" + (e?.message || e));
      renderTable([], page, 0, state.limit);
    } finally {
      setLoading(false);
    }
  }

  // =========================================================
  // Pagination
  // =========================================================
  function renderPagination(page, total, limit) {
    const pager = $("pager");
    if (!pager) return;

    const totalPages = Math.max(1, Math.ceil((total || 0) / (limit || 20)));

    const mkBtn = (p, label = null, disabled = false, active = false) => {
      const b = document.createElement("button");
      b.className =
        "pg-btn" + (active ? " active" : "") + (disabled ? " disabled" : "");
      b.textContent = label || String(p);
      b.disabled = !!disabled;
      if (!disabled && !active) b.addEventListener("click", () => goToPage(p));
      return b;
    };

    pager.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "paginator";

    wrap.appendChild(mkBtn(Math.max(1, page - 1), "«", page <= 1));

    const windowSize = 2;
    const addPage = (p) =>
      wrap.appendChild(mkBtn(p, String(p), false, p === page));
    const addDots = () => {
      const sp = document.createElement("span");
      sp.textContent = "…";
      sp.className = "pager-dots";
      wrap.appendChild(sp);
    };

    if (totalPages <= 9) {
      for (let p = 1; p <= totalPages; p++) addPage(p);
    } else {
      addPage(1);
      if (page > 1 + windowSize + 1) addDots();

      const start = Math.max(2, page - windowSize);
      const end = Math.min(totalPages - 1, page + windowSize);
      for (let p = start; p <= end; p++) addPage(p);

      if (page < totalPages - (windowSize + 1)) addDots();
      addPage(totalPages);
    }

    wrap.appendChild(
      mkBtn(Math.min(totalPages, page + 1), "»", page >= totalPages),
    );
    pager.appendChild(wrap);
  }

  function goToPage(p) {
    const curve = state.curveTab || "ALL";
    loadItems(curve, p);
  }

  // =========================================================
  // UI bindings
  // =========================================================
  function debounce(fn, ms = 300) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  function applySwitchDefaults() {
    qsa("#switch-groupby .btn-switch").forEach((b) =>
      b.classList.toggle("active", b.dataset.group === state.groupBy),
    );
    qsa("#switch-metric  .btn-switch").forEach((b) =>
      b.classList.toggle("active", b.dataset.metric === state.metric),
    );
  }

  function setToggleBtn(btn, on) {
    if (!btn) return;
    btn.classList.toggle("active", !!on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.dataset.on = on ? "1" : "0";
  }

  function bindExtraToggles() {
    const bAds = $("btnIncludeAds");
    const bVisits = $("btnIncludeVisits");
    const bPromos = $("btnIncludePromos");

    // sync inicial (OFF por padrão)
    setToggleBtn(bAds, state.includeAds);
    setToggleBtn(bVisits, state.includeVisits);
    setToggleBtn(bPromos, state.includePromos);

    const toggle = (key, btn) => {
      if (!btn) return;
      btn.addEventListener("click", () => {
        state[key] = !state[key];
        setToggleBtn(btn, state[key]);
      });
    };

    toggle("includeAds", bAds);
    toggle("includeVisits", bVisits);
    toggle("includePromos", bPromos);
  }

  function bind() {
    const btnPesquisar = $("btnPesquisar");
    if (btnPesquisar) {
      btnPesquisar.addEventListener("click", async () => {
        state.page = 1;
        await Promise.all([loadSummary(), loadItems("ALL", 1)]);
      });
    }

    qsa(".abc-kpi-card[data-curve]").forEach((el) => {
      el.addEventListener("click", () => {
        const curve = el.getAttribute("data-curve") || "ALL";
        state.sort = null;
        state.page = 1;
        loadItems(curve, 1);
      });
    });

    const totalCard = $("cardTotal");
    if (totalCard) {
      totalCard.addEventListener("click", () => {
        const fSearch = $("fSearch");
        if (fSearch) fSearch.value = "";
        state.sort = "share";
        state.page = 1;
        loadItems("ALL", 1);
      });
    }

    qsa("#switch-groupby .btn-switch").forEach((btn) => {
      btn.addEventListener("click", () => {
        qsa("#switch-groupby .btn-switch").forEach((b) =>
          b.classList.remove("active"),
        );
        btn.classList.add("active");
        state.groupBy = btn.dataset.group || "mlb";
        state.page = 1;
        loadSummary();
        loadItems(state.curveTab || "ALL", 1);
      });
    });

    qsa("#switch-metric .btn-switch").forEach((btn) => {
      btn.addEventListener("click", () => {
        qsa("#switch-metric .btn-switch").forEach((b) =>
          b.classList.remove("active"),
        );
        btn.classList.add("active");
        state.metric = btn.dataset.metric || "revenue";
        state.page = 1;
        loadSummary();
        loadItems(state.curveTab || "ALL", 1);
      });
    });

    const fSearch = $("fSearch");
    if (fSearch) {
      fSearch.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          state.page = 1;
          loadItems("ALL", 1);
        }
      });
      fSearch.addEventListener(
        "input",
        debounce(() => {
          state.page = 1;
          loadItems(state.curveTab || "ALL", 1);
        }, 500),
      );
    }

    const fFull = $("fFull");
    if (fFull) {
      fFull.addEventListener("change", () => {
        state.page = 1;
        loadSummary();
        loadItems(state.curveTab || "ALL", 1);
      });
    }
  }

  // =========================================================
  // CSV Export
  // =========================================================
  async function fetchAllPages(onProgress, opts = {}) {
    const limit = Math.max(20, Math.min(Number(opts.limit || 120), 200));
    const timeoutMs = Number(opts.timeoutMs || 180000);
    const withAds = opts.withAds === true;
    const withVisits = opts.withVisits === true;
    const withPromos = opts.withPromos === true;
    const signal = opts.signal;

    const base = getFilters({
      curve: "ALL",
      page: 1,
      limit,
      include_ads: withAds ? "1" : "0",
      include_visits: withVisits ? "1" : "0",
      include_promos: withPromos ? "1" : "0",
    });

    const s = $("fSearch")?.value?.trim();
    if (s) base.search = s;

    const p1Url = `/api/analytics/abc-ml/items?${new URLSearchParams(base).toString()}`;
    const r1 = await fetchWithTimeout(
      p1Url,
      { credentials: "same-origin", signal },
      timeoutMs,
    );

    if (!r1.ok) {
      const t = await r1.text().catch(() => "");
      throw new Error(
        `Export: items HTTP ${r1.status} ${t ? "• " + t.slice(0, 180) : ""}`,
      );
    }
    const j1 = await r1.json();

    const total = Number(j1?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    let all = Array.isArray(j1?.data) ? j1.data.slice() : [];
    if (typeof onProgress === "function")
      onProgress(1, totalPages, { withAds, withVisits, withPromos, limit });

    for (let p = 2; p <= totalPages; p++) {
      const url = `/api/analytics/abc-ml/items?${new URLSearchParams({
        ...base,
        page: p,
      }).toString()}`;

      const r = await fetchWithTimeout(
        url,
        { credentials: "same-origin", signal },
        timeoutMs,
      );
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(
          `Export: page ${p} HTTP ${r.status} ${t ? "• " + t.slice(0, 180) : ""}`,
        );
      }
      const j = await r.json();
      const arr = Array.isArray(j?.data) ? j.data : [];
      all.push(...arr);

      if (typeof onProgress === "function")
        onProgress(p, totalPages, { withAds, withVisits, withPromos, limit });
    }

    return all;
  }

  function setExportButtonState(isExporting) {
    const btn = $("btnExportCsv");
    if (!btn) return;
    btn.disabled = !!isExporting;
    btn.setAttribute("aria-busy", isExporting ? "true" : "false");
    btn.textContent = isExporting ? "Exportando…" : "Exportar CSV";
  }

  async function exportCSV() {
    if (state.exporting) return;
    state.exporting = true;
    setExportButtonState(true);

    state.exportController = new AbortController();

    try {
      // Export usa painel lateral de progresso; evita bloquear a tela inteira.
      progressFab.show("Carregando dados para exportação…");
      hideProgress();

      // ✅ export respeita toggles do usuário
      const withAds = !!state.includeAds;
      const withVisits = !!state.includeVisits;
      const withPromos = !!state.includePromos;

      const allRows = await fetchAllPages(
        (page, totalPages, opts) => {
          progressFab.progress(page, totalPages, opts);
          progressFab.message(`Carregando dados… Página ${page}/${totalPages}`);
        },
        {
          limit: 120,
          withAds,
          withVisits,
          withPromos,
          timeoutMs: 180000,
          signal: state.exportController.signal,
        },
      );

      progressFab.message("Gerando CSV…");

      let rowsForCsv = allRows.slice();

      if (state.sort === "share" || state.metric === "revenue") {
        rowsForCsv.sort(
          (a, b) => (b.revenue_cents || 0) - (a.revenue_cents || 0),
        );
      } else {
        rowsForCsv.sort((a, b) => (b.units || 0) - (a.units || 0));
      }

      const rowsFiltered = rowsForCsv.filter((r) => Number(r.units || 0) > 0);

      const uTotal = rowsFiltered.reduce((s, r) => s + (r.units || 0), 0);
      const rTotal = rowsFiltered.reduce(
        (s, r) => s + (r.revenue_cents || 0),
        0,
      );

      const head = [
        "Índice",
        "MLB",
        "Título",
        "Unidades",
        "Unid. (%)",
        "Valor",
        "FATURAMENTO %",

        "PROMO",
        "% APLICADA",

        "ADS",
        "Cliq.",
        "Impr.",

        "Visit.",
        "Conv.",

        "Invest.",
        "ACOS",
        "Receita Ads",

        "Vendas 7D",
        "Vendas 15D",
        "Vendas 30D",
        "Vendas 40D",
        "Vendas 60D",
        "Vendas 90D",
      ];

      const csvRows = rowsFiltered.map((r) => {
        const unitShare = uTotal > 0 ? (r.units || 0) / uTotal : 0;
        const revShare = rTotal > 0 ? (r.revenue_cents || 0) / rTotal : 0;

        // promo
        const promoActive = !!(r.promo && r.promo.active);
        const promoPct =
          r.promo && r.promo.percent != null ? Number(r.promo.percent) : null;
        const promoTxt = withPromos ? (promoActive ? "Sim" : "Não") : "—";
        const promoPctCsv =
          withPromos && promoActive && promoPct != null
            ? (promoPct * 100).toFixed(2).replace(".", ",") + "%"
            : "—";

        // ads
        const ads = r.ads || {};
        const clicks = withAds ? Number(ads.clicks || 0) : null;
        const imps = withAds ? Number(ads.impressions || 0) : null;
        const spendC = withAds ? Number(ads.spend_cents || 0) : null;
        const aRevC = withAds ? Number(ads.revenue_cents || 0) : null;

        const acosVal =
          withAds && aRevC != null && aRevC > 0 && spendC != null
            ? spendC / aRevC
            : null;

        const statusText = withAds
          ? ads.status_text || (ads.in_campaign ? "Ativo" : "Não")
          : "—";

        // visits
        const visits = withVisits
          ? Number(r.visits || r.visits_total || 0)
          : null;
        const conv =
          withVisits && visits != null && visits > 0
            ? Number(r.units || 0) / visits
            : null;

        return [
          r.curve || "-",
          r.mlb || "",
          (r.title || "").replace(/"/g, '""'),

          r.units || 0,
          (unitShare * 100).toFixed(2).replace(".", ",") + "%",
          (Number(r.revenue_cents || 0) / 100).toFixed(2).replace(".", ","),
          (revShare * 100).toFixed(2).replace(".", ",") + "%",

          promoTxt,
          promoPctCsv,

          statusText,
          clicks == null ? "—" : clicks,
          imps == null ? "—" : imps,

          visits == null ? "—" : visits,
          conv != null ? (conv * 100).toFixed(2).replace(".", ",") + "%" : "—",

          spendC == null ? "—" : (spendC / 100).toFixed(2).replace(".", ","),
          acosVal !== null
            ? (acosVal * 100).toFixed(2).replace(".", ",") + "%"
            : "—",
          aRevC == null ? "—" : (aRevC / 100).toFixed(2).replace(".", ","),

          Number(r.units_7d || 0),
          Number(r.units_15d || 0),
          Number(r.units_30d || 0),
          Number(r.units_40d || 0),
          Number(r.units_60d || 0),
          Number(r.units_90d || 0),
        ];
      });

      const data = [head, ...csvRows]
        .map((cols) => cols.map((c) => `"${String(c)}"`).join(";"))
        .join("\r\n");

      const blob = new Blob([data], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = "curva_abc.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);

      progressFab.message("Concluído!");
      progressFab.doneOk();
    } catch (e) {
      console.error(e);

      if (isAbortError(e)) {
        progressFab.doneFail("Exportação cancelada.");
        return;
      }

      progressFab.doneFail("Falha ❌ " + (e?.message || e));
      alert("❌ Falha ao exportar CSV: " + (e?.message || e));
    } finally {
      state.exporting = false;
      setExportButtonState(false);
      state.exportController = null;
    }
  }

  function bindExportCsvButton() {
    const btn = $("btnExportCsv");
    if (!btn) {
      console.warn("⚠️ btnExportCsv não encontrado no DOM.");
      return;
    }
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      exportCSV();
    });
  }

  // =========================================================
  // Boot
  // =========================================================
  window.addEventListener("DOMContentLoaded", async () => {
    await initTopBar();
    setDefaultDates();
    await ensureCurrentAccountContext();

    applySwitchDefaults();
    bindExtraToggles(); // ✅ NOVO

    bind();
    bindExportCsvButton();

    await loadSummary();
    await loadItems("ALL", 1);
  });
})();
