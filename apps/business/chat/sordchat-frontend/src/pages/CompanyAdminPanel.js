import React, { useEffect, useMemo, useState } from "react";
import {
  Building2,
  Download,
  Eye,
  FileImage,
  FileSpreadsheet,
  GitBranch,
  Pencil,
  Printer,
  Save,
  Search,
  Settings2,
  Upload,
  UserRoundPlus,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import { API_BASE_URL } from "../config";
import { useAuth } from "../contexts/AuthContext";
import { formatBirthdayInput } from '../utils/birthdays';
import UserManagementModal from '../components/common/UserManagementModal';
import InternalControlPanel from '../components/admin/InternalControlPanel';

const roleLabel = {
  company_admin: "Admin da empresa",
  master_admin: "Admin Master",
  coordinator: "Coordenador",
  user: "Usuario",
};

const requestJson = async (path, options = {}) => {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${localStorage.getItem("token")}`,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || "Operacao nao concluida.");
  }
  return response.json();
};

const escapeXml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

const CompanyAdminPanel = () => {
  const { user, isPlatformAdmin, isCompanyAdmin } = useAuth();
  const [activeTab, setActiveTab] = useState("departments");
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState("");
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingDepartment, setSavingDepartment] = useState(false);
  const [departmentForm, setDepartmentForm] = useState({
    id: "",
    name: "",
    description: "",
    status: "active",
  });
  const [draggedUserId, setDraggedUserId] = useState(null);
  const [selectedDepartmentId, setSelectedDepartmentId] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [savingUser, setSavingUser] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [newUser, setNewUser] = useState({
    full_name: "",
    username: "",
    email: "",
    password: "",
    role_title: "",
    phone: "",
    phone_extension: "",
    birthday: "",
    role: "user",
  });
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importing, setImporting] = useState(false);
  const [savingCompanySettings, setSavingCompanySettings] = useState(false);

  const activeDepartments = useMemo(
    () =>
      (overview?.departments || []).filter(
        (department) => department.status === "active",
      ),
    [overview],
  );

  const usersByDepartment = useMemo(() => {
    const groups = new Map();
    (overview?.departments || []).forEach((department) =>
      groups.set(department.id, []),
    );
    groups.set("unassigned", []);
    (overview?.users || []).forEach((item) => {
      const departmentId = item.membership?.department_id;
      const key = groups.has(departmentId) ? departmentId : "unassigned";
      groups.get(key).push(item);
    });
    return groups;
  }, [overview]);

  const selectedDepartment = useMemo(
    () =>
      (overview?.departments || []).find(
        (department) => department.id === selectedDepartmentId,
      ) || null,
    [overview, selectedDepartmentId],
  );

  const selectedUsers = useMemo(() => {
    const term = userQuery.trim().toLowerCase();
    return (usersByDepartment.get(selectedDepartmentId) || []).filter(
      (item) =>
        !term ||
        [item.full_name, item.username, item.email, item.role_title]
          .join(" ")
          .toLowerCase()
          .includes(term),
    );
  }, [selectedDepartmentId, userQuery, usersByDepartment]);

  const loadCompanies = async () => {
    try {
      const data = await requestJson("/companies/available");
      const allowed = data.filter((company) =>
        ["company_admin", "master_admin"].includes(company.role),
      );
      setCompanies(allowed);
      if (!isPlatformAdmin()) {
        setCompanyId(user?.company_id || allowed[0]?.id || "");
      } else {
        setCompanyId((current) => current || allowed[0]?.id || "");
      }
    } catch (error) {
      toast.error(error.message);
      setLoading(false);
    }
  };

  const loadOverview = async (targetCompanyId = companyId) => {
    if (!targetCompanyId) return;
    setLoading(true);
    try {
      const data = await requestJson(
        `/company-admin/overview?company_id=${encodeURIComponent(targetCompanyId)}`,
      );
      setOverview(data);
      setSelectedDepartmentId((current) =>
        data.departments.some((department) => department.id === current)
          ? current
          : data.departments.find(
              (department) => department.status === "active",
            )?.id ||
            data.departments[0]?.id ||
            "",
      );
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCompanies();
  }, []);

  useEffect(() => {
    if (companyId) {
      loadOverview(companyId);
      setImportPreview(null);
      setDepartmentForm({
        id: "",
        name: "",
        description: "",
        status: "active",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  if (!isCompanyAdmin()) {
    return (
      <section className="empty-state">
        <Building2 size={30} />
        <h2>Acesso restrito</h2>
        <p>
          Somente administradores da empresa podem gerenciar setores e importar
          usuarios.
        </p>
      </section>
    );
  }

  const resetDepartmentForm = () => {
    setDepartmentForm({ id: "", name: "", description: "", status: "active" });
  };

  const editDepartment = (department) => {
    setDepartmentForm({
      id: department.id,
      name: department.name,
      description: department.description || "",
      status: department.status,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveDepartment = async (event) => {
    event.preventDefault();
    setSavingDepartment(true);
    try {
      const path = departmentForm.id
        ? `/company-admin/departments/${departmentForm.id}`
        : "/company-admin/departments";
      await requestJson(path, {
        method: departmentForm.id ? "PATCH" : "POST",
        body: JSON.stringify({ ...departmentForm, company_id: companyId }),
      });
      toast.success(departmentForm.id ? "Setor atualizado." : "Setor criado.");
      resetDepartmentForm();
      await loadOverview();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSavingDepartment(false);
    }
  };

  const allocateUser = async (userId, departmentId) => {
    if (!userId || !departmentId) return;
    try {
      await requestJson(`/company-admin/users/${userId}/department`, {
        method: "PATCH",
        body: JSON.stringify({
          company_id: companyId,
          department_id: departmentId,
        }),
      });
      toast.success("Usuario alocado no setor.");
      setDraggedUserId(null);
      await loadOverview();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const updateUserRole = async (item, role) => {
    try {
      await requestJson(`/users/${item.id}`, {
        method: "PUT",
        body: JSON.stringify({ company_id: companyId, role }),
      });
      toast.success("Permissao do usuario atualizada.");
      await loadOverview();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const createUser = async (event) => {
    event.preventDefault();
    if (!selectedDepartment) {
      toast.error("Selecione o setor do novo usuario.");
      return;
    }
    setSavingUser(true);
    try {
      await requestJson("/users/", {
        method: "POST",
        body: JSON.stringify({
          ...newUser,
          company_id: companyId,
          department_id: selectedDepartment.id,
          department: selectedDepartment.name,
        }),
      });
      toast.success(`Usuario criado no setor ${selectedDepartment.name}.`);
      setNewUser({
        full_name: "",
        username: "",
        email: "",
        password: "",
        role_title: "",
        phone: "",
        phone_extension: "",
        birthday: "",
        role: "user",
      });
      await loadOverview();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSavingUser(false);
    }
  };

  const buildMindMapSvg = () => {
    const rows = (overview?.departments || []).map((department) => ({
      department,
      users: usersByDepartment.get(department.id) || [],
    }));
    const heights = rows.map((row) =>
      Math.max(104, 50 + row.users.length * 42),
    );
    const height = Math.max(
      280,
      heights.reduce((total, item) => total + item + 20, 70),
    );
    const companyY = height / 2 - 45;
    let cursorY = 60;
    const items = [
      `<rect width="1280" height="${height}" fill="#f8fafc"/>`,
      `<text x="38" y="32" fill="#64748b" font-family="Arial" font-size="15" font-weight="700">MAPA DE DISTRIBUICAO DA EMPRESA</text>`,
      `<rect x="38" y="${companyY}" width="250" height="90" rx="18" fill="#0f766e"/>`,
      `<text x="58" y="${companyY + 33}" fill="#ccfbf1" font-family="Arial" font-size="13" font-weight="700">EMPRESA</text>`,
      `<text x="58" y="${companyY + 62}" fill="#fff" font-family="Arial" font-size="20" font-weight="800">${escapeXml((overview?.company?.name || "Empresa").slice(0, 23))}</text>`,
    ];
    rows.forEach(({ department, users }, index) => {
      const nodeY = cursorY + heights[index] / 2 - 38;
      items.push(
        `<path d="M288 ${companyY + 45} C335 ${companyY + 45},335 ${nodeY + 38},382 ${nodeY + 38}" fill="none" stroke="#94a3b8" stroke-width="3"/>`,
      );
      items.push(
        `<rect x="382" y="${nodeY}" width="280" height="76" rx="14" fill="${department.status === "active" ? "#2563eb" : "#94a3b8"}"/>`,
      );
      items.push(
        `<text x="400" y="${nodeY + 28}" fill="#dbeafe" font-family="Arial" font-size="12" font-weight="700">SETOR • ${users.length} USUARIO(S)</text>`,
      );
      items.push(
        `<text x="400" y="${nodeY + 54}" fill="#fff" font-family="Arial" font-size="19" font-weight="800">${escapeXml(department.name.slice(0, 24))}</text>`,
      );
      if (!users.length)
        items.push(
          `<text x="780" y="${nodeY + 43}" fill="#94a3b8" font-family="Arial" font-size="14">Sem usuarios alocados</text>`,
        );
      users.forEach((user, userIndex) => {
        const userY = cursorY + userIndex * 42;
        items.push(
          `<path d="M662 ${nodeY + 38} C710 ${nodeY + 38},710 ${userY + 16},758 ${userY + 16}" fill="none" stroke="#bfdbfe" stroke-width="2"/>`,
        );
        items.push(
          `<rect x="758" y="${userY}" width="470" height="34" rx="9" fill="#fff" stroke="#cbd5e1"/>`,
        );
        items.push(
          `<text x="776" y="${userY + 22}" fill="#0f172a" font-family="Arial" font-size="13" font-weight="700">${escapeXml((user.full_name || user.username).slice(0, 34))}</text>`,
        );
        items.push(
          `<text x="1050" y="${userY + 22}" fill="#64748b" font-family="Arial" font-size="11">${escapeXml(roleLabel[user.membership?.role] || user.membership?.role)}</text>`,
        );
      });
      cursorY += heights[index] + 20;
    });
    if (!rows.length)
      items.push(
        '<text x="390" y="145" fill="#64748b" font-family="Arial" font-size="18">Nenhum setor cadastrado.</text>',
      );
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="${height}" viewBox="0 0 1280 ${height}">${items.join("")}</svg>`;
  };

  const exportMindMap = () => {
    const filename = `mapa-${(overview?.company?.name || "empresa").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.svg`;
    downloadBlob(
      new Blob([buildMindMapSvg()], { type: "image/svg+xml;charset=utf-8" }),
      filename,
    );
  };

  const printMindMap = () => {
    const popup = window.open("", "_blank");
    if (!popup) {
      toast.error("Permita pop-ups para abrir a versao de impressao.");
      return;
    }
    popup.document.write(
      `<!doctype html><html><head><title>Mapa mental</title><style>@page{size:landscape;margin:8mm}body{margin:0;font-family:Arial}.tools{padding:12px;text-align:center;background:#0f172a}.tools button{padding:10px 18px;border:0;border-radius:8px;font-weight:700;cursor:pointer}.map{padding:12px}.map svg{display:block;width:100%;height:auto}@media print{.tools{display:none}.map{padding:0}}</style></head><body><div class="tools"><button onclick="window.print()">Imprimir ou salvar como PDF</button></div><div class="map">${buildMindMapSvg()}</div></body></html>`,
    );
    popup.document.close();
  };

  const downloadTemplate = async () => {
    try {
      const response = await fetch(
        `${API_BASE_URL}/company-admin/import/users/template?company_id=${encodeURIComponent(companyId)}`,
        {
          headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
        },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.detail || "Nao foi possivel baixar o modelo.");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "modelo-importacao-usuarios.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const previewImport = async () => {
    if (!importFile) {
      toast.error("Selecione uma planilha CSV ou XLSX.");
      return;
    }
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", importFile);
      const response = await fetch(
        `${API_BASE_URL}/company-admin/import/users/preview?company_id=${encodeURIComponent(companyId)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
          body: formData,
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(payload.detail || "Nao foi possivel ler a planilha.");
      setImportPreview(payload);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setImporting(false);
    }
  };

  const confirmImport = async () => {
    if (!importPreview || importPreview.error_count > 0) return;
    setImporting(true);
    try {
      const result = await requestJson("/company-admin/import/users/confirm", {
        method: "POST",
        body: JSON.stringify({
          company_id: companyId,
          rows: importPreview.rows.map((row) => row.data),
        }),
      });
      toast.success(
        `Importacao concluida: ${result.imported} novos, ${result.updated} atualizados.`,
      );
      setImportFile(null);
      setImportPreview(null);
      await loadOverview();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setImporting(false);
    }
  };

  const renderCompanySelector = () => (
    <div className="company-tags" aria-label="Selecionar empresa">
      {companies.map((company) => (
        <button
          className={company.id === companyId ? "active" : ""}
          key={company.id}
          type="button"
          onClick={() => setCompanyId(company.id)}
        >
          <Building2 size={15} />
          {company.name}
        </button>
      ))}
    </div>
  );

  const renderDepartments = () => (
    <>
      <section className="company-admin-grid">
        <form
          className="panel company-admin-department-form"
          onSubmit={saveDepartment}
        >
          <div className="section-heading">
            <div>
              <span>{departmentForm.id ? "Editar setor" : "Novo setor"}</span>
              <h3>{departmentForm.id ? departmentForm.name : "Criar setor"}</h3>
            </div>
            {departmentForm.id && (
              <button
                className="icon-button icon-button--light"
                type="button"
                onClick={resetDepartmentForm}
              >
                <X size={17} />
              </button>
            )}
          </div>
          <label>
            Nome
            <input
              className="input"
              required
              value={departmentForm.name}
              onChange={(event) =>
                setDepartmentForm((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Descricao
            <textarea
              className="textarea"
              rows={3}
              value={departmentForm.description}
              onChange={(event) =>
                setDepartmentForm((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
            />
          </label>
          {departmentForm.id && (
            <label>
              Status
              <select
                className="select"
                value={departmentForm.status}
                onChange={(event) =>
                  setDepartmentForm((current) => ({
                    ...current,
                    status: event.target.value,
                  }))
                }
              >
                <option value="active">Ativo</option>
                <option value="inactive">Inativo</option>
              </select>
            </label>
          )}
          <button
            className="button-primary"
            type="submit"
            disabled={savingDepartment}
          >
            <Save size={16} />{" "}
            {savingDepartment ? "Salvando..." : "Salvar setor"}
          </button>
        </form>

        <article className="panel company-admin-guide">
          <GitBranch size={25} />
          <h3>Mapa de alocacao</h3>
          <p>
            Arraste um usuario de um setor para outro. A alteracao e salva
            imediatamente no tenant da empresa.
          </p>
          <div className="flex flex-wrap gap-2">
            <span className="badge">
              {overview?.stats?.departments || 0} setores
            </span>
            <span className="badge badge--success">
              {overview?.stats?.users || 0} usuarios
            </span>
          </div>
        </article>
      </section>

      <section className="department-map" aria-label="Mapa de setores">
        {(overview?.departments || []).map((department) => (
          <article
            className={`department-map-card ${department.status !== "active" ? "department-map-card--inactive" : ""}`}
            key={department.id}
            onDragOver={(event) =>
              department.status === "active" && event.preventDefault()
            }
            onDrop={() =>
              department.status === "active" &&
              allocateUser(draggedUserId, department.id)
            }
          >
            <header>
              <div>
                <span>Setor</span>
                <h3>{department.name}</h3>
              </div>
              <button
                className="icon-button icon-button--light"
                type="button"
                onClick={() => editDepartment(department)}
                title="Editar setor"
              >
                <Pencil size={16} />
              </button>
            </header>
            {department.description && <p>{department.description}</p>}
            <div className="department-map-users">
              {(usersByDepartment.get(department.id) || []).map((item) => (
                <button
                  className="department-user-chip"
                  draggable={department.status === "active"}
                  key={item.id}
                  type="button"
                  onDragStart={() => setDraggedUserId(item.id)}
                  title="Arraste para outro setor"
                >
                  <span>
                    {(item.full_name || item.username || "U")
                      .charAt(0)
                      .toUpperCase()}
                  </span>
                  <div>
                    <strong>{item.full_name}</strong>
                    <small>
                      {roleLabel[item.membership?.role] ||
                        item.membership?.role}
                    </small>
                  </div>
                </button>
              ))}
              {(usersByDepartment.get(department.id) || []).length === 0 && (
                <small className="department-map-empty">
                  Solte usuarios aqui
                </small>
              )}
            </div>
          </article>
        ))}
      </section>

      <section className="panel p-5">
        <div className="section-heading">
          <div>
            <span>Modo manual</span>
            <h3>Alocacao individual</h3>
          </div>
        </div>
        <div className="company-user-allocation-list">
          {(overview?.users || []).map((item) => (
            <div className="company-user-allocation-row" key={item.id}>
              <div>
                <strong>{item.full_name}</strong>
                <small>
                  {item.email} ?{" "}
                  {roleLabel[item.membership?.role] || item.membership?.role}
                </small>
              </div>
              <div className="company-user-allocation-controls">
                <select
                  className="select"
                  value={item.membership?.department_id || ""}
                  onChange={(event) =>
                    allocateUser(item.id, event.target.value)
                  }
                >
                  <option value="" disabled>
                    Selecionar setor
                  </option>
                  {activeDepartments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </select>
                <select
                  className="select"
                  value={item.membership?.role || "user"}
                  onChange={(event) => updateUserRole(item, event.target.value)}
                >
                  <option value="user">Usuario</option>
                  <option value="coordinator">Coordenador</option>
                  <option value="company_admin">Admin da empresa</option>
                </select>
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => setEditingUser(item)}
                >
                  <Pencil size={15} /> Editar / excluir
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );

  const renderUsers = () => (
    <>
      <section className="panel p-5">
        <div className="section-heading">
          <div>
            <span>Setor ativo</span>
            <h3>{selectedDepartment?.name || "Selecione um setor"}</h3>
            <p>Crie, localize e mova usuarios dentro da empresa.</p>
          </div>
          <select
            className="select company-admin-sector-select"
            value={selectedDepartmentId}
            onChange={(event) => setSelectedDepartmentId(event.target.value)}
          >
            <option value="">Selecionar setor</option>
            {activeDepartments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="panel p-5">
        <div className="section-heading">
          <div>
            <span>Novo acesso</span>
            <h3>Criar usuario em {selectedDepartment?.name || "um setor"}</h3>
          </div>
          <UserRoundPlus size={23} className="text-blue-600" />
        </div>
        <form className="company-admin-user-form mt-4" onSubmit={createUser}>
          <input
            className="input"
            required
            value={newUser.full_name}
            onChange={(event) =>
              setNewUser((current) => ({
                ...current,
                full_name: event.target.value,
              }))
            }
            placeholder="Nome completo"
          />
          <input
            className="input"
            value={newUser.username}
            onChange={(event) =>
              setNewUser((current) => ({
                ...current,
                username: event.target.value,
              }))
            }
            placeholder="Usuario (opcional)"
          />
          <input
            className="input"
            required
            type="email"
            value={newUser.email}
            onChange={(event) =>
              setNewUser((current) => ({
                ...current,
                email: event.target.value,
              }))
            }
            placeholder="E-mail para login"
          />
          <input
            className="input"
            required
            minLength={6}
            type="password"
            value={newUser.password}
            onChange={(event) =>
              setNewUser((current) => ({
                ...current,
                password: event.target.value,
              }))
            }
            placeholder="Senha inicial"
          />
          <input
            className="input"
            value={newUser.role_title}
            onChange={(event) =>
              setNewUser((current) => ({
                ...current,
                role_title: event.target.value,
              }))
            }
            placeholder="Cargo"
          />
          <input
            className="input"
            value={newUser.phone}
            onChange={(event) =>
              setNewUser((current) => ({
                ...current,
                phone: event.target.value,
              }))
            }
            placeholder="Telefone"
          />
          <input
            className="input"
            value={newUser.phone_extension}
            onChange={(event) =>
              setNewUser((current) => ({
                ...current,
                phone_extension: event.target.value,
              }))
            }
            placeholder="Ramal"
          />
          <input
            className="input"
            value={newUser.birthday}
            onChange={(event) =>
              setNewUser((current) => ({
                ...current,
                birthday: formatBirthdayInput(event.target.value),
              }))
            }
            placeholder="Nascimento DD-MM-AA ou DD-MM-AAAA"
            inputMode="numeric"
            maxLength={10}
            title="Aceita 24/09/03, 24-09-2003 ou 24092003"
          />
          <select
            className="select"
            value={newUser.role}
            onChange={(event) =>
              setNewUser((current) => ({
                ...current,
                role: event.target.value,
              }))
            }
          >
            <option value="user">Usuario</option>
            <option value="coordinator">Coordenador</option>
            <option value="company_admin">Admin da empresa</option>
          </select>
          <button
            className="button-primary"
            type="submit"
            disabled={savingUser || !selectedDepartment}
          >
            <Save size={16} /> {savingUser ? "Criando..." : "Criar usuario"}
          </button>
        </form>
      </section>

      <section className="panel p-5">
        <div className="section-heading">
          <div>
            <span>Equipe</span>
            <h3>Usuarios de {selectedDepartment?.name || "setor"}</h3>
          </div>
          <label className="coordination-search">
            <Search size={16} />
            <input
              value={userQuery}
              onChange={(event) => setUserQuery(event.target.value)}
              placeholder="Buscar por nome ou e-mail"
            />
          </label>
        </div>
        <div className="company-user-allocation-list">
          {selectedUsers.map((item) => (
            <div className="company-user-allocation-row" key={item.id}>
              <div>
                <strong>{item.full_name}</strong>
                <small>
                  {item.email} •{" "}
                  {roleLabel[item.membership?.role] || item.membership?.role}
                </small>
              </div>
              <div className="company-user-allocation-controls">
                <select
                  className="select"
                  value={item.membership?.department_id || ""}
                  onChange={(event) =>
                    allocateUser(item.id, event.target.value)
                  }
                >
                  <option value="" disabled>
                    Selecionar setor
                  </option>
                  {activeDepartments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </select>
                <select
                  className="select"
                  value={item.membership?.role || "user"}
                  onChange={(event) => updateUserRole(item, event.target.value)}
                >
                  <option value="user">Usuario</option>
                  <option value="coordinator">Coordenador</option>
                  <option value="company_admin">Admin da empresa</option>
                </select>
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => setEditingUser(item)}
                >
                  <Pencil size={15} /> Editar / excluir
                </button>
              </div>
            </div>
          ))}
          {selectedDepartment && !selectedUsers.length && (
            <div className="empty-state">
              <UserRoundPlus size={26} />
              <h3>Nenhum usuario encontrado</h3>
              <p>Crie o primeiro usuario deste setor.</p>
            </div>
          )}
        </div>
      </section>
    </>
  );

  const renderMindMap = () => (
    <>
      <section className="panel p-5">
        <div className="section-heading">
          <div>
            <span>Organograma interativo</span>
            <h3>Mapa mental da empresa</h3>
            <p>
              Arraste usuarios entre setores e exporte a distribuicao completa.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="button-secondary"
              type="button"
              onClick={exportMindMap}
            >
              <FileImage size={16} /> Baixar imagem SVG
            </button>
            <button
              className="button-primary"
              type="button"
              onClick={printMindMap}
            >
              <Printer size={16} /> Imprimir / salvar PDF
            </button>
          </div>
        </div>
      </section>
      <section className="mind-map-board" aria-label="Mapa mental da empresa">
        <article className="mind-map-company-node">
          <Building2 size={24} />
          <span>Empresa</span>
          <strong>{overview?.company?.name || "Empresa"}</strong>
          <small>
            {overview?.stats?.users || 0} usuarios •{" "}
            {overview?.stats?.departments || 0} setores
          </small>
        </article>
        <div className="mind-map-branches">
          {(overview?.departments || []).map((department) => (
            <article
              className={`mind-map-department-node ${department.status !== "active" ? "is-inactive" : ""}`}
              key={department.id}
              onDragOver={(event) =>
                department.status === "active" && event.preventDefault()
              }
              onDrop={() =>
                department.status === "active" &&
                allocateUser(draggedUserId, department.id)
              }
            >
              <header>
                <div>
                  <span>Setor</span>
                  <h3>{department.name}</h3>
                </div>
                <button
                  className="icon-button icon-button--light"
                  type="button"
                  onClick={() => {
                    setSelectedDepartmentId(department.id);
                    editDepartment(department);
                    setActiveTab("departments");
                  }}
                  title="Configurar setor"
                >
                  <Settings2 size={16} />
                </button>
              </header>
              {department.description && <p>{department.description}</p>}
              <div className="department-map-users">
                {(usersByDepartment.get(department.id) || []).map((item) => (
                  <button
                    className="department-user-chip"
                    draggable={department.status === "active"}
                    key={item.id}
                    type="button"
                    onDragStart={() => setDraggedUserId(item.id)}
                    title="Arraste para outro setor"
                  >
                    <span>
                      {(item.full_name || item.username || "U")
                        .charAt(0)
                        .toUpperCase()}
                    </span>
                    <div>
                      <strong>{item.full_name}</strong>
                      <small>
                        {roleLabel[item.membership?.role] ||
                          item.membership?.role}
                      </small>
                    </div>
                  </button>
                ))}
                {(usersByDepartment.get(department.id) || []).length === 0 && (
                  <small className="department-map-empty">
                    Solte usuarios aqui
                  </small>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );

  const renderImport = () => (
    <>
      <section className="panel p-5">
        <div className="section-heading">
          <div>
            <span>Importacao em lote</span>
            <h3>Usuarios por planilha</h3>
            <p>
              Informe nome, usuario, email, ramal, setor e nivel de acesso. O
              status sera ativo, sem login no Hub, com senha inicial Alterar@123.
            </p>
          </div>
          <button
            className="button-secondary"
            type="button"
            onClick={downloadTemplate}
          >
            <Download size={16} /> Baixar planilha modelo
          </button>
        </div>
        <div className="company-import-actions">
          <label className="company-import-drop">
            <FileSpreadsheet size={25} />
            <strong>{importFile?.name || "Selecionar CSV ou XLSX"}</strong>
            <span>Ate 1.000 usuarios por importacao</span>
            <input
              hidden
              type="file"
              accept=".csv,.xlsx"
              onChange={(event) => {
                setImportFile(event.target.files?.[0] || null);
                setImportPreview(null);
              }}
            />
          </label>
          <button
            className="button-primary"
            type="button"
            onClick={previewImport}
            disabled={importing || !importFile}
          >
            <Upload size={16} /> Gerar previa
          </button>
        </div>
      </section>

      {importPreview && (
        <section className="panel p-5">
          <div className="section-heading">
            <div>
              <span>Conferencia</span>
              <h3>Previa da importacao</h3>
            </div>
            <div className="flex gap-2">
              <span className="badge badge--success">
                {importPreview.valid_count} validos
              </span>
              <span className="badge badge--danger">
                {importPreview.error_count} erros
              </span>
            </div>
          </div>
          <div className="import-preview-table">
            {importPreview.rows.map((row) => (
              <div className={row.valid ? "valid" : "invalid"} key={row.row}>
                <strong>
                  Linha {row.row}: {row.data.nome_completo || row.data.email}
                </strong>
                <span>
                  {row.data.email} ? {row.data.setor} ?{" "}
                  {roleLabel[row.data.nivel_usuario] || row.data.nivel_usuario}
                </span>
                {row.errors.map((error) => (
                  <small className="text-red-600" key={error}>
                    {error}
                  </small>
                ))}
                {row.warnings.map((warning) => (
                  <small className="text-amber-700" key={warning}>
                    {warning}
                  </small>
                ))}
              </div>
            ))}
          </div>
          <button
            className="button-primary mt-4"
            type="button"
            onClick={confirmImport}
            disabled={importing || importPreview.error_count > 0}
          >
            <UserRoundPlus size={16} />{" "}
            {importing ? "Importando..." : "Confirmar importacao"}
          </button>
        </section>
      )}
    </>
  );

  const updateStickerCreationPolicy = async (enabled) => {
    if (!companyId || savingCompanySettings) return;
    setSavingCompanySettings(true);
    try {
      const company = await requestJson("/company-admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          company_id: companyId,
          allow_user_sticker_creation: enabled,
        }),
      });
      setOverview((current) => current ? { ...current, company } : current);
      toast.success(enabled ? "Criação de figurinhas liberada." : "Criação de figurinhas restrita às oficiais.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSavingCompanySettings(false);
    }
  };

  const updateMessageEditingPolicy = async (enabled) => {
    if (!companyId || savingCompanySettings) return;
    setSavingCompanySettings(true);
    try {
      const company = await requestJson("/company-admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          company_id: companyId,
          allow_user_message_editing: enabled,
        }),
      });
      setOverview((current) => current ? { ...current, company } : current);
      toast.success(enabled ? "Edição de mensagens liberada." : "Edição de mensagens desabilitada.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSavingCompanySettings(false);
    }
  };

  const renderCompanySettings = () => (
    <section className="panel p-5">
      <div className="flex items-start gap-3">
        <span className="rounded-xl bg-blue-50 p-2 text-blue-600"><Settings2 size={20} /></span>
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-lg font-extrabold text-slate-950">Configurações da empresa</h3>
          <p className="mt-1 text-sm text-slate-500">Defina quais recursos de personalização estarão disponíveis aos usuários.</p>
        </div>
      </div>
      <div className="mt-5 grid gap-4">
        <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <strong className="block text-sm text-slate-950">Liberar criação de figurinhas de chat para seus usuários?</strong>
            <span className="mt-1 block text-xs leading-5 text-slate-500">Quando desabilitada, usuários comuns poderão enviar apenas as figurinhas oficiais pré-salvas do VoltChat.</span>
          </div>
          <button
            type="button"
            className={`${overview?.company?.allow_user_sticker_creation ? "button-primary" : "button-secondary"} min-w-32`}
            disabled={savingCompanySettings}
            aria-pressed={Boolean(overview?.company?.allow_user_sticker_creation)}
            onClick={() => updateStickerCreationPolicy(!overview?.company?.allow_user_sticker_creation)}
          >
            {savingCompanySettings ? "Salvando..." : overview?.company?.allow_user_sticker_creation ? "Liberado" : "Desabilitado"}
          </button>
        </div>
        <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <strong className="block text-sm text-slate-950">Permitir usuários editarem mensagens?</strong>
            <span className="mt-1 block text-xs leading-5 text-slate-500">Cada mensagem de texto poderá ser editada no máximo 2 vezes, somente nos primeiros 30 minutos após o envio. O histórico das versões ficará visível na conversa.</span>
          </div>
          <button
            type="button"
            className={`${overview?.company?.allow_user_message_editing ? "button-primary" : "button-secondary"} min-w-32`}
            disabled={savingCompanySettings}
            aria-pressed={Boolean(overview?.company?.allow_user_message_editing)}
            onClick={() => updateMessageEditingPolicy(!overview?.company?.allow_user_message_editing)}
          >
            {savingCompanySettings ? "Salvando..." : overview?.company?.allow_user_message_editing ? "Permitido" : "Desabilitado"}
          </button>
        </div>
      </div>
    </section>
  );

  return (
    <div className="work-page">
      <section className="panel p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <span className="badge">Coordenacao da empresa</span>
            <h2 className="m-0 mt-3 text-2xl font-extrabold text-slate-950">
              {overview?.company?.name || "Empresa"}
            </h2>
            <p className="m-0 mt-1 text-sm text-slate-500">
              Configure setores, usuarios e a distribuicao completa da equipe.
            </p>
          </div>
          {isPlatformAdmin() ? renderCompanySelector() : null}
        </div>
      </section>

      <section className="tenant-tabs coordination-tabs">
        <button
          className={activeTab === "departments" ? "active" : ""}
          type="button"
          onClick={() => setActiveTab("departments")}
        >
          <GitBranch size={16} /> Setores e configuracao
        </button>
        <button
          className={activeTab === "users" ? "active" : ""}
          type="button"
          onClick={() => setActiveTab("users")}
        >
          <UserRoundPlus size={16} /> Usuarios por setor
        </button>
        <button
          className={activeTab === "mind-map" ? "active" : ""}
          type="button"
          onClick={() => setActiveTab("mind-map")}
        >
          <FileImage size={16} /> Mapa mental
        </button>
        <button
          className={activeTab === "import" ? "active" : ""}
          type="button"
          onClick={() => setActiveTab("import")}
        >
          <FileSpreadsheet size={16} /> Importar usuarios
        </button>
        <button
          className={activeTab === "settings" ? "active" : ""}
          type="button"
          onClick={() => setActiveTab("settings")}
        >
          <Settings2 size={16} /> Configurações da empresa
        </button>
        <button
          className={activeTab === "internal-control" ? "active" : ""}
          type="button"
          onClick={() => setActiveTab("internal-control")}
        >
          <Eye size={16} /> Controle Interno
        </button>
      </section>

      {loading ? (
        <section className="empty-state">
          <div className="spinner h-6 w-6" />
          <h2>Carregando empresa</h2>
        </section>
      ) : activeTab === "departments" ? (
        renderDepartments()
      ) : activeTab === "users" ? (
        renderUsers()
      ) : activeTab === "mind-map" ? (
        renderMindMap()
      ) : activeTab === "settings" ? (
        renderCompanySettings()
      ) : activeTab === "internal-control" ? (
        <InternalControlPanel companyId={companyId} users={overview?.users || []} />
      ) : (
        renderImport()
      )}

      <UserManagementModal
        companyId={companyId}
        currentUserId={user?.id}
        departments={overview?.departments || []}
        isPlatformAdmin={isPlatformAdmin()}
        onChanged={() => loadOverview(companyId)}
        onClose={() => setEditingUser(null)}
        userRecord={editingUser}
      />
    </div>
  );
};

export default CompanyAdminPanel;
