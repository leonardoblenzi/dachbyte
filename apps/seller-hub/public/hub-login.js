// @ts-check
(function () {
  "use strict";

  const card = /** @type {HTMLElement} */ (document.querySelector("[data-login]"));
  if (!card) return;
  const returnTo = card.getAttribute("data-return") || "/hub/";
  const form = /** @type {HTMLFormElement} */ (card.querySelector("[data-login-form]"));
  const errorBox = /** @type {HTMLElement} */ (card.querySelector("[data-login-error]"));
  const companies = /** @type {HTMLElement} */ (card.querySelector("[data-login-companies]"));
  const companyList = /** @type {HTMLElement} */ (card.querySelector("[data-login-company-list]"));
  /** @type {string} */
  let ticket = "";

  /** @param {string} message */
  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  /** @param {string} path @param {Record<string, any>} body */
  async function post(path, body) {
    const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ ...body, volta: returnTo }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.message || "Não foi possível entrar. Tente de novo.");
    return data;
  }

  /** @param {HTMLButtonElement | null} button @param {boolean} isBusy @param {string} [label] */
  function busy(button, isBusy, label) {
    if (!button) return;
    if (isBusy) { button.dataset.label = button.innerHTML; button.disabled = true; button.textContent = label || "Entrando…"; }
    else { button.disabled = false; if (button.dataset.label) button.innerHTML = button.dataset.label; }
  }

  /** @param {{ tenantId: string, companyName: string }[]} list */
  function chooseCompany(list) {
    companyList.innerHTML = "";
    for (const company of list) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "seller-btn hub-login__company";
      button.textContent = company.companyName;
      button.addEventListener("click", async () => {
        showError("");
        busy(button, true);
        try { location.assign((await post("/hub/api/session/tenant", { ticket, tenantId: company.tenantId })).redirect); }
        catch (error) { busy(button, false); showError(/** @type {Error} */ (error).message); }
      });
      companyList.appendChild(button);
    }
    form.hidden = true;
    companies.hidden = false;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showError("");
    const email = String(new FormData(form).get("email") || "").trim();
    const password = String(new FormData(form).get("password") || "");
    if (!email || !password) { showError("Informe e-mail e senha."); return; }
    const button = /** @type {HTMLButtonElement} */ (form.querySelector("button[type=submit]"));
    busy(button, true);
    try {
      const data = await post("/hub/api/session", { email, password });
      if (data.choose) { ticket = data.ticket; busy(button, false); chooseCompany(data.choose); return; }
      location.assign(data.redirect);
    } catch (error) {
      busy(button, false);
      showError(/** @type {Error} */ (error).message);
    }
  });

  card.querySelector("[data-login-back]")?.addEventListener("click", () => {
    ticket = "";
    companies.hidden = true;
    form.hidden = false;
  });

  const suite = /** @type {HTMLButtonElement | null} */ (card.querySelector("[data-login-suite]"));
  suite?.addEventListener("click", async () => {
    showError("");
    busy(suite, true);
    try { location.assign((await post("/hub/api/session/suite", {})).redirect); }
    catch (error) { busy(suite, false); showError(/** @type {Error} */ (error).message); }
  });
})();
