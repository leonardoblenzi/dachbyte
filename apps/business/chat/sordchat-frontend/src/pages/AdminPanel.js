import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArchiveRestore,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Download,
  FileSpreadsheet,
  GitFork,
  GitBranch,
  History,
  KeyRound,
  Link2,
  ListChecks,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Upload,
  UserPlus,
  Users,
  XCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { API_BASE_URL } from '../config';
import { usePlatformDialog } from '../contexts/PlatformDialogContext';

const tabs = [
  ['dashboard', 'Dashboard Geral', ShieldCheck],
  ['companies', 'Empresas', Building2],
  ['users', 'Usuarios', Users],
  ['mindmap', 'Mapa Mental', GitBranch],
  ['imports', 'Importacao por Planilha', FileSpreadsheet],
  ['links', 'Vinculos', Link2],
  ['logs', 'Logs/Auditoria', ListChecks],
  ['backups', 'Backups do Chat', ArchiveRestore],
  ['settings', 'Configuracoes', Settings],
];

const initialCompanyForm = {
  name: '',
  cnpj: '',
  responsible_name: '',
  phone_primary: '',
  phone_secondary: '',
  status: 'active',
};

const initialUserForm = {
  name: '',
  email: '',
  password: '',
  phone: '',
  company_id: '',
  department: '',
  role: 'user',
  status: 'active',
  create_hub_login: false,
};

const initialDepartmentLinkForm = {
  source_department_id: '',
  target_department_id: '',
  label: '',
};

const roleLabel = {
  master_admin: 'Admin Master',
  company_admin: 'Admin Empresa',
  coordinator: 'Coordenador',
  user: 'Usuario',
};

const statusLabel = {
  active: 'Ativo',
  inactive: 'Inativo',
};

const importTemplateColumns = {
  companies: ['nome_empresa', 'cnpj', 'responsavel', 'telefone_1', 'telefone_2', 'status'],
  users: ['nome_usuario', 'email', 'senha_primaria', 'id_empresa', 'telefone', 'setor', 'nivel_usuario', 'status'],
};

const csvEscape = (value) => {
  const text = String(value ?? '');
  if (/[;"\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
};

const downloadCsv = (filename, rows) => {
  const csv = rows.map((row) => row.map(csvEscape).join(';')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const requestJson = async (path, options = {}) => {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('token')}`,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || 'Operacao nao concluida.');
  }

  return response.json();
};

const uploadImportPreview = async (kind, file) => {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_BASE_URL}/platform/import/${kind}/preview`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${localStorage.getItem('token')}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || 'Nao foi possivel ler a planilha.');
  }

  return response.json();
};

const Metric = ({ icon: Icon, label, value }) => (
  <article className="metric-card">
    <Icon className="text-teal-700" size={20} />
    <p className="m-0 mt-4 text-sm font-bold text-slate-500">{label}</p>
    <p className="m-0 mt-2 text-3xl font-extrabold text-slate-950">{value || 0}</p>
  </article>
);

const MindNode = ({ node, onSelect, onToggle, collapsedNodeIds, onCreateUser }) => {
  const nodeKey = `${node.type}-${node.id}`;
  const hasChildren = node.children?.length > 0;
  const isCollapsed = collapsedNodeIds.includes(nodeKey);

  return (
  <div className="mind-node-branch">
    <div className={`mind-node mind-node--${node.type}`}>
      <button className="mind-node__main" type="button" onClick={() => onSelect(node)}>
        <span className="mind-node__type">{node.type === 'department' ? 'setor' : node.type}</span>
        <strong>{node.label}</strong>
        {node.role && <small>{roleLabel[node.role] || node.role}</small>}
        {node.status && <small>{statusLabel[node.status] || node.status}</small>}
      </button>
      {node.type === 'department' && (
        <button className="mind-node__point" type="button" title="Criar usuário neste setor" onClick={() => onCreateUser(node)}>
          <UserPlus size={14} />
        </button>
      )}
      {hasChildren && (
        <button className="mind-node__toggle" type="button" title={isCollapsed ? 'Expandir' : 'Recolher'} onClick={() => onToggle(nodeKey)}>
          {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
        </button>
      )}
    </div>
    {hasChildren && !isCollapsed && (
      <div className="mind-node-children">
        {node.children.map((child) => (
          <MindNode
            key={`${child.type}-${child.id}-${child.link_id || ''}`}
            node={child}
            onSelect={onSelect}
            onToggle={onToggle}
            collapsedNodeIds={collapsedNodeIds}
            onCreateUser={onCreateUser}
          />
        ))}
      </div>
    )}
  </div>
  );
};

const AdminPanel = () => {
  const dialog = usePlatformDialog();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState(null);
  const [companyForm, setCompanyForm] = useState(initialCompanyForm);
  const [editingCompanyId, setEditingCompanyId] = useState('');
  const [clearingCompanyId, setClearingCompanyId] = useState('');
  const [userForm, setUserForm] = useState(initialUserForm);
  const [mindMapUserForm, setMindMapUserForm] = useState(initialUserForm);
  const [mindMapCompanyId, setMindMapCompanyId] = useState('');
  const [departmentLinkForm, setDepartmentLinkForm] = useState(initialDepartmentLinkForm);
  const [collapsedMindNodeIds, setCollapsedMindNodeIds] = useState([]);
  const [importKind, setImportKind] = useState('companies');
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [backupCompanyId, setBackupCompanyId] = useState("");
  const [backupUserId, setBackupUserId] = useState("");
  const [chatBackups, setChatBackups] = useState([]);
  const [backupLoading, setBackupLoading] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await requestJson('/platform/overview');
      setOverview(data);
      const firstCompanyId = data.companies?.[0]?.id || '';
      setUserForm((prev) => ({ ...prev, company_id: prev.company_id || firstCompanyId }));
      setMindMapCompanyId((previousCompanyId) => (
        data.companies?.some((company) => company.id === previousCompanyId)
          ? previousCompanyId
          : firstCompanyId
      ));
      setBackupCompanyId((current) => data.companies?.some((company) => company.id === current) ? current : firstCompanyId);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const companies = useMemo(() => overview?.companies || [], [overview]);
  const users = useMemo(() => overview?.users || [], [overview]);
  const links = useMemo(() => overview?.company_users || [], [overview]);
  const departments = useMemo(() => overview?.departments || [], [overview]);
  const departmentLinks = useMemo(() => overview?.department_links || [], [overview]);
  const logs = useMemo(() => overview?.audit_logs || [], [overview]);
  const stats = overview?.stats || {};

  const backupUsers = useMemo(() => users.filter((item) =>
    item.companies?.some((membership) =>
      membership.company_id === backupCompanyId && membership.status === "active",
    ),
  ), [backupCompanyId, users]);

  useEffect(() => {
    setBackupUserId((current) =>
      backupUsers.some((item) => String(item.id) === String(current))
        ? current
        : String(backupUsers[0]?.id || ""),
    );
  }, [backupUsers]);

  const loadChatBackups = useCallback(async () => {
    if (!backupCompanyId || !backupUserId) {
      setChatBackups([]);
      return;
    }
    setBackupLoading(true);
    try {
      const result = await requestJson(`/platform/chat-backups?company_id=${encodeURIComponent(backupCompanyId)}&user_id=${encodeURIComponent(backupUserId)}`);
      setChatBackups(result.backups || []);
    } catch (error) {
      toast.error(error.message);
      setChatBackups([]);
    } finally {
      setBackupLoading(false);
    }
  }, [backupCompanyId, backupUserId]);

  useEffect(() => {
    if (activeTab === "backups") loadChatBackups();
  }, [activeTab, loadChatBackups]);

  const handleRestoreChatBackup = async (backup) => {
    const company = companies.find((item) => item.id === backupCompanyId);
    const selectedUser = backupUsers.find((item) => String(item.id) === String(backupUserId));
    const confirmed = await dialog.confirm({
      title: "Restaurar histórico do chat?",
      message: `Restaurar ${backup.relevant_message_count || 0} mensagens de ${selectedUser?.name || selectedUser?.full_name || "usuário"}?`,
      detail: `Empresa: ${company?.name || "-"}. Mensagens já restauradas serão ignoradas pela identificação segura.`,
      confirmLabel: "Restaurar mensagens",
    });
    if (!confirmed) return;
    setBackupLoading(true);
    try {
      const result = await requestJson(`/platform/chat-backups/${backup.id}/restore`, {
        method: "POST",
        body: JSON.stringify({ company_id: backupCompanyId, user_id: Number(backupUserId) }),
      });
      toast.success(`${result.restored} mensagens restauradas; ${result.skipped} já existentes ou indisponíveis.`);
      await loadChatBackups();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBackupLoading(false);
    }
  };

  const departmentsForUserCompany = useMemo(
    () => departments.filter((department) => department.company_id === userForm.company_id),
    [departments, userForm.company_id]
  );

  const filteredUsers = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return users;
    return users.filter((user) =>
      [user.name, user.full_name, user.email, user.phone, user.company_name, user.company_role]
        .join(' ')
        .toLowerCase()
        .includes(term)
    );
  }, [query, users]);

  const handleCreateCompany = async (event) => {
    event.preventDefault();
    try {
      const isEditing = Boolean(editingCompanyId);
      await requestJson(isEditing ? `/platform/companies/${editingCompanyId}` : '/platform/companies', {
        method: isEditing ? 'PATCH' : 'POST',
        body: JSON.stringify(companyForm),
      });
      toast.success(isEditing ? 'Empresa atualizada.' : 'Empresa criada.');
      setCompanyForm(initialCompanyForm);
      setEditingCompanyId('');
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleEditCompany = (company) => {
    setEditingCompanyId(company.id);
    setCompanyForm({
      name: company.name || '',
      cnpj: company.cnpj || '',
      responsible_name: company.responsible_name || '',
      phone_primary: company.phone_primary || '',
      phone_secondary: company.phone_secondary || '',
      status: company.status || 'active',
    });
  };

  const handleClearCompanyHistory = async (company) => {
    const confirmation = await dialog.prompt({
      title: 'Apagar histórico da empresa?',
      message: `Esta ação é permanente e apagará conversas, tickets, tarefas, agendas, anexos e backups de ${company.name}. A empresa, os usuários, os setores e as configurações serão preservados.`,
      inputLabel: 'Digite o nome exato da empresa para confirmar',
      placeholder: company.name,
      confirmLabel: 'Apagar histórico',
      danger: true,
    });
    if (confirmation !== company.name) {
      if (confirmation !== null) toast.error('Nome da empresa não confere. Limpeza cancelada.');
      return;
    }
    setClearingCompanyId(company.id);
    try {
      const result = await requestJson(`/platform/companies/${company.id}/history`, { method: 'DELETE' });
      toast.success(`${result.deleted_total || 0} registros do histórico foram apagados.`);
      await loadData();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setClearingCompanyId('');
    }
  };

  const handleDeleteCompany = async (company) => {
    const confirmation = await dialog.prompt({
      title: "Excluir empresa e tenant?",
      message: `A exclusão é permanente e removerá usuários, chats, tickets, tarefas, arquivos e backups de ${company.name}.`,
      inputLabel: "Digite o nome exato da empresa para confirmar",
      placeholder: company.name,
      confirmLabel: "Excluir empresa",
      danger: true,
    });
    if (confirmation !== company.name) {
      if (confirmation !== null) toast.error('Nome da empresa nao confere. Exclusao cancelada.');
      return;
    }
    try {
      await requestJson(`/platform/companies/${company.id}`, { method: 'DELETE' });
      toast.success('Empresa e dados do tenant excluidos.');
      if (editingCompanyId === company.id) {
        setEditingCompanyId('');
        setCompanyForm(initialCompanyForm);
      }
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };


  const handleCreateUser = async (event) => {
    event.preventDefault();
    try {
      await requestJson('/platform/users', {
        method: 'POST',
        body: JSON.stringify(userForm),
      });
      toast.success('Usuario criado e vinculado.');
      setUserForm((prev) => ({
        ...initialUserForm,
        company_id: prev.company_id,
        department: prev.department,
      }));
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleSelectMindNode = (node) => {
    setSelectedNode(node);
    if (node.type === 'department') {
      setMindMapUserForm((prev) => ({
        ...prev,
        company_id: node.company_id,
        department: node.label,
      }));
      setDepartmentLinkForm((prev) => ({ ...prev, source_department_id: prev.source_department_id || node.id }));
    }
  };

  const handleToggleMindNode = (nodeKey) => {
    setCollapsedMindNodeIds((current) => (
      current.includes(nodeKey) ? current.filter((item) => item !== nodeKey) : [...current, nodeKey]
    ));
  };

  const openMindMapUserForm = (department) => {
    handleSelectMindNode(department);
    setMindMapUserForm((prev) => ({ ...prev, company_id: department.company_id, department: department.label }));
  };

  const handleCreateMindMapUser = async (event) => {
    event.preventDefault();
    if (!mindMapUserForm.company_id || !mindMapUserForm.department) {
      toast.error('Selecione um setor no mapa antes de criar o usuário.');
      return;
    }
    try {
      await requestJson('/platform/users', {
        method: 'POST',
        body: JSON.stringify(mindMapUserForm),
      });
      toast.success(`Usuário criado em ${mindMapUserForm.department}.`);
      setMindMapUserForm((prev) => ({ ...initialUserForm, company_id: prev.company_id, department: prev.department }));
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleCreateDepartmentLink = async (event) => {
    event.preventDefault();
    try {
      await requestJson('/platform/department-links', {
        method: 'POST',
        body: JSON.stringify(departmentLinkForm),
      });
      toast.success('Ligação entre setores criada.');
      setDepartmentLinkForm((prev) => ({ ...initialDepartmentLinkForm, source_department_id: prev.source_department_id }));
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleRemoveDepartmentLink = async (linkId) => {
    try {
      await requestJson(`/platform/department-links/${linkId}`, { method: 'DELETE' });
      toast.success('Ligação entre setores removida.');
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handlePreviewImport = async () => {
    if (!importFile) {
      toast.error('Selecione uma planilha CSV ou XLSX.');
      return;
    }
    try {
      const preview = await uploadImportPreview(importKind, importFile);
      setImportPreview(preview);
      toast.success('Previa gerada.');
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleDownloadImportTemplate = () => {
    const companyIdExample = companies[0]?.id || 'COLE_AQUI_O_ID_DA_EMPRESA';
    const rowsByKind = {
      companies: [
        importTemplateColumns.companies,
        ['Empresa Exemplo Ltda', '12345678000190', 'Maria Responsavel', '11999990000', '1133334444', 'active'],
      ],
      users: [
        importTemplateColumns.users,
        ['Joao Usuario', 'joao.usuario@empresa.com', 'Senha@123', companyIdExample, '11988887777', 'Atendimento', 'user', 'active'],
      ],
    };
    const filename = importKind === 'companies' ? 'modelo-importacao-empresas.csv' : 'modelo-importacao-usuarios.csv';
    downloadCsv(filename, rowsByKind[importKind]);
    toast.success('Modelo de planilha baixado.');
  };

  const handleConfirmImport = async () => {
    if (!importPreview?.rows?.length) {
      toast.error('Gere a previa antes de confirmar.');
      return;
    }
    try {
      const result = await requestJson(`/platform/import/${importKind}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ rows: importPreview.rows.map((row) => row.data) }),
      });
      toast.success(`Importacao concluida. Registros: ${result.imported || result.linked || 0}`);
      setImportPreview(null);
      setImportFile(null);
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleResetPassword = async (userId) => {
    const password = await dialog.prompt({ title: "Redefinir senha", message: "Informe a nova senha primária deste usuário.", inputLabel: "Nova senha", inputType: "password", confirmLabel: "Redefinir senha" });
    if (!password) return;
    try {
      await requestJson(`/platform/users/${userId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      toast.success('Senha resetada. Usuario devera trocar no proximo login.');
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleUpdateLink = async (linkId, payload) => {
    try {
      await requestJson(`/platform/company-users/${linkId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      toast.success('Vinculo atualizado.');
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleRemoveLink = async (linkId) => {
    const confirmed = await dialog.confirm({ title: "Remover vínculo?", message: "O usuário perderá este vínculo empresarial.", confirmLabel: "Remover vínculo", danger: true });
    if (!confirmed) return;
    try {
      await requestJson(`/platform/company-users/${linkId}`, { method: 'DELETE' });
      toast.success('Vinculo removido.');
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleMindMapCompanyChange = (companyId) => {
    setMindMapCompanyId(companyId);
    setSelectedNode(null);
    setCollapsedMindNodeIds([]);
    setMindMapUserForm({ ...initialUserForm, company_id: companyId });
    setDepartmentLinkForm(initialDepartmentLinkForm);
  };

  const renderDashboard = () => (
    <>
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <Metric icon={Building2} label="Empresas" value={stats.companies} />
        <Metric icon={CheckCircle2} label="Empresas ativas" value={stats.active_companies} />
        <Metric icon={Users} label="Usuarios" value={stats.users} />
        <Metric icon={Link2} label="Vinculos ativos" value={stats.links} />
        <Metric icon={GitBranch} label="Setores" value={stats.departments} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <article className="panel p-5">
          <h3 className="m-0 text-lg font-extrabold text-slate-950">Empresas recentes</h3>
          <div className="mt-4 grid gap-3">
            {companies.slice(0, 6).map((company) => (
              <button className="tenant-row" key={company.id} type="button" onClick={() => setSelectedNode({ ...company, type: 'company', label: company.name })}>
                <span>
                  <strong>{company.name}</strong>
                  <small>{company.cnpj || 'Sem CNPJ'} - {company.responsible_name || 'Sem responsavel'}</small>
                </span>
                <span className="badge">{statusLabel[company.status] || company.status}</span>
              </button>
            ))}
          </div>
        </article>

        <article className="panel p-5">
          <h3 className="m-0 text-lg font-extrabold text-slate-950">Auditoria recente</h3>
          <div className="mt-4 grid gap-3">
            {logs.slice(0, 7).map((log) => (
              <div className="rounded-lg border border-slate-200 bg-white p-3" key={log.id}>
                <p className="m-0 text-sm font-extrabold text-slate-950">{log.action}</p>
                <p className="m-0 mt-1 text-xs text-slate-500">{log.entity_type} #{log.entity_id}</p>
              </div>
            ))}
          </div>
        </article>
      </section>
    </>
  );

  const renderCompanies = () => (
    <section className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
      <article className="panel p-5">
        <h3 className="m-0 text-lg font-extrabold text-slate-950">{editingCompanyId ? 'Editar empresa' : 'Cadastro manual de empresa'}</h3>
        <form className="mt-4 grid gap-3" onSubmit={handleCreateCompany}>
          <input className="input" value={companyForm.name} onChange={(event) => setCompanyForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="Nome da empresa" />
          <input className="input" value={companyForm.cnpj} onChange={(event) => setCompanyForm((prev) => ({ ...prev, cnpj: event.target.value }))} placeholder="CNPJ" />
          <input className="input" value={companyForm.responsible_name} onChange={(event) => setCompanyForm((prev) => ({ ...prev, responsible_name: event.target.value }))} placeholder="Responsavel" />
          <input className="input" value={companyForm.phone_primary} onChange={(event) => setCompanyForm((prev) => ({ ...prev, phone_primary: event.target.value }))} placeholder="Telefone 1" />
          <input className="input" value={companyForm.phone_secondary} onChange={(event) => setCompanyForm((prev) => ({ ...prev, phone_secondary: event.target.value }))} placeholder="Telefone 2" />
          <select className="select" value={companyForm.status} onChange={(event) => setCompanyForm((prev) => ({ ...prev, status: event.target.value }))}>
            <option value="active">Ativa</option>
            <option value="inactive">Inativa</option>
          </select>
          <button className="button-primary" type="submit">
            <Save size={17} />
            {editingCompanyId ? 'Salvar alteracoes' : 'Criar empresa'}
          </button>
          {editingCompanyId && (
            <button className="button-secondary" type="button" onClick={() => {
              setEditingCompanyId('');
              setCompanyForm(initialCompanyForm);
            }}>
              Cancelar edicao
            </button>
          )}
        </form>
      </article>

      <article className="panel p-5">
        <h3 className="m-0 text-lg font-extrabold text-slate-950">Empresas</h3>
        <div className="mt-4 grid gap-3">
          {companies.map((company) => (
            <div className="tenant-row" key={company.id}>
              <button className="min-w-0 flex-1 text-left" type="button" onClick={() => setSelectedNode({ ...company, type: 'company', label: company.name })}>
                <strong>{company.name}</strong>
                <small>{company.tenant_global_id || company.id}</small>
                <small>{company.hub_enabled ? 'Hub global vinculado' : 'Hub global ainda sem login'}</small>
              </button>
              <div className="flex items-center gap-2">
                <span className="badge">{statusLabel[company.status] || company.status}</span>
                <button className="button-secondary px-3" type="button" title="Editar empresa" onClick={() => handleEditCompany(company)}>
                  <Pencil size={15} />
                </button>
                <button
                  className="button-secondary whitespace-nowrap px-3"
                  type="button"
                  title="Apagar conversas, tickets, tarefas e agendas desta empresa"
                  disabled={clearingCompanyId === company.id}
                  onClick={() => handleClearCompanyHistory(company)}
                >
                  <History className={clearingCompanyId === company.id ? 'animate-spin' : ''} size={15} />
                  {clearingCompanyId === company.id ? 'Limpando...' : 'Apagar histórico'}
                </button>
                <button className="button-danger px-3" type="button" title="Excluir empresa e tenant" onClick={() => handleDeleteCompany(company)}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </article>
    </section>
  );

  const renderUsers = () => (
    <section className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
      <article className="panel p-5">
        <h3 className="m-0 text-lg font-extrabold text-slate-950">Cadastro manual de usuario</h3>
        <form className="mt-4 grid gap-3" onSubmit={handleCreateUser}>
          <input className="input" value={userForm.name} onChange={(event) => setUserForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="Nome" />
          <input className="input" value={userForm.email} onChange={(event) => setUserForm((prev) => ({ ...prev, email: event.target.value }))} placeholder="Email" />
          <input className="input" type="password" value={userForm.password} onChange={(event) => setUserForm((prev) => ({ ...prev, password: event.target.value }))} placeholder="Senha primaria" />
          <input className="input" value={userForm.phone} onChange={(event) => setUserForm((prev) => ({ ...prev, phone: event.target.value }))} placeholder="Telefone" />
          <select className="select" value={userForm.company_id} onChange={(event) => setUserForm((prev) => ({ ...prev, company_id: event.target.value, department: '' }))}>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>{company.name}</option>
            ))}
          </select>
          <input className="input" list="departments-list" value={userForm.department} onChange={(event) => setUserForm((prev) => ({ ...prev, department: event.target.value }))} placeholder="Setor" />
          <datalist id="departments-list">
            {departmentsForUserCompany.map((department) => (
              <option key={department.id} value={department.name} />
            ))}
          </datalist>
          <select className="select" value={userForm.role} onChange={(event) => setUserForm((prev) => ({ ...prev, role: event.target.value }))}>
            <option value="company_admin">Company admin</option>
            <option value="coordinator">Coordinator</option>
            <option value="user">User</option>
          </select>
          <select className="select" value={userForm.status} onChange={(event) => setUserForm((prev) => ({ ...prev, status: event.target.value }))}>
            <option value="active">Ativo</option>
            <option value="inactive">Inativo</option>
          </select>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm text-slate-700">
            <input
              className="mt-1 h-4 w-4 accent-teal-700"
              type="checkbox"
              checked={userForm.create_hub_login}
              onChange={(event) => setUserForm((prev) => ({ ...prev, create_hub_login: event.target.checked }))}
            />
            <span>
              <strong className="block text-slate-950">Criar login no Hub global</strong>
              Vincula esta conta ao mesmo tenant usado pelo Volt Core e pelos demais modulos Davantti.
            </span>
          </label>
          <button className="button-primary" type="submit">
            <UserPlus size={17} />
            Criar usuario
          </button>
        </form>
      </article>

      <article className="panel p-5">
        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h3 className="m-0 text-lg font-extrabold text-slate-950">Usuarios</h3>
          <div className="relative w-full md:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={17} />
            <input className="input pl-10" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar usuario" />
          </div>
        </div>
        <div className="grid gap-3">
          {filteredUsers.map((user) => (
            <div className="tenant-row" key={user.id}>
              <span>
                <strong>{user.full_name || user.name}</strong>
                <small>{user.email} - {user.company_name || 'Sem empresa principal'}</small>
              </span>
              <button className="button-secondary" type="button" onClick={() => handleResetPassword(user.id)}>
                <KeyRound size={15} />
                Resetar
              </button>
            </div>
          ))}
        </div>
      </article>
    </section>
  );

  const renderMindMap = () => {
    const selectedCompany = companies.find((company) => company.id === mindMapCompanyId);
    const selectedCompanyMap = overview?.mind_map?.children?.find((company) => company.id === mindMapCompanyId);
    const companyDepartments = departments.filter((department) => department.company_id === mindMapCompanyId);
    const companyDepartmentLinks = departmentLinks.filter((link) => link.company_id === mindMapCompanyId);
    const sourceDepartment = companyDepartments.find((department) => department.id === departmentLinkForm.source_department_id);
    const targetDepartments = sourceDepartment
      ? companyDepartments.filter((department) => department.id !== sourceDepartment.id)
      : [];

    return (
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <article className="panel mind-map-panel p-5">
          <div className="mind-map-toolbar">
            <div>
              <span className="badge"><GitFork size={13} /> Mapa interativo</span>
              <h3 className="m-0 mt-2 text-lg font-extrabold text-slate-950">
                {selectedCompany ? `Mapa de ${selectedCompany.name}` : 'Mapa da empresa'}
              </h3>
              <p className="m-0 mt-1 text-sm text-slate-500">Clique nos cartões para ver detalhes; use o ponto + de um setor para cadastrar uma pessoa nele.</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                className="select min-w-60"
                aria-label="Empresa do mapa mental"
                value={mindMapCompanyId}
                onChange={(event) => handleMindMapCompanyChange(event.target.value)}
              >
                <option value="">Selecione uma empresa</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>{company.name}</option>
                ))}
              </select>
              <button className="button-secondary" type="button" onClick={() => setActiveTab('companies')}>
                <Building2 size={16} />
                Criar empresa
              </button>
            </div>
          </div>

          <div className="mind-map-canvas">
            {selectedCompanyMap ? (
              <MindNode
                node={selectedCompanyMap}
                onSelect={handleSelectMindNode}
                onToggle={handleToggleMindNode}
                collapsedNodeIds={collapsedMindNodeIds}
                onCreateUser={openMindMapUserForm}
              />
            ) : (
              <p className="m-0 text-sm text-slate-500">Selecione uma empresa para abrir seu mapa mental.</p>
            )}
          </div>

          <section className="mind-map-links" aria-label="Ligações entre setores">
            <div className="mind-map-links__heading">
              <div>
                <span className="badge"><CircleDot size={13} /> Pontos de ligação</span>
                <p className="m-0 mt-2 text-sm text-slate-500">Crie conexões entre setores da mesma empresa para representar o fluxo de trabalho.</p>
              </div>
              <span className="badge">{companyDepartmentLinks.length} ligações</span>
            </div>
            {companyDepartmentLinks.length > 0 && (
              <div className="mind-map-link-list">
                {companyDepartmentLinks.map((link) => (
                  <div className="mind-map-link" key={link.id}>
                    <span>{link.source_department_name}</span><GitFork size={14} /><span>{link.target_department_name}</span>
                    {link.label && <small>{link.label}</small>}
                    <button type="button" title="Remover ligação" onClick={() => handleRemoveDepartmentLink(link.id)}><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </article>

        <aside className="grid h-max gap-4">
          <section className="panel p-5">
            <h3 className="m-0 text-lg font-extrabold text-slate-950">Detalhes</h3>
            {selectedNode ? (
              <div className="mt-4 grid gap-3">
                <span className="badge">{selectedNode.type === 'department' ? 'setor' : selectedNode.type}</span>
                <p className="m-0 text-xl font-extrabold text-slate-950">{selectedNode.label || selectedNode.name}</p>
                {selectedNode.email && <p className="m-0 text-sm text-slate-500">{selectedNode.email}</p>}
                {selectedNode.role && <span className="badge">{roleLabel[selectedNode.role] || selectedNode.role}</span>}
                {selectedNode.type === 'department' && (
                  <button className="button-secondary" type="button" onClick={() => openMindMapUserForm(selectedNode)}>
                    <UserPlus size={16} /> Criar usuário neste setor
                  </button>
                )}
                {selectedNode.type === 'user' && (
                  <button className="button-secondary" type="button" onClick={() => handleResetPassword(Number(selectedNode.id))}>
                    Resetar senha
                  </button>
                )}
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-500">Selecione um setor para criar um usuário ou usá-lo como ponto de ligação.</p>
            )}
          </section>

          <form className="panel grid gap-3 p-5" onSubmit={handleCreateMindMapUser}>
            <div>
              <h3 className="m-0 text-lg font-extrabold text-slate-950">Novo usuário no mapa</h3>
              <p className="m-0 mt-1 text-sm text-slate-500">{mindMapUserForm.department ? `Setor: ${mindMapUserForm.department}` : 'Selecione o setor no mapa.'}</p>
            </div>
            <input className="input" required value={mindMapUserForm.name} onChange={(event) => setMindMapUserForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="Nome completo" />
            <input className="input" required type="email" value={mindMapUserForm.email} onChange={(event) => setMindMapUserForm((prev) => ({ ...prev, email: event.target.value }))} placeholder="E-mail" />
            <input className="input" required minLength="6" type="password" value={mindMapUserForm.password} onChange={(event) => setMindMapUserForm((prev) => ({ ...prev, password: event.target.value }))} placeholder="Senha primária" />
            <input className="input" value={mindMapUserForm.phone} onChange={(event) => setMindMapUserForm((prev) => ({ ...prev, phone: event.target.value }))} placeholder="Telefone" />
            <select className="select" value={mindMapUserForm.role} onChange={(event) => setMindMapUserForm((prev) => ({ ...prev, role: event.target.value }))}>
              <option value="company_admin">Administrador da empresa</option>
              <option value="coordinator">Coordenador</option>
              <option value="user">Usuário</option>
            </select>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm text-slate-700">
              <input
                className="mt-1 h-4 w-4 accent-teal-700"
                type="checkbox"
                checked={mindMapUserForm.create_hub_login}
                onChange={(event) => setMindMapUserForm((prev) => ({ ...prev, create_hub_login: event.target.checked }))}
              />
              <span>
                <strong className="block text-slate-950">Criar login no Hub global</strong>
                Usa o tenant global desta empresa em todos os modulos habilitados.
              </span>
            </label>
            <button className="button-primary" type="submit" disabled={!mindMapUserForm.department}>
              <UserPlus size={17} /> Salvar usuário no setor
            </button>
          </form>

          <form className="panel grid gap-3 p-5" onSubmit={handleCreateDepartmentLink}>
            <div>
              <h3 className="m-0 text-lg font-extrabold text-slate-950">Ligar setores</h3>
              <p className="m-0 mt-1 text-sm text-slate-500">Escolha a origem e o destino.</p>
            </div>
            <select className="select" required value={departmentLinkForm.source_department_id} onChange={(event) => setDepartmentLinkForm((prev) => ({ ...prev, source_department_id: event.target.value, target_department_id: '' }))}>
              <option value="">Setor de origem</option>
              {companyDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
            <select className="select" required disabled={!sourceDepartment} value={departmentLinkForm.target_department_id} onChange={(event) => setDepartmentLinkForm((prev) => ({ ...prev, target_department_id: event.target.value }))}>
              <option value="">Setor de destino</option>
              {targetDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
            <input className="input" value={departmentLinkForm.label} onChange={(event) => setDepartmentLinkForm((prev) => ({ ...prev, label: event.target.value }))} placeholder="Descrição da ligação (opcional)" />
            <button className="button-secondary" type="submit" disabled={!departmentLinkForm.target_department_id}>
              <GitFork size={16} /> Criar ligação
            </button>
          </form>
        </aside>
      </section>
    );
  };

  const renderImports = () => (
    <section className="panel p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h3 className="m-0 text-lg font-extrabold text-slate-950">Importacao por planilha</h3>
          <p className="m-0 mt-1 text-sm text-slate-500">Gere a previa, corrija erros e confirme a importacao.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select className="select" value={importKind} onChange={(event) => { setImportKind(event.target.value); setImportPreview(null); }}>
            <option value="companies">Empresas</option>
            <option value="users">Usuarios</option>
          </select>
          <button className="button-secondary" type="button" onClick={handleDownloadImportTemplate}>
            <Download size={16} />
            Baixar modelo
          </button>
          <input className="input" type="file" accept=".csv,.tsv,.txt,.xlsx" onChange={(event) => setImportFile(event.target.files?.[0] || null)} />
          <button className="button-secondary" type="button" onClick={handlePreviewImport}>
            <Upload size={16} />
            Previa
          </button>
          <button className="button-primary" type="button" onClick={handleConfirmImport} disabled={!importPreview || importPreview.error_count > 0}>
            Confirmar
          </button>
        </div>
      </div>

      {importPreview && (
        <div className="mt-5 overflow-x-auto">
          <div className="mb-3 flex flex-wrap gap-2">
            <span className="badge">Validos: {importPreview.valid_count}</span>
            <span className="badge badge--danger">Erros: {importPreview.error_count}</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Linha</th>
                <th>Dados</th>
                <th>Status</th>
                <th>Erros/Avisos</th>
              </tr>
            </thead>
            <tbody>
              {importPreview.rows.map((row) => (
                <tr key={row.row}>
                  <td>{row.row}</td>
                  <td><code>{JSON.stringify(row.data)}</code></td>
                  <td>{row.valid ? <CheckCircle2 className="text-emerald-600" size={18} /> : <XCircle className="text-red-600" size={18} />}</td>
                  <td>{[...(row.errors || []), ...(row.warnings || [])].join(' | ') || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );

  const renderLinks = () => (
    <section className="panel p-5">
      <h3 className="m-0 text-lg font-extrabold text-slate-950">Vinculos usuario-empresa</h3>
      <div className="mt-4 grid gap-3">
        {links.map((link) => (
          <div className="tenant-row" key={link.id}>
            <span>
              <strong>{link.user_name}</strong>
              <small>{link.company_name} - {link.department_name || 'Sem setor'} - {roleLabel[link.role] || link.role}</small>
            </span>
            <div className="flex flex-wrap gap-2">
              <select className="select" value={link.role} onChange={(event) => handleUpdateLink(link.id, { role: event.target.value })}>
                <option value="company_admin">Company admin</option>
                <option value="coordinator">Coordinator</option>
                <option value="user">User</option>
              </select>
              <button className="button-secondary" type="button" onClick={() => handleRemoveLink(link.id)}>Remover</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );

  const renderLogs = () => (
    <section className="panel p-5">
      <h3 className="m-0 text-lg font-extrabold text-slate-950">Logs e auditoria</h3>
      <p className="m-0 mt-1 text-sm text-slate-500">
        Registros mantidos por 7 dias e removidos automaticamente.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Usuario da acao</th>
              <th>Acao</th>
              <th>Entidade</th>
              <th>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td>{log.created_at ? new Date(log.created_at).toLocaleString('pt-BR') : '-'}</td>
                <td>
                  <strong className="block text-slate-900">{log.actor_name || 'Sistema'}</strong>
                  <small className="text-slate-500">
                    {log.actor_email || (log.actor_username ? `@${log.actor_username}` : '')}
                  </small>
                </td>
                <td>{log.action}</td>
                <td>{log.entity_type} #{log.entity_id}</td>
                <td><code>{JSON.stringify(log.metadata || {})}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );

  const renderBackups = () => (
    <section className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="m-0 text-lg font-extrabold text-slate-950">Segurança e restauração do chat</h3>
          <p className="m-0 mt-1 text-sm text-slate-500">Selecione primeiro a empresa e depois o usuário. A restauração usa identificação única e nunca duplica mensagens.</p>
        </div>
        <button className="button-secondary" type="button" onClick={loadChatBackups} disabled={backupLoading || !backupUserId}><RefreshCw size={16} /> Atualizar backups</button>
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="field"><span>Empresa</span><select className="select" value={backupCompanyId} onChange={(event) => setBackupCompanyId(event.target.value)}>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
        <label className="field"><span>Usuário</span><select className="select" value={backupUserId} onChange={(event) => setBackupUserId(event.target.value)}><option value="">Selecione</option>{backupUsers.map((item) => <option key={item.id} value={item.id}>{item.name || item.full_name} — {item.email}</option>)}</select></label>
      </div>
      <div className="mt-4 rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm text-teal-900">
        <strong>Proteção em duas camadas:</strong> o banco mantém ZIPs mensais com checksum SHA-256; o aplicativo desktop mantém um cofre criptografado em <code>Documentos/VoltChatArchives</code>.
      </div>
      <div className="mt-5 overflow-x-auto">
        <table className="data-table">
          <thead><tr><th>Período</th><th>Mensagens do usuário</th><th>Compactado</th><th>Integridade</th><th>Ação</th></tr></thead>
          <tbody>
            {backupLoading && <tr><td colSpan="5">Carregando e verificando backups...</td></tr>}
            {!backupLoading && chatBackups.map((backup) => (
              <tr key={backup.id}>
                <td><strong>{backup.period_start ? new Date(backup.period_start).toLocaleDateString("pt-BR") : "-"}</strong><small className="block text-slate-500">até {backup.period_end ? new Date(backup.period_end).toLocaleDateString("pt-BR") : "-"}</small></td>
                <td>{backup.relevant_message_count ?? "-"}<small className="block text-slate-500">de {backup.message_count} no arquivo</small></td>
                <td>{(Number(backup.compressed_size || 0) / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB</td>
                <td><span className={`badge ${backup.integrity === "error" ? "badge--danger" : ""}`}>{backup.integrity === "verified" ? "Verificado" : backup.integrity === "legacy" ? "Backup legado" : "Inválido"}</span>{backup.error && <small className="block text-red-600">{backup.error}</small>}</td>
                <td><button className="button-primary" type="button" disabled={backupLoading || backup.integrity === "error" || !backup.relevant_message_count} onClick={() => handleRestoreChatBackup(backup)}><ArchiveRestore size={16} /> Restaurar</button></td>
              </tr>
            ))}
            {!backupLoading && chatBackups.length === 0 && <tr><td colSpan="5">Nenhum backup mensal encontrado para esta seleção.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );

  const renderSettings = () => (
    <section className="panel p-5">
      <h3 className="m-0 text-lg font-extrabold text-slate-950">Configuracoes</h3>
      <p className="m-0 mt-2 text-sm text-slate-500">
        Empresas inativas ficam bloqueadas para vinculos e operacao. Usuarios importados entram com troca de senha obrigatoria.
      </p>
      <div className="mt-4 grid gap-2 text-sm text-slate-600">
        <span>Roles: master_admin, company_admin, coordinator, user.</span>
        <span>Colunas de empresas: nome_empresa, cnpj, responsavel, telefone_1, telefone_2, status.</span>
        <span>Colunas de usuarios: nome_usuario, email, senha_primaria, id_empresa, telefone, setor, nivel_usuario, status.</span>
      </div>
    </section>
  );

  const renderContent = () => {
    if (loading) {
      return <div className="panel p-6 text-sm font-bold text-slate-500">Carregando Admin Master...</div>;
    }
    if (activeTab === 'dashboard') return renderDashboard();
    if (activeTab === 'companies') return renderCompanies();
    if (activeTab === 'users') return renderUsers();
    if (activeTab === 'mindmap') return renderMindMap();
    if (activeTab === 'imports') return renderImports();
    if (activeTab === 'links') return renderLinks();
    if (activeTab === 'logs') return renderLogs();
    if (activeTab === 'backups') return renderBackups();
    return renderSettings();
  };

  return (
    <div className="work-page">
      <section className="panel p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <span className="badge">
              <ShieldCheck size={13} />
              Admin Master
            </span>
            <h2 className="m-0 mt-3 text-2xl font-extrabold text-slate-950">Arquitetura multi-tenant</h2>
            <p className="m-0 mt-1 text-sm text-slate-500">
              Controle empresas, usuarios, setores, vinculos, importacoes e auditoria com isolamento por company_id.
            </p>
          </div>
          <button className="button-secondary" type="button" onClick={loadData} disabled={loading}>
            <RefreshCw size={17} />
            Atualizar
          </button>
        </div>
      </section>

      <section className="tenant-tabs" aria-label="Abas Admin Master">
        {tabs.map(([id, label, Icon]) => (
          <button key={id} className={activeTab === id ? 'active' : ''} type="button" onClick={() => setActiveTab(id)}>
            <Icon size={16} />
            {label}
          </button>
        ))}
      </section>

      {renderContent()}
    </div>
  );
};

export default AdminPanel;
