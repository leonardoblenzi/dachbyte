"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  function mlUrl(path) {
    if (typeof window.mlUrl === "function") return window.mlUrl(path);
    const base = String(window.ML?.base || window.__ML_BASE__ || "/ml").replace(/\/+$/, "");
    return `${base}${String(path || "").startsWith("/") ? path : `/${path}`}`;
  }

  function showAlert(message, tone = "warn") {
    const alert = $("regularize-alert");
    if (!alert) return;
    alert.hidden = !message;
    alert.textContent = message || "";
    alert.dataset.tone = tone;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatOrders(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "--";
    return n.toLocaleString("pt-BR");
  }

  function formatDate(value) {
    if (!value) return "Sem prazo";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "Sem prazo";
    return date.toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  }

  function billingOf(account = {}) {
    return account.billing || {
      label: account.billing_status || "Status indefinido",
      tone: "neutral",
      reason: "Status comercial nao carregado.",
      can_operate: false,
      order_range_label: account.order_range_code || "--",
      recommended_range_label: account.recommended_range_code || "--",
      last_closed_period_orders: account.last_closed_period_orders,
      grace_expires_at: account.billing_grace_expires_at,
      renewal_checkout_url: account.renewal_checkout_url,
    };
  }

  function toneClass(tone) {
    if (tone === "danger") return "is-danger";
    if (tone === "warn" || tone === "warning") return "is-warn";
    if (tone === "ok" || tone === "success") return "is-ok";
    return "";
  }

  function setCurrent(account) {
    const billing = billingOf(account);
    const label = account?.label || "Conta selecionada";
    $("regularize-account-label").textContent = label;
    $("regularize-account-sub").textContent = account?.meli_user_id
      ? `ML ${account.meli_user_id}`
      : "Mercado Livre";
    $("regularize-reason").textContent = billing.reason || "Regularize esta conta para continuar operando.";
    $("regularize-current-range").textContent = billing.order_range_label || "--";
    $("regularize-target-range").textContent = billing.recommended_range_label || billing.order_range_label || "--";
    $("regularize-orders").textContent = formatOrders(billing.last_closed_period_orders);
    $("regularize-grace").textContent = formatDate(billing.grace_expires_at || billing.review_due_at);

    const status = $("regularize-status");
    status.textContent = billing.label || "Status indefinido";
    status.className = `regularize-status ${toneClass(billing.tone)}`.trim();

    const pay = $("regularize-pay");
    if (billing.renewal_checkout_url) {
      pay.href = billing.renewal_checkout_url;
      pay.setAttribute("aria-disabled", "false");
    } else {
      pay.href = "#";
      pay.setAttribute("aria-disabled", "true");
    }

    if (billing.can_operate) {
      showAlert("Esta conta ja esta operacional. Voce pode voltar ao painel ou revisar o plano no Davantti Pay.", "ok");
    } else {
      showAlert(billing.reason || "Regularize esta conta para retomar as operacoes.", billing.tone || "warn");
    }
  }

  async function selectAccount(id) {
    const response = await window.fetch(mlUrl("/api/meli/selecionar"), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ meli_conta_id: Number(id) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || "Falha ao trocar conta.");
    }
  }

  function renderAccounts(accounts = [], currentId = null) {
    const list = $("regularize-account-list");
    if (!list) return;
    const activeAccounts = accounts.filter((account) => {
      const billing = billingOf(account);
      return String(account.id || "") !== String(currentId || "") && billing.can_operate;
    });

    if (!activeAccounts.length) {
      list.innerHTML = '<div class="regularize-empty">Nenhuma outra conta ativa encontrada.</div>';
      return;
    }

    list.innerHTML = activeAccounts.map((account) => {
      const billing = billingOf(account);
      return `
        <article class="regularize-account-option">
          <div>
            <h3>${escapeHtml(account.label || `Conta ${account.meli_user_id || account.id}`)}</h3>
            <p>${escapeHtml(account.meli_user_id ? `ML ${account.meli_user_id}` : "Mercado Livre")}</p>
          </div>
          <span class="regularize-status ${toneClass(billing.tone)}">${escapeHtml(billing.label || "Ativa")}</span>
          <button class="regularize-btn regularize-btn-ghost" type="button" data-select-account="${escapeHtml(account.id)}">
            Entrar nesta conta
          </button>
        </article>
      `;
    }).join("");
  }

  async function load() {
    showAlert("");
    try {
      const [currentResponse, listResponse] = await Promise.all([
        window.fetch(mlUrl("/api/account/current"), {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers: { accept: "application/json" },
        }),
        window.fetch(mlUrl("/api/meli/contas?active_only=1&limit=50"), {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers: { accept: "application/json" },
        }),
      ]);

      const currentPayload = await currentResponse.json().catch(() => null);
      const listPayload = await listResponse.json().catch(() => null);
      if (!currentResponse.ok || currentPayload?.ok === false) {
        throw new Error(currentPayload?.error || "Nao foi possivel carregar a conta atual.");
      }
      if (!listResponse.ok || listPayload?.ok === false) {
        throw new Error(listPayload?.error || "Nao foi possivel carregar suas contas.");
      }

      const current = currentPayload?.current || null;
      if (!current) {
        window.location.href = mlUrl("/vincular-conta");
        return;
      }
      setCurrent(current);
      renderAccounts(Array.isArray(listPayload?.contas) ? listPayload.contas : [], current.id);
    } catch (error) {
      showAlert(error?.message || "Nao foi possivel carregar a regularizacao.", "danger");
    }
  }

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-select-account]");
    if (!button) return;
    button.disabled = true;
    try {
      await selectAccount(button.getAttribute("data-select-account"));
      window.location.href = mlUrl("/painel");
    } catch (error) {
      button.disabled = false;
      showAlert(error?.message || "Nao foi possivel entrar nesta conta.", "danger");
    }
  });

  $("regularize-refresh")?.addEventListener("click", load);
  load();
})();
