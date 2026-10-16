(function creditOperationModalFactory(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CreditOperationModal = api;
})(typeof window !== "undefined" ? window : null, function createCreditOperationModal() {
  "use strict";

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : null;
  }

  function normalizeQuote(quote) {
    if (!quote || typeof quote !== "object") {
      return { mode: "unavailable", canConfirm: false, estimatedCredits: null, availableCredits: null, projectedCredits: null };
    }
    if (quote.unlimited === true || quote.credits_unlimited === true) {
      return { mode: "unlimited", canConfirm: true, estimatedCredits: null, availableCredits: null, projectedCredits: null };
    }
    const estimatedCredits = numberOrNull(quote.estimated_credits);
    const availableCredits = numberOrNull(quote.available_credits);
    if (quote.deferred === true) {
      const minimumCredits = numberOrNull(quote.minimum_estimated_credits);
      if (minimumCredits === null && availableCredits === null) {
        return { mode: "deferred", canConfirm: true, estimatedCredits: null, availableCredits: null, projectedCredits: null };
      }
      if (minimumCredits === null || availableCredits === null) {
        return { mode: "unavailable", canConfirm: false, estimatedCredits: null, availableCredits, projectedCredits: null };
      }
      return {
        mode: availableCredits < minimumCredits ? "insufficient" : "deferred",
        canConfirm: availableCredits >= minimumCredits,
        estimatedCredits: minimumCredits,
        availableCredits,
        projectedCredits: null,
      };
    }
    if (estimatedCredits === null) {
      return { mode: "unavailable", canConfirm: false, estimatedCredits: null, availableCredits, projectedCredits: null };
    }
    if (quote.sufficient === false || (availableCredits != null && availableCredits < estimatedCredits)) {
      return { mode: "insufficient", canConfirm: false, estimatedCredits, availableCredits, projectedCredits: Math.max(0, (availableCredits || 0) - estimatedCredits) };
    }
    if (availableCredits == null) {
      return { mode: "unavailable", canConfirm: false, estimatedCredits, availableCredits: null, projectedCredits: null };
    }
    return { mode: "prepaid", canConfirm: true, estimatedCredits, availableCredits, projectedCredits: Math.max(0, availableCredits - estimatedCredits) };
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  function formatCredits(value) {
    return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(Number(value || 0));
  }

  function render(view, options = {}) {
    const quantity = Math.max(0, Number(options.quantity || 0));
    const unitLabel = escapeHtml(options.unitLabel || "itens");
    const title = escapeHtml(options.title || "Confirmar operação");
    const description = escapeHtml(options.description || "Revise o consumo antes de continuar.");
    const confirmLabel = escapeHtml(options.confirmLabel || "Confirmar");
    const quantityLabel = quantity > 0
      ? `${formatCredits(quantity)} ${unitLabel}`
      : `Quantidade de ${unitLabel} definida após a consulta`;
    let detail = "";
    if (view.mode === "unlimited") {
      detail = '<p class="credit-operation-modal__status credit-operation-modal__status--unlimited">Créditos ilimitados — sem débito.</p>';
    } else if (view.mode === "deferred") {
      const minimum = view.estimatedCredits === null ? "" : `<dl class="credit-operation-modal__numbers"><div><dt>Estimativa mínima</dt><dd>${formatCredits(view.estimatedCredits)} c</dd></div><div><dt>Saldo atual</dt><dd>${formatCredits(view.availableCredits)} c</dd></div></dl>`;
      detail = `<p class="credit-operation-modal__status credit-operation-modal__status--deferred">A quantidade real será descoberta pelo backend. O custo final será confirmado na reserva; a operação não prossegue se faltar saldo.</p>${minimum}`;
    } else if (view.mode === "prepaid") {
      detail = `<dl class="credit-operation-modal__numbers"><div><dt>Custo estimado</dt><dd>${formatCredits(view.estimatedCredits)} c</dd></div><div><dt>Saldo atual</dt><dd>${formatCredits(view.availableCredits)} c</dd></div><div><dt>Saldo após reserva</dt><dd>${formatCredits(view.projectedCredits)} c</dd></div></dl>`;
    } else if (view.mode === "insufficient") {
      detail = `<p class="credit-operation-modal__status credit-operation-modal__status--insufficient">Saldo insuficiente para esta operação.</p><dl class="credit-operation-modal__numbers"><div><dt>Custo estimado</dt><dd>${formatCredits(view.estimatedCredits)} c</dd></div><div><dt>Saldo atual</dt><dd>${formatCredits(view.availableCredits)} c</dd></div></dl>`;
    } else {
      detail = '<p class="credit-operation-modal__status credit-operation-modal__status--unavailable">Não foi possível confirmar o custo agora. Tente novamente antes de aplicar.</p>';
    }
    const confirm = view.canConfirm ? `<button type="button" class="btn-primary" data-credit-confirm>${confirmLabel}</button>` : "";
    return `<div class="credit-operation-modal" role="dialog" aria-modal="true" aria-labelledby="credit-operation-modal-title"><div class="credit-operation-modal__backdrop" data-credit-cancel></div><section class="credit-operation-modal__card"><header><span class="credit-operation-modal__eyebrow">CONFIRMAÇÃO DE CRÉDITOS</span><h2 id="credit-operation-modal-title">${title}</h2><p>${description}</p></header><div class="credit-operation-modal__quantity">${quantityLabel}</div>${detail}<footer><button type="button" class="btn-secondary" data-credit-cancel>Cancelar</button>${confirm}</footer></section></div>`;
  }

  function confirm(options = {}) {
    const view = normalizeQuote(options.quote);
    if (typeof document === "undefined") return Promise.resolve(false);
    return new Promise((resolve) => {
      const host = document.createElement("div");
      host.innerHTML = render(view, options);
      const element = host.firstElementChild;
      const close = (result) => {
        document.removeEventListener("keydown", onKeydown);
        element.remove();
        resolve(result);
      };
      const onKeydown = (event) => {
        if (event.key === "Escape") close(false);
      };
      element.querySelectorAll("[data-credit-cancel]").forEach((button) => button.addEventListener("click", () => close(false)));
      element.querySelector("[data-credit-confirm]")?.addEventListener("click", () => close(true));
      document.addEventListener("keydown", onKeydown);
      document.body.appendChild(element);
      element.querySelector("[data-credit-confirm], [data-credit-cancel]")?.focus();
    });
  }

  return { normalizeQuote, render, confirm };
});
