(function installSuitePaymentGate() {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  if (window.__suitePaymentGateInstalled) return;
  window.__suitePaymentGateInstalled = true;

  const originalFetch = window.fetch.bind(window);

  function shouldRedirectForPayment(payload) {
    const code = String((payload && (payload.code || payload.reason)) || "").toUpperCase();
    const message = String(
      (payload && (payload.error || payload.message)) || "",
    );
    return (
      code === "PAYMENT_REQUIRED" ||
      code === "SUBSCRIPTION_INACTIVE" ||
      /payment|required|assinatura|subscription/i.test(message)
    );
  }

  function redirectToSubscriptionRenewal() {
    const path = String(window.location.pathname || "");
    if (path.includes("selecao-plataforma") || path.includes("login")) return;

    const key = "davantti_payment_required_redirect_at";
    const now = Date.now();
    const last = Number(sessionStorage.getItem(key) || 0);
    if (Number.isFinite(last) && now - last < 1500) return;

    sessionStorage.setItem(key, String(now));
    window.location.assign("/selecao-plataforma?subscription=expired");
  }

  function watchPaymentRequired(response) {
    if (!response || response.status !== 402) return response;

    response
      .clone()
      .json()
      .then((payload) => {
        if (shouldRedirectForPayment(payload)) redirectToSubscriptionRenewal();
      })
      .catch(() => redirectToSubscriptionRenewal());

    return response;
  }

  window.fetch = function suitePaymentGateFetch(input, init) {
    return originalFetch(input, init).then(watchPaymentRequired);
  };
})();
