// public/js/accountBar.js
// OAuth-only: mostra a conta atual na navbar usando /api/account/current.
// Se não houver conta e não estiver em /select-conta, redireciona pra seleção.

window.AccountBar = (function () {
  let _loaded = false;

  // =========================
  // Base path (/ml) support
  // =========================
  function detectBasePath() {
    // If backend injects an explicit base, prefer it
    const injected = (window.__APP_BASE_PATH || window.__ML_BASE_PATH || "").trim();
    if (injected) {
      const v = injected.startsWith("/") ? injected : `/${injected}`;
      return v.replace(/\/$/, "");
    }

    // Auto-detect by URL path
    const p = String(window.location.pathname || "");
    return p === "/ml" || p.startsWith("/ml/") ? "/ml" : "";
  }

  const BASE = detectBasePath();

  function withBase(path) {
    if (!path) return path;
    if (path.startsWith("http://") || path.startsWith("https://")) return path;
    if (!path.startsWith("/")) return path; // keep relative paths relative
    return BASE ? `${BASE}${path}` : path;
  }

  function pickAccountPayload(j = {}) {
    // esperado: { accountType:'oauth', accountKey:'123', label:'...' }
    const key = j.accountKey || (j.current && j.current.id) || null;
    const label = j.label || (j.current && j.current.label) || "";
    const viewer = j.viewer || {};
    return {
      key,
      label,
      viewer: {
        nivel: String(viewer.nivel || "").trim().toLowerCase(),
        is_master: viewer.is_master === true,
      },
    };
  }

  async function load(options = {}) {
    const force = options === true || options?.force === true;
    if (!force && _loaded && window.__ACCOUNT__) return window.__ACCOUNT__;

    const lbl =
      document.querySelector("[data-account-label]") ||
      document.getElementById("account-current");
    // Suporta variações de markup (muitas telas usam só id="account-switch")
    const btn =
      document.querySelector("[data-account-switch]") ||
      document.getElementById("account-switch");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const r = await fetch(withBase("/api/account/current"), {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const ct = String(r.headers.get("content-type") || "");
      if (!ct.includes("application/json")) {
        if (lbl) lbl.textContent = "indisponível";
        return null;
      }

      const j = await r.json().catch(() => ({}));
      const acc = pickAccountPayload(j);

      if (acc.key) {
        if (lbl) lbl.textContent = acc.label || "Conta selecionada";
        window.__ACCOUNT__ = {
          key: String(acc.key),
          label: String(acc.label || "").trim() || "Conta selecionada",
          viewer: acc.viewer,
        };
      } else {
        if (lbl) lbl.textContent = "nenhuma";
        if (!String(location.pathname || "").endsWith("/select-conta")) {
          location.replace(withBase("/select-conta"));
        }
        return null;
      }
    } catch (e) {
      clearTimeout(timeoutId);
      if (lbl) lbl.textContent = e?.name === "AbortError" ? "tempo esgotado" : "erro";
      // em erro, não redireciona automaticamente pra evitar loop off-line
      return null;
    }

    // Handler robusto (delegação): cobre telas que renderizam o botão de formas diferentes
    // e garante /ml/select-conta quando o app roda na suite.
    const handleSwitch = async (ev) => {
      const t = ev?.target;
      const hit =
        t?.closest?.("[data-account-switch]") || t?.closest?.("#account-switch");
      if (!hit) return;

      ev.preventDefault();
      ev.stopPropagation();

      let isMaster = false;
      try {
        const meResponse = await fetch(withBase("/api/auth/me"), {
          method: "GET",
          credentials: "include",
          headers: { accept: "application/json" },
        });
        const me = await meResponse.json().catch(() => null);
        isMaster = me?.flags?.is_master === true || me?.is_master === true;
      } catch {}

      if (isMaster) {
        try {
          await fetch(withBase("/api/meli/limpar-selecao"), {
            method: "POST",
            credentials: "include",
          });
        } catch {}

        const target = withBase("/select-conta");
        if (!String(location.pathname || "").endsWith("/select-conta")) {
          window.location.href = target;
        }
        return;
      }

      try {
        await fetch(withBase("/api/auth/logout"), {
          method: "POST",
          credentials: "include",
        });
      } catch {}

      window.location.href = "/selecao-plataforma";
    };

    // 1) se o botão existe, liga direto
    if (btn) btn.addEventListener("click", handleSwitch);
    // 2) fallback universal (captura)
    document.addEventListener("click", handleSwitch, true);

    _loaded = true;
    return window.__ACCOUNT__;
  }

  async function ensure(options = {}) {
    const force = options === true || options?.force === true;
    if (force || !window.__ACCOUNT__) return await load({ force });
    return window.__ACCOUNT__;
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (!_loaded) load();
  });

  return { load, ensure };
})();

