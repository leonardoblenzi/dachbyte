(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DachPortalPriceNotice = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  function escapeHtml(value) {
    return String(value ?? "").replace(/[<>&'"]/g, (char) => ({
      "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;"
    })[char]);
  }
  function formatMoney(cents) {
    const value = Number(cents);
    return Number.isSafeInteger(value) && value > 0 ? money.format(value / 100) : "—";
  }
  function formatDay(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    return match ? `${match[3]}/${match[2]}/${match[1]}` : "—";
  }

  function renderPriceNotice(notice) {
    if (!notice || typeof notice !== "object") return "";
    const status = String(notice.status || "pending");
    const labels = {
      sent: "Aumento comunicado",
      pending: "Aviso em preparação",
      sending: "Enviando aviso",
      failed: "Aviso não entregue"
    };
    const label = labels[status] || labels.pending;
    const isSent = status === "sent";
    const description = isSent
      ? "O valor atual continua até a renovação. O novo valor só pode entrar após sete dias corridos do aviso."
      : status === "failed"
        ? "O aviso precisa ser resolvido; o aumento não será aplicado enquanto não houver aviso válido."
        : "O valor atual continua. O aumento depende do envio confirmado e de sete dias corridos de antecedência.";
    return `<section class="price-notice price-notice--${isSent ? "sent" : status === "failed" ? "failed" : "pending"}" aria-label="Aviso de mudança de preço">
      <div class="price-notice__head"><span>Próximo ciclo</span><strong>${label}</strong></div>
      <div class="price-notice__values"><div><small>Valor atual</small><strong>${escapeHtml(formatMoney(notice.oldMonthlyPriceCents))}</strong><span>${escapeHtml(notice.oldRangeCode)}</span></div>
      <span class="price-notice__arrow" aria-hidden="true">→</span><div><small>Valor proposto</small><strong>${escapeHtml(formatMoney(notice.newMonthlyPriceCents))}</strong><span>${escapeHtml(notice.newRangeCode)}</span></div></div>
      <p>${description}</p><div class="price-notice__meta"><span>Pedidos apurados: ${escapeHtml(notice.measuredOrders)}</span><span>Primeira vigência possível: ${escapeHtml(formatDay(notice.earliestEffectiveOn))}</span></div>
    </section>`;
  }

  return { renderPriceNotice };
});
