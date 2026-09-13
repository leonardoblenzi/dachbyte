(function bootstrapActivate() {
  const form = document.getElementById("activate-form");
  if (!form) return;

  const token = new URLSearchParams(window.location.search).get("token") || "";
  if (!token) {
    setMessage("Convite invalido. Solicite um novo link ao administrador.", "error");
    form.querySelector('button[type="submit"]').disabled = true;
    return;
  }

  loadInvite(token);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = form.querySelector('button[type="submit"]');
    const name = document.getElementById("activate-name")?.value || "";
    const password = document.getElementById("activate-password")?.value || "";
    const passwordConfirm = document.getElementById("activate-password-confirm")?.value || "";

    if (password !== passwordConfirm) {
      setMessage("As senhas nao conferem.", "error");
      return;
    }

    try {
      setLoading(submitButton, true, "Ativando...");
      setMessage("Ativando seu acesso...", "info");

      const response = await fetch("api/auth/invite/activate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token,
          name,
          password,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Nao foi possivel ativar o convite.");
      }

      setMessage("Acesso ativado. Redirecionando para o login...", "success");
      setTimeout(() => {
        window.location.href = payload.redirect || "login";
      }, 1200);
    } catch (error) {
      setMessage(error?.message || "Falha ao ativar o convite.", "error");
    } finally {
      setLoading(submitButton, false, "Ativar acesso");
    }
  });
})();

async function loadInvite(token) {
  try {
    const response = await fetch(`api/auth/invite?token=${encodeURIComponent(token)}`);
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Convite invalido.");
    }

    document.getElementById("activate-name").value = payload.invite?.name || "";
    document.getElementById("activate-email").value = payload.invite?.email || "";
    setMessage("Convite validado. Defina sua senha para entrar no workspace.", "success");
  } catch (error) {
    setMessage(error?.message || "Falha ao carregar o convite.", "error");
    const button = document.querySelector('#activate-form button[type="submit"]');
    if (button) button.disabled = true;
  }
}

function setLoading(button, isLoading, loadingText) {
  if (!button) return;
  button.disabled = isLoading;
  button.textContent = isLoading ? loadingText : "Ativar acesso";
}

function setMessage(text, kind) {
  const box = document.getElementById("activate-msg");
  if (!box) return;
  box.textContent = text;
  box.dataset.kind = kind || "info";
}
