(function () {
  "use strict";

  if (window.__DAVANTTI_SUPPORT_WIDGET_LOADED__) return;
  if (/^\/sacdavantti(?:\/|$)/i.test(window.location.pathname)) return;
  window.__DAVANTTI_SUPPORT_WIDGET_LOADED__ = true;

  var API_BASE = String(window.DAVANTTI_SUPPORT_API_BASE || "").replace(/\/+$/, "");
  var CHAT_KEY = "davantti:sac:chat-id";
  var TICKET_KEY = "davantti:sac:ticket";
  var LAUNCHER_TOP_KEY = "davantti:sac:launcher-top";
  var CATEGORIES = [
    "Contratação",
    "Bugs/Problemas na plataforma",
    "Erros de processos",
    "Solicitação de melhoria",
  ];
  var SUBCATEGORIES = [
    "DACHBYTE Seller · Mercado Livre",
    "DACHBYTE Seller · Shopee",
    "Avantracking",
    "LogiSync",
    "MadeiraMadeira",
    "DACHBYTE Business",
    "DACHBYTE Chat",
    "DACHBYTE Stock",
  ];

  var state = {
    open: false,
    screen: "home",
    status: null,
    loading: false,
    error: "",
    success: "",
    chat: null,
    ticket: null,
    lookup: restoreTicketLookup(),
    launcherTop: restoreLauncherTop(),
    chatDraft: "",
    ticketDraft: "",
  };

  var launcherDrag = {
    active: false,
    moved: false,
    suppressClick: false,
    pointerId: null,
    startY: 0,
    startTop: 0,
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function api(path, options) {
    return fetch(API_BASE + "/api/sac" + path, Object.assign({
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
    }, options || {})).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || payload.ok === false) {
          var error = new Error(payload.error || "Falha no suporte DACHBYTE.");
          error.payload = payload;
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  function restoreTicketLookup() {
    try {
      var parsed = JSON.parse(localStorage.getItem(TICKET_KEY) || "{}");
      return {
        protocol: parsed.protocol || new URLSearchParams(window.location.search).get("sacTicket") || "",
        email: parsed.email || "",
      };
    } catch (_error) {
      return {
        protocol: new URLSearchParams(window.location.search).get("sacTicket") || "",
        email: "",
      };
    }
  }

  function saveTicketLookup(protocol, email) {
    state.lookup = { protocol: protocol || "", email: email || "" };
    localStorage.setItem(TICKET_KEY, JSON.stringify(state.lookup));
  }

  function pageMeta() {
    return {
      pageUrl: window.location.href,
      sourceModule: inferModule(),
    };
  }

  function inferModule() {
    var text = (window.location.href || "").toLowerCase();
    if (text.indexOf("/shopee") >= 0) return "DACHBYTE Seller · Shopee";
    if (text.indexOf("/avantracking") >= 0) return "Avantracking";
    if (text.indexOf("/davanttilog") >= 0) return "DACHBYTE Log";
    if (text.indexOf("/madeiramadeira") >= 0) return "MadeiraMadeira";
    if (text.indexOf("/voltstock") >= 0) return "DACHBYTE Stock";
    if (text.indexOf("/voltchat") >= 0 || text.indexOf("/chat") >= 0) return "DACHBYTE Chat";
    if (text.indexOf("volt") >= 0) return "DACHBYTE Business";
    if (text.indexOf("/ml") >= 0) return "DACHBYTE Seller · Mercado Livre";
    return "DACHBYTE";
  }

  function formData(form) {
    var data = {};
    Array.prototype.forEach.call(new FormData(form).entries(), function (entry) {
      data[entry[0]] = entry[1];
    });
    return data;
  }

  function fieldValue(form, selector) {
    var field = form && form.querySelector ? form.querySelector(selector) : null;
    return field ? String(field.value || "").trim() : "";
  }

  function ensureCustomerPayload(form, payload) {
    payload.customerName = String(payload.customerName || fieldValue(form, "[name='customerName']")).trim();
    payload.companyName = String(payload.companyName || fieldValue(form, "[name='companyName']")).trim();
    payload.email = String(payload.email || fieldValue(form, "[name='email']")).trim();
    payload.category = String(payload.category || fieldValue(form, "[name='category']")).trim();
    payload.subcategory = String(payload.subcategory || fieldValue(form, "[name='subcategory']")).trim();
    payload.message = String(payload.message || fieldValue(form, "[name='message']")).trim();
    return payload;
  }

  function clampLauncherTop(value) {
    var viewportHeight = Math.max(window.innerHeight || 0, 320);
    var min = 72;
    var max = Math.max(min, viewportHeight - 72);
    var next = Number(value);
    if (!Number.isFinite(next)) next = Math.round(viewportHeight * 0.58);
    return Math.min(max, Math.max(min, next));
  }

  function restoreLauncherTop() {
    try {
      return clampLauncherTop(Number(localStorage.getItem(LAUNCHER_TOP_KEY)));
    } catch (_error) {
      return clampLauncherTop(null);
    }
  }

  function saveLauncherTop(value) {
    state.launcherTop = clampLauncherTop(value);
    try {
      localStorage.setItem(LAUNCHER_TOP_KEY, String(Math.round(state.launcherTop)));
    } catch (_error) {}
    applyLauncherPosition();
  }

  function applyLauncherPosition() {
    var root = document.getElementById("dvt-sac-root");
    if (!root) return;
    root.style.setProperty("--dvt-sac-launcher-top", Math.round(state.launcherTop) + "px");
  }

  function setError(error) {
    state.error = error && error.message ? error.message : String(error || "");
    state.success = "";
    state.loading = false;
    render();
  }

  function setSuccess(message) {
    state.success = message || "";
    state.error = "";
    state.loading = false;
    render();
  }

  function setScreen(screen) {
    state.screen = screen;
    state.error = "";
    state.success = "";
    render();
  }

  function loadStatus() {
    return api("/status")
      .then(function (payload) {
        state.status = payload.support || null;
        if (payload.support && payload.support.categories) CATEGORIES = payload.support.categories;
        if (payload.support && payload.support.subcategories) SUBCATEGORIES = payload.support.subcategories;
        render();
      })
      .catch(function () {
        state.status = {
          open: false,
          schedule: "Segunda a sexta, das 8h as 22h",
          message: "Nao foi possivel consultar o status do atendimento. Voce ainda pode tentar abrir um ticket.",
        };
        render();
      });
  }

  function loadStoredChat() {
    var chatId = localStorage.getItem(CHAT_KEY);
    if (!chatId) return Promise.resolve(null);
    return api("/chats/" + encodeURIComponent(chatId))
      .then(function (payload) {
        state.chat = payload.chat;
        if (payload.chat && payload.chat.status === "closed") {
          localStorage.removeItem(CHAT_KEY);
        }
        render();
        return payload.chat;
      })
      .catch(function () {
        localStorage.removeItem(CHAT_KEY);
        state.chat = null;
        render();
      });
  }

  function loadTicket(protocol, email) {
    if (!protocol || !email) return Promise.resolve(null);
    return api("/tickets/" + encodeURIComponent(protocol) + "?email=" + encodeURIComponent(email))
      .then(function (payload) {
        state.ticket = payload.ticket;
        saveTicketLookup(protocol, email);
        render();
        return payload.ticket;
      });
  }

  function renderMessage(message) {
    var cls = "dvt-sac-message";
    if (message.author === "customer") cls += " is-customer";
    else if (message.author === "admin") cls += " is-admin";
    else cls += " is-system";
    return [
      '<div class="' + cls + '">',
      '<span class="dvt-sac-message-meta">' + escapeHtml(message.authorName || message.author || "Sistema") + "</span>",
      escapeHtml(message.text || ""),
      "</div>",
    ].join("");
  }

  function captureDrafts() {
    var root = document.getElementById("dvt-sac-root");
    if (!root) return;
    var chatMessage = root.querySelector("#dvt-sac-chat-message-form [name='message']");
    var ticketMessage = root.querySelector("#dvt-sac-ticket-message-form [name='message']");
    if (chatMessage) state.chatDraft = String(chatMessage.value || "");
    if (ticketMessage) state.ticketDraft = String(ticketMessage.value || "");
  }

  function chatStatusLabel(status) {
    var value = String(status || "").toLowerCase();
    if (value === "queued") return "Aguardando atendente";
    if (value === "open") return "Em atendimento";
    if (value === "closed") return "Encerrado";
    return status || "Aguardando atendente";
  }

  function categoryFields(prefix, selectedCategory) {
    var category = selectedCategory || "";
    var inferredSubcategory = inferModule();
    if (SUBCATEGORIES.indexOf(inferredSubcategory) < 0) inferredSubcategory = "";
    var categoryOptions = CATEGORIES.map(function (item) {
      return '<option value="' + escapeHtml(item) + '"' + (item === category ? " selected" : "") + ">" + escapeHtml(item) + "</option>";
    }).join("");
    var subOptions = SUBCATEGORIES.map(function (item) {
      return '<option value="' + escapeHtml(item) + '"' + (item === inferredSubcategory ? " selected" : "") + ">" + escapeHtml(item) + "</option>";
    }).join("");
    return [
      '<div class="dvt-sac-field">',
      '<label for="' + prefix + '-category">Categoria</label>',
      '<select id="' + prefix + '-category" name="category" required data-category-select>',
      '<option value="">Selecione</option>',
      categoryOptions,
      "</select>",
      "</div>",
      '<div class="dvt-sac-field" data-subcategory-field>',
      '<label for="' + prefix + '-subcategory">Subcategoria</label>',
      '<select id="' + prefix + '-subcategory" name="subcategory">',
      '<option value="">Selecione</option>',
      subOptions,
      "</select>",
      "</div>",
    ].join("");
  }

  function commonCustomerFields(prefix, ticket) {
    return [
      '<div class="dvt-sac-field">',
      '<label for="' + prefix + '-name">Seu nome</label>',
      '<input id="' + prefix + '-name" name="customerName" autocomplete="name" required>',
      "</div>",
      '<div class="dvt-sac-field">',
      '<label for="' + prefix + '-company">Empresa</label>',
      '<input id="' + prefix + '-company" name="companyName" autocomplete="organization" required>',
      "</div>",
      '<div class="dvt-sac-field">',
      '<label for="' + prefix + '-email">E-mail' + (ticket ? "" : " (opcional)") + "</label>",
      '<input id="' + prefix + '-email" name="email" autocomplete="email"' + (ticket ? " required" : "") + ">",
      "</div>",
      '<div class="dvt-sac-field">',
      '<label for="' + prefix + '-whatsapp">WhatsApp (opcional)</label>',
      '<input id="' + prefix + '-whatsapp" name="whatsapp" inputmode="tel" autocomplete="tel">',
      "</div>",
    ].join("");
  }

  function homeScreen() {
    var status = state.status || {};
    var open = Boolean(status.open);
    var hasChat = state.chat && state.chat.status !== "closed";
    return [
      '<div class="dvt-sac-card">',
      '<div class="dvt-sac-status"><span class="dvt-sac-dot ' + (open ? "is-on" : "") + '"></span><span>' + escapeHtml(status.message || "Consultando atendimento...") + "</span></div>",
      '<p class="dvt-sac-muted">Horario: ' + escapeHtml(status.schedule || "Segunda a sexta, das 8h as 22h") + ".</p>",
      hasChat ? '<button class="dvt-sac-primary" data-screen="chat" type="button">Continuar chat ' + escapeHtml(state.chat.protocol || "") + "</button>" : "",
      '<div class="dvt-sac-actions">',
      '<button class="dvt-sac-primary" data-screen="chatForm" type="button" ' + (open ? "" : "disabled") + ">Abrir novo chat</button>",
      '<button class="dvt-sac-secondary" data-screen="ticketForm" type="button">Abrir ticket</button>',
      "</div>",
      !open ? '<div class="dvt-sac-alert" style="margin-top:12px;">Fora do horario de atendimento ao vivo. Abra um ticket e acompanhe pelo protocolo.</div>' : "",
      "</div>",
      '<div class="dvt-sac-card">',
      '<div class="dvt-sac-actions is-stack">',
      '<button class="dvt-sac-ghost" data-screen="ticketLookup" type="button">Consultar ticket</button>',
      "</div>",
      '<p class="dvt-sac-muted">Tickets exigem e-mail e possuem prazo de 48 horas uteis para resposta do usuario apos retorno do suporte.</p>',
      "</div>",
    ].join("");
  }

  function chatFormScreen() {
    return [
      '<form class="dvt-sac-form" id="dvt-sac-chat-form">',
      commonCustomerFields("dvt-chat", false),
      '<div class="dvt-sac-field">',
      '<label for="dvt-chat-title">Titulo (opcional)</label>',
      '<input id="dvt-chat-title" name="title" maxlength="180">',
      "</div>",
      categoryFields("dvt-chat"),
      '<div class="dvt-sac-field">',
      '<label for="dvt-chat-message">Como podemos ajudar?</label>',
      '<textarea id="dvt-chat-message" name="message" required></textarea>',
      "</div>",
      '<div class="dvt-sac-actions">',
      '<button class="dvt-sac-ghost" data-screen="home" type="button">Voltar</button>',
      '<button class="dvt-sac-primary" type="submit">Iniciar chat</button>',
      "</div>",
      "</form>",
    ].join("");
  }

  function ticketFormScreen() {
    return [
      '<form class="dvt-sac-form" id="dvt-sac-ticket-form">',
      commonCustomerFields("dvt-ticket", true),
      '<div class="dvt-sac-field">',
      '<label for="dvt-ticket-title">Titulo</label>',
      '<input id="dvt-ticket-title" name="title" maxlength="180" required>',
      "</div>",
      categoryFields("dvt-ticket"),
      '<div class="dvt-sac-field">',
      '<label for="dvt-ticket-message">Descreva o ticket</label>',
      '<textarea id="dvt-ticket-message" name="message" required></textarea>',
      "</div>",
      '<div class="dvt-sac-alert">Ao receber resposta do suporte, voce tera 48 horas uteis para retornar. Sem resposta, o ticket sera fechado automaticamente.</div>',
      '<div class="dvt-sac-actions">',
      '<button class="dvt-sac-ghost" data-screen="home" type="button">Voltar</button>',
      '<button class="dvt-sac-primary" type="submit">Abrir ticket</button>',
      "</div>",
      "</form>",
    ].join("");
  }

  function chatScreen() {
    var chat = state.chat;
    if (!chat) return '<div class="dvt-sac-card"><p>Carregando chat...</p></div>';
    var messages = (chat.messages || []).map(renderMessage).join("");
    var closed = chat.status === "closed";
    var statusLabel = chatStatusLabel(chat.status);
    return [
      '<div class="dvt-sac-card">',
      '<strong>Chat ao vivo</strong>',
      '<p class="dvt-sac-muted">Protocolo ' + escapeHtml(chat.protocol) + " - " + escapeHtml(statusLabel) + ".</p>",
      !closed && chat.status === "queued" ? '<div class="dvt-sac-alert">Aguardando atendente. Voce ja esta na fila do suporte DACHBYTE.</div>' : "",
      '<div class="dvt-sac-chat-log">' + messages + "</div>",
      closed ? '<div class="dvt-sac-success" style="margin-top:12px;">Chat encerrado. Protocolo: ' + escapeHtml(chat.protocol) + ".</div>" : [
        '<form class="dvt-sac-footer-form" id="dvt-sac-chat-message-form">',
        '<input name="message" placeholder="Digite sua mensagem" value="' + escapeHtml(state.chatDraft || "") + '" required>',
        '<button class="dvt-sac-primary" type="submit">Enviar</button>',
        "</form>",
        '<div class="dvt-sac-actions is-stack">',
        '<button class="dvt-sac-ghost" data-screen="finalizeChat" type="button">Encerrar chat</button>',
        "</div>",
      ].join(""),
      "</div>",
      '<button class="dvt-sac-ghost" data-screen="home" type="button">Voltar</button>',
    ].join("");
  }

  function finalizeChatScreen() {
    return [
      '<form class="dvt-sac-form" id="dvt-sac-finalize-chat-form">',
      '<div class="dvt-sac-field">',
      '<label>Avaliação do atendimento</label>',
      '<select name="rating"><option value="">Opcional</option><option value="5">5 - Excelente</option><option value="4">4 - Bom</option><option value="3">3 - Regular</option><option value="2">2 - Ruim</option><option value="1">1 - Muito ruim</option></select>',
      "</div>",
      '<label class="dvt-sac-check"><input type="checkbox" name="problemResolved" value="true"> O problema foi resolvido</label>',
      '<div class="dvt-sac-field"><label>Comentário opcional</label><textarea name="feedback"></textarea></div>',
      '<label class="dvt-sac-check"><input type="checkbox" name="deleteAuthorized" value="true"> Podemos apagar o conteúdo deste chat? Se confirmar, guardaremos por 5 anos apenas o protocolo e a informação de que você autorizou a exclusão com data e hora.</label>',
      '<label class="dvt-sac-check"><input type="checkbox" name="deleteConfirmed" value="true"> Confirmo minha autorização de apagar o conteúdo do chat</label>',
      '<div class="dvt-sac-actions">',
      '<button class="dvt-sac-ghost" data-screen="chat" type="button">Voltar</button>',
      '<button class="dvt-sac-primary" type="submit">Finalizar</button>',
      "</div>",
      "</form>",
    ].join("");
  }

  function ticketLookupScreen() {
    return [
      '<form class="dvt-sac-form" id="dvt-sac-ticket-lookup-form">',
      '<div class="dvt-sac-field"><label>Protocolo</label><input name="protocol" value="' + escapeHtml(state.lookup.protocol || "") + '" required></div>',
      '<div class="dvt-sac-field"><label>E-mail</label><input name="email" value="' + escapeHtml(state.lookup.email || "") + '" required></div>',
      '<div class="dvt-sac-actions">',
      '<button class="dvt-sac-ghost" data-screen="home" type="button">Voltar</button>',
      '<button class="dvt-sac-primary" type="submit">Consultar</button>',
      "</div>",
      "</form>",
    ].join("");
  }

  function ticketViewScreen() {
    var ticket = state.ticket;
    if (!ticket) return ticketLookupScreen();
    var closed = ticket.status === "closed";
    var messages = (ticket.messages || []).map(renderMessage).join("");
    return [
      '<div class="dvt-sac-card">',
      '<strong>Ticket ' + escapeHtml(ticket.protocol) + "</strong>",
      '<p class="dvt-sac-muted">' + escapeHtml(ticket.title || "") + " | " + escapeHtml(ticket.status || "") + "</p>",
      '<div class="dvt-sac-chat-log">' + messages + "</div>",
      closed ? '<div class="dvt-sac-success" style="margin-top:12px;">Ticket fechado. Protocolo: ' + escapeHtml(ticket.protocol) + ".</div>" : [
        '<form class="dvt-sac-footer-form" id="dvt-sac-ticket-message-form">',
        '<input name="message" placeholder="Responder ticket" value="' + escapeHtml(state.ticketDraft || "") + '" required>',
        '<button class="dvt-sac-primary" type="submit">Enviar</button>',
        "</form>",
        '<p class="dvt-sac-muted">Após resposta do suporte, responda em até 48 horas úteis para evitar fechamento automático.</p>',
        '<div class="dvt-sac-actions is-stack">',
        '<button class="dvt-sac-ghost" data-screen="finalizeTicket" type="button">Finalizar e avaliar ticket</button>',
        "</div>",
      ].join(""),
      "</div>",
      '<button class="dvt-sac-ghost" data-screen="home" type="button">Voltar</button>',
    ].join("");
  }

  function finalizeTicketScreen() {
    return [
      '<form class="dvt-sac-form" id="dvt-sac-finalize-ticket-form">',
      '<div class="dvt-sac-field">',
      '<label>Avaliação do atendimento</label>',
      '<select name="rating"><option value="">Opcional</option><option value="5">5 - Excelente</option><option value="4">4 - Bom</option><option value="3">3 - Regular</option><option value="2">2 - Ruim</option><option value="1">1 - Muito ruim</option></select>',
      "</div>",
      '<label class="dvt-sac-check"><input type="checkbox" name="problemResolved" value="true"> O problema foi resolvido</label>',
      '<div class="dvt-sac-field"><label>Comentário opcional</label><textarea name="feedback"></textarea></div>',
      '<label class="dvt-sac-check"><input type="checkbox" name="deleteAuthorized" value="true"> Podemos apagar o conteúdo deste ticket? Se confirmar, guardaremos por 5 anos apenas o protocolo e a autorização com data e hora.</label>',
      '<label class="dvt-sac-check"><input type="checkbox" name="deleteConfirmed" value="true"> Confirmo minha autorização de apagar o conteúdo do ticket</label>',
      '<div class="dvt-sac-actions">',
      '<button class="dvt-sac-ghost" data-screen="ticketView" type="button">Voltar</button>',
      '<button class="dvt-sac-primary" type="submit">Finalizar</button>',
      "</div>",
      "</form>",
    ].join("");
  }

  function currentScreenHtml() {
    if (state.screen === "chatForm") return chatFormScreen();
    if (state.screen === "ticketForm") return ticketFormScreen();
    if (state.screen === "chat") return chatScreen();
    if (state.screen === "finalizeChat") return finalizeChatScreen();
    if (state.screen === "ticketLookup") return ticketLookupScreen();
    if (state.screen === "ticketView") return ticketViewScreen();
    if (state.screen === "finalizeTicket") return finalizeTicketScreen();
    return homeScreen();
  }

  function render() {
    var root = document.getElementById("dvt-sac-root");
    if (!root) return;
    captureDrafts();
    root.className = "dvt-sac-root" + (state.open ? " is-open" : "");
    applyLauncherPosition();
    root.innerHTML = [
      '<button class="dvt-sac-button" type="button" aria-label="Abrir suporte DACHBYTE" title="Suporte DACHBYTE" data-open-widget data-drag-widget>',
      '<span class="dvt-sac-grip" aria-hidden="true"></span>',
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>',
      '<span class="dvt-sac-tab-text">SAC</span>',
      "</button>",
      '<section class="dvt-sac-panel" aria-label="Suporte DACHBYTE">',
      '<header class="dvt-sac-header">',
      '<div class="dvt-sac-mark">SAC</div>',
      '<div><h2 class="dvt-sac-title">Suporte DACHBYTE</h2><p class="dvt-sac-subtitle">Chat ao vivo e tickets</p></div>',
      '<button class="dvt-sac-close" type="button" aria-label="Fechar" data-close-widget>×</button>',
      "</header>",
      '<div class="dvt-sac-body">',
      state.loading ? '<div class="dvt-sac-card">Processando...</div>' : "",
      state.error ? '<div class="dvt-sac-error">' + escapeHtml(state.error) + "</div>" : "",
      state.success ? '<div class="dvt-sac-success">' + escapeHtml(state.success) + "</div>" : "",
      currentScreenHtml(),
      "</div>",
      "</section>",
    ].join("");
    applyLauncherPosition();
    syncSubcategoryFields();
  }

  function syncSubcategoryFields() {
    var root = document.getElementById("dvt-sac-root");
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll("[data-category-select]"), function (select) {
      var field = select.closest("form").querySelector("[data-subcategory-field]");
      var sub = field ? field.querySelector("select") : null;
      var isHiring = select.value === "Contratação";
      if (field) field.style.display = isHiring ? "none" : "";
      if (sub) sub.required = !isHiring;
    });
  }

  function createRoot() {
    var root = document.createElement("div");
    root.id = "dvt-sac-root";
    document.body.appendChild(root);
    if (state.lookup.protocol) {
      state.open = true;
      state.screen = "ticketLookup";
      loadStatus();
    }
    render();
  }

  function submitChat(form) {
    var payload = ensureCustomerPayload(form, Object.assign(formData(form), pageMeta()));
    if (!payload.customerName) {
      setError("Informe seu nome.");
      return;
    }
    if (!payload.companyName) {
      setError("Informe de qual empresa voce fala.");
      return;
    }
    if (!payload.category) {
      setError("Selecione a categoria.");
      return;
    }
    if (!payload.message) {
      setError("Descreva como podemos ajudar.");
      return;
    }
    state.loading = true;
    render();
    api("/chats", { method: "POST", body: JSON.stringify(payload) })
      .then(function (result) {
        state.chat = result.chat;
        localStorage.setItem(CHAT_KEY, result.chat.id);
        state.screen = "chat";
        setSuccess("Chat iniciado. Protocolo: " + result.chat.protocol + ". Guarde este numero.");
      })
      .catch(setError);
  }

  function submitTicket(form) {
    var payload = ensureCustomerPayload(form, Object.assign(formData(form), pageMeta()));
    if (!payload.email) {
      setError("Informe um e-mail.");
      return;
    }
    state.loading = true;
    render();
    api("/tickets", { method: "POST", body: JSON.stringify(payload) })
      .then(function (result) {
        state.ticket = result.ticket;
        saveTicketLookup(result.ticket.protocol, result.ticket.email);
        state.screen = "ticketView";
        setSuccess("Ticket aberto. Protocolo: " + result.ticket.protocol + ". Enviamos a confirmacao por e-mail quando o SMTP estiver configurado.");
      })
      .catch(setError);
  }

  function submitChatMessage(form) {
    if (!state.chat) return;
    var message = fieldValue(form, "[name='message']") || String(state.chatDraft || "").trim();
    state.chatDraft = message;
    if (!message) {
      setError("Digite a mensagem.");
      return;
    }
    api("/chats/" + encodeURIComponent(state.chat.id) + "/messages", {
      method: "POST",
      body: JSON.stringify({ message: message, customerName: state.chat.customer_name }),
    })
      .then(function (result) {
        state.chat = result.chat;
        state.chatDraft = "";
        render();
      })
      .catch(setError);
  }

  function submitTicketLookup(form) {
    var payload = formData(form);
    state.loading = true;
    render();
    loadTicket(payload.protocol, payload.email)
      .then(function () {
        state.loading = false;
        state.screen = "ticketView";
        render();
      })
      .catch(setError);
  }

  function submitTicketMessage(form) {
    if (!state.ticket) return;
    var message = fieldValue(form, "[name='message']") || String(state.ticketDraft || "").trim();
    state.ticketDraft = message;
    if (!message) {
      setError("Digite a mensagem.");
      return;
    }
    api("/tickets/" + encodeURIComponent(state.ticket.protocol) + "/messages", {
      method: "POST",
      body: JSON.stringify({ email: state.lookup.email || state.ticket.email, message: message }),
    })
      .then(function (result) {
        state.ticket = result.ticket;
        state.ticketDraft = "";
        render();
      })
      .catch(setError);
  }

  function boolField(data, key) {
    return data[key] === "true" || data[key] === true || data[key] === "on";
  }

  function submitFinalizeChat(form) {
    if (!state.chat) return;
    var data = formData(form);
    if (boolField(data, "deleteAuthorized") && !boolField(data, "deleteConfirmed")) {
      setError("Confirme a autorizacao para apagar o conteudo do chat.");
      return;
    }
    api("/chats/" + encodeURIComponent(state.chat.id) + "/finalize", {
      method: "POST",
      body: JSON.stringify({
        rating: data.rating || null,
        problemResolved: boolField(data, "problemResolved"),
        feedback: data.feedback || "",
        deleteAuthorized: boolField(data, "deleteAuthorized"),
      }),
    })
      .then(function (result) {
        state.chat = result.chat;
        localStorage.removeItem(CHAT_KEY);
        state.screen = "chat";
        setSuccess("Chat finalizado. Protocolo: " + result.chat.protocol + ".");
      })
      .catch(setError);
  }

  function submitFinalizeTicket(form) {
    if (!state.ticket) return;
    var data = formData(form);
    if (boolField(data, "deleteAuthorized") && !boolField(data, "deleteConfirmed")) {
      setError("Confirme a autorizacao para apagar o conteudo do ticket.");
      return;
    }
    api("/tickets/" + encodeURIComponent(state.ticket.protocol) + "/finalize", {
      method: "POST",
      body: JSON.stringify({
        email: state.lookup.email || state.ticket.email,
        rating: data.rating || null,
        problemResolved: boolField(data, "problemResolved"),
        feedback: data.feedback || "",
        deleteAuthorized: boolField(data, "deleteAuthorized"),
      }),
    })
      .then(function (result) {
        state.ticket = result.ticket;
        state.screen = "ticketView";
        setSuccess("Ticket finalizado. Protocolo: " + result.ticket.protocol + ".");
      })
      .catch(setError);
  }

  document.addEventListener("click", function (event) {
    var target = event.target.closest && event.target.closest("[data-open-widget],[data-close-widget],[data-screen]");
    if (!target) return;
    if (target.hasAttribute("data-open-widget")) {
      if (launcherDrag.suppressClick) {
        launcherDrag.suppressClick = false;
        event.preventDefault();
        return;
      }
      state.open = true;
      state.error = "";
      render();
      loadStatus();
      loadStoredChat();
      if (state.lookup.protocol && state.lookup.email) {
        loadTicket(state.lookup.protocol, state.lookup.email).catch(function () {});
      }
      return;
    }
    if (target.hasAttribute("data-close-widget")) {
      state.open = false;
      render();
      return;
    }
    var screen = target.getAttribute("data-screen");
    if (screen) setScreen(screen);
  });

  document.addEventListener("pointerdown", function (event) {
    var target = event.target.closest && event.target.closest("[data-drag-widget]");
    if (!target || state.open) return;
    launcherDrag.active = true;
    launcherDrag.moved = false;
    launcherDrag.suppressClick = false;
    launcherDrag.pointerId = event.pointerId;
    launcherDrag.startY = event.clientY;
    launcherDrag.startTop = state.launcherTop;
    if (typeof target.setPointerCapture === "function") {
      target.setPointerCapture(event.pointerId);
    }
  });

  document.addEventListener("pointermove", function (event) {
    if (!launcherDrag.active) return;
    if (launcherDrag.pointerId !== null && event.pointerId !== launcherDrag.pointerId) return;
    var delta = event.clientY - launcherDrag.startY;
    if (Math.abs(delta) > 3) launcherDrag.moved = true;
    if (!launcherDrag.moved) return;
    event.preventDefault();
    saveLauncherTop(launcherDrag.startTop + delta);
  }, { passive: false });

  document.addEventListener("pointerup", function (event) {
    if (!launcherDrag.active) return;
    if (launcherDrag.pointerId !== null && event.pointerId !== launcherDrag.pointerId) return;
    launcherDrag.active = false;
    launcherDrag.pointerId = null;
    if (launcherDrag.moved) {
      launcherDrag.suppressClick = true;
      window.setTimeout(function () {
        launcherDrag.suppressClick = false;
      }, 250);
    }
  });

  document.addEventListener("pointercancel", function () {
    launcherDrag.active = false;
    launcherDrag.pointerId = null;
  });

  window.addEventListener("resize", function () {
    saveLauncherTop(state.launcherTop);
  });

  document.addEventListener("change", function (event) {
    if (event.target && event.target.matches("[data-category-select]")) syncSubcategoryFields();
  });

  document.addEventListener("input", function (event) {
    var target = event.target;
    if (!target || !target.matches) return;
    if (target.matches("#dvt-sac-chat-message-form [name='message']")) {
      state.chatDraft = String(target.value || "");
    }
    if (target.matches("#dvt-sac-ticket-message-form [name='message']")) {
      state.ticketDraft = String(target.value || "");
    }
  });

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || !form.id || form.id.indexOf("dvt-sac-") !== 0) return;
    event.preventDefault();
    if (form.id === "dvt-sac-chat-form") submitChat(form);
    if (form.id === "dvt-sac-ticket-form") submitTicket(form);
    if (form.id === "dvt-sac-chat-message-form") submitChatMessage(form);
    if (form.id === "dvt-sac-ticket-lookup-form") submitTicketLookup(form);
    if (form.id === "dvt-sac-ticket-message-form") submitTicketMessage(form);
    if (form.id === "dvt-sac-finalize-chat-form") submitFinalizeChat(form);
    if (form.id === "dvt-sac-finalize-ticket-form") submitFinalizeTicket(form);
  });

  setInterval(function () {
    if (!state.open) return;
    if (state.screen === "chat" && state.chat && state.chat.status !== "closed") {
      api("/chats/" + encodeURIComponent(state.chat.id))
        .then(function (result) {
          state.chat = result.chat;
          render();
        })
        .catch(function () {});
    }
    if (state.screen === "ticketView" && state.ticket && state.lookup.email) {
      loadTicket(state.ticket.protocol, state.lookup.email).catch(function () {});
    }
  }, 5000);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createRoot);
  } else {
    createRoot();
  }
})();
