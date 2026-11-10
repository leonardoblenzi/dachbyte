"use strict";

// Teste grátis do Mercado Livre: formulário -> autorização no Mercado Livre ->
// e-mail para criar a senha. A página mostra o formulário, o "confira seu e-mail"
// (?enviado=1) ou o motivo de uma recusa (?erro=...).
(function () {
  const MESSAGES = {
    trial_email_login_required: "Este e-mail já tem cadastro na DACHBYTE. Entre e adicione a conta do Mercado Livre pela seleção de plataforma. Se a empresa ainda não usou o teste, os 7 dias valem lá também.",
    trial_company_already_customer: "Esta empresa já é cliente do DACH ML. Entre e adicione a conta pela seleção de plataforma.",
    trial_document_already_used: "Este CNPJ já usou o teste grátis do DACH ML. Fale com a DACHBYTE para contratar.",
    trial_ml_account_already_linked: "Esta conta do Mercado Livre já está conectada na DACHBYTE. Entre na empresa dona dela para usá-la.",
    cnpj_required: "Confira o CNPJ da empresa.",
    identity_sync_document_invalid: "Confira o CNPJ da empresa.",
    identity_sync_cnpj_required: "Informe o CNPJ da empresa (CPF não é aceito no teste).",
    cnpj_not_found: "Não encontramos este CNPJ na Receita Federal. Confira o número.",
    cnpj_lookup_unavailable: "A consulta do CNPJ está indisponível agora. Tente de novo em instantes.",
    trial_email_invalid: "Informe um e-mail válido.",
    trial_activation_fields_required: "Preencha todos os campos.",
    trial_eligibility_unavailable: "Não conseguimos conferir o teste agora. Tente de novo em instantes.",
  };
  const LOGIN_CODES = new Set(["trial_email_login_required", "trial_company_already_customer", "trial_ml_account_already_linked"]);
  const DEFAULT_ERROR = "Não foi possível iniciar o teste agora. Tente de novo em instantes.";

  const $ = (id) => document.getElementById(id);

  function showMessage(text, tone) {
    const box = $("trial-message");
    box.textContent = text;
    box.className = `login-msg ${tone === "ok" ? "is-success" : tone === "info" ? "is-info" : "is-error"}`;
    box.hidden = false;
  }

  function showError(code) {
    showMessage(MESSAGES[code] || DEFAULT_ERROR, "error");
    $("trial-login").hidden = !LOGIN_CODES.has(code);
  }

  function apiPath() {
    const base = window.location.pathname.startsWith("/ml/") ? "/ml" : "";
    return `${base}/api/meli/oauth/trial/start`;
  }

  document.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(window.location.search);
    const form = $("trial-form");

    if (params.get("enviado") === "1") {
      form.hidden = true;
      $("trial-title").textContent = "Seu teste começou";
      $("trial-description").textContent = "Os 7 dias grátis já estão valendo e a conta do Mercado Livre está conectada.";
      if (params.get("email") === "pendente") {
        showMessage("Não conseguimos enviar o e-mail para criar a senha agora. Fale com a DACHBYTE pelo suporte para receber o acesso.", "info");
      } else {
        showMessage("Enviamos um e-mail para você criar a senha. Depois de criar, você entra na seleção de plataforma e acessa a conta do Mercado Livre.", "ok");
      }
      return;
    }
    if (params.get("erro")) showError(params.get("erro"));

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      if (!data.email || !data.full_name || !data.company_name || !data.document_number) {
        showError("trial_activation_fields_required");
        return;
      }
      const button = $("trial-submit");
      button.disabled = true;
      button.textContent = "Conferindo dados...";
      try {
        const response = await fetch(apiPath(), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok || !payload.url) {
          showError(payload?.error);
          button.disabled = false;
          button.textContent = "Autorizar no Mercado Livre";
          return;
        }
        button.textContent = "Abrindo Mercado Livre...";
        window.location.href = payload.url;
      } catch (_error) {
        showError(null);
        button.disabled = false;
        button.textContent = "Autorizar no Mercado Livre";
      }
    });
  });
})();
