(function initBasePath() {
  if (typeof window === "undefined") return;
  if (window.__ML_BASE_PATH != null) return;
  const p = window.location && window.location.pathname ? window.location.pathname : "";
  window.__ML_BASE_PATH = p === "/ml" || p.startsWith("/ml/") ? "/ml" : "";
})();

function withBase(path) {
  const base =
    typeof window !== "undefined" && window.__ML_BASE_PATH
      ? window.__ML_BASE_PATH
      : "";
  if (!path || typeof path !== "string") return path;
  if (!base) return path;
  if (path === base || path.startsWith(base + "/")) return path;
  if (path.startsWith("/")) return base + path;
  return path;
}

(() => {
  const $ = (id) => document.getElementById(id);

  const tbody = $("tbody");
  const search = $("search");
  const btnClear = $("btn-clear");
  const btnCreate = $("btn-create");
  const btnRefresh = $("btn-refresh");
  const btnPrev = $("btn-prev");
  const btnNext = $("btn-next");
  const pageInfo = $("page-info");
  const rangeInfo = $("range-info");
  const countPill = $("count-pill");
  const modal = $("modal-user");
  const modalTitle = $("modal-title");
  const modalClose = $("modal-close");
  const btnCancel = $("btn-cancel");
  const btnSave = $("btn-save");
  const wizardHead = $("wizard-head");
  const wizardStepText = $("wizard-steptext");
  const wizardStepSmall = $("wizard-stepsmall");
  const wizardBarFill = $("wizard-bar-fill");
  const step1El = $("step-1");
  const step2El = $("step-2");
  const btnWizBack = $("btn-wiz-back");
  const btnWizNext = $("btn-wiz-next");
  const wizardSummaryValue = $("wizard-summary-value");
  const fNome = $("f-nome");
  const fEmail = $("f-email");
  const fNivel = $("f-nivel");
  const fSenha = $("f-senha");
  const lblSenha = $("lbl-senha");
  const senhaHelp = $("senha-help");
  const senhaGroup = $("senha-group");
  const inviteNote = $("invite-note");
  const formError = $("form-error");
  const errNome = $("err-nome");
  const errEmail = $("err-email");
  const errNivel = $("err-nivel");
  const errSenha = $("err-senha");
  const errEmpresa = $("err-empresa");
  const errPapel = $("err-papel");
  const fEmpresa = $("f-empresa");
  const fPapel = $("f-papel");
  const masterAccessPanel = $("master-access-panel");
  const accessEmpty = $("access-empty");
  const accessEditor = $("access-editor");
  const accessCompany = $("access-company");
  const accessRole = $("access-role");
  const accessGroupFilter = $("access-group-filter");
  const accessSectorList = $("access-sector-list");
  const accessModules = $("access-modules");
  const btnAccessReload = $("btn-access-reload");
  const btnAccessClear = $("btn-access-clear");
  const btnAccessSave = $("btn-access-save");
  const toast = $("toast");

  let allUsers = [];
  let filtered = [];
  let page = 1;
  const perPage = 25;
  let mode = "create";
  let editingId = null;
  let wizardStep = 1;
  let empresasCache = null;
  let empresasLoaded = false;
  let accessPayload = null;
  let selectedAccessEmpresaId = null;
  let suppressSearchEventsUntil = 0;

  const auth = {
    isMaster: false,
    uid: null,
  };

  function showToast(msg) {
    toast.textContent = msg;
    toast.style.display = "block";
    setTimeout(() => {
      toast.style.display = "none";
    }, 2800);
  }

  function setError(msg) {
    formError.style.display = msg ? "block" : "none";
    formError.textContent = msg || "";
  }

  function showModal() {
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
  }

  function hideModal() {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    if (masterAccessPanel) masterAccessPanel.style.display = "none";
  }

  function clearFieldErrors() {
    [errNome, errEmail, errNivel, errSenha, errEmpresa, errPapel].forEach((el) => {
      if (el) el.textContent = "";
    });
    [fNome, fEmail, fNivel, fSenha, fEmpresa, fPapel].forEach((el) => {
      if (el?.classList) el.classList.remove("is-invalid");
    });
  }

  function setFieldError(inputEl, msgEl, msg) {
    if (msgEl) msgEl.textContent = msg || "";
    if (inputEl?.classList) {
      if (msg) inputEl.classList.add("is-invalid");
      else inputEl.classList.remove("is-invalid");
    }
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("pt-BR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function badgeNivel(nivel) {
    const n = String(nivel || "usuario").toLowerCase();
    if (n === "admin_master") return `<span class="badge admin">MASTER</span>`;
    if (n === "administrador") return `<span class="badge admin">ADMIN</span>`;
    return `<span class="badge user">USUARIO</span>`;
  }

  function badgeStatus(user) {
    const status = String(user?.status || "ativo").toLowerCase();
    if (status === "pendente_ativacao") {
      const exp = user?.activation_expires_at ? ` ate ${formatDate(user.activation_expires_at)}` : "";
      return `<span class="badge warn" title="Convite pendente${escapeHtml(exp)}">PENDENTE</span>`;
    }
    if (status === "inativo") {
      return `<span class="badge danger">INATIVO</span>`;
    }
    return `<span class="badge success">ATIVO</span>`;
  }

  function normalizeKey(value) {
    return String(value || "").trim().toLowerCase();
  }

  function cssIdent(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value || ""));
    return String(value || "").replace(/["\\]/g, "\\$&");
  }

  function isAdminNivel(value) {
    const nivel = normalizeKey(value);
    return nivel === "administrador" || nivel === "admin_master";
  }

  function editedUserHasFullAccess() {
    return isAdminNivel(fNivel?.value);
  }

  function sectorLabel(key) {
    return (accessPayload?.setores || []).find((item) => item.key === key)?.label || key;
  }

  function moduleRows() {
    return Array.isArray(accessPayload?.modulos) ? accessPayload.modulos : [];
  }

  function currentVinculo() {
    const id = Number(selectedAccessEmpresaId || accessCompany?.value);
    return (accessPayload?.vinculos || []).find((item) => Number(item.empresa_id) === id) || null;
  }

  function currentModuleMap() {
    const vinculo = currentVinculo();
    return new Map((vinculo?.modulos || []).map((item) => [item.modulo_key, item]));
  }

  function currentAvailableSectors() {
    const id = String(selectedAccessEmpresaId || accessCompany?.value || "");
    return accessPayload?.setores_por_empresa?.[id] || accessPayload?.setores || [];
  }

  function groupModules() {
    return moduleRows().reduce((acc, item) => {
      const group = item.group || "Outros";
      if (!acc[group]) acc[group] = [];
      acc[group].push(item);
      return acc;
    }, {});
  }

  async function api(path, options = {}) {
    const res = await fetch(withBase(path), {
      credentials: "include",
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error || data?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    window.prompt("Copie o link do convite:", text);
  }

  async function presentInvite(convite, emailDelivery) {
    if (!convite?.link) return;
    try {
      await copyText(convite.link);
      if (emailDelivery?.sent) {
        showToast("Convite enviado por email e link copiado.");
      } else if (emailDelivery?.error) {
        showToast("Email falhou; link copiado para envio manual.");
      } else if (emailDelivery?.skipped) {
        showToast("Brevo nao configurado; link copiado para envio manual.");
      } else {
        showToast("Link de convite copiado.");
      }
    } catch (_err) {
      window.prompt("Copie o link do convite:", convite.link);
    }
  }

  function setAccessLoading(message) {
    if (!masterAccessPanel) return;
    masterAccessPanel.style.display = mode === "edit" ? "" : "none";
    if (!accessEmpty) return;
    accessEmpty.style.display = "";
    accessEmpty.textContent = message;
    if (accessEditor) accessEditor.style.display = "none";
  }

  function setAccessUnavailable(message) {
    if (!masterAccessPanel) return;
    masterAccessPanel.style.display = mode === "edit" ? "" : "none";
    if (accessEmpty) {
      accessEmpty.style.display = "";
      accessEmpty.textContent = message;
    }
    if (accessEditor) accessEditor.style.display = "none";
  }

  function renderAccessCompanyOptions() {
    const vinculos = accessPayload?.vinculos || [];
    if (!accessCompany) return;
    accessCompany.innerHTML = vinculos
      .map((vinculo) => `
        <option value="${Number(vinculo.empresa_id)}">
          ${escapeHtml(vinculo.empresa_nome || `Empresa ${vinculo.empresa_id}`)}
        </option>
      `)
      .join("");

    if (!selectedAccessEmpresaId && vinculos[0]) selectedAccessEmpresaId = Number(vinculos[0].empresa_id);
    if (selectedAccessEmpresaId) accessCompany.value = String(selectedAccessEmpresaId);
  }

  function renderAccessFilters() {
    const groups = Object.keys(groupModules()).sort((a, b) => a.localeCompare(b));
    if (!accessGroupFilter) return;
    const current = accessGroupFilter.value || "";
    accessGroupFilter.innerHTML =
      `<option value="">Todos os grupos</option>` +
      groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join("");
    accessGroupFilter.value = groups.includes(current) ? current : "";
  }

  function renderAccessSectors() {
    const vinculo = currentVinculo();
    const selected = new Set(vinculo?.setores || []);
    accessSectorList.innerHTML = currentAvailableSectors()
      .map((setor) => `
        <label class="access-check">
          <input type="checkbox" value="${escapeHtml(setor.key)}" ${selected.has(setor.key) ? "checked" : ""} />
          <span>${escapeHtml(setor.label)}</span>
        </label>
      `)
      .join("");
  }

  function renderAccessModules() {
    const groups = groupModules();
    const filter = String(accessGroupFilter?.value || "");
    const selected = currentModuleMap();
    const fullAccess = editedUserHasFullAccess();
    const visibleEntries = Object.entries(groups)
      .filter(([group]) => !filter || group === filter)
      .sort(([a], [b]) => a.localeCompare(b));

    const adminNote = fullAccess
      ? `<div class="access-admin-note">
          <span>i</span>
          <div><strong>Acesso completo por nivel</strong>Administradores e masters ja acessam todas as telas permitidas pela assinatura. Use a matriz abaixo apenas para usuarios comuns.</div>
        </div>`
      : "";

    accessModules.innerHTML = adminNote + visibleEntries
      .map(([group, modules]) => {
        const allAccess = modules.every((item) => selected.get(item.key)?.pode_acessar === true);
        const allEdit = modules.every((item) => selected.get(item.key)?.pode_editar === true);
        return `
          <section class="access-module-group" data-access-group="${escapeHtml(group)}">
            <header class="access-module-group__head">
              <button class="access-group-title" type="button" data-access-toggle-group="${escapeHtml(group)}">
                <span>${escapeHtml(group)}</span>
                <small>${modules.length} tela(s)</small>
              </button>
              <label class="access-mini-check">
                <input type="checkbox" data-access-group-view="${escapeHtml(group)}" ${allAccess ? "checked" : ""} ${fullAccess ? "disabled" : ""} />
                Visualizar grupo
              </label>
              <label class="access-mini-check">
                <input type="checkbox" data-access-group-edit="${escapeHtml(group)}" ${allEdit ? "checked" : ""} ${allAccess && !fullAccess ? "" : "disabled"} />
                Editar grupo
              </label>
            </header>
            <div class="access-module-list">
              ${modules.map((module) => {
                const row = selected.get(module.key) || {};
                const canView = row.pode_acessar === true;
                const canEdit = row.pode_editar === true;
                return `
                  <div class="access-module-item" data-module-key="${escapeHtml(module.key)}">
                    <div>
                      <strong>${escapeHtml(module.label)}</strong>
                      <span>${escapeHtml(module.path || module.key)}</span>
                    </div>
                    <label class="access-mini-check">
                      <input type="checkbox" data-access-view="${escapeHtml(module.key)}" ${canView ? "checked" : ""} ${fullAccess ? "disabled" : ""} />
                      Visualizar
                    </label>
                    <label class="access-mini-check">
                      <input type="checkbox" data-access-edit="${escapeHtml(module.key)}" ${canEdit ? "checked" : ""} ${canView && !fullAccess ? "" : "disabled"} />
                      Editar
                    </label>
                  </div>
                `;
              }).join("")}
            </div>
          </section>
        `;
      })
      .join("");
  }

  function renderAccessControls() {
    if (!masterAccessPanel || mode !== "edit") return;
    masterAccessPanel.style.display = "";
    const vinculos = accessPayload?.vinculos || [];
    if (!vinculos.length) {
      setAccessUnavailable("Este usuario ainda nao possui vinculo com empresa. Crie um vinculo antes de liberar modulos.");
      return;
    }

    renderAccessCompanyOptions();
    const vinculo = currentVinculo();
    if (!vinculo) {
      setAccessUnavailable("Vinculo nao encontrado para este usuario.");
      return;
    }

    if (accessEmpty) accessEmpty.style.display = "none";
    if (accessEditor) accessEditor.style.display = "";
    accessEditor.classList.toggle("is-admin-full-access", editedUserHasFullAccess());
    accessRole.value = String(vinculo.papel || "operador").toLowerCase();
    renderAccessFilters();
    renderAccessSectors();
    renderAccessModules();
  }

  async function loadAccessControls(userId, { silent = false } = {}) {
    if (!userId || !masterAccessPanel) return;
    if (!silent) setAccessLoading("Carregando acessos e modulos...");
    try {
      accessPayload = await api(`/api/admin/usuarios/${userId}/access-controls`, { method: "GET" });
      const vinculos = accessPayload?.vinculos || [];
      if (!selectedAccessEmpresaId && vinculos[0]) selectedAccessEmpresaId = Number(vinculos[0].empresa_id);
      if (selectedAccessEmpresaId && !vinculos.some((item) => Number(item.empresa_id) === Number(selectedAccessEmpresaId))) {
        selectedAccessEmpresaId = vinculos[0] ? Number(vinculos[0].empresa_id) : null;
      }
      renderAccessControls();
    } catch (err) {
      setAccessUnavailable(err.message || "Nao foi possivel carregar os acessos deste usuario.");
    }
  }

  function applyGroupSelection(group, kind, checked) {
    const selector = kind === "edit" ? "[data-access-edit]" : "[data-access-view]";
    accessModules
      .querySelectorAll(`[data-access-group="${cssIdent(group)}"] ${selector}`)
      .forEach((input) => {
        input.checked = checked;
        if (kind === "view") {
          const row = input.closest("[data-module-key]");
          const editInput = row?.querySelector("[data-access-edit]");
          if (editInput) {
            editInput.disabled = !checked;
            if (!checked) editInput.checked = false;
          }
        }
      });

    const groupEdit = accessModules.querySelector(`[data-access-group-edit="${cssIdent(group)}"]`);
    if (groupEdit && kind === "view") {
      groupEdit.disabled = !checked;
      if (!checked) groupEdit.checked = false;
    }
  }

  function collectAccessPayload() {
    const setores = [...accessSectorList.querySelectorAll("input[type='checkbox']:checked")].map((input) => input.value);
    if (editedUserHasFullAccess()) {
      return {
        papel: accessRole.value || "operador",
        setores,
        modulos: [],
      };
    }
    const moduleMap = new Map(
      (currentVinculo()?.modulos || []).map((item) => [
        item.modulo_key,
        {
          modulo_key: item.modulo_key,
          pode_acessar: item.pode_acessar === true,
          pode_editar: item.pode_editar === true,
        },
      ]),
    );

    [...accessModules.querySelectorAll("[data-module-key]")]
      .forEach((row) => {
        const key = row.dataset.moduleKey;
        const view = row.querySelector("[data-access-view]")?.checked === true;
        const edit = row.querySelector("[data-access-edit]")?.checked === true;
        moduleMap.set(key, {
          modulo_key: key,
          pode_acessar: view,
          pode_editar: view && edit,
        });
      });

    const modulos = [...moduleMap.values()].filter((item) => item.pode_acessar);

    return {
      papel: accessRole.value || "operador",
      setores,
      modulos,
    };
  }

  async function saveAccessControls({ clear = false } = {}) {
    if (!editingId || !selectedAccessEmpresaId) return;
    const button = clear ? btnAccessClear : btnAccessSave;
    const original = button?.textContent || "";
    if (button) {
      button.disabled = true;
      button.textContent = clear ? "Removendo..." : "Salvando...";
    }

    try {
      const payload = clear
        ? { papel: accessRole.value || "operador", setores: [], modulos: [] }
        : collectAccessPayload();
      await api(`/api/admin/usuarios/${editingId}/access-controls/${selectedAccessEmpresaId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      await loadAccessControls(editingId, { silent: true });
      showToast(clear ? "Acessos removidos para esta empresa." : "Acessos atualizados.");
    } catch (err) {
      setError(err.message || "Erro ao salvar acessos.");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = original;
      }
    }
  }

  async function loadMe() {
    try {
      const data = await api("/api/auth/me", { method: "GET" });
      const logged = data?.logged === true || !!data?.user;
      if (!logged) {
        window.location.href = withBase("/login");
        return false;
      }

      auth.uid = Number(data?.user?.uid) || null;
      auth.isMaster =
        data?.is_master === true || String(data?.user?.nivel || "") === "admin_master";

      if (!auth.isMaster) {
        window.location.href = withBase("/nao-autorizado");
        return false;
      }
      return true;
    } catch (_err) {
      window.location.href = withBase("/login");
      return false;
    }
  }

  function ensureNivelOptions() {
    const wanted = [
      { v: "usuario", t: "Usuario" },
      { v: "administrador", t: "Administrador" },
      { v: "admin_master", t: "Master" },
    ];

    const existing = new Set([...fNivel.options].map((o) => o.value));
    wanted.forEach((opt) => {
      if (!existing.has(opt.v)) {
        const o = document.createElement("option");
        o.value = opt.v;
        o.textContent = opt.t;
        fNivel.appendChild(o);
      }
    });
  }

  function isMasterRow(user) {
    return String(user?.nivel || "").toLowerCase() === "admin_master";
  }

  function isSelfRow(user) {
    return Number(user?.id) === Number(auth.uid);
  }

  function canDeleteUserRow(user) {
    return auth.isMaster && !isSelfRow(user) && !isMasterRow(user);
  }

  function canInviteUserRow(user) {
    return auth.isMaster && String(user?.status || "").toLowerCase() !== "ativo";
  }

  function wizardEnable(on) {
    wizardHead.style.display = on ? "" : "none";
    btnWizNext.style.display = on ? "" : "none";
    btnWizBack.style.display = "none";
    btnSave.style.display = on ? "none" : "";
  }

  function setWizardStep(step) {
    wizardStep = step === 2 ? 2 : 1;
    step1El.style.display = wizardStep === 1 ? "" : "none";
    step2El.style.display = wizardStep === 2 ? "" : "none";
    wizardStepText.textContent = `Passo ${wizardStep}/2`;
    wizardStepSmall.textContent =
      wizardStep === 1 ? "Dados do usuario" : "Vinculo com empresa";
    wizardBarFill.style.width = wizardStep === 1 ? "50%" : "100%";

    if (wizardStep === 1) {
      btnWizBack.style.display = "none";
      btnWizNext.style.display = "";
      btnSave.style.display = "none";
    } else {
      btnWizBack.style.display = "";
      btnWizNext.style.display = "none";
      btnSave.style.display = "";
    }

    setError("");
    clearFieldErrors();
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
  }

  function validateStep1() {
    clearFieldErrors();

    const nome = String(fNome.value || "").trim();
    const email = String(fEmail.value || "").trim().toLowerCase();
    const nivel = String(fNivel.value || "usuario").trim().toLowerCase();
    const senha = String(fSenha.value || "");
    let ok = true;

    if (nome && nome.length < 2) {
      ok = false;
      setFieldError(fNome, errNome, "Nome muito curto.");
    }
    if (!email) {
      ok = false;
      setFieldError(fEmail, errEmail, "Informe o email.");
    } else if (!isValidEmail(email)) {
      ok = false;
      setFieldError(fEmail, errEmail, "Email invalido.");
    }
    if (!nivel) {
      ok = false;
      setFieldError(fNivel, errNivel, "Selecione o nivel.");
    }
    if (mode === "edit" && senha && senha.length < 6) {
      ok = false;
      setFieldError(fSenha, errSenha, "A senha deve ter no minimo 6 caracteres.");
    }
    return ok;
  }

  function validateStep2() {
    clearFieldErrors();

    const empresaId = Number(fEmpresa.value);
    const papel = String(fPapel.value || "").trim().toLowerCase();
    let ok = true;

    if (!Number.isFinite(empresaId) || empresaId <= 0) {
      ok = false;
      setFieldError(fEmpresa, errEmpresa, "Selecione uma empresa.");
    }
    if (!["owner", "admin", "operador"].includes(papel)) {
      ok = false;
      setFieldError(fPapel, errPapel, "Selecione um papel valido.");
    }
    return ok;
  }

  async function loadEmpresasIfNeeded() {
    if (empresasLoaded && Array.isArray(empresasCache)) return;
    fEmpresa.innerHTML = `<option value="">Carregando...</option>`;
    const data = await api("/api/admin/empresas", { method: "GET" });
    empresasCache = Array.isArray(data.empresas) ? data.empresas : [];
    empresasLoaded = true;

    if (!empresasCache.length) {
      fEmpresa.innerHTML = `<option value="">Nenhuma empresa cadastrada</option>`;
      return;
    }

    fEmpresa.innerHTML =
      `<option value="">Selecione...</option>` +
      empresasCache
        .map(
          (empresa) =>
            `<option value="${Number(empresa.id)}">${escapeHtml(
              empresa.nome || `Empresa ${empresa.id}`,
            )}</option>`,
        )
        .join("");
  }

  async function wizardNext() {
    setError("");
    if (!validateStep1()) return;

    wizardSummaryValue.textContent = String(fEmail.value || "").trim().toLowerCase();
    try {
      await loadEmpresasIfNeeded();
      setWizardStep(2);
    } catch (err) {
      setError(err.message || "Erro ao carregar empresas.");
    }
  }

  function wizardBack() {
    setWizardStep(1);
  }

  function applyFilter() {
    if (Date.now() < suppressSearchEventsUntil) return;
    const q = String(search.value || "").trim().toLowerCase();
    if (!q) {
      filtered = [...allUsers];
    } else {
      filtered = allUsers.filter((u) => {
        return [
          u.id,
          u.nome,
          u.email,
          u.nivel,
          u.status,
        ].some((value) => String(value || "").toLowerCase().includes(q));
      });
    }
    page = 1;
    render();
  }

  function paginate(list) {
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / perPage));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * perPage;
    const end = Math.min(start + perPage, total);
    return { total, pages, start, end, slice: list.slice(start, end) };
  }

  function render() {
    const { total, pages, start, end, slice } = paginate(filtered);
    countPill.textContent = `${total} usuario${total === 1 ? "" : "s"}`;
    pageInfo.textContent = `${page} / ${pages}`;
    rangeInfo.textContent = total
      ? `Mostrando ${start + 1}–${end} de ${total}`
      : "Nenhum usuario encontrado";
    btnPrev.disabled = page <= 1;
    btnNext.disabled = page >= pages;

    if (!slice.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="table-empty">Nenhum usuario encontrado.</td></tr>`;
      return;
    }

    tbody.innerHTML = slice
      .map((u) => {
        const editBtn = `<button class="icon-btn" data-action="edit" data-id="${u.id}" title="Editar">✏️</button>`;
        const inviteBtn = canInviteUserRow(u)
          ? `<button class="icon-btn" data-action="invite" data-id="${u.id}" title="Gerar novo convite">🔗</button>`
          : `<button class="icon-btn" disabled title="Usuario ja ativo">🔗</button>`;
        const deleteBtn = canDeleteUserRow(u)
          ? `<button class="icon-btn danger" data-action="delete" data-id="${u.id}" title="Remover">🗑️</button>`
          : `<button class="icon-btn danger" disabled title="Sem permissao">🗑️</button>`;

        return `
          <tr>
            <td>${u.id}</td>
            <td>${escapeHtml(u.nome || "—")}</td>
            <td>${escapeHtml(u.email || "—")}</td>
            <td>${badgeNivel(u.nivel)}</td>
            <td>${badgeStatus(u)}</td>
            <td>${formatDate(u.criado_em)}</td>
            <td>${formatDate(u.ultimo_login_em)}</td>
            <td>
              <div class="actions">
                ${inviteBtn}
                ${editBtn}
                ${deleteBtn}
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  async function loadUsers() {
    tbody.innerHTML = `<tr><td colspan="8" class="table-empty">Carregando...</td></tr>`;
    try {
      const data = await api("/api/admin/usuarios", { method: "GET" });
      allUsers = Array.isArray(data.usuarios) ? data.usuarios : [];
      filtered = [...allUsers];
      applyFilter();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8" class="table-empty">Erro ao carregar usuarios: ${escapeHtml(
        err.message,
      )}</td></tr>`;
    }
  }

  function openCreate() {
    mode = "create";
    editingId = null;
    modalTitle.textContent = "Convidar usuario";
    ensureNivelOptions();
    fNome.value = "";
    fEmail.value = "";
    fNivel.value = "usuario";
    fSenha.value = "";
    fEmpresa.value = "";
    fPapel.value = "admin";
    senhaGroup.style.display = "none";
    inviteNote.style.display = "";
    lblSenha.textContent = "Nova senha (opcional)";
    senhaHelp.textContent = "No cadastro, a senha sera definida pelo usuario no convite.";
    fNivel.disabled = false;
    fEmail.disabled = false;
    setError("");
    clearFieldErrors();
    wizardEnable(true);
    accessPayload = null;
    selectedAccessEmpresaId = null;
    if (masterAccessPanel) masterAccessPanel.style.display = "none";
    setWizardStep(1);
    showModal();
    fEmail.focus();
  }

  function openEdit(user) {
    suppressSearchEventsUntil = Date.now() + 900;
    mode = "edit";
    editingId = user.id;
    modalTitle.textContent = `Editar usuario #${user.id}`;
    ensureNivelOptions();
    fNome.value = user.nome || "";
    fEmail.value = user.email || "";
    fNivel.value = String(user.nivel || "usuario").toLowerCase();
    fSenha.value = "";
    senhaGroup.style.display = "";
    inviteNote.style.display = "none";
    lblSenha.textContent = "Nova senha (opcional)";
    senhaHelp.textContent = "Deixe vazio para manter a senha atual.";
    fNivel.disabled = isSelfRow(user) && isMasterRow(user);
    fEmail.disabled = isSelfRow(user) && isMasterRow(user);
    setError("");
    clearFieldErrors();
    wizardEnable(false);
    step1El.style.display = "";
    step2El.style.display = "none";
    btnSave.style.display = "";
    selectedAccessEmpresaId = null;
    accessPayload = null;
    setAccessLoading("Carregando acessos e modulos...");
    showModal();
    fNome.focus();
    loadAccessControls(user.id);
  }

  async function saveUser() {
    setError("");

    if (!validateStep1()) return;

    const payload = {
      nome: String(fNome.value || "").trim() || null,
      email: String(fEmail.value || "").trim().toLowerCase(),
      nivel: String(fNivel.value || "usuario").trim().toLowerCase(),
    };

    const senha = String(fSenha.value || "");
    if (mode === "edit" && senha) payload.senha = senha;

    if (mode === "create") {
      if (wizardStep !== 2) {
        await wizardNext();
        return;
      }
      if (!validateStep2()) return;
      payload.empresa_id = Number(fEmpresa.value);
      payload.papel = String(fPapel.value || "").trim().toLowerCase();
    }

    btnSave.disabled = true;
    btnSave.textContent = mode === "create" ? "Gerando convite..." : "Salvando...";

    try {
      if (mode === "create") {
        const data = await api("/api/admin/usuarios", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        hideModal();
        await loadUsers();
        await presentInvite(data.convite, data.email_delivery);
      } else {
        await api(`/api/admin/usuarios/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        hideModal();
        await loadUsers();
        showToast("Usuario atualizado.");
      }
    } catch (err) {
      setError(err.message || "Erro ao salvar.");
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = "Salvar";
      fNivel.disabled = false;
      fEmail.disabled = false;
    }
  }

  async function regenerateInvite(id) {
    try {
      const data = await api(`/api/admin/usuarios/${id}/invite`, {
        method: "POST",
      });
      await loadUsers();
      await presentInvite(data.convite, data.email_delivery);
    } catch (err) {
      alert(`Erro ao gerar convite: ${err.message}`);
    }
  }

  async function deleteUser(id) {
    const user = allUsers.find((item) => Number(item.id) === Number(id));
    if (!user) return;

    if (!canDeleteUserRow(user)) {
      alert("Remocao nao permitida para este usuario.");
      return;
    }

    if (!confirm(`Remover o usuario ${user.email} (#${user.id})?`)) return;

    try {
      await api(`/api/admin/usuarios/${id}`, { method: "DELETE" });
      await loadUsers();
      showToast("Usuario removido.");
    } catch (err) {
      alert(`Erro ao remover: ${err.message}`);
    }
  }

  function bindEvents() {
    btnCreate?.addEventListener("click", openCreate);
    btnRefresh?.addEventListener("click", loadUsers);
    btnClear?.addEventListener("click", () => {
      search.value = "";
      applyFilter();
      search.focus();
    });
    search?.addEventListener("input", applyFilter);
    btnPrev?.addEventListener("click", () => {
      page -= 1;
      render();
    });
    btnNext?.addEventListener("click", () => {
      page += 1;
      render();
    });
    modalClose?.addEventListener("click", hideModal);
    btnCancel?.addEventListener("click", hideModal);
    btnWizNext?.addEventListener("click", wizardNext);
    btnWizBack?.addEventListener("click", wizardBack);
    btnSave?.addEventListener("click", saveUser);
    btnAccessReload?.addEventListener("click", () => {
      if (editingId) loadAccessControls(editingId);
    });
    btnAccessSave?.addEventListener("click", () => saveAccessControls());
    fNivel?.addEventListener("change", () => {
      if (mode === "edit" && accessPayload) renderAccessControls();
    });
    btnAccessClear?.addEventListener("click", () => {
      if (confirm("Remover todos os acessos e setores deste usuario para a empresa selecionada?")) {
        saveAccessControls({ clear: true });
      }
    });
    accessCompany?.addEventListener("change", () => {
      selectedAccessEmpresaId = Number(accessCompany.value) || null;
      renderAccessControls();
    });
    accessGroupFilter?.addEventListener("change", renderAccessModules);
    accessModules?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-access-toggle-group]");
      if (!btn) return;
      const group = btn.getAttribute("data-access-toggle-group");
      const shell = btn.closest("[data-access-group]");
      if (!shell) return;
      shell.classList.toggle("is-collapsed");
      btn.setAttribute("aria-expanded", shell.classList.contains("is-collapsed") ? "false" : "true");
    });
    accessModules?.addEventListener("change", (e) => {
      const groupView = e.target.closest("[data-access-group-view]");
      const groupEdit = e.target.closest("[data-access-group-edit]");
      const itemView = e.target.closest("[data-access-view]");
      if (groupView) {
        applyGroupSelection(groupView.getAttribute("data-access-group-view"), "view", groupView.checked);
      }
      if (groupEdit) {
        applyGroupSelection(groupEdit.getAttribute("data-access-group-edit"), "edit", groupEdit.checked);
      }
      if (itemView) {
        const row = itemView.closest("[data-module-key]");
        const editInput = row?.querySelector("[data-access-edit]");
        if (editInput) {
          editInput.disabled = !itemView.checked;
          if (!itemView.checked) editInput.checked = false;
        }
      }
    });

    modal?.addEventListener("click", (e) => {
      if (e.target === modal) hideModal();
    });

    tbody?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      const id = Number(btn.getAttribute("data-id"));
      const user = allUsers.find((item) => Number(item.id) === id);

      if (action === "edit" && user) openEdit(user);
      if (action === "invite") regenerateInvite(id);
      if (action === "delete") deleteUser(id);
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.style.display === "flex") hideModal();
      if (modal.style.display !== "flex") return;
      if (e.key !== "Enter") return;

      const tag = String(e.target?.tagName || "").toLowerCase();
      if (!["input", "select"].includes(tag)) return;
      e.preventDefault();

      if (mode === "create" && wizardStep === 1) wizardNext();
      else saveUser();
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    const ok = await loadMe();
    if (!ok) return;
    await loadUsers();
  });
})();
