(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let active = "pricing";
  const choices = new Set(["pricing", "available", "participating"]);
  function tabFromUrl() {
    const name = new URLSearchParams(location.search).get("aba");
    return ({ precificacao: "pricing", disponiveis: "available", participando: "participating" })[name] || "pricing";
  }
  function mount() {
    const parent = $("mg-promotions-page");
    const pricing = $("mg-promo-prices-page");
    const campaigns = $("mg-promotions-campaign-content");
    if (!parent || !pricing || !campaigns) return;
    parent.appendChild(pricing);
    const tabs = [...document.querySelectorAll("[data-campaigns-tab]")];
    function activate(next, updateUrl = true) {
      active = choices.has(next) ? next : "available";
      for (const button of tabs) {
        const selected = button.dataset.campaignsTab === active;
        button.classList.toggle("is-active", selected);
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
      }
      campaigns.hidden = active === "pricing";
      pricing.hidden = active !== "pricing";
      if (updateUrl) {
        const url = new URL(location.href);
        if (active === "pricing") url.searchParams.set("aba", "precificacao");
        else if (active === "participating") url.searchParams.set("aba", "participando");
        else url.searchParams.delete("aba");
        history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
      window.dispatchEvent(new CustomEvent("magalu:campaignstab", { detail: { tab: active } }));
    }
    tabs.forEach((button) => button.addEventListener("click", () => activate(button.dataset.campaignsTab)));
    // Aciona a lógica de filtro já existente da aba Participando, sem duplicá-la.
    const requested = tabFromUrl();
    if (requested === "participating") $("mg-promotions-page")?.querySelector('[data-promotions-tab="participating"]')?.click();
    else activate(requested, false);
    window.addEventListener("popstate", () => {
      const next = tabFromUrl();
      if (next === "participating") $("mg-promotions-page")?.querySelector('[data-promotions-tab="participating"]')?.click();
      else if (next === "available") $("mg-promotions-page")?.querySelector('[data-promotions-tab="available"]')?.click();
      else activate("pricing", false);
    });
  }
  window.MagaluCampaignTabs = Object.freeze({ activeTab: () => active });
  document.addEventListener("DOMContentLoaded", mount);
})();
