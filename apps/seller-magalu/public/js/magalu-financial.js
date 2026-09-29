(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const FINANCIAL_SEARCH_DEBOUNCE_MS = 300;
  const financialSearchTimers = { costs: null, margins: null };
  const number = (id) => Number($(id)?.value || 0);
  const account = () => window.MagaluSellerShell?.getSelectedAccountId?.();
  const esc = (value) => window.MagaluSellerShell?.escapeHtml?.(value) ?? String(value ?? "");

  async function api(path, options = {}) {
    return window.MagaluSellerShell.fetchJson(`/magalu/api/financial${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
  }

  function selectedGuard() {
    if (!account()) {
      window.MagaluSellerShell.showAlert("Escolha uma conta Magalu para usar a Precificação.", "warning");
      return false;
    }
    return true;
  }

  function setFinancialLoading(kind, isLoading) {
    const input = $(kind === "costs" ? "mg-financial-cost-search" : "mg-financial-margin-search");
    const body = $(kind === "costs" ? "mg-financial-costs-body" : "mg-financial-margin-body");
    if (input) {
      input.setAttribute("aria-busy", String(isLoading));
      input.dataset.loading = String(isLoading);
    }
    if (body) body.setAttribute("aria-busy", String(isLoading));
    const coverage = kind === "costs" ? $("mg-financial-cost-coverage") : null;
    if (coverage && isLoading) coverage.textContent = "Atualizando resultados…";
  }

  function scheduleFinancialLoad(kind) {
    clearTimeout(financialSearchTimers[kind]);
    setFinancialLoading(kind, true);
    financialSearchTimers[kind] = setTimeout(() => {
      financialSearchTimers[kind] = null;
      void (kind === "costs" ? loadCosts() : loadMargins());
    }, FINANCIAL_SEARCH_DEBOUNCE_MS);
  }

  function marginTone(margin) {
    if (!Number.isFinite(margin)) return "muted";
    if (margin < 0) return "bad";
    if (margin < 10) return "warn";
    return "ok";
  }

  async function loadCosts() {
    if (!selectedGuard()) return;
    setFinancialLoading("costs", true);
    try {
      const q = $("mg-financial-cost-search")?.value?.trim() || "";
      const data = await api(`/costs?account_id=${account()}&q=${encodeURIComponent(q)}`);
      const body = $("mg-financial-costs-body");
      if (!body) return;
      const coverage = $("mg-financial-cost-coverage");
      if (coverage) coverage.textContent = `${data.total || 0} SKU(s) no recorte`;

      body.innerHTML = (data.rows || []).map((row) => `
        <tr>
          <td><code>${esc(row.sku)}</code></td>
          <td><div class="mg-financial-product"><strong>${esc(row.title || "Sem título")}</strong><small>Custo operacional por unidade</small></div></td>
          <td><strong>${money.format(Number(row.price || 0))}</strong></td>
          <td><input class="mg-financial-cost-input" data-cost-sku="${esc(row.sku)}" type="number" min="0" step="0.01" value="${row.unit_cost ?? ""}" placeholder="R$ 0,00" aria-label="Custo do SKU ${esc(row.sku)}"></td>
          <td><button class="mg-secondary-btn mg-financial-save" data-save-cost="${esc(row.sku)}" type="button">Salvar custo</button></td>
        </tr>`).join("") || '<tr><td colspan="5" class="mg-empty-state">Nenhum SKU sincronizado.</td></tr>';

      body.querySelectorAll("[data-save-cost]").forEach((button) => button.addEventListener("click", async () => {
        const sku = button.dataset.saveCost;
        const input = body.querySelector(`[data-cost-sku="${CSS.escape(sku)}"]`);
        button.disabled = true;
        try {
          await api(`/costs/${encodeURIComponent(sku)}`, {
            method: "PUT",
            body: JSON.stringify({ account_id: account(), unit_cost: input.value }),
          });
          window.MagaluSellerShell.showAlert("Custo salvo.", "success");
          void loadCosts();
        } finally {
          button.disabled = false;
        }
      }));
    } catch (_error) {
      window.MagaluSellerShell.showAlert("Não foi possível atualizar os custos. Exibindo o último resultado válido.", "warning");
    } finally {
      setFinancialLoading("costs", false);
    }
  }

  async function loadMargins() {
    if (!selectedGuard()) return;
    setFinancialLoading("margins", true);
    try {
      const q = $("mg-financial-margin-search")?.value?.trim() || "";
      const data = await api(`/margins?account_id=${account()}&q=${encodeURIComponent(q)}`);
      const body = $("mg-financial-margin-body");
      if (!body) return;

      body.innerHTML = (data.rows || []).map((row) => {
        const margin = Number(row.estimate?.margin_pct);
        const profit = Number(row.estimate?.profit);
        const tone = marginTone(margin);
        const profitClass = Number.isFinite(profit) ? (profit < 0 ? "mg-financial-money-negative" : "mg-financial-money-positive") : "";
        return `<tr>
          <td><code>${esc(row.sku)}</code></td>
          <td><strong>${money.format(Number(row.price || 0))}</strong></td>
          <td>${row.unit_cost == null ? '<span class="mg-financial-chip" data-tone="warn">Sem custo</span>' : money.format(Number(row.unit_cost))}</td>
          <td>${Number.isFinite(margin) ? `<span class="mg-financial-chip" data-tone="${tone}">${margin.toFixed(1)}%</span>` : "—"}</td>
          <td class="${profitClass}">${Number.isFinite(profit) ? money.format(profit) : "—"}</td>
        </tr>`;
      }).join("") || '<tr><td colspan="5" class="mg-empty-state">Sem dados suficientes para calcular margem.</td></tr>';
    } catch (_error) {
      window.MagaluSellerShell.showAlert("Não foi possível atualizar as margens. Exibindo o último resultado válido.", "warning");
    } finally {
      setFinancialLoading("margins", false);
    }
  }

  function setResultTone(id, value, { percent = false } = {}) {
    const node = $(id);
    const card = node?.closest("article");
    if (!card) return;
    const n = Number(value);
    card.dataset.tone = !Number.isFinite(n) ? "muted" : n < 0 ? "bad" : (percent && n < 10 ? "warn" : "ok");
  }

  async function calculate() {
    if (!selectedGuard()) return;
    const payload = {
      account_id: account(), sale_price: number("mg-fin-sale"), unit_cost: number("mg-fin-cost"),
      commission_rate: number("mg-fin-commission"), commission_fixed: number("mg-fin-commission-fixed"),
      platform_fee_rate: number("mg-fin-fee"), seller_shipping: number("mg-fin-shipping"),
      shipping_share: number("mg-fin-share"), seller_discount: number("mg-fin-discount"), tax_rate: number("mg-fin-tax"),
      packaging_cost: number("mg-fin-packaging"), operational_cost: number("mg-fin-operational"),
      other_cost: number("mg-fin-other"), target_margin: number("mg-fin-target"),
    };
    const data = await api("/calculator/calculate", { method: "POST", body: JSON.stringify(payload) });
    const r = data.result;
    $("mg-fin-profit").textContent = r.profit == null ? "—" : money.format(r.profit);
    $("mg-fin-margin").textContent = r.margin_pct == null ? "—" : `${r.margin_pct.toFixed(1)}%`;
    $("mg-fin-roi").textContent = r.roi_pct == null ? "—" : `${r.roi_pct.toFixed(1)}%`;
    $("mg-fin-break-even").textContent = r.break_even_price == null ? "—" : money.format(r.break_even_price);
    $("mg-fin-target-price").textContent = r.target_price == null ? "Não atingível" : money.format(r.target_price);
    $("mg-fin-total").textContent = r.total_costs == null ? "Custo do produto obrigatório" : money.format(r.total_costs);
    setResultTone("mg-fin-profit", r.profit);
    setResultTone("mg-fin-margin", r.margin_pct, { percent: true });
    setResultTone("mg-fin-roi", r.roi_pct, { percent: true });
  }

  window.addEventListener("magalu:accountchange", () => { void loadCosts(); void loadMargins(); });
  document.addEventListener("DOMContentLoaded", () => {
    $("mg-financial-refresh")?.addEventListener("click", () => { void loadCosts(); void loadMargins(); });
    $("mg-financial-cost-search")?.addEventListener("input", () => scheduleFinancialLoad("costs"));
    $("mg-financial-margin-search")?.addEventListener("input", () => scheduleFinancialLoad("margins"));
    $("mg-fin-calculate")?.addEventListener("click", () => void calculate());
    setTimeout(() => { void loadCosts(); void loadMargins(); }, 0);
  });
})();
