(() => {
  "use strict";

  const base = (window.ML && window.ML.base) || window.__ML_BASE__ || "";
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const emailForm = document.getElementById("trial-email-form");
  const activationForm = document.getElementById("trial-activate-form");
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
        password: document.getElementById("trial-password").value,
      });
      if (response.ok && body?.action === "activated") {
        activationForm.hidden = true;
        showMessage("Teste ativado. Entre com seu e-mail e a senha que acabou de definir.", "success");
      } else if (response.status === 409 && body?.error === "trial_email_login_required") {
        showMessage("Este e-mail já pertence a uma empresa. Entre na empresa existente; não criamos uma segunda conta.", "info");
      } else if (response.status === 410) {
        activationForm.hidden = true;
        showMessage("O link expirou ou já foi usado. Inicie novamente pela página do módulo.", "error");
      } else {
        showMessage("Não foi possível finalizar. Sua conta ainda não está operacional; tente novamente sem refazer o OAuth.", "error");
      }
    } catch (_) {
      showMessage("Conexão indisponível. Nenhum acesso foi liberado; tente novamente.", "error");
    } finally {
      setBusy(button, false, "Ativar meus 7 dias");
    }
  });
})();
