async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message =
      (json && (json.error || json.message)) ||
      text ||
      `HTTP ${response.status}`;
    throw new Error(message);
  }

  return json;
}

function setMsg(text, kind) {
  const el = document.getElementById("login-msg");
  if (!el) return;
  el.textContent = text || "";
  el.dataset.kind = kind || "";
}

function setLoading(on) {
  const btn = document.getElementById("btn-send");
  if (!btn) return;
  btn.disabled = on;
  btn.textContent = on ? "Enviando..." : "Enviar link";
}

async function onForgotSubmit(e) {
  e.preventDefault();

  const email = String(document.getElementById("email")?.value || "").trim();
  if (!email) {
    setMsg("Informe o e-mail.", "error");
    return;
  }

  try {
    setLoading(true);
    const data = await api("/shopee/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    setMsg(
      data?.message ||
        "Se o email existir na base, enviaremos as instrucoes para redefinir a senha.",
      "success",
    );
  } catch (err) {
    setMsg(
      String(err?.message || "Falha ao solicitar a redefinicao."),
      "error",
    );
  } finally {
    setLoading(false);
  }
}

function bootForgotPassword() {
  document
    .getElementById("forgot-form")
    ?.addEventListener("submit", onForgotSubmit);
}

bootForgotPassword();
