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
  const btn = document.getElementById("btn-activate");
  if (!btn) return;
  btn.disabled = on;
  btn.textContent = on ? "Ativando..." : "Ativar acesso";
}

async function loadInvite() {
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const meta = document.getElementById("invite-meta");
  const form = document.getElementById("activate-form");

  if (!token) {
    setMsg("Token de convite ausente.", "error");
    if (form) form.style.display = "none";
    return;
  }

  try {
    const data = await api(
      `/shopee/auth/activation-info?token=${encodeURIComponent(token)}`,
    );
    if (meta) {
      meta.style.display = "block";
      meta.textContent = data?.invite?.email
        ? `Convite para ${data.invite.email}`
        : "Convite valido.";
    }
  } catch (err) {
    setMsg(String(err?.message || "Convite invalido."), "error");
    if (form) form.style.display = "none";
  }
}

async function onActivateSubmit(e) {
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
    const data = await api("/shopee/auth/activate", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    });
    window.location.href = data?.redirect || "/shopee/?tab=auth&startOauth=1";
  } catch (err) {
    setMsg(String(err?.message || "Falha ao ativar conta."), "error");
  } finally {
    setLoading(false);
  }
}

function bootActivate() {
  document
    .getElementById("activate-form")
    ?.addEventListener("submit", onActivateSubmit);
  loadInvite();
}

bootActivate();
