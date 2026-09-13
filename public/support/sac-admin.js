(function () {
  "use strict";

  var API_BASE = "";
  var CATEGORIES = [
    "",
    "Contratação",
    "Bugs/Problemas na plataforma",
    "Erros de processos",
    "Solicitação de melhoria",
  ];

  var state = {
    admin: null,
    tab: "chats",
    chats: [],
    tickets: [],
    selectedChat: null,
    selectedTicket: null,
    chatFilters: {},
    ticketFilters: {},
    chatReplyDraft: "",
    ticketReplyDraft: "",
    loading: false,
    message: "",
    error: "",
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
      if (response.status === 204) return {};
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || payload.ok === false) {
          var error = new Error(payload.error || "Falha no SAC.");
          error.status = response.status;
          error.payload = payload;
          throw error;
        }
        return payload;
      });
    });
  }

  function formData(form) {
    var data = {};
    Array.prototype.forEach.call(new FormData(form).entries(), function (entry) {
      data[entry[0]] = entry[1];
    });
    return data;
  }

  function fieldValue(form, name) {
    var selector = "[name='" + name + "']";
    var field = form && form.querySelector ? form.querySelector(selector) : null;
    if (!field) field = document.querySelector("#sac-login-form " + selector);
    return field ? String(field.value || "").trim() : "";
  }

  function formFieldValue(form, name) {
    var selector = "[name='" + name + "']";
    var field = form && form.querySelector ? form.querySelector(selector) : null;
    return field ? String(field.value || "").trim() : "";
  }

  function loginFormData(form) {
    return {
      email: fieldValue(form, "email").toLowerCase(),
      password: fieldValue(form, "password"),
    };
  }

  function qs(filters) {
    var params = new URLSearchParams();
    Object.keys(filters || {}).forEach(function (key) {
      if (filters[key]) params.set(key, filters[key]);
    });
    var text = params.toString();
    return text ? "?" + text : "";
  }

  function setMessage(message) {
    state.message = message || "";
    state.error = "";
    state.loading = false;
    render();
  }

  function setError(error) {
    state.error = error && error.message ? error.message : String(error || "");
    if (error && error.payload && error.payload.debug) {
      var debug = error.payload.debug;
      state.error += " Debug: email=" + (debug.email || "vazio") +
        ", senhaRecebida=" + (debug.passwordReceived ? "sim" : "nao") +
        ", tamanhoSenha=" + String(debug.passwordLength || 0) +
        ", adminExiste=" + (debug.adminFound ? "sim" : "nao") +
        ", ativo=" + (debug.active ? "sim" : "nao") +
        ", senhaConfere=" + (debug.passwordMatches ? "sim" : "nao") + ".";
    }
    state.message = "";
    state.loading = false;
    render();
  }

  function rowMeta(item) {
    return [
      item.customer_name,
      item.company_name,
      item.email,
      item.category,
      item.subcategory,
    ].filter(Boolean).join(" | ");
  }

  function renderMessage(message) {
    var cls = "sac-message";
    if (message.author === "customer") cls += " is-customer";
    else if (message.author === "admin") cls += " is-admin";
    else cls += " is-system";
    return [
      '<div class="' + cls + '">',
      "<small>" + escapeHtml(message.authorName || message.author || "Sistema") + " · " + escapeHtml(message.at || "") + "</small>",
      escapeHtml(message.text || ""),
      "</div>",
    ].join("");
  }

  function captureDrafts() {
    var root = document.getElementById("sac-admin-root");
    if (!root) return;
    var chatReply = root.querySelector("#sac-chat-reply-form [name='message']");
    var ticketReply = root.querySelector("#sac-ticket-reply-form [name='message']");
    if (chatReply) state.chatReplyDraft = String(chatReply.value || "");
    if (ticketReply) state.ticketReplyDraft = String(ticketReply.value || "");
  }

  function layout(content) {
    return [
      '<div class="sac-shell">',
      '<header class="sac-topbar">',
      '<div class="sac-brand"><div class="sac-brand-mark">SAC</div><div>SAC DACHBYTE<small>Chat ao vivo e tickets globais</small></div></div>',
      state.admin ? '<button class="sac-ghost" data-action="logout" type="button" style="margin-left:auto;">Sair</button>' : "",
      "</header>",
      '<main class="sac-main">',
      state.error ? '<div class="sac-alert">' + escapeHtml(state.error) + "</div>" : "",
      state.message ? '<div class="sac-success">' + escapeHtml(state.message) + "</div>" : "",
      state.loading ? '<div class="sac-alert">Processando...</div>' : "",
      content,
      "</main>",
      "</div>",
    ].join("");
  }

  function loginHtml() {
    return layout([
      '<section class="sac-login">',
      "<h1>Login SAC</h1>",
      '<p class="sac-muted">Acesso global de suporte DACHBYTE.</p>',
      '<form class="sac-form" id="sac-login-form">',
      '<div class="sac-field"><label>E-mail</label><input name="email" type="email" value="sac@admindavantti.com.br" required></div>',
      '<div class="sac-field"><label>Senha</label><input name="password" type="password" required></div>',
      '<button class="sac-primary" type="submit">Entrar</button>',
      "</form>",
      "</section>",
    ].join(""));
  }

  function tabsHtml() {
    return [
      '<div class="sac-tabs">',
      '<button class="sac-tab ' + (state.tab === "chats" ? "is-active" : "") + '" data-tab="chats" type="button">Chat ao vivo</button>',
      '<button class="sac-tab ' + (state.tab === "tickets" ? "is-active" : "") + '" data-tab="tickets" type="button">Tickets abertos</button>',
      "</div>",
    ].join("");
  }

  function categoryOptions(selected) {
    return CATEGORIES.map(function (item) {
      return '<option value="' + escapeHtml(item) + '"' + (item === selected ? " selected" : "") + ">" + escapeHtml(item || "Todas") + "</option>";
    }).join("");
  }

  function filtersHtml(kind) {
    var filters = kind === "chats" ? state.chatFilters : state.ticketFilters;
    return [
      '<form class="sac-filters" id="sac-' + kind + '-filters">',
      '<div class="sac-field"><label>Busca</label><input name="q" value="' + escapeHtml(filters.q || "") + '" placeholder="Nome, e-mail, protocolo, titulo"></div>',
      '<div class="sac-field"><label>Status</label><input name="status" value="' + escapeHtml(filters.status || "") + '" placeholder="open, queued, waiting_customer..."></div>',
      '<div class="sac-field"><label>Categoria</label><select name="category">' + categoryOptions(filters.category || "") + "</select></div>",
      '<div class="sac-field"><label>Subcategoria</label><input name="subcategory" value="' + escapeHtml(filters.subcategory || "") + '"></div>',
      '<button class="sac-primary" type="submit">Filtrar</button>',
      '<button class="sac-ghost" type="button" data-action="clear-filters" data-kind="' + kind + '">Limpar</button>',
      "</form>",
    ].join("");
  }

  function chatsListHtml() {
    if (!state.chats.length) return '<div class="sac-muted">Nenhum chat encontrado.</div>';
    return state.chats.map(function (chat) {
      return [
        '<button class="sac-row ' + (state.selectedChat && state.selectedChat.id === chat.id ? "is-selected" : "") + '" data-chat-id="' + escapeHtml(chat.id) + '" type="button">',
        "<strong>" + escapeHtml(chat.protocol) + ' <span class="sac-badge">' + escapeHtml(chat.status) + "</span></strong>",
        '<div class="sac-muted">' + escapeHtml(rowMeta(chat)) + "</div>",
        '<div class="sac-muted">Mensagens: ' + escapeHtml(chat.messages_count) + " · " + escapeHtml(chat.source_module || "") + "</div>",
        "</button>",
      ].join("");
    }).join("");
  }

  function ticketsListHtml() {
    if (!state.tickets.length) return '<div class="sac-muted">Nenhum ticket encontrado.</div>';
    return state.tickets.map(function (ticket) {
      return [
        '<button class="sac-row ' + (state.selectedTicket && state.selectedTicket.id === ticket.id ? "is-selected" : "") + '" data-ticket-id="' + escapeHtml(ticket.id) + '" type="button">',
        "<strong>" + escapeHtml(ticket.protocol) + ' <span class="sac-badge">' + escapeHtml(ticket.status) + "</span></strong>",
        '<div>' + escapeHtml(ticket.title || "") + "</div>",
        '<div class="sac-muted">' + escapeHtml(rowMeta(ticket)) + "</div>",
        ticket.response_deadline_at ? '<div class="sac-muted">Prazo usuario: ' + escapeHtml(ticket.response_deadline_at) + "</div>" : "",
        "</button>",
      ].join("");
    }).join("");
  }

  function chatDetailHtml() {
    var chat = state.selectedChat;
    if (!chat) return '<div class="sac-card"><div class="sac-card-body sac-muted">Selecione um chat na fila.</div></div>';
    return [
      '<section class="sac-card">',
      '<div class="sac-card-header"><div><strong>' + escapeHtml(chat.protocol) + "</strong><div class=\"sac-muted\">" + escapeHtml(chat.customer_name) + " · " + escapeHtml(chat.company_name) + "</div></div><span class=\"sac-badge\">" + escapeHtml(chat.status) + "</span></div>",
      '<div class="sac-card-body">',
      '<div class="sac-log">' + (chat.messages || []).map(renderMessage).join("") + "</div>",
      '<form class="sac-form" id="sac-chat-reply-form" style="margin-top:12px;">',
      '<div class="sac-field"><label>Responder chat</label><textarea name="message" required>' + escapeHtml(state.chatReplyDraft || "") + "</textarea></div>",
      '<button class="sac-primary" type="submit">Enviar resposta</button>',
      "</form>",
      '<form class="sac-form" id="sac-chat-ticket-form" style="margin-top:16px;border-top:1px solid #e2e8f0;padding-top:14px;">',
      '<strong>Abrir ticket sobre o chat</strong>',
      '<div class="sac-field"><label>E-mail do usuario</label><input name="email" type="email" value="' + escapeHtml(chat.email || "") + '" required></div>',
      '<div class="sac-field"><label>Titulo</label><input name="title" value="' + escapeHtml(chat.title || "Ticket sobre chat " + chat.protocol) + '" required></div>',
      '<div class="sac-field"><label>Mensagem complementar</label><textarea name="message"></textarea></div>',
      '<button class="sac-secondary" type="submit">Abrir ticket sobre o chat</button>',
      "</form>",
      "</div>",
      "</section>",
    ].join("");
  }

  function ticketDetailHtml() {
    var ticket = state.selectedTicket;
    if (!ticket) return '<div class="sac-card"><div class="sac-card-body sac-muted">Selecione um ticket.</div></div>';
    return [
      '<section class="sac-card">',
      '<div class="sac-card-header"><div><strong>' + escapeHtml(ticket.protocol) + "</strong><div class=\"sac-muted\">" + escapeHtml(ticket.title) + "</div></div><span class=\"sac-badge\">" + escapeHtml(ticket.status) + "</span></div>",
      '<div class="sac-card-body">',
      '<p class="sac-muted">' + escapeHtml(ticket.customer_name) + " · " + escapeHtml(ticket.company_name) + " · " + escapeHtml(ticket.email) + "</p>",
      '<div class="sac-log">' + (ticket.messages || []).map(renderMessage).join("") + "</div>",
      '<form class="sac-form" id="sac-ticket-reply-form" style="margin-top:12px;">',
      '<div class="sac-field"><label>Responder ticket</label><textarea name="message" required>' + escapeHtml(state.ticketReplyDraft || "") + "</textarea></div>",
      '<label><input type="checkbox" name="notify" value="true" checked> Notificar usuario por e-mail via Umbler</label>',
      '<button class="sac-primary" type="submit">Responder e notificar</button>',
      "</form>",
      '<div class="sac-actions">',
      '<button class="sac-secondary" data-ticket-action="resolve" type="button">Resolver</button>',
      '<button class="sac-danger" data-ticket-action="close" type="button">Fechar</button>',
      '<button class="sac-ghost" data-ticket-action="reopen" type="button">Reabrir</button>',
      '<button class="sac-ghost" data-action="resend-ticket" type="button">Notificar resposta novamente</button>',
      "</div>",
      "</div>",
      "</section>",
    ].join("");
  }

  function appHtml() {
    var content = [
      tabsHtml(),
      '<div class="sac-grid" style="margin-top:14px;">',
      '<section class="sac-card">',
      '<div class="sac-card-header"><strong>' + (state.tab === "chats" ? "Fila de atendimento" : "Tickets") + "</strong><button class=\"sac-ghost\" data-action=\"refresh\" type=\"button\">Atualizar</button></div>",
      '<div class="sac-card-body">',
      filtersHtml(state.tab),
      '<div class="sac-list">' + (state.tab === "chats" ? chatsListHtml() : ticketsListHtml()) + "</div>",
      "</div>",
      "</section>",
      state.tab === "chats" ? chatDetailHtml() : ticketDetailHtml(),
      "</div>",
    ].join("");
    return layout(content);
  }

  function render() {
    captureDrafts();
    document.getElementById("sac-admin-root").innerHTML = state.admin ? appHtml() : loginHtml();
  }

  function refreshChats() {
    return api("/admin/chats" + qs(state.chatFilters)).then(function (payload) {
      state.chats = payload.chats || [];
      if (state.selectedChat) {
        var current = state.chats.find(function (item) { return item.id === state.selectedChat.id; });
        if (!current) state.selectedChat = null;
      }
      render();
    });
  }

  function refreshTickets() {
    return api("/admin/tickets" + qs(state.ticketFilters)).then(function (payload) {
      state.tickets = payload.tickets || [];
      if (state.selectedTicket) {
        var current = state.tickets.find(function (item) { return item.id === state.selectedTicket.id; });
        if (!current) state.selectedTicket = null;
      }
      render();
    });
  }

  function refreshAll() {
    if (!state.admin) return Promise.resolve();
    return Promise.all([refreshChats(), refreshTickets()]).catch(setError);
  }

  function loadChat(id) {
    state.loading = true;
    render();
    return api("/admin/chats/" + encodeURIComponent(id))
      .then(function (payload) {
        state.selectedChat = payload.chat;
        state.loading = false;
        render();
      })
      .catch(setError);
  }

  function loadTicket(id) {
    state.loading = true;
    render();
    return api("/admin/tickets/" + encodeURIComponent(id))
      .then(function (payload) {
        state.selectedTicket = payload.ticket;
        state.loading = false;
        render();
      })
      .catch(setError);
  }

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || !form.id || form.id.indexOf("sac-") !== 0) return;
    event.preventDefault();

    if (form.id === "sac-login-form") {
      var loginData = loginFormData(form);
      state.loading = true;
      render();
      api("/admin/login", { method: "POST", body: JSON.stringify(loginData) })
        .then(function (payload) {
          state.admin = payload.admin;
          setMessage("Login realizado.");
          refreshAll();
        })
        .catch(setError);
      return;
    }

    if (form.id === "sac-chats-filters") {
      state.chatFilters = formData(form);
      refreshChats();
      return;
    }

    if (form.id === "sac-tickets-filters") {
      state.ticketFilters = formData(form);
      refreshTickets();
      return;
    }

    if (form.id === "sac-chat-reply-form" && state.selectedChat) {
      var chatReplyData = formData(form);
      chatReplyData.message = formFieldValue(form, "message") || String(state.chatReplyDraft || "").trim();
      state.chatReplyDraft = String(chatReplyData.message || "");
      if (!chatReplyData.message) {
        setError("Digite a mensagem.");
        return;
      }
      state.loading = true;
      render();
      api("/admin/chats/" + encodeURIComponent(state.selectedChat.id) + "/messages", {
        method: "POST",
        body: JSON.stringify(chatReplyData),
      })
        .then(function (payload) {
          state.selectedChat = payload.chat;
          state.chatReplyDraft = "";
          setMessage("Resposta enviada no chat.");
          refreshChats();
        })
        .catch(setError);
      return;
    }

    if (form.id === "sac-chat-ticket-form" && state.selectedChat) {
      var chatTicketData = formData(form);
      state.loading = true;
      render();
      api("/admin/chats/" + encodeURIComponent(state.selectedChat.id) + "/ticket", {
        method: "POST",
        body: JSON.stringify(chatTicketData),
      })
        .then(function (payload) {
          state.tab = "tickets";
          state.selectedTicket = payload.ticket;
          setMessage("Ticket aberto sobre o chat: " + payload.ticket.protocol);
          refreshAll();
        })
        .catch(setError);
      return;
    }

    if (form.id === "sac-ticket-reply-form" && state.selectedTicket) {
      var data = formData(form);
      data.message = formFieldValue(form, "message") || String(state.ticketReplyDraft || "").trim();
      data.notify = data.notify === "true";
      state.ticketReplyDraft = String(data.message || "");
      if (!data.message) {
        setError("Digite a mensagem.");
        return;
      }
      state.loading = true;
      render();
      api("/admin/tickets/" + encodeURIComponent(state.selectedTicket.id) + "/messages", {
        method: "POST",
        body: JSON.stringify(data),
      })
        .then(function (payload) {
          state.selectedTicket = payload.ticket;
          state.ticketReplyDraft = "";
          setMessage(payload.email && payload.email.sent ? "Resposta enviada e notificada por e-mail." : "Resposta enviada. Verifique configuracao Umbler se o e-mail nao saiu.");
          refreshTickets();
        })
        .catch(setError);
    }
  });

  document.addEventListener("input", function (event) {
    var target = event.target;
    if (!target || !target.matches) return;
    if (target.matches("#sac-chat-reply-form [name='message']")) {
      state.chatReplyDraft = String(target.value || "");
    }
    if (target.matches("#sac-ticket-reply-form [name='message']")) {
      state.ticketReplyDraft = String(target.value || "");
    }
  });

  document.addEventListener("click", function (event) {
    var target = event.target.closest && event.target.closest("[data-tab],[data-action],[data-chat-id],[data-ticket-id],[data-ticket-action]");
    if (!target) return;

    if (target.hasAttribute("data-tab")) {
      state.tab = target.getAttribute("data-tab");
      render();
      return;
    }

    if (target.hasAttribute("data-chat-id")) {
      loadChat(target.getAttribute("data-chat-id"));
      return;
    }

    if (target.hasAttribute("data-ticket-id")) {
      loadTicket(target.getAttribute("data-ticket-id"));
      return;
    }

    if (target.hasAttribute("data-ticket-action") && state.selectedTicket) {
      var action = target.getAttribute("data-ticket-action");
      state.loading = true;
      render();
      api("/admin/tickets/" + encodeURIComponent(state.selectedTicket.id) + "/status", {
        method: "POST",
        body: JSON.stringify({ action: action, notify: true }),
      })
        .then(function (payload) {
          state.selectedTicket = payload.ticket;
          setMessage("Status atualizado: " + payload.ticket.status);
          refreshTickets();
        })
        .catch(setError);
      return;
    }

    var actionName = target.getAttribute("data-action");
    if (actionName === "logout") {
      api("/admin/logout", { method: "POST", body: "{}" }).finally(function () {
        state.admin = null;
        render();
      });
      return;
    }

    if (actionName === "refresh") {
      refreshAll();
      return;
    }

    if (actionName === "clear-filters") {
      var kind = target.getAttribute("data-kind");
      if (kind === "chats") state.chatFilters = {};
      if (kind === "tickets") state.ticketFilters = {};
      refreshAll();
      return;
    }

    if (actionName === "resend-ticket" && state.selectedTicket) {
      state.loading = true;
      render();
      api("/admin/tickets/" + encodeURIComponent(state.selectedTicket.id) + "/resend", {
        method: "POST",
        body: "{}",
      })
        .then(function () {
          setMessage("Notificacao reenviada para o usuario.");
        })
        .catch(setError);
    }
  });

  function init() {
    render();
    api("/admin/me")
      .then(function (payload) {
        state.admin = payload.admin;
        render();
        refreshAll();
      })
      .catch(function () {
        state.admin = null;
        render();
      });
  }

  setInterval(function () {
    if (!state.admin) return;
    refreshAll();
    if (state.selectedChat) loadChat(state.selectedChat.id);
    if (state.selectedTicket) loadTicket(state.selectedTicket.id);
  }, 8000);

  init();
})();
