// ml/public/js/ml-base.js
// ✅ Base helper + auto-prefix para suite (/ml) vs standalone ("")
// ✅ Intercepta fetch() e XHR para evitar 404 por falta de /ml
(() => {
  "use strict";

  function injectAsset(tagName, attrs) {
    const refAttr = attrs.href ? "href" : attrs.src ? "src" : null;
    const exists = refAttr
      ? document.querySelector(`${tagName}[${refAttr}="${attrs[refAttr]}"]`)
      : null;
    if (exists) return;

    const node = document.createElement(tagName);
    Object.entries(attrs).forEach(([key, value]) => {
      node.setAttribute(key, value);
    });
    document.head.appendChild(node);
  }

  // Base real onde o app está montado
  // - suite:   /ml/login      -> base "/ml"
  // - teste:   /ml-teste/...  -> base "/ml-teste"
  // - local:   /login         -> base ""
  function detectBase() {
    const p = String(window.location.pathname || "/");
    if (p.startsWith("/ml/") || p === "/ml") return "/ml";

    const prefixedRoute = p.match(
      /^\/([^/]+)\/(?:api|login|cadastro|ativar|esqueci-senha|redefinir-senha|selecao-plataforma|privacidade|privacy|politica-de-privacidade|select-conta|vincular-conta|painel|dashboard|projecao-mensal|publicidade|reputacao|filtro-anuncios|anuncios|estoque|ranking-anuncios|clonar-anuncio|excluir-anuncio|gestao-anuncios|modelo-massa|caracteristicas|validar-dimensoes|prazo|atacado|criar-promocao|remover-promocao|ia-analytics|analise-mercado|logistica|fiscal|financeiro|ajuda|conta|admin)(?:\/|$)/i,
    );

    if (prefixedRoute && prefixedRoute[1]) {
      return `/${prefixedRoute[1]}`;
    }

    return "";
  }

  function normalizePath(path) {
    return String(path || "/").replace(/\/+$/, "") || "/";
  }

  const SHELL_DISABLED_PATHS = [
    "/",
    "/login",
    "/cadastro",
    "/ativar",
    "/esqueci-senha",
    "/redefinir-senha",
    "/selecao-plataforma",
    "/privacidade",
    "/privacidade/davantti-cloner",
    "/privacy/davantti-cloner",
    "/privacy",
    "/politica-de-privacidade/davantti-cloner",
    "/politica-de-privacidade",
    "/vincular-conta",
    "/nao-autorizado",
  ];

  function isShellDisabledPath(pathname) {
    const normalized = normalizePath(pathname);
    return SHELL_DISABLED_PATHS.some((path) => normalizePath(path) === normalized);
  }

  const base = window.__ML_BASE__ ?? detectBase();
  const currentPath = (() => {
    const pathname = normalizePath(window.location.pathname || "/");
    if (base && pathname.startsWith(base)) {
      const sliced = pathname.slice(base.length);
      return normalizePath(sliced || "/");
    }
    return pathname;
  })();

  const SHELL_PATH_PREFIXES = [
    "/painel",
    "/select-conta",
    "/projecao-mensal",
    "/dashboard",
    "/publicidade",
    "/reputacao",
    "/filtro-anuncios",
    "/anuncios/cadastro",
    "/estoque",
    "/ranking-anuncios",
    "/clonar-anuncio",
    "/excluir-anuncio",
    "/gestao-anuncios",
    "/modelo-massa",
    "/caracteristicas",
    "/validar-dimensoes",
    "/prazo",
    "/atacado",
    "/criar-promocao",
    "/remover-promocao",
    "/ia-analytics/curva-abc",
    "/analise-mercado",
    "/logistica",
    "/fiscal",
    "/financeiro",
    "/ajuda",
    "/conta",
    "/admin",
  ];

  function shouldPrepareShell(pathname) {
    const normalized = normalizePath(pathname);
    if (isShellDisabledPath(normalized)) return false;
    return SHELL_PATH_PREFIXES.some((prefix) => (
      normalized === prefix || normalized.startsWith(prefix + "/")
    ));
  }

  const shellDisabled =
    Boolean(window.__ML_DISABLE_SHELL__) || isShellDisabledPath(currentPath);

  const shellPending = !shellDisabled && shouldPrepareShell(currentPath);

  function releaseShellPending() {
    document.documentElement.classList.remove("ml-shell-pending");
  }

  if (shellPending) {
    document.documentElement.classList.add("ml-shell-pending");
    window.setTimeout(() => {
      if (!document.body?.classList.contains("ml-shell-ready")) {
        releaseShellPending();
      }
    }, 2500);
  }

  // compat (código antigo usa isso)
  window.ML_BASE = base;
  window.__ML_BASE__ = base;
  window.__ML_RELEASE_SHELL_PENDING__ = releaseShellPending;

  function withBase(url) {
    if (!url) return url;

    // Request object (fetch)
    if (typeof url === "object" && url.url) {
      return new Request(withBase(url.url), url);
    }

    if (typeof url !== "string") return url;

    // Não mexe em URL absoluta
    if (
      url.startsWith("http://") ||
      url.startsWith("https://") ||
      url.startsWith("//")
    ) {
      return url;
    }

    // Já está com base
    if (base && (url === base || url.startsWith(base + "/"))) return url;

    // Só prefixa quando é caminho absoluto do site
    if (url.startsWith("/")) return base + url;

    return url;
  }

  function ensureModuleFavicon() {
    // The marketplace remains contextual in the UI, while the browser identity
    // is the DACHBYTE Seller product family.
    const faviconHref = withBase("/img/dachbyte-seller-mark.svg?v=1");
    const iconLinks = Array.from(
      document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]'),
    );

    if (!iconLinks.length) {
      injectAsset("link", {
        rel: "icon",
        type: "image/png",
        href: faviconHref,
      });
      return;
    }

    iconLinks.forEach((link) => {
      link.setAttribute("rel", "icon");
      link.setAttribute("type", "image/png");
      link.setAttribute("href", faviconHref);
    });
  }

  // Helper antigo (mantém)
  window.mlUrl = function mlUrl(path) {
    if (!path) return base || "/";
    return withBase(path);
  };
  window.withBase = withBase;

  // Helper novo (pra padronizar daqui pra frente)
  window.ML = window.ML || {};
  window.ML.base = base;
  window.ML.url = (p) => withBase(p);

  ensureModuleFavicon();
  // A number of legacy screens still ship static document titles. Normalizing
  // at the shared shell keeps their entrypoints and server routes untouched.
  if (document.title) {
    document.title = document.title.replace(/Davantti(?: Commerce Suite| ML)?/gi, "DACHBYTE Seller");
  }

  if (!shellDisabled) {
    injectAsset("link", {
      rel: "stylesheet",
      href: withBase("/css/ml-shell.css?v=28"),
    });

    injectAsset("script", {
      src: withBase("/js/ml-shell.js?v=36"),
      defer: "defer",
    });

    injectAsset("script", {
      src: withBase("/js/ml-shell-alerts-fix.js?v=2"),
      defer: "defer",
    });
  }

  injectAsset("link", {
    rel: "stylesheet",
    href: withBase("/css/ml-loading.css?v=5"),
  });

  // Camada visual consolidada carregada por ultimo para que os modulos
  // compartilhem a mesma hierarquia white/dark sem depender de overrides legados.
  injectAsset("link", {
    rel: "stylesheet",
    href: withBase("/css/ml-ui-v3.css?v=2026081002"),
  });

  // -----------------------
  // Loading overlay global
  // -----------------------
  (function initLoadingOverlay() {
    if (window.MLLoadingOverlay) return;

    const state = {
      depth: 0,
      hideTimer: null,
      progressTimer: null,
      textTimer: null,
      progress: 0,
      target: 92,
      texts: [],
      textIndex: 0,
      els: null,
    };

    const clamp = (value, min, max) =>
      Math.max(min, Math.min(max, Number(value) || 0));

    function ensure() {
      if (state.els) return state.els;

      const root = document.createElement("div");
      root.id = "ml-loading-screen";
      root.className = "ml-loading-screen";
      root.hidden = true;
      root.setAttribute("aria-live", "polite");
      root.setAttribute("aria-busy", "true");
      root.innerHTML = `
        <div class="ml-loading-screen__content">
          <div class="ml-loading-screen__panel">
            <div id="ml-loading-context" class="ml-loading-screen__context" hidden></div>
            <div class="ml-loading-screen__head">
              <div class="ml-loading-screen__title-wrap">
                <span class="ml-loading-screen__spinner" aria-hidden="true"></span>
                <strong id="ml-loading-label" class="ml-loading-screen__label">Atualizando dados</strong>
              </div>
              <span id="ml-loading-percent" class="ml-loading-screen__percent">18%</span>
            </div>
            <div id="ml-loading-text" class="ml-loading-screen__text">Carregando dados...</div>
            <div id="ml-loading-track" class="ml-loading-screen__track">
              <span id="ml-loading-bar" class="ml-loading-screen__bar" style="width:18%"></span>
            </div>
          </div>
        </div>
      `;

      (document.body || document.documentElement).appendChild(root);

      state.els = {
        root,
        bar: root.querySelector("#ml-loading-bar"),
        percent: root.querySelector("#ml-loading-percent"),
        label: root.querySelector("#ml-loading-label"),
        text: root.querySelector("#ml-loading-text"),
        context: root.querySelector("#ml-loading-context"),
      };

      return state.els;
    }

    function setProgress(value) {
      const els = ensure();
      state.progress = clamp(value, 0, 100);
      els.bar.style.width = `${state.progress}%`;
      els.percent.textContent = `${Math.round(state.progress)}%`;
    }

    function setText(value) {
      const els = ensure();
      els.text.textContent = value || "Carregando dados...";
    }

    function setLabel(value) {
      const els = ensure();
      els.label.textContent =
        value && value !== "Loading..." ? value : "Atualizando dados";
    }

    function setContext(value) {
      const els = ensure();
      if (value) {
        els.context.hidden = false;
        els.context.textContent = value;
      } else {
        els.context.hidden = true;
        els.context.textContent = "";
      }
    }

    function stopLoops() {
      clearInterval(state.progressTimer);
      clearInterval(state.textTimer);
      state.progressTimer = null;
      state.textTimer = null;
    }

    function startProgressLoop() {
      clearInterval(state.progressTimer);
      state.progressTimer = setInterval(() => {
        if (state.depth <= 0) return;
        const gap = state.target - state.progress;
        if (gap <= 0.8) return;

        const step =
          gap > 38 ? 6.8 : gap > 24 ? 4.4 : gap > 12 ? 2.4 : 1.1;

        setProgress(Math.min(state.target, state.progress + step));
      }, 180);
    }

    function startTextLoop() {
      clearInterval(state.textTimer);
      if (!Array.isArray(state.texts) || state.texts.length <= 1) return;

      state.textTimer = setInterval(() => {
        if (state.depth <= 0) return;
        state.textIndex = (state.textIndex + 1) % state.texts.length;
        setText(state.texts[state.textIndex]);
      }, 2400);
    }

    function show(options = {}) {
      const els = ensure();

      clearTimeout(state.hideTimer);
      state.hideTimer = null;
      state.depth += 1;

      state.texts =
        Array.isArray(options.texts) && options.texts.length
          ? options.texts.slice()
          : [options.message || "Carregando dados..."];
      state.textIndex = 0;
      state.target = clamp(options.maxProgress || 92, 30, 99);

      setContext(options.context || "");
      setLabel(options.label || "Atualizando dados");
      setText(options.message || state.texts[0] || "Carregando dados...");

      const initial = clamp(options.initialProgress || 18, 6, state.target);
      if (state.progress < initial || state.depth === 1) {
        setProgress(initial);
      }

      els.root.hidden = false;
      requestAnimationFrame(() => {
        els.root.classList.add("is-visible");
      });

      startProgressLoop();
      startTextLoop();
    }

    function hide(force = false) {
      const els = ensure();

      if (force) state.depth = 0;
      else state.depth = Math.max(0, state.depth - 1);

      if (state.depth > 0) return;

      stopLoops();
      setProgress(100);

      clearTimeout(state.hideTimer);
      state.hideTimer = setTimeout(() => {
        els.root.classList.remove("is-visible");
        state.hideTimer = setTimeout(() => {
          if (state.depth > 0) return;
          els.root.hidden = true;
          setProgress(0);
          setText("Carregando dados...");
          setContext("");
        }, 220);
      }, 140);
    }

    function update(options = {}) {
      if (options.context !== undefined) setContext(options.context);
      if (options.label !== undefined) setLabel(options.label);
      if (options.message !== undefined) setText(options.message);
      if (Number.isFinite(Number(options.progress))) {
        setProgress(clamp(options.progress, 0, 100));
      }
      if (Array.isArray(options.texts) && options.texts.length) {
        state.texts = options.texts.slice();
        state.textIndex = 0;
        setText(state.texts[0]);
        startTextLoop();
      }
    }

    window.MLLoadingOverlay = { show, hide, update };
  })();

  // -----------------------
  // Patch do fetch
  // -----------------------
  if (typeof window.fetch === "function") {
    const originalFetch = window.fetch.bind(window);
    const shouldRedirectForPayment = (payload) => {
      const code = String(payload?.code || payload?.reason || "").toUpperCase();
      return (
        code === "PAYMENT_REQUIRED" ||
        code === "SUBSCRIPTION_INACTIVE" ||
        /payment|required|assinatura|subscription/i.test(
          String(payload?.error || payload?.message || ""),
        )
      );
    };
    const redirectToSubscriptionRenewal = () => {
      const path = String(window.location.pathname || "");
      if (path.includes("selecao-plataforma") || path.includes("login")) return;
      const now = Date.now();
      const key = "davantti_payment_required_redirect_at";
      const last = Number(sessionStorage.getItem(key) || 0);
      if (Number.isFinite(last) && now - last < 1500) return;
      sessionStorage.setItem(key, String(now));
      window.location.assign("/selecao-plataforma?subscription=expired");
    };
    const watchPaymentRequired = (response) => {
      if (!response || response.status !== 402) return response;
      response
        .clone()
        .json()
        .then((payload) => {
          if (shouldRedirectForPayment(payload)) redirectToSubscriptionRenewal();
        })
        .catch(() => redirectToSubscriptionRenewal());
      return response;
    };
    window.fetch = (input, init) =>
      originalFetch(withBase(input), init).then(watchPaymentRequired);
  }

  // -----------------------
  // Patch do XHR (caso algum script use axios/XHR)
  // -----------------------
  if (
    window.XMLHttpRequest &&
    XMLHttpRequest.prototype &&
    typeof XMLHttpRequest.prototype.open === "function"
  ) {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
      return origOpen.call(this, method, withBase(url), async, user, password);
    };
  }

  try {
    console.log("✅ ml-base.js ativo | base =", base || "(standalone)");
  } catch {}
})();

