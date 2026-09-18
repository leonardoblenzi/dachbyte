"use strict";

(() => {
  const status = document.querySelector("[data-multichannel-status]");
  if (!status) return;
  const state = { range: 30, data: null };
  const targetForm = document.querySelector("[data-target-form]");
  const mappingHost = document.querySelector("[data-meta-conversion-mappings]");

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    return payload;
  }
  function setStatus(text, tone = "info") { status.textContent = text; status.className = `ads-alert ads-alert--${tone}`; }
  function money(value, currency = "BRL") {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    try { return new Intl.NumberFormat("pt-BR", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(value)); }
    catch { return Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 }); }
  }
  function number(value, digits = 2) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    return Number(value).toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function ratio(value) { return value === null || value === undefined ? "—" : `${number(value, 2)}x`; }
  function date(value) {
    if (!value) return "—";
    const [y,m,d] = String(value).slice(0,10).split("-"); return y && m && d ? `${d}/${m}/${y}` : value;
  }
  function parseLocaleNumber(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
    const parsed = Number(normalized); return Number.isFinite(parsed) ? parsed : null;
  }
  function fillTargetForm(targets) {
    if (!targetForm) return;
    const set = (name, value) => { const field = targetForm.elements.namedItem(name); if (field) field.value = value === null || value === undefined ? "" : String(value).replace(".", ","); };
    set("monthlyBudget", targets?.monthlyBudget); set("targetCpa", targets?.targetCpa); set("targetRoas", targets?.targetRoas);
    set("averageTicket", targets?.averageTicket); set("grossMarginPercent", targets?.grossMarginPercent);
    set("currencyCode", targets?.currencyCode || "BRL"); set("notes", targets?.notes || "");
  }
  function channelCurrency(channel, fallback) { return channel?.currencyCode || fallback || "BRL"; }
  function renderChannel(provider, channel, fallbackCurrency) {
    const prefix = provider === "google_ads" ? "google" : "meta";
    const current = channel?.summary?.current;
    const currency = channelCurrency(channel, fallbackCurrency);
    const values = {
      spend: current ? money(current.spend, currency) : "—",
      conversions: current ? number(current.conversions, 2) : "—",
      cpa: current ? money(current.cpa, currency) : "—",
      roas: current ? ratio(current.roas) : "—",
      frequency: current ? number(current.frequency, 2) : "—",
    };
    document.querySelectorAll(`[data-multi-${prefix}]`).forEach((node) => { node.textContent = values[node.dataset[`multi${prefix[0].toUpperCase()}${prefix.slice(1)}`]] || "—"; });
    // Dataset camelCase differs by browser for data-multi-google="spend"; set directly as a fallback.
    document.querySelectorAll(`[data-multi-${prefix}]`).forEach((node) => { const key = node.getAttribute(`data-multi-${prefix}`); node.textContent = values[key] || "—"; });
  }
  function groupActions(rows) {
    const groups = new Map();
    for (const row of rows || []) {
      if (!groups.has(row.ad_account_id)) groups.set(row.ad_account_id, { accountId: row.ad_account_id, accountName: row.account_name || row.external_account_id, rows: [] });
      groups.get(row.ad_account_id).rows.push(row);
    }
    return [...groups.values()];
  }
  function semanticGuess(sourceKey) {
    const key = String(sourceKey || "").toLowerCase();
    if (key.includes("purchase")) return "purchase";
    if (key.includes("lead")) return "lead";
    if (key.includes("message")) return "message";
    if (key.includes("appointment") || key.includes("schedule")) return "appointment";
    if (key.includes("call")) return "call";
    return "custom";
  }
  function renderMappings(data) {
    if (!mappingHost) return;
    mappingHost.replaceChildren();
    const groups = groupActions(data.actionTypes);
    if (!groups.length) {
      const empty = document.createElement("div"); empty.className = "ads-loading-row"; empty.textContent = "Nenhuma action Meta sincronizada ainda."; mappingHost.append(empty); return;
    }
    groups.forEach((group) => {
      const card = document.createElement("div"); card.className = "ads-meta-mapping-card";
      const title = document.createElement("strong"); title.textContent = group.accountName || "Conta Meta";
      const select = document.createElement("select"); select.className = "ads-compact-select";
      const none = document.createElement("option"); none.value = ""; none.textContent = "Selecionar action principal"; select.append(none);
      group.rows.forEach((row) => {
        const option = document.createElement("option"); option.value = row.action_type; option.textContent = `${row.action_type} · ${number(row.action_count, 0)}`; option.selected = row.is_primary === true; select.append(option);
      });
      const semantic = document.createElement("select"); semantic.className = "ads-compact-select";
      [["lead","Lead"],["purchase","Compra"],["message","Mensagem"],["appointment","Agendamento"],["call","Ligação"],["custom","Outro"]].forEach(([value,label]) => {
        const option = document.createElement("option"); option.value = value; option.textContent = label; semantic.append(option);
      });
      const primary = group.rows.find((row) => row.is_primary === true);
      semantic.value = primary?.semantic_type || semanticGuess(select.value);
      select.addEventListener("change", () => { if (!primary || select.value !== primary.action_type) semantic.value = semanticGuess(select.value); });
      const button = document.createElement("button"); button.type = "button"; button.className = "ads-secondary-button"; button.textContent = "Salvar";
      const feedback = document.createElement("small"); feedback.className = "ads-muted-copy";
      button.addEventListener("click", async () => {
        button.disabled = true; feedback.textContent = "Salvando…";
        try {
          await request(`/ads/api/intelligence/meta/accounts/${encodeURIComponent(group.accountId)}/primary-conversion`, {
            method: "PUT", body: JSON.stringify({ sourceKey: select.value || null, semanticType: semantic.value, label: select.value || null }),
          });
          feedback.textContent = "Salvo"; await load();
        } catch (error) { feedback.textContent = error.message; }
        finally { button.disabled = false; }
      });
      const controls = document.createElement("div"); controls.className = "ads-meta-mapping-card__controls"; controls.append(select, semantic, button);
      card.append(title, controls, feedback); mappingHost.append(card);
    });
  }
  function render(data) {
    state.data = data; fillTargetForm(data.targets); renderMappings(data);
    if (!data.available) { setStatus(data.reason === "no_synced_metrics" ? "Contas conectadas, mas ainda sem métricas sincronizadas." : "Selecione pelo menos uma conta Google ou Meta para sincronização.", "warning"); return; }
    const combined = document.querySelector("[data-multi-combined-spend]");
    if (combined) combined.textContent = data.combined?.currencyMismatch ? "Moedas diferentes" : money(data.combined?.spend, data.combined?.currencyCode || data.targets?.currencyCode || "BRL");
    const period = document.querySelector("[data-multi-period]"); if (period) period.textContent = `${date(data.period?.startDate)} a ${date(data.period?.endDate)} · comparação ancorada na data comum mais recente.`;
    renderChannel("google_ads", data.channels?.google_ads, data.combined?.currencyCode || data.targets?.currencyCode);
    renderChannel("meta_ads", data.channels?.meta_ads, data.combined?.currencyCode || data.targets?.currencyCode);
    const badge = document.querySelector("[data-meta-mapping-badge]");
    if (badge) {
      const map = data.channels?.meta_ads?.conversionMapping;
      badge.textContent = !map ? "Sem Meta" : map.mappedAccounts === map.totalAccounts ? "Conversão mapeada" : `${map.mappedAccounts}/${map.totalAccounts} mapeadas`;
      badge.classList.toggle("ads-badge--ok", Boolean(map && map.totalAccounts > 0 && map.mappedAccounts === map.totalAccounts));
    }
    const providers = Object.keys(data.channels || {}).length;
    setStatus(`${providers} canal(is) com dados · janela comum até ${date(data.freshness?.comparisonAnchorDate)}. Conversões entre plataformas permanecem separadas.`, "info");
  }
  async function load() {
    try { render(await request(`/ads/api/intelligence/multichannel?range=${state.range}`)); }
    catch (error) { setStatus(error.message, "danger"); }
  }

  targetForm?.addEventListener("submit", async (event) => {
    event.preventDefault(); const feedback = document.querySelector("[data-target-save-status]");
    const form = new FormData(targetForm);
    const body = {
      monthlyBudget: parseLocaleNumber(form.get("monthlyBudget")), targetCpa: parseLocaleNumber(form.get("targetCpa")),
      targetRoas: parseLocaleNumber(form.get("targetRoas")), averageTicket: parseLocaleNumber(form.get("averageTicket")),
      grossMarginPercent: parseLocaleNumber(form.get("grossMarginPercent")), currencyCode: String(form.get("currencyCode") || "BRL"), notes: String(form.get("notes") || ""),
    };
    if (feedback) feedback.textContent = "Salvando…";
    try { await request("/ads/api/intelligence/targets", { method: "PUT", body: JSON.stringify(body) }); if (feedback) feedback.textContent = "Referências salvas"; await load(); }
    catch (error) { if (feedback) feedback.textContent = error.message; }
  });

  document.querySelectorAll("[data-analytics-range]").forEach((button) => button.addEventListener("click", () => { state.range = Number(button.dataset.analyticsRange || 30); void load(); }));
  void load();
})();
