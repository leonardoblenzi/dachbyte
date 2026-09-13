"use strict";

(() => {
  const state = {
    users: [],
    filtered: [],
    metadata: {
      roles: [],
      setores: [],
      modulos: [],
    },
    editing: null,
    editingSector: null,
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function api(path, options = {}) {
    return fetch(path, {
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      return payload;
    });
  }

  function normalize(value) {
    return String(value || "").trim().toLowerCase();
  }

  function isAdmin(user) {
    const nivel = normalize(user?.nivel);
    return nivel === "administrador" || nivel === "admin_master";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function roleLabel(role) {
    const map = { owner: "Owner", admin: "Admin", operador: "Operador" };
    return map[normalize(role)] || "Operador";
  }

  function sectorLabel(key) {
    return state.metadata.setores.find((item) => item.key === key)?.label || key;
  }

  function moduleLabel(key) {
    return state.metadata.modulos.find((item) => item.key === key)?.label || key;
  }

  function renderCompanySectors() {
    if (!els.companySectorList) return;
    const setores = state.metadata.setores || [];
    els.companySectorList.innerHTML = setores.length
      ? setores
        .map((setor) => `<span class="au-chip">${escapeHtml(setor.label)}</span>`)
        .join("")
      : '<span class="au-pill au-pill--muted">Nenhum setor cadastrado</span>';

    if (!els.sectorsBody) return;
    if (!setores.length) {
      els.sectorsBody.innerHTML = '<tr><td colspan="4" class="au-empty">Nenhum setor cadastrado.</td></tr>';
      return;
    }

    els.sectorsBody.innerHTML = setores
      .map((setor) => `
        <tr>
          <td><strong>${escapeHtml(setor.label)}</strong></td>
          <td><code>${escapeHtml(setor.key)}</code></td>
          <td>
            <span class="au-pill ${setor.custom ? "au-pill--ok" : "au-pill--muted"}">
              ${setor.custom ? "Empresa" : "Padrao"}
            </span>
          </td>
          <td>
            <div class="au-row-actions">
              <button class="au-btn au-btn-secondary" type="button" data-edit-sector="${escapeHtml(setor.key)}">
                Editar
              </button>
              <button class="au-btn au-btn-danger" type="button" data-delete-sector="${escapeHtml(setor.key)}" data-sector-label="${escapeHtml(setor.label)}">
                Remover
              </button>
            </div>
          </td>
        </tr>
      `)
      .join("");
  }

  function toast(message, type = "ok") {
    const node = document.createElement("div");
    node.className = `au-toast au-toast--${type}`;
    node.textContent = message;
    document.body.appendChild(node);
    window.setTimeout(() => node.remove(), 3600);
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async function presentInvite(payload) {
    const link = payload?.convite?.link;
    const delivery = payload?.email_delivery || {};
    const hubSync = payload?.hub_sync || null;
    const hubWarning = hubSync && hubSync.ok === false && hubSync.skipped !== true;
    if (!link) {
      if (hubWarning) {
        toast("Usuario vinculado, mas o Hub nao sincronizou agora. Tente atualizar depois.", "error");
        return;
      }
      toast(payload?.message || "Usuario vinculado a empresa.");
      return;
    }
    const copied = await copyText(link);
    if (delivery.sent) {
      if (hubWarning) {
        toast("Convite enviado, mas o Hub nao sincronizou agora. Tente atualizar depois.", "error");
        return;
      }
      toast(copied ? "Convite enviado por e-mail e link copiado." : "Convite enviado por e-mail.");
      return;
    }
    if (copied) {
      toast("Nao foi possivel enviar por e-mail, mas o link foi copiado.", "error");
      return;
    }
    window.prompt("Copie o link do convite:", link);
  }

  function chips(values, mapper, empty = "Nenhum") {
    const list = Array.isArray(values) ? values : [];
    if (!list.length) return `<span class="au-pill au-pill--muted">${escapeHtml(empty)}</span>`;
    return `<div class="au-chip-list">${list
      .map((value) => `<span class="au-chip">${escapeHtml(mapper(value))}</span>`)
      .join("")}</div>`;
  }

  function userSearchBlob(user) {
    const modulos = (user.modulos || []).map((modulo) => moduleLabel(modulo.modulo_key)).join(" ");
    const setores = (user.setores || []).map(sectorLabel).join(" ");
    return [
      user.nome,
      user.email,
      user.nivel,
      user.status,
      user.papel,
      setores,
      modulos,
    ]
      .map(normalize)
      .join(" ");
  }

  function applyFilter() {
    const term = normalize(els.search.value);
    state.filtered = term
      ? state.users.filter((user) => userSearchBlob(user).includes(term))
      : [...state.users];
    render();
  }

  function renderStats() {
    const total = state.users.length;
    const admins = state.users.filter(isAdmin).length;
    const active = state.users.filter((user) => normalize(user.status) === "ativo").length;
    els.statTotal.textContent = String(total);
    els.statAdmins.textContent = String(admins);
    els.statUsers.textContent = String(Math.max(0, total - admins));
    els.statActive.textContent = String(active);
  }

  function renderTable() {
    const total = state.users.length;
    const showing = state.filtered.length;
    els.counter.textContent = `Exibindo ${showing} de ${total} usuario(s).`;

    if (!showing) {
      els.body.innerHTML = `<tr><td colspan="7" class="au-empty">Nenhum usuario encontrado.</td></tr>`;
      return;
    }

    els.body.innerHTML = state.filtered
      .map((user) => {
        const admin = isAdmin(user);
        const moduleCount = Array.isArray(user.modulos)
          ? user.modulos.filter((modulo) => modulo.pode_acessar).length
          : 0;
        const statusOk = normalize(user.status) === "ativo";
        return `
          <tr>
            <td>
              <div class="au-user">
                <strong>${escapeHtml(user.nome || "Sem nome")}</strong>
                <span>${escapeHtml(user.email || "-")}</span>
              </div>
            </td>
            <td>
              <span class="au-pill ${admin ? "au-pill--admin" : ""}">
                ${admin ? "Admin" : "Usuario"}
              </span>
            </td>
            <td><span class="au-pill au-pill--muted">${escapeHtml(roleLabel(user.papel))}</span></td>
            <td>${chips(user.setores, sectorLabel, "Sem setor")}</td>
            <td>
              ${
                admin
                  ? '<span class="au-pill au-pill--admin">Acesso completo</span>'
                  : `<span class="au-pill au-pill--muted">${moduleCount} modulo(s)</span>`
              }
            </td>
            <td>
              <span class="au-pill ${statusOk ? "au-pill--ok" : "au-pill--muted"}">
                ${escapeHtml(user.status || "-")}
              </span>
            </td>
            <td>
              <div class="au-row-actions">
                <button class="au-btn au-btn-secondary" type="button" data-edit-user="${escapeHtml(user.id)}">
                  Editar acessos
                </button>
                ${
                  statusOk
                    ? ""
                    : `<button class="au-btn au-btn-secondary" type="button" data-resend-invite="${escapeHtml(user.id)}">Reenviar convite</button>`
                }
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function render() {
    renderStats();
    renderTable();
  }

  function groupedModules() {
    return state.metadata.modulos.reduce((acc, modulo) => {
      const group = modulo.group || "Outros";
      if (!acc[group]) acc[group] = [];
      acc[group].push(modulo);
      return acc;
    }, {});
  }

  function renderEditorOptions(user) {
    const selectedSetores = new Set(user.setores || []);
    const selectedModules = new Map(
      (user.modulos || []).map((modulo) => [modulo.modulo_key, modulo]),
    );

    els.sectorOptions.innerHTML = state.metadata.setores
      .map((setor) => `
        <label class="au-check">
          <input type="checkbox" value="${escapeHtml(setor.key)}" ${selectedSetores.has(setor.key) ? "checked" : ""} />
          <span>${escapeHtml(setor.label)}</span>
        </label>
      `)
      .join("");

    const groups = groupedModules();
    els.moduleOptions.innerHTML = Object.entries(groups)
      .map(([group, modules]) => `
        <section class="au-module-group">
          <h4>${escapeHtml(group)}</h4>
          ${modules
            .map((modulo) => {
              const current = selectedModules.get(modulo.key) || {};
              const access = current.pode_acessar === true;
              const edit = current.pode_editar === true;
              return `
                <div class="au-module-row" data-module-key="${escapeHtml(modulo.key)}">
                  <div>
                    <strong>${escapeHtml(modulo.label)}</strong>
                    <small>${escapeHtml(modulo.path || modulo.key)}</small>
                  </div>
                  <label class="au-module-toggle">
                    <input type="checkbox" data-module-access value="${escapeHtml(modulo.key)}" ${access ? "checked" : ""} />
                    Acessar
                  </label>
                  <label class="au-module-toggle">
                    <input type="checkbox" data-module-edit value="${escapeHtml(modulo.key)}" ${edit ? "checked" : ""} ${access ? "" : "disabled"} />
                    Editar
                  </label>
                </div>
              `;
            })
            .join("")}
        </section>
      `)
      .join("");
  }

  function openEditor(userId) {
    const user = state.users.find((item) => String(item.id) === String(userId));
    if (!user) return;
    state.editing = user;
    els.dialogTitle.textContent = user.nome || "Editar acessos";
    els.dialogSubtitle.textContent = `${user.email || ""} - ${
      isAdmin(user)
        ? "nivel ADMIN tem acesso completo as telas restritas"
        : "usuario comum depende dos modulos liberados"
    }`;
    els.role.value = normalize(user.papel) || "operador";
    els.moduleHelp.textContent = isAdmin(user)
      ? "Este usuario ja tem acesso completo por nivel ADMIN. As marcacoes abaixo ficam registradas, mas nao limitam o admin."
      : "Usuarios comuns acessam somente os modulos marcados.";
    renderEditorOptions(user);
    els.dialog.showModal();
  }

  function collectEditorPayload() {
    const setores = [...els.sectorOptions.querySelectorAll("input[type='checkbox']:checked")].map((item) => item.value);
    const modulos = [...els.moduleOptions.querySelectorAll("[data-module-key]")].map((row) => {
      const key = row.dataset.moduleKey;
      const access = row.querySelector("[data-module-access]")?.checked === true;
      const edit = row.querySelector("[data-module-edit]")?.checked === true;
      return {
        modulo_key: key,
        pode_acessar: access,
        pode_editar: access && edit,
      };
    }).filter((modulo) => modulo.pode_acessar);

    return {
      papel: els.role.value || "operador",
      setores,
      modulos,
    };
  }

  function openInviteDialog() {
    if (!els.inviteDialog) return;
    if (els.inviteName) els.inviteName.value = "";
    if (els.inviteEmail) els.inviteEmail.value = "";
    if (els.inviteLevel) els.inviteLevel.value = "usuario";
    if (els.inviteRole) els.inviteRole.value = "operador";
    els.inviteDialog.showModal();
    window.setTimeout(() => els.inviteName?.focus(), 60);
  }

  function collectInvitePayload() {
    return {
      nome: String(els.inviteName?.value || "").trim(),
      email: String(els.inviteEmail?.value || "").trim(),
      nivel: String(els.inviteLevel?.value || "usuario").trim(),
      papel: String(els.inviteRole?.value || "operador").trim(),
    };
  }

  async function sendInvite() {
    const payload = collectInvitePayload();
    if (!payload.email) {
      toast("Informe o e-mail do usuario.", "error");
      els.inviteEmail?.focus();
      return;
    }
    els.sendInvite.disabled = true;
    els.sendInvite.textContent = "Enviando...";
    try {
      const result = await api("/api/account/users/invite", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (Array.isArray(result.usuarios)) {
        state.users = result.usuarios;
        applyFilter();
      } else {
        await loadUsers();
      }
      els.inviteDialog.close();
      await presentInvite(result);
    } catch (error) {
      toast(error.message || "Falha ao enviar convite.", "error");
    } finally {
      els.sendInvite.disabled = false;
      els.sendInvite.textContent = "Enviar convite";
    }
  }

  async function resendInvite(userId) {
    if (!userId) return;
    try {
      const result = await api(`/api/account/users/${encodeURIComponent(userId)}/invite`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await presentInvite(result);
      await loadUsers();
    } catch (error) {
      toast(error.message || "Falha ao reenviar convite.", "error");
    }
  }

  async function saveEditor() {
    if (!state.editing?.id) return;
    els.save.disabled = true;
    els.save.textContent = "Salvando...";
    try {
      await api(`/api/account/users/${encodeURIComponent(state.editing.id)}/access`, {
        method: "PUT",
        body: JSON.stringify(collectEditorPayload()),
      });
      els.dialog.close();
      await loadUsers();
      toast("Acessos atualizados.");
    } catch (error) {
      toast(error.message || "Falha ao salvar acessos.", "error");
    } finally {
      els.save.disabled = false;
      els.save.textContent = "Salvar acessos";
    }
  }

  function resetSectorForm() {
    state.editingSector = null;
    if (els.newSectorName) els.newSectorName.value = "";
    if (els.createSector) els.createSector.textContent = "Criar setor";
    if (els.cancelSectorEdit) els.cancelSectorEdit.hidden = true;
  }

  function startSectorEdit(key) {
    const setor = state.metadata.setores.find((item) => item.key === key);
    if (!setor) return;
    state.editingSector = setor.key;
    els.newSectorName.value = setor.label || "";
    els.createSector.textContent = "Salvar setor";
    els.cancelSectorEdit.hidden = false;
    els.newSectorName.focus();
    switchTab("sectors");
  }

  async function createSector() {
    const label = String(els.newSectorName?.value || "").trim();
    if (!label) {
      toast("Informe o nome do setor.", "error");
      els.newSectorName?.focus();
      return;
    }
    els.createSector.disabled = true;
    const wasEditing = Boolean(state.editingSector);
    els.createSector.textContent = wasEditing ? "Salvando..." : "Criando...";
    try {
      const path = state.editingSector
        ? `/api/account/users/setores/${encodeURIComponent(state.editingSector)}`
        : "/api/account/users/setores";
      const payload = await api(path, {
        method: wasEditing ? "PUT" : "POST",
        body: JSON.stringify({ label }),
      });
      state.metadata.setores = payload.setores || state.metadata.setores;
      resetSectorForm();
      renderCompanySectors();
      if (state.editing) renderEditorOptions(state.editing);
      applyFilter();
      toast(wasEditing ? "Setor atualizado." : "Setor criado.");
    } catch (error) {
      toast(error.message || "Falha ao salvar setor.", "error");
    } finally {
      els.createSector.disabled = false;
      els.createSector.textContent = state.editingSector ? "Salvar setor" : "Criar setor";
    }
  }

  async function deleteSector(key, label) {
    const setor = state.metadata.setores.find((item) => item.key === key);
    const name = label || setor?.label || key;
    if (!setor) return;
    if (!confirm(`Remover o setor "${name}" desta empresa?\n\nUsuarios que estiverem neste setor perderao esta atribuicao.`)) return;
    try {
      const payload = await api(`/api/account/users/setores/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      state.metadata.setores = payload.setores || state.metadata.setores;
      resetSectorForm();
      renderCompanySectors();
      await loadUsers();
      if (state.editing) renderEditorOptions(state.editing);
      const removedUsers = Number(payload.removed_users || 0);
      toast(removedUsers ? `Setor removido. ${removedUsers} atribuicao(oes) removida(s).` : "Setor removido.");
    } catch (error) {
      toast(error.message || "Falha ao remover setor.", "error");
    }
  }

  function switchTab(target) {
    const tab = target === "sectors" ? "sectors" : "users";
    els.tabs.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.tabTarget === tab);
    });
    els.tabUsers.hidden = tab !== "users";
    els.tabSectors.hidden = tab !== "sectors";
    els.tabUsers.classList.toggle("is-active", tab === "users");
    els.tabSectors.classList.toggle("is-active", tab === "sectors");
  }

  async function loadMetadata() {
    const payload = await api("/api/account/users/metadata");
    state.metadata = {
      roles: payload.roles || [],
      setores: payload.setores || [],
      modulos: payload.modulos || [],
    };
    renderCompanySectors();
  }

  async function loadUsers() {
    els.body.innerHTML = `<tr><td colspan="7" class="au-empty">Carregando...</td></tr>`;
    const payload = await api("/api/account/users");
    state.users = Array.isArray(payload.usuarios) ? payload.usuarios : [];
    applyFilter();
  }

  function bindEvents() {
    els.refresh.addEventListener("click", async () => {
      els.refresh.disabled = true;
      els.refresh.textContent = "Atualizando...";
      try {
        await loadUsers();
      } catch (error) {
        toast(error.message || "Falha ao carregar usuarios.", "error");
      } finally {
        els.refresh.disabled = false;
        els.refresh.textContent = "Atualizar";
      }
    });

    els.search.addEventListener("input", applyFilter);
    els.invite?.addEventListener("click", openInviteDialog);
    els.sendInvite?.addEventListener("click", sendInvite);
    els.inviteLevel?.addEventListener("change", () => {
      if (els.inviteLevel.value === "administrador" && els.inviteRole.value === "operador") {
        els.inviteRole.value = "admin";
      }
    });
    els.body.addEventListener("click", (event) => {
      const button = event.target.closest("[data-edit-user]");
      if (button) openEditor(button.dataset.editUser);
      const resendButton = event.target.closest("[data-resend-invite]");
      if (resendButton) resendInvite(resendButton.dataset.resendInvite);
    });
    els.moduleOptions.addEventListener("change", (event) => {
      const accessInput = event.target.closest("[data-module-access]");
      if (!accessInput) return;
      const row = accessInput.closest("[data-module-key]");
      const editInput = row?.querySelector("[data-module-edit]");
      if (!editInput) return;
      editInput.disabled = !accessInput.checked;
      if (!accessInput.checked) editInput.checked = false;
    });
    els.save.addEventListener("click", saveEditor);
    els.createSector?.addEventListener("click", createSector);
    els.cancelSectorEdit?.addEventListener("click", resetSectorForm);
    els.tabs.forEach((button) => {
      button.addEventListener("click", () => switchTab(button.dataset.tabTarget));
    });
    els.sectorsBody?.addEventListener("click", (event) => {
      const editButton = event.target.closest("[data-edit-sector]");
      if (editButton) startSectorEdit(editButton.dataset.editSector);
      const deleteButton = event.target.closest("[data-delete-sector]");
      if (deleteButton) deleteSector(deleteButton.dataset.deleteSector, deleteButton.dataset.sectorLabel);
    });
    els.newSectorName?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      createSector();
    });
  }

  async function init() {
    Object.assign(els, {
      refresh: $("btn-refresh-users"),
      invite: $("btn-invite-user"),
      search: $("user-search"),
      body: $("users-body"),
      counter: $("users-counter"),
      statTotal: $("stat-total"),
      statAdmins: $("stat-admins"),
      statUsers: $("stat-users"),
      statActive: $("stat-active"),
      dialog: $("access-dialog"),
      dialogTitle: $("dialog-title"),
      dialogSubtitle: $("dialog-subtitle"),
      role: $("edit-role"),
      sectorOptions: $("sector-options"),
      moduleOptions: $("module-options"),
      moduleHelp: $("module-help"),
      companySectorList: $("company-sector-list"),
      newSectorName: $("new-sector-name"),
      createSector: $("btn-create-sector"),
      cancelSectorEdit: $("btn-cancel-sector-edit"),
      sectorsBody: $("sectors-body"),
      tabs: [...document.querySelectorAll("[data-tab-target]")],
      tabUsers: $("tab-users"),
      tabSectors: $("tab-sectors"),
      save: $("btn-save-access"),
      inviteDialog: $("invite-dialog"),
      inviteName: $("invite-name"),
      inviteEmail: $("invite-email"),
      inviteLevel: $("invite-level"),
      inviteRole: $("invite-role"),
      sendInvite: $("btn-send-invite"),
    });

    bindEvents();

    try {
      await loadMetadata();
      await loadUsers();
    } catch (error) {
      els.body.innerHTML = `<tr><td colspan="7" class="au-empty">${escapeHtml(error.message || "Falha ao carregar usuarios.")}</td></tr>`;
      toast(error.message || "Falha ao carregar usuarios.", "error");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
