"use strict";

(() => {
  const els = {
    form: document.getElementById("help-form"),
    topic: document.getElementById("help-topic"),
    message: document.getElementById("help-message"),
    submit: document.getElementById("help-submit"),
    feedback: document.getElementById("help-feedback"),
    phoneRow: document.getElementById("help-phone-row"),
    cellphone: document.getElementById("help-cellphone"),
    accountPill: document.getElementById("help-account-pill"),
    accountLabel: document.getElementById("help-account-label"),
    accountId: document.getElementById("help-account-id"),
    meliUserId: document.getElementById("help-meli-user-id"),
    pagePath: document.getElementById("help-page-path"),
    userEmail: document.getElementById("help-user-email"),
    userName: document.getElementById("help-user-name"),
    sideAccount: document.getElementById("help-side-account"),
  };

  function selectedReplyPreference() {
    return (
      document.querySelector('input[name="reply_preference"]:checked')?.value ||
      "email"
    );
  }

  function setFeedback(type, text) {
    if (!els.feedback) return;
    els.feedback.hidden = !text;
    els.feedback.textContent = text || "";
    els.feedback.className = "help-feedback";
    if (type) {
      els.feedback.classList.add(`is-${type}`);
    }
  }

  function togglePhoneField() {
    const needsCellphone = selectedReplyPreference() === "cellphone";
    if (els.phoneRow) els.phoneRow.hidden = !needsCellphone;
    if (els.cellphone) {
      els.cellphone.required = needsCellphone;
      if (!needsCellphone) els.cellphone.value = "";
    }
  }

  function setLoading(loading) {
    if (!els.submit) return;
    els.submit.disabled = loading;
    els.submit.textContent = loading ? "Enviando..." : "Enviar mensagem";
  }

  async function fetchJson(url) {
    const response = await window.fetch(window.mlUrl(url), {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json" },
    });
    return response.json().catch(() => ({}));
  }

  async function hydrateContext() {
    const [authPayload, accountPayload] = await Promise.all([
      fetchJson("/api/auth/me").catch(() => ({})),
      fetchJson("/api/account/current").catch(() => ({})),
    ]);

    const user = authPayload?.user || {};
    const current = accountPayload?.current || {};
    const accountLabel =
      accountPayload?.label || current?.label || "Nenhuma conta selecionada";

    if (els.userEmail) {
      els.userEmail.textContent = user.email || "Email do login indisponivel";
    }
    if (els.userName) {
      els.userName.textContent = user.nome || "Usuario DAVANTTI";
    }
    if (els.sideAccount) {
      els.sideAccount.textContent = accountLabel;
    }
    if (els.accountPill) {
      els.accountPill.textContent = `Conta: ${accountLabel}`;
    }
    if (els.accountLabel) {
      els.accountLabel.value = accountLabel;
    }
    if (els.accountId) {
      els.accountId.value = current?.id || "";
    }
    if (els.meliUserId) {
      els.meliUserId.value = current?.meli_user_id || "";
    }
    if (els.pagePath) {
      const base = String(window.ML?.base || window.__ML_BASE__ || "");
      const pathname = String(window.location.pathname || "/");
      els.pagePath.value =
        base && pathname.startsWith(base) ? pathname.slice(base.length) || "/" : pathname;
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setFeedback("", "");

    const payload = {
      topic: els.topic?.value || "duvidas",
      message: (els.message?.value || "").trim(),
      reply_preference: selectedReplyPreference(),
      cellphone: (els.cellphone?.value || "").trim(),
      account_label: els.accountLabel?.value || "",
      account_id: els.accountId?.value || "",
      meli_user_id: els.meliUserId?.value || "",
      page_path: els.pagePath?.value || "",
    };

    setLoading(true);
    window.MLLoadingOverlay?.show({
      label: "Enviando mensagem",
      text: "Preparando seu contexto e encaminhando para o suporte.",
      context: "Ajuda e contato",
      target: 88,
    });

    try {
      const response = await window.fetch(window.mlUrl("/api/contact/help"), {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) {
        throw new Error(
          data?.error || "Nao foi possivel enviar sua mensagem agora.",
        );
      }

      setFeedback("success", data?.message || "Mensagem enviada com sucesso.");
      if (els.message) els.message.value = "";
      if (payload.reply_preference === "cellphone" && els.cellphone) {
        els.cellphone.value = "";
      }
    } catch (error) {
      setFeedback(
        "error",
        error?.message || "Nao foi possivel enviar sua mensagem agora.",
      );
    } finally {
      setLoading(false);
      window.MLLoadingOverlay?.hide();
    }
  }

  function bind() {
    document
      .querySelectorAll('input[name="reply_preference"]')
      .forEach((input) => {
        input.addEventListener("change", togglePhoneField);
      });

    els.form?.addEventListener("submit", handleSubmit);
    togglePhoneField();
  }

  async function init() {
    bind();
    await hydrateContext();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
