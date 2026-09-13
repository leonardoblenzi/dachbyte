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
  const btn = document.getElementById("btn-reset");
  if (!btn) return;
  btn.disabled = on;
  btn.textContent = on ? "Salvando..." : "Salvar nova senha";
}

async function loadReset() {
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const meta = document.getElementById("reset-meta");
  const form = document.getElementById("reset-form");

  if (!token) {
    if (form) form.style.display = "none";
    setMsg("Token ausente.", "error");
    return;
  }

  try {
    const data = await api(`/shopee/auth/reset-info?token=${encodeURIComponent(token)}`);
    if (meta) {
      meta.style.display = "block";
      meta.textContent = data?.reset?.email
        ? `Redefinindo acesso de ${data.reset.email}`
        : "Link valido.";
    }
  } catch (err) {
    if (form) form.style.display = "none";
    setMsg(String(err?.message || "Link invalido."), "error");
  }
}

async function onResetSubmit(e) {
  e.preventDefault();

  const token = new URLSearchParams(window.location.search).get("token") || "";
  const password = String(document.getElementById("password")?.value || "");
  const confirmPassword = String(
    document.getElementById("confirm-password")?.value || "",
  );

  if (!password || password.length < 6) {
    setMsg("A senha deve ter pelo menos 6 caracteres.", "error");
    return;
  }

  if (password !== confirmPassword) {
    setMsg("As senhas nao conferem.", "error");
    return;
  }

  try {
    setLoading(true);
    const data = await api("/shopee/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    });
    setMsg(data?.message || "Senha redefinida com sucesso.", "success");
    setTimeout(() => {
      window.location.href = data?.redirect || "/shopee/login";
    }, 1200);
  } catch (err) {
    setMsg(String(err?.message || "Falha ao redefinir a senha."), "error");
  } finally {
    setLoading(false);
  }
}

function bootResetPassword() {
  document
    .getElementById("reset-form")
    ?.addEventListener("submit", onResetSubmit);
  loadReset();
}

bootResetPassword();
