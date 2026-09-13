(function initMlShellAlertsFix() {
  "use strict";

  if (window.__ML_NATIVE_ALERTS_FILTER__ === true) {
    return;
  }

  const STORAGE_KEY = "ml-shell-alerts-view";

  function getMode() {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === "history" ? "history" : "today";
  }

  function setMode(mode) {
    const next = mode === "history" ? "history" : "today";
    window.localStorage.setItem(STORAGE_KEY, next);
    applyAll();
  }

  function ensureHeadActions(panel) {
    const head = panel.querySelector(".ml-shell__alerts-head");
    const refreshButton = panel.querySelector("#shell-alerts-refresh");
    if (!head || !refreshButton) return null;

    let actions = head.querySelector(".ml-shell__alerts-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "ml-shell__alerts-actions";
      head.appendChild(actions);
    }

    let switchWrap = actions.querySelector(".ml-shell__alerts-switch");
    if (!switchWrap) {
      switchWrap = document.createElement("div");
      switchWrap.className = "ml-shell__alerts-switch";
      switchWrap.innerHTML = `
        <button type="button" class="ml-shell__alerts-switch-btn" data-alerts-mode="today">Hoje</button>
        <button type="button" class="ml-shell__alerts-switch-btn" data-alerts-mode="history">Historico</button>
      `;
      actions.appendChild(switchWrap);
    }

    if (refreshButton.parentElement !== actions) {
      actions.appendChild(refreshButton);
    }

    return actions;
  }

  function syncText(panel) {
    const title = panel.querySelector(".ml-shell__alerts-title");
    const subtitle = panel.querySelector(".ml-shell__alerts-subtitle");

    if (title) title.textContent = "Notificacoes";
    panel.setAttribute("aria-label", "Notificacoes");

    if (subtitle) {
      subtitle.textContent = getMode() === "history" ? "Ultimos 7 dias" : "Hoje";
    }
  }

  function ensureFilterEmpty(body) {
    let empty = body.querySelector(".ml-shell__alerts-filter-empty");
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "ml-shell__alerts-empty ml-shell__alerts-filter-empty";
      empty.hidden = true;
      body.appendChild(empty);
    }
    return empty;
  }

  function applyMode(panel) {
    const body = panel.querySelector("#shell-alerts-body");
    if (!body) return;

    const sections = Array.from(body.querySelectorAll(".ml-shell__alerts-section"));
    const mode = getMode();
    const empty = ensureFilterEmpty(body);

    sections.forEach((section) => {
      const heading = (
        section.querySelector(".ml-shell__alerts-day")?.textContent || ""
      )
        .trim()
        .toLowerCase();
      const isToday = heading === "hoje";

      section.hidden = mode === "today" ? !isToday : isToday;
    });

    const visibleSections = sections.filter((section) => !section.hidden);
    empty.hidden = visibleSections.length > 0 || sections.length === 0;
    if (!empty.hidden) {
      empty.textContent =
        mode === "history"
          ? "Nenhuma notificacao historica nos ultimos 7 dias."
          : "Nenhuma notificacao para hoje.";
    }

    panel
      .querySelectorAll(".ml-shell__alerts-switch-btn")
      .forEach((button) => {
        const active = button.getAttribute("data-alerts-mode") === mode;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      });
  }

  function applyAll() {
    document
      .querySelectorAll(".ml-shell__alerts-panel")
      .forEach((panel) => {
        ensureHeadActions(panel);
        syncText(panel);
        applyMode(panel);
      });
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-alerts-mode]");
    if (!button) return;
    event.preventDefault();
    setMode(button.getAttribute("data-alerts-mode"));
  });

  const observer = new MutationObserver(() => {
    window.requestAnimationFrame(applyAll);
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener(
      "DOMContentLoaded",
      () => observer.observe(document.body, { childList: true, subtree: true }),
      { once: true },
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyAll, { once: true });
  } else {
    applyAll();
  }
})();
