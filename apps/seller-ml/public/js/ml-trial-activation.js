(() => {
  "use strict";

  const base = (window.ML && window.ML.base) || window.__ML_BASE__ || "";
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const linkingExisting = new URLSearchParams(window.location.search).get("link") === "1";
  const emailForm = document.getElementById("trial-email-form");
  const activationForm = document.getElementById("trial-activate-form");
  const existingForm = document.getElementById("trial-existing-form");
  const loginLink = document.getElementById("trial-existing-login");
  const description = document.getElementById("trial-description");
  const message = document.getElementById("trial-message");

  function showMessage(value, kind) {
    message.hidden = false;
    message.textContent = value;
    message.className = `login-msg is-${kind}`;
  }

  function setBusy(button, busy, original) {
    button.disabled = busy;
    button.textContent = busy ? "Aguarde..." : original;
  }

  async function post(path, payload) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { response, body: await response.json().catch(() => null) };
  }

  if (token) {
    emailForm.hidden = true;
    activationForm.hidden = false;
    description.textContent = "E-mail confirmado. Defina seus dados de acesso para iniciar os sete dias de teste.";
  }

  if (linkingExisting && !token) {
    emailForm.hidden = true;
    existingForm.hidden = false;
    description.textContent = "Escolha a empresa já cadastrada para vincular sua conta Mercado Livre.";
    fetch(`${base}/api/meli/oauth/trial/link-options`, {
      credentials: "include", cache: "no-store",
    }).then(async (response) => {
      const body = await response.json().catch(() => null);
      if (response.status === 401) {
        existingForm.hidden = true;
        loginLink.hidden = false;
        showMessage("Entre na empresa existente para continuar. Seu teste ainda não foi iniciado.", "info");
        return;
      }
      if (!response.ok || !body?.ok || !Array.isArray(body.companies)) {
        existingForm.hidden = true;
        showMessage("Não foi possível confirmar a empresa para este e-mail. Entre novamente e tente outra vez.", "error");
        return;
      }
      const select = document.getElementById("trial-existing-company");
      for (const company of body.companies) {
        const option = document.createElement("option");
        option.value = String(company.id);
        option.textContent = company.name;
        select.appendChild(option);
      }
      if (!body.companies.length) {
        existingForm.hidden = true;
        showMessage("Este acesso não pertence a nenhuma empresa cadastrada. Peça acesso ao administrador da empresa.", "error");
      }
    }).catch(() => {
      existingForm.hidden = true;
      showMessage("Conexão indisponível. Recarregue a página para tentar novamente.", "error");
    });
  }

  emailForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.getElementById("trial-email-submit");
    setBusy(button, true, "Enviar confirmação");
    try {
      const { response, body } = await post("/api/meli/oauth/trial/email", {
        email: document.getElementById("trial-email").value.trim(),
      });
      if (response.ok && body?.action === "verification_sent") {
        emailForm.hidden = true;
        showMessage("Enviamos um link de confirmação. Abra o e-mail neste ou em outro dispositivo para continuar.", "success");
      } else if (response.ok && body?.action === "login_required") {
        emailForm.hidden = true;
        loginLink.hidden = false;
        showMessage("Este e-mail já tem acesso à DACHBYTE. Entre na empresa existente para vincular a conta. Nenhum teste foi iniciado.", "info");
      } else {
        showMessage("Não foi possível enviar a confirmação agora. Tente novamente.", "error");
      }
    } catch (_) {
      showMessage("Conexão indisponível. Tente novamente.", "error");
    } finally {
      setBusy(button, false, "Enviar confirmação");
    }
  });

  activationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.getElementById("trial-activate-submit");
    setBusy(button, true, "Ativar meus 7 dias");
    try {
      const { response, body } = await post("/api/meli/oauth/trial/activate", {
        token,
        full_name: document.getElementById("trial-name").value.trim(),
        company_name: document.getElementById("trial-company").value.trim(),
        document_number: document.getElementById("trial-document").value.trim(),
        password: document.getElementById("trial-password").value,
      });
      if (response.ok && body?.action === "activated") {
        activationForm.hidden = true;
        showMessage(body.trial_active
          ? "Teste ativado. Entre com seu e-mail e a senha que acabou de definir."
          : "Conta criada, mas o teste desta empresa já terminou. Entre para consultar a contratação.", "success");
      } else if (response.status === 409 && body?.error === "trial_email_login_required") {
        showMessage("Este e-mail já pertence a uma empresa. Entre na empresa existente; não criamos uma segunda conta.", "info");
      } else if (response.status === 410) {
        activationForm.hidden = true;
        showMessage("O link expirou ou já foi usado. Inicie novamente pela página do módulo.", "error");
      } else if (body?.error === "document_invalid") {
        showMessage("CNPJ inválido. Confira todos os dígitos e tente novamente.", "error");
      } else if (body?.error === "cnpj_required" || body?.error === "identity_sync_cnpj_required") {
        showMessage("Informe um CNPJ válido para cadastrar a empresa.", "error");
      } else if (body?.error === "cnpj_not_found") {
        showMessage("CNPJ não encontrado no cadastro consultado. Confira o número.", "error");
      } else if (body?.error === "cnpj_lookup_unavailable") {
        showMessage("A consulta ao CNPJ está indisponível. Tente novamente em alguns minutos.", "error");
      } else if (body?.error === "identity_sync_document_invalid") {
        showMessage("CNPJ inválido. Confira os dados e tente novamente.", "error");
      } else {
        showMessage("Não foi possível finalizar. Sua conta ainda não está operacional; tente novamente sem refazer o OAuth.", "error");
      }
    } catch (_) {
      showMessage("Conexão indisponível. Nenhum acesso foi liberado; tente novamente.", "error");
    } finally {
      setBusy(button, false, "Ativar meus 7 dias");
    }
  });

  existingForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.getElementById("trial-existing-submit");
    setBusy(button, true, "Vincular à empresa");
    try {
      const companyId = Number(document.getElementById("trial-existing-company").value);
      const { response, body } = await post("/api/meli/oauth/trial/link-existing", {
        company_id: companyId,
      });
      if (response.ok && body?.action === "linked") {
        existingForm.hidden = true;
        showMessage(body.trial_active
          ? "Conta vinculada à sua empresa. Você já pode acessar o Seller ML."
          : "Conta vinculada, mas o teste ML desta empresa já terminou. Consulte a contratação no painel.", "success");
      } else if (response.status === 409) {
        showMessage("Esta conta já foi vinculada ou a empresa escolhida não pertence ao seu acesso. Confira a seleção.", "error");
      } else {
        showMessage("Não foi possível concluir o vínculo. Nenhuma conta foi liberada; tente novamente.", "error");
      }
    } catch (_) {
      showMessage("Conexão indisponível. Tente novamente sem refazer o OAuth.", "error");
    } finally {
      setBusy(button, false, "Vincular à empresa");
    }
  });
})();
