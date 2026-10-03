"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const money = (cents) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
      Number(cents || 0) / 100,
    );
  const number = (value) =>
    new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(
      Math.max(0, Math.trunc(Number(value || 0))),
    );
  const signedNumber = (value) => {
    const numeric = Math.trunc(Number(value || 0));
    const prefix = numeric > 0 ? "+" : "";
    return `${prefix}${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(numeric)} c`;
  };

  function apiUrl(path) {
    return window.mlUrl ? window.mlUrl(path) : path;
  }

  function showAlert(message) {
    const el = $("credits-alert");
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || "";
  }

  function showLowBalanceAlert(total) {
    if (total <= 0) {
      showAlert("Tokens zerados nesta conta. Operacoes pesadas podem ficar indisponiveis quando a cobranca estrita for ativada.");
      return;
    }
    if (total <= 50) {
      showAlert(`Saldo baixo: restam ${number(total)} tokens. Considere fazer uma recarga para evitar bloqueios em jobs pesados.`);
    }
  }

  function dateLabel(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("pt-BR");
  }

  function resourceFrom(payload) {
    return {
      ...(payload?.resource || {}),
      ...(payload?.wallet || {}),
    };
  }

  function creditScale(payload) {
    return Math.max(
      1,
      Number(
        payload?.wallet?.credit_unit_scale ||
        payload?.resource?.credit_unit_scale ||
        1
      ) || 1,
    );
  }

  function visibleCreditUnits(value, scale = 1) {
    return Number(value || 0) / Math.max(1, Number(scale || 1));
  }

  function isUnlimited(payload) {
    const resource = resourceFrom(payload);
    const context = payload?.billing_context || payload?.context || {};
    const status = String(resource.status || context.status || payload?.status || "").toLowerCase();
    const billingMode = String(resource.billing_mode || context.billingMode || context.billing_mode || "").toLowerCase();
    const usagePolicy = String(resource.usage_policy || context.usagePolicy || context.usage_policy || "").toLowerCase();
    return Boolean(
      payload?.unlimited ||
        resource.unlimited ||
        usagePolicy === "unlimited" ||
        ["internal_unlimited", "courtesy_unlimited"].includes(status) ||
        (status === "legacy_active" && billingMode === "legacy"),
    );
  }

  function renderWallet(payload) {
    const resource = resourceFrom(payload);
    const unlimited = isUnlimited(payload);
    document.body?.classList.toggle("credits-app--unlimited", unlimited);
    const monthly = Number(resource.monthly_balance || 0);
    const purchased = Number(resource.purchased_balance || 0);
    const prepaid = resource.prepaid === true || String(resource.model || resource.consumption_model || "") === "prepaid_credits";
    const total = Number(resource.available_balance ?? (monthly + purchased));
    const status = String(resource.status || payload?.status || "indefinido");
    const plan = String(resource.plan_code || "ml_pro");
    const range = String(resource.order_range_code || "faixa nao definida");

    $("credits-total").textContent = unlimited ? "Ilimitado" : `${number(total)} c`;
    $("credits-monthly").textContent = unlimited ? "Ilimitado" : prepaid ? "Pré-pago" : `${number(monthly)} c`;
    $("credits-purchased").textContent = unlimited ? "Ilimitado" : `${number(purchased)} c`;
    $("credits-status").textContent = unlimited ? "Uso ilimitado" : status.replaceAll("_", " ");
    $("credits-plan").textContent = `${plan} - ${range}`;
    showLowBalanceAlert(unlimited ? Number.POSITIVE_INFINITY : total);

    const starts = dateLabel(resource.period_starts_at);
    const ends = dateLabel(resource.period_ends_at);
    $("credits-period").textContent = unlimited
      ? "Conta legado, cortesia ou interna sem limite de consumo."
      : prepaid
        ? "Sem franquia mensal. O saldo comprado não expira."
        : starts && ends
          ? `Ciclo de ${starts} ate ${ends}.`
          : "Ciclo mensal ainda nao definido.";
  }

  function renderPackages(packages = []) {
    const grid = $("credits-packages");
    if (!grid) return;
    if (!packages.length) {
      grid.innerHTML = '<div class="credits-empty">Nenhum pacote de recarga disponivel.</div>';
      return;
    }

    grid.innerHTML = packages.map((item) => {
      const total = Number(item.credits || 0) + Number(item.bonus_credits || 0);
      const bonus = Number(item.bonus_credits || 0);
      return `
        <article class="credits-package">
          <div>
            <small>${bonus > 0 ? `${number(item.credits)} + ${number(bonus)} bonus` : "Recarga avulsa"}</small>
            <strong>${number(total)} c</strong>
            <p>${money(item.price_cents)}</p>
          </div>
          <button class="credits-btn credits-btn-primary" type="button" data-package-code="${String(item.package_code || "")}">
            Comprar
          </button>
        </article>
      `;
    }).join("");
  }

  const ledgerLabels = {
    monthly_grant: "Credito mensal",
    initial_grant: "Credito inicial",
    purchase: "Recarga comprada",
    admin_credit: "Credito manual",
    admin_debit: "Debito manual",
    reservation: "Reserva para job",
    job_debit: "Consumo de job",
    release: "Reserva liberada",
    refund: "Estorno",
    expiry: "Expiracao mensal",
    migration: "Migracao",
  };

  function formatDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function bucketLabel(value) {
    const normalized = String(value || "");
    if (normalized === "monthly") return "mensal";
    if (normalized === "purchased") return "comprado";
    if (normalized === "unlimited") return "ilimitado";
    return normalized || "saldo";
  }

  function renderLedger(ledger = [], scale = 1) {
    const list = $("credits-ledger");
    if (!list) return;
    if (!ledger.length) {
      list.innerHTML = '<div class="credits-empty">Nenhuma movimentacao registrada ainda.</div>';
      return;
    }

    list.innerHTML = ledger.map((entry) => {
      const amount = visibleCreditUnits(entry.amount, scale);
      const amountClass = amount > 0 ? "is-positive" : amount < 0 ? "is-negative" : "is-neutral";
      const title = ledgerLabels[String(entry.entry_type || "")] || String(entry.entry_type || "Movimentacao");
      const reason = String(entry.reason || entry.reference_type || "").replaceAll("_", " ");
      return `
        <article class="credits-ledger-row">
          <div class="credits-ledger-main">
            <span class="credits-ledger-title">${title}</span>
            <span class="credits-ledger-meta">${bucketLabel(entry.balance_bucket)} - ${reason || "sem detalhe"} - ${formatDateTime(entry.created_at)}</span>
          </div>
          <strong class="credits-ledger-amount ${amountClass}">${signedNumber(amount)}</strong>
        </article>
      `;
    }).join("");
  }

  function renderReservations(reservations = [], scale = 1) {
    const list = $("credits-reservations");
    if (!list) return;
    if (!reservations.length) {
      list.innerHTML = '<div class="credits-empty">Nenhuma reserva recente.</div>';
      return;
    }

    list.innerHTML = reservations.slice(0, 8).map((item) => `
      <article class="credits-reservation-row">
        <div class="credits-reservation-main">
          <span class="credits-reservation-title">${String(item.operation_key || "job").replaceAll("_", " ")}</span>
          <span class="credits-reservation-meta">${number(visibleCreditUnits(item.reserved_credits, item.credit_unit_scale || scale))} c reservados - ${formatDateTime(item.created_at)}</span>
        </div>
        <span class="credits-reservation-status">${String(item.status || "reserved").replaceAll("_", " ")}</span>
      </article>
    `).join("");
  }

  function operationLabel(value) {
    const normalized = String(value || "operacao").trim();
    const labels = {
      "ads.filter": "Consulta de anuncios",
      "promo.apply": "Aplicar promocao",
      "promo.remove": "Remover promocao",
      "wholesale.batch": "Atacado",
      "dimensions.validate": "Validar dimensoes",
      "attributes.batch": "Caracteristicas",
      "model.bulk": "Modelo em massa",
      "production_time.batch": "Prazo de producao",
      "stock.alert": "Estoque",
      "ads.bulk": "Gestao em lote",
    };
    return labels[normalized] || normalized.replaceAll("_", " ").replaceAll(".", " ");
  }

  function renderUsageByOperation(ledger = [], scale = 1) {
    const target = $("credits-usage");
    if (!target) return;

    const usage = new Map();
    ledger.forEach((entry) => {
      const amount = visibleCreditUnits(entry.amount, scale);
      const type = String(entry.entry_type || "");
      if (amount >= 0) return;
      if (!["reservation", "job_debit"].includes(type)) return;

      const operation = String(entry.reason || entry.reference_type || "operacao");
      const current = usage.get(operation) || { operation, credits: 0, events: 0 };
      current.credits += Math.abs(amount);
      current.events += 1;
      usage.set(operation, current);
    });

    const rows = Array.from(usage.values()).sort((a, b) => b.credits - a.credits).slice(0, 8);
    if (!rows.length) {
      target.innerHTML = '<div class="credits-empty">Ainda nao ha consumo por operacao no extrato recente.</div>';
      return;
    }

    const maxCredits = Math.max(...rows.map((item) => item.credits), 1);
    target.innerHTML = rows.map((item) => {
      const pct = Math.max(4, Math.round((item.credits / maxCredits) * 100));
      return `
        <article class="credits-usage-row">
          <div class="credits-usage-title">
            <strong>${operationLabel(item.operation)}</strong>
            <span>${item.events} evento(s)</span>
          </div>
          <div class="credits-usage-track" aria-hidden="true">
            <div class="credits-usage-bar" style="width:${pct}%"></div>
          </div>
          <div class="credits-usage-total">
            <strong>${number(item.credits)} c</strong>
            <span>consumidos</span>
          </div>
        </article>
      `;
    }).join("");
  }

  async function requestJson(path, options = {}) {
    const response = await fetch(apiUrl(path), {
      credentials: "include",
      headers: { accept: "application/json", "content-type": "application/json" },
      ...options,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.message || payload?.error || "request_failed");
    }
    return payload;
  }

  async function loadCredits() {
    showAlert("");
    try {
      const [access, policy, activity] = await Promise.all([
        requestJson("/api/billing/credits"),
        requestJson("/api/billing/credit-policy"),
        requestJson("/api/billing/credits/activity?limit=50"),
      ]);
      const view = {
        ...access,
        ...activity,
        resource: activity?.resource || access?.resource || {},
        wallet: activity?.wallet || access?.wallet || null,
        unlimited: Boolean(activity?.unlimited || access?.unlimited),
      };
      const scale = creditScale(view);
      renderWallet(view);
      renderPackages(Array.isArray(policy?.packages) ? policy.packages : []);
      const ledger = Array.isArray(activity?.ledger) ? activity.ledger : [];
      renderLedger(ledger, scale);
      renderReservations(Array.isArray(activity?.reservations) ? activity.reservations : [], scale);
      renderUsageByOperation(ledger, scale);
    } catch (error) {
      console.warn("[conta-creditos] falha ao carregar:", error?.message || error);
      showAlert("Nao foi possivel carregar os creditos agora. Verifique se o Hub ja esta migrado e configurado.");
      renderPackages([]);
      renderLedger([]);
      renderReservations([]);
      renderUsageByOperation([]);
    }
  }

  async function startTopup(packageCode) {
    if (!packageCode) return;
    try {
      const payload = await requestJson("/api/billing/credits/topup-checkout", {
        method: "POST",
        body: JSON.stringify({
          package_code: packageCode,
          success_url: window.location.href,
        }),
      });
      const checkoutUrl = payload.checkout_url || payload.init_point || payload.sandbox_init_point;
      if (!checkoutUrl) throw new Error("checkout_url_missing");
      window.location.href = checkoutUrl;
    } catch (error) {
      console.error("[conta-creditos] recarga:", error?.message || error);
      showAlert("Nao foi possivel iniciar a recarga. Confira a configuracao do Asaas no Hub.");
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-package-code]");
    if (!button) return;
    event.preventDefault();
    startTopup(button.getAttribute("data-package-code"));
  });

  $("btn-refresh-credits")?.addEventListener("click", loadCredits);
  document.addEventListener("DOMContentLoaded", loadCredits);
})();
