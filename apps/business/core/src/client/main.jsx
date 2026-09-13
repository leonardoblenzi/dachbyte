import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  AlertTriangle,
  BadgeDollarSign,
  BanknoteArrowDown,
  BarChart3,
  Boxes,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  Download,
  Eye,
  EyeOff,
  FileCheck2,
  FileText,
  Glasses,
  Landmark,
  LayoutDashboard,
  Lock,
  LogOut,
  MoreVertical,
  PackageCheck,
  PackagePlus,
  PanelsTopLeft,
  Plus,
  ReceiptText,
  Search,
  Settings,
  ShieldCheck,
  ShoppingCart,
  SlidersHorizontal,
  Store,
  TrendingUp,
  UserCog,
  UserRound,
  UsersRound,
  WalletCards,
  Wrench,
  X,
} from "lucide-react";
import {
  normalizeUiRole,
} from "./core/access";
import { apiFetch } from "./core/api";
import { downloadCsv } from "./core/csv";
import {
  customerImportColumns,
  downloadCustomerTemplateXlsx,
  downloadErrorRowsXlsx,
  downloadProductTemplateXlsx,
  downloadRowsXlsx,
  productImportColumns,
  readImportSheetRows,
  rowsToCsv,
} from "./core/spreadsheet";
import { OperationalList } from "./components/OperationalList";
import {
  formatCurrency,
  formatDateTime,
  formatMoneyInput,
  formatShortDate,
  formatShortTime,
  matchesReportDate,
  normalizeReportDate,
  parseMoney,
} from "./core/formatters";
import {
  confirmRecordPayload,
  editRecordPayload,
  recordKey,
  updateByKey,
} from "./core/records";
import {
  buildModalConfig,
  NEW_PRODUCT_BRAND_VALUE,
  userAccessAreas,
} from "./modals/config";
import {
  addActionModalPayment,
  deriveActionModalState,
  prepareActionModalValues,
  removeActionModalPayment,
  updateActionModalPayment,
  updateActionModalValue,
  validateActionModal,
} from "./modals/actionModalState";
import {
  ActionModalFields,
  SaleCartSummary,
  SalePaymentsSection,
  SaleTotalSummary,
} from "./modals/ActionModalSections";
import { DUE_DATE_SALE_PAYMENTS, INSTALLMENT_SALE_PAYMENTS, paymentMethodLabel, SALE_PAYMENT_METHODS, saleDefaultDueDate } from "./core/sales";
import "./styles.css";
import { submitAction } from "./actions/submitAction";
import { applyWorkspaceSnapshot, fetchCompanyWorkspace } from "./runtime/workspaceState";
import { fetchRuntimeCollection, fetchRuntimeReports } from "./runtime/runtimeData";
import { markRuntimeResourceFailed } from "./runtime/runtimeListState.mjs";
import { mapWorkspaceToAppData } from "./workspace/mapWorkspaceToAppData";
import {
  isPagedRuntimeResource,
  isRuntimeResourceAvailable,
  extensionProductFilters,
  extensionProductImportSchema,
  extensionServiceOrderFilters,
  fallbackPermissionsForRoleWithExtensions,
  listEnabledExtensionNavigation,
  listExtensionSlots,
  resolveExtensionPage,
  resolvePageRuntimeResources,
} from "./extensions/registry";
import { ExtensionPageHost, ExtensionSlotHost } from "./extensions/ExtensionHost";
import { extensionIcon } from "./extensions/icons";


const navGroups = [
  {
    label: "Operacao",
    hint: "Vendas, clientes e estoque",
    icon: ShoppingCart,
    items: [
      { id: "dashboard", name: "Dashboard", icon: LayoutDashboard },
      { id: "sales", name: "Vendas", icon: ShoppingCart },
      { id: "customers", name: "Clientes", icon: UsersRound },
      { id: "products", name: "Produtos e servicos", icon: PackagePlus },
      { id: "inventory", name: "Estoque", icon: Boxes },
      { id: "service_orders", name: "Ordens de servico", icon: Wrench },
    ],
  },
  {
    label: "Financeiro",
    hint: "Caixa, recebiveis e pagamentos",
    icon: Landmark,
    items: [
      { id: "payments", name: "Pagamentos", icon: CreditCard },
      { id: "receivables", name: "Recebiveis", icon: WalletCards },
      { id: "cash_register", name: "Caixa", icon: CircleDollarSign },
      { id: "receipts", name: "Recibos", icon: ReceiptText },
      { id: "finance", name: "Financeiro", icon: Landmark },
    ],
  },
  {
    label: "Servicos",
    hint: "Add-ons e produtos do ecossistema Volt",
    icon: BriefcaseBusiness,
    items: [
      { id: "services", name: "Servicos Volt", icon: BriefcaseBusiness, minRole: "manager" },
    ],
  },
  {
    label: "Gestao",
    hint: "Relatorios e leitura gerencial",
    icon: BarChart3,
    items: [
      { id: "reports", name: "Relatorios", icon: BarChart3 },
    ],
  },
  {
    label: "Administracao",
    hint: "Implantacao, usuarios e parametros",
    icon: Settings,
    items: [
      { id: "settings", name: "Configuracoes", icon: Settings, minRole: "owner" },
      { id: "users", name: "Usuarios", icon: UserCog, minRole: "owner" },
      { id: "companies", name: "Empresas", icon: Building2, minRole: "owner" },
      { id: "modules", name: "Modulos", icon: PanelsTopLeft, minRole: "owner" },
    ],
  },

];

const extensionNavGroups = Object.freeze({
  vertical: Object.freeze({ label: "Vertical", hint: "Recursos do nicho contratado", icon: PanelsTopLeft }),
  services: Object.freeze({ label: "Servicos", hint: "Add-ons e produtos do ecossistema Volt", icon: BriefcaseBusiness }),
  channels: Object.freeze({ label: "Canais", hint: "Marketplaces e canais conectados", icon: Store }),
});

function composeCompanyNavigation(configuration) {
  const groups = navGroups.map((group) => ({ ...group, items: [...group.items] }));
  for (const item of listEnabledExtensionNavigation(configuration || {})) {
    const groupMeta = extensionNavGroups[item.group] || extensionNavGroups.services;
    let group = groups.find((candidate) => candidate.label === groupMeta.label);
    if (!group) {
      group = { ...groupMeta, items: [] };
      const servicesIndex = groups.findIndex((candidate) => candidate.label === "Servicos");
      groups.splice(servicesIndex >= 0 ? servicesIndex : groups.length, 0, group);
    }
    if (!group.items.some((candidate) => candidate.id === item.id)) {
      group.items.push({ ...item, icon: extensionIcon(item.icon, groupMeta.icon) });
    }
  }
  return groups;
}

function companyVerticalLabel(configuration) {
  const activeVerticals = (configuration?.commercial?.products || [])
    .filter((product) => product.kind === "vertical" && product.status === "active")
    .map((product) => product.name)
    .filter(Boolean);
  return activeVerticals.length ? activeVerticals.join(" + ") : "Core padrao";
}

const masterNavGroups = [
  {
    label: "Visao global",
    hint: "Empresas, usuarios e vinculos",
    icon: LayoutDashboard,
    items: [
      { id: "master_dashboard", name: "Painel master", icon: LayoutDashboard },
      { id: "companies", name: "Empresas", icon: Building2 },
      { id: "users", name: "Usuarios", icon: UserCog },
      { id: "master_links", name: "Vinculos", icon: UsersRound },
    ],
  },
  {
    label: "Governanca",
    hint: "Modulos, auditoria e sistema",
    icon: ShieldCheck,
    items: [
      { id: "master_modules", name: "Segmentos e modulos", icon: PanelsTopLeft },
      { id: "master_audit", name: "Auditoria", icon: ShieldCheck },
      { id: "master_system", name: "Sistema", icon: Settings },
    ],
  },
];

const pages = navGroups.flatMap((group) => group.items);

const masterOnlyPages = new Set(["companies", "modules"]);
const roleWeight = {
  operator: 1,
  stock: 2,
  finance: 2,
  manager: 3,
  owner: 4,
};
const pageReadPermissions = {
  sales: "sales:read",
  customers: "customers:read",
  products: "products:read",
  inventory: "inventory:read",
  payments: "payments:read",
  receivables: "receivables:read",
  cash_register: "cash_register:read",
  receipts: "receipts:read",
  finance: "expenses:read",
  service_orders: "service_orders:read",
  services: "services:read",
  reports: "reports:read",
  settings: "settings:read",
  users: "users:read",
};

const pageMeta = {
  dashboard: ["Dashboard", "Visao executiva da empresa, rotina de hoje e alertas de operacao."],
  sales: ["Vendas", "PDV e acompanhamento de pedidos."],
  customers: ["Clientes", "Cadastro, contato e acompanhamento operacional."],
  products: ["Produtos e servicos", "Produtos, servicos, precos e estoque."],
  inventory: ["Estoque", "Entradas, saidas, ajustes, inventario e reposicao."],
  payments: ["Pagamentos", "Formas de pagamento, conciliacao e repasses."],
  receivables: ["Recebiveis", "Parcelas, cheques, vencidos, cobrancas e recebimento parcial."],
  cash_register: ["Caixa", "Abertura, sangria, reforco, conferencia e fechamento."],
  receipts: ["Recibos", "Emissao, modelo, reimpressao e envio ao cliente."],
  finance: ["Financeiro", "Contas, fluxo de caixa, despesas e previsao."],
  service_orders: ["Ordens de servico", "OS, producao, prazos e entrega."],
  services: ["Servicos Volt", "Verticais, servicos e canais disponiveis para compor sua operacao."],
  reports: ["Relatorios", "Indicadores, exportacoes e leitura gerencial."],
  settings: ["Configuracoes", "Regras operacionais, empresa e implantacao avancada."],
  users: ["Usuarios", "Equipe, perfis, permissoes e acesso por empresa."],
  companies: ["Empresas", "Painel master para clientes, segmentos e ambientes."],
  modules: ["Modulos", "Implantacao de telas, templates setoriais e planos comerciais."],
  master_dashboard: ["Painel Master", "Visao global dos ambientes, acessos e atividade do DACHBYTE Core."],
  master_links: ["Vinculos", "Relacao entre usuarios, empresas, perfis e permissoes."],
  master_modules: ["Segmentos e modulos", "Distribuicao dos templates e configuracoes por empresa."],
  master_audit: ["Auditoria", "Eventos operacionais registrados em todos os ambientes."],
  master_system: ["Sistema", "Estado do banco, migrations e processos internos do DACHBYTE Core."],
};





function resetCompanyOperationalData(current) {
  return {
    ...current,
    sales: [], customers: [], products: [], productCategories: [], productBrands: [], movements: [], stockReservations: [],
    receivables: [], cashRows: [], cashSessions: [], paymentMethods: [], expenses: [], serviceOrders: [],
    users: [], auditEvents: [], receipts: [],
  };
}

function runtimeOperationalListProps(runtimeData, resource, extraQuery = {}) {
  const state = runtimeData?.lists?.[resource];
  if (!runtimeData?.loadResource || !state?.pagination) return {};
  return {
    serverLoading: Boolean(state.loading),
    serverPagination: state.pagination,
    onServerQueryChange: (query) => runtimeData.loadResource(resource, { ...query, ...extraQuery }, { silent: true }),
  };
}

const emptyDashboardMetrics = [
  { label: "Clientes", value: "0", hint: "Cadastros ativos", tone: "blue", page: "customers" },
  { label: "Produtos", value: "0", hint: "Catalogo da empresa", tone: "blue", page: "products" },
  { label: "Estoque critico", value: "0", hint: "Itens abaixo do minimo", tone: "amber", page: "inventory" },
  { label: "Recebiveis", value: formatCurrency(0), hint: "Saldo em aberto", tone: "violet", page: "receivables" },
];

function extractNodeText(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractNodeText).join(" ");
  if (React.isValidElement(node)) return extractNodeText(node.props?.children);
  return "";
}

function BrandLogo() {
  return (
    <span className="brand-lockup">
      <span className="dachbyte-signature__wordmark"><span>DACH</span><span>BYTE</span></span>
      <span className="dachbyte-signature__label">Core</span>
    </span>
  );
}

function Login({ onLogin }) {
  const [credentials, setCredentials] = useState({ username: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const payload = await apiFetch("/core/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: credentials.username,
          username: credentials.username,
          password: credentials.password,
          senha: credentials.password,
        }),
      });
      onLogin({
        ...payload.user,
        companies: payload.companies || [],
        selectedCompanyId: payload.selectedCompanyId || payload.companies?.[0]?.id || null,
      });
    } catch (loginError) {
      setError(loginError?.message || "Nao foi possivel entrar agora.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page min-h-screen">
      <section className="login-hero">
        <BrandLogo />

        <div className="login-copy">
          <span className="badge badge--hero">
            <ShieldCheck size={14} />
            Ambiente de gestao
          </span>
          <h1>Controle vendas, estoque, caixa e clientes em um fluxo direto.</h1>
          <p>
            O DACHBYTE Core organiza a rotina operacional de pequenas e medias empresas, dentro do ecossistema DACHBYTE Business.
          </p>
        </div>

        <div className="login-footnotes">
          <span>Vendas e PDV</span>
          <span>Estoque rastreavel</span>
          <span>Recebiveis e caixa</span>
        </div>
      </section>

      <section className="login-panel-wrap min-h-screen">
        <div className="panel login-panel">
          <div className="login-panel__icon">
            <BriefcaseBusiness size={25} />
          </div>
          <h2>Entrar</h2>
          <p>Use suas credenciais para acessar o ambiente da empresa.</p>

          <form className="login-form" onSubmit={handleSubmit}>
            <div className="field-label">
              <label htmlFor="login-username">Usuario</label>
              <span className="login-field">
                <UserRound className="login-field__icon" size={18} />
                <input
                  id="login-username"
                  className="input login-field__input"
                  value={credentials.username}
                  autoComplete="username"
                  onChange={(event) => setCredentials((current) => ({ ...current, username: event.target.value }))}
                />
              </span>
            </div>

            <div className="field-label">
              <label htmlFor="login-password">Senha</label>
              <span className="login-field">
                <Lock className="login-field__icon" size={18} />
                <input
                  id="login-password"
                  className="input login-field__input login-field__input--password"
                  value={credentials.password}
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))}
                />
                <button
                  className="login-field__visibility"
                  type="button"
                  aria-label={showPassword ? "Ocultar senha" : "Exibir senha"}
                  title={showPassword ? "Ocultar senha" : "Exibir senha"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((current) => !current)}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </span>
            </div>

            {error ? <div className="login-error">{error}</div> : null}

            <button className="button-primary button-full" disabled={loading} type="submit">
              {loading ? <span className="spinner" /> : <ArrowRight size={18} />}
              {loading ? "Entrando..." : "Entrar no DACHBYTE Core"}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}

function safeReadJsonStorage(key) {
  try {
    return JSON.parse(window.localStorage.getItem(key) || "null");
  } catch (_error) {
    return null;
  }
}

function AppShell({ user, onLogout }) {
  const isMasterUser = user?.isMaster || user?.is_master || user?.role === "admin_master" || user?.nivel === "admin_master";
  const masterContextStorageKey = `volt_core_master_context_${user?.uid || user?.id || user?.email || "current"}`;
  const companies = user?.companies || [];
  const storedMasterContext = isMasterUser ? safeReadJsonStorage(masterContextStorageKey) : null;
  const storedCompanyId = storedMasterContext?.selectedCompanyId;
  const storedCompanyExists = companies.some((company) => String(company.id) === String(storedCompanyId));
  const initialCompanyId = (isMasterUser && storedCompanyExists ? storedCompanyId : user?.selectedCompanyId) || companies[0]?.id || null;
  const initialContextMode = isMasterUser && storedMasterContext?.contextMode === "company" && initialCompanyId ? "company" : isMasterUser ? "master" : "company";
  const initialActivePage = initialContextMode === "master" ? "master_dashboard" : storedMasterContext?.activePage || "dashboard";
  const [contextMode, setContextMode] = useState(initialContextMode);
  const [activePage, setActivePage] = useState(initialActivePage);
  const [navigationIntent, setNavigationIntent] = useState(null);
  const [openNavGroup, setOpenNavGroup] = useState(initialContextMode === "master" ? masterNavGroups[0]?.label : navGroups[0]?.label);
  const [selectedCompanyId, setSelectedCompanyId] = useState(initialCompanyId);
  const [pendingCompanyPage, setPendingCompanyPage] = useState("dashboard");
  const loadedCompanyRef = useRef(null);
  const [workspace, setWorkspace] = useState(null);
  const [runtimeMode, setRuntimeMode] = useState("database");
  const [runtimeError, setRuntimeError] = useState("");
  const [databaseAvailable, setDatabaseAvailable] = useState(false);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [modal, setModal] = useState(null);
  const [completedSale, setCompletedSale] = useState(null);
  const [toast, setToast] = useState("");
  const [appData, setAppData] = useState(() => ({
    sales: [],
    customers: [],
    products: [],
    productCategories: [],
    movements: [],
    stockReservations: [],
    receivables: [],
    cashRows: [],
    cashSummary: {
      balance: 0,
      expectedAmount: 0,
      movementCount: 0,
      movementTotal: 0,
      openingAmount: 0,
      sessionId: null,
      status: "closed",
      openedAt: null,
    },
    cashSessions: [],
    paymentMethods: [],
    expenses: [],
    serviceOrders: [],
    users: [],
    masterCompanies: [],
    masterOverview: {
      totals: { companies: 0, users: 0, activeCompanies: 0, activeUsers: 0 },
      auditEvents: [],
      segmentDistribution: [],
      companyActivity: [],
      system: {},
    },
    customFields: [],
    workflows: [],
    modulePlans: [],
    auditEvents: [],
    receipts: [],
    settings: {
      companyName: "",
      legalName: "",
      document: "",
      phone: "",
      email: "",
    },
  }));
  const [runtimeLists, setRuntimeLists] = useState({});
  const [reportData, setReportData] = useState(null);
  const runtimeRequestSequence = useRef({});

  const isMasterContext = isMasterUser && contextMode === "master";
  const extensionPageMeta = resolveExtensionPage(activePage, workspace?.configuration || {});
  const [defaultTitle, defaultDescription] = extensionPageMeta
    ? [extensionPageMeta.title || activePage, extensionPageMeta.description || "Recurso da extensao ativa."]
    : (pageMeta[activePage] || pageMeta.dashboard);
  const title = defaultTitle;
  const description = defaultDescription;
  const enabledScreens = workspace?.configuration?.screens || [];
  const selectedCompanyAccess = useMemo(
    () => (user?.companies || []).find((company) => String(company.id) === String(selectedCompanyId)) || null,
    [selectedCompanyId, user?.companies],
  );
  const effectivePermissions = useMemo(() => {
    if (isMasterUser) return ["*"];
    const explicit = Array.isArray(selectedCompanyAccess?.permissions) ? selectedCompanyAccess.permissions : [];
    return explicit.length ? explicit : fallbackPermissionsForRoleWithExtensions(selectedCompanyAccess?.role || user?.role || user?.nivel, workspace?.configuration);
  }, [isMasterUser, selectedCompanyAccess, user?.nivel, user?.role, workspace?.configuration]);
  const canReadPage = useMemo(() => {
    const permissions = new Set(effectivePermissions);
    return (pageId) => {
      if (masterOnlyPages.has(pageId)) return isMasterContext;
      const extensionPage = resolveExtensionPage(pageId, workspace?.configuration || {});
      const permission = pageReadPermissions[pageId] || extensionPage?.readPermission;
      return !permission || permissions.has("*") || permissions.has(permission);
    };
  }, [effectivePermissions, isMasterContext, workspace?.configuration]);
  const canManageUsers = isMasterUser || effectivePermissions.includes("*") || effectivePermissions.includes("users:write");
  const canManageServices = isMasterUser || effectivePermissions.includes("*") || effectivePermissions.includes("services:write");
  const selectedCompanyRole = normalizeUiRole(selectedCompanyAccess?.role || user?.role || user?.nivel);
  const canChooseSector = !isMasterUser && selectedCompanyRole === "owner";
  const companyProfile = workspace?.configuration?.settings?.companyProfile || {};
  const requiresCompanyProfile = !isMasterUser && Boolean(workspace) && companyProfile.status === "incomplete";
  const sectorConfirmed = workspace?.configuration?.settings?.onboarding?.sectorConfirmed === true;
  const requiresSectorOnboarding = !isMasterUser && Boolean(workspace) && !sectorConfirmed;
  const visibleNavGroups = useMemo(() => {
    if (isMasterContext) return masterNavGroups;
    return composeCompanyNavigation(workspace?.configuration || {})
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          if (masterOnlyPages.has(item.id)) return false;
          if (item.minRole && roleWeight[selectedCompanyRole] < roleWeight[item.minRole]) return false;
          if (item.id === "dashboard") return canReadPage(item.id);
          return enabledScreens.includes(item.id) && canReadPage(item.id);
        }),
      }))
      .filter((group) => group.items.length > 0);
  }, [canReadPage, enabledScreens, isMasterContext, selectedCompanyRole, workspace?.configuration]);

  useEffect(() => {
    const activeGroup = visibleNavGroups.find((group) => group.items.some((item) => item.id === activePage));
    if (activeGroup) setOpenNavGroup(activeGroup.label);
  }, [activePage, isMasterContext]);

  useEffect(() => {
    const visiblePages = visibleNavGroups.flatMap((group) => group.items.map((item) => item.id));
    if (visiblePages.length && !visiblePages.includes(activePage)) {
      setActivePage(visiblePages[0]);
    }
  }, [activePage, visibleNavGroups]);

  useEffect(() => {
    apiFetch("/core/runtime/status")
      .then((status) => setDatabaseAvailable(Boolean(status.databaseEnabled)))
      .catch(() => setDatabaseAvailable(false));
  }, []);

  useEffect(() => {
    if (!isMasterUser) return;
    if (contextMode === "company" && selectedCompanyId) {
      window.localStorage.setItem(masterContextStorageKey, JSON.stringify({
        activePage: masterOnlyPages.has(activePage) ? "dashboard" : activePage,
        contextMode,
        selectedCompanyId,
      }));
      return;
    }
    window.localStorage.removeItem(masterContextStorageKey);
  }, [activePage, contextMode, isMasterUser, masterContextStorageKey, selectedCompanyId]);

  const loadRuntimeResource = useCallback(async (resource, query = {}, options = {}) => {
    if (!selectedCompanyId || contextMode !== "company") return null;
    if (!isRuntimeResourceAvailable(resource, workspace?.configuration)) return null;
    const requestId = Number(runtimeRequestSequence.current[resource] || 0) + 1;
    runtimeRequestSequence.current[resource] = requestId;
    setRuntimeLists((current) => ({
      ...current,
      [resource]: { ...(current[resource] || {}), loading: true, query, error: "" },
    }));
    try {
      const payload = await fetchRuntimeCollection(selectedCompanyId, resource, query, workspace?.configuration);
      if (runtimeRequestSequence.current[resource] !== requestId) return payload;
      const patch = payload.data || {};
      setWorkspace((current) => current ? { ...current, ...patch } : current);
      setAppData((current) => mapWorkspaceToAppData({ configuration: workspace?.configuration, ...patch }, current));
      let summary = payload.summary || null;
      if (resource === "receivables" && Array.isArray(summary?.queueRows)) {
        summary = {
          ...summary,
          queueRows: mapWorkspaceToAppData({ receivables: summary.queueRows }, { receivables: [] }).receivables,
        };
      }
      if (resource === "serviceOrders" && Array.isArray(summary?.queueRows)) {
        summary = {
          ...summary,
          queueRows: mapWorkspaceToAppData({ configuration: workspace?.configuration, serviceOrders: summary.queueRows }, { serviceOrders: [] }).serviceOrders,
        };
      }
      setRuntimeLists((current) => ({
        ...current,
        [resource]: {
          loading: false,
          loaded: true,
          companyId: selectedCompanyId,
          pagination: payload.pagination || null,
          summary,
          query,
          error: "",
        },
      }));
      return payload;
    } catch (error) {
      if (runtimeRequestSequence.current[resource] === requestId) {
        setRuntimeLists((current) => markRuntimeResourceFailed(
          current,
          resource,
          error.message || "Falha ao carregar dados.",
        ));
      }
      if (!options.silent) throw error;
      return null;
    }
  }, [contextMode, selectedCompanyId, workspace?.configuration]);

  const searchRuntimeResource = useCallback(async (resource, query = {}) => {
    if (!selectedCompanyId || contextMode !== "company") return [];
    if (!isRuntimeResourceAvailable(resource, workspace?.configuration)) return [];
    const payload = await fetchRuntimeCollection(selectedCompanyId, resource, query, workspace?.configuration);
    const mapped = mapWorkspaceToAppData(
      { configuration: workspace?.configuration, ...(payload.data || {}) },
      { [resource]: [] },
    );
    return Array.isArray(mapped[resource]) ? mapped[resource] : [];
  }, [contextMode, selectedCompanyId, workspace?.configuration]);

  async function loadActivePageData(pageId = activePage, { force = false } = {}) {
    if (!selectedCompanyId || contextMode !== "company") return;
    const resources = resolvePageRuntimeResources(pageId, workspace?.configuration);
    await Promise.all(resources.map((resource) => {
      const cached = runtimeLists[resource];
      if (!force && cached?.loaded && String(cached.companyId) === String(selectedCompanyId)) return Promise.resolve(null);
      const isLookupOnSales = pageId === "sales" && resource !== "sales";
      const largeLookup = ["users", "auditLogs"].includes(resource);
      const query = isPagedRuntimeResource(resource, workspace?.configuration)
        ? { page: 1, pageSize: isLookupOnSales ? 20 : largeLookup ? 50 : 10 }
        : {};
      return loadRuntimeResource(resource, query, { silent: true });
    }));
  }

  const loadServerReports = useCallback(async (filters = {}) => {
    if (!selectedCompanyId || contextMode !== "company") return null;
    setRuntimeLists((current) => ({ ...current, reports: { ...(current.reports || {}), loading: true, error: "" } }));
    try {
      const report = await fetchRuntimeReports(selectedCompanyId, filters);
      const mapped = mapWorkspaceToAppData(report.data || {}, {
        sales: [], movements: [], stockReservations: [], expenses: [], receivables: [], products: [],
      });
      const nextReport = {
        ...mapped,
        lowStock: mapped.products || [],
        summary: report.summary || {},
        detailPagination: report.detailPagination || {},
        filters: report.filters || filters,
      };
      setReportData(nextReport);
      setRuntimeLists((current) => ({ ...current, reports: { loading: false, loaded: true, error: "" } }));
      return nextReport;
    } catch (error) {
      setRuntimeLists((current) => ({ ...current, reports: { loading: false, error: error.message || "Falha ao carregar relatorios." } }));
      throw error;
    }
  }, [contextMode, selectedCompanyId]);

  useEffect(() => {
    let cancelled = false;

    async function loadWorkspace() {
      if (contextMode !== "company") {
        setRuntimeLoading(false);
        return;
      }
      if (!selectedCompanyId) {
        setWorkspace(null);
        setRuntimeMode("error");
        setRuntimeError("Nenhuma empresa esta vinculada a este usuario.");
        setRuntimeLoading(false);
        return;
      }
      setRuntimeLoading(true);
      setRuntimeError("");
      try {
        const nextWorkspace = await fetchCompanyWorkspace(selectedCompanyId);
        if (!cancelled) {
          const isSwitchingCompany = String(loadedCompanyRef.current || "") !== String(selectedCompanyId || "");
          if (isSwitchingCompany) {
            setAppData((current) => resetCompanyOperationalData(current));
            setRuntimeLists({});
            setReportData(null);
            runtimeRequestSequence.current = {};
          }
          applyWorkspaceSnapshot(nextWorkspace, { setAppData, setRuntimeMode, setWorkspace });
          loadedCompanyRef.current = selectedCompanyId;
          if (isSwitchingCompany) setActivePage(pendingCompanyPage || "dashboard");
          setPendingCompanyPage("dashboard");
        }
      } catch (error) {
        if (!cancelled) {
          setWorkspace(null);
          setRuntimeMode("error");
          setRuntimeError(error.message || "Nao foi possivel carregar o ambiente da empresa.");
        }
      } finally {
        if (!cancelled) setRuntimeLoading(false);
      }
    }

    loadWorkspace();
    return () => {
      cancelled = true;
    };
  }, [contextMode, selectedCompanyId]);

  useEffect(() => {
    if (contextMode !== "company" || !selectedCompanyId || workspace?.workspaceVersion !== 2) return;
    if (activePage === "reports") {
      loadServerReports(reportData?.filters || {}).catch((error) => notify(error.message || "Nao foi possivel carregar os relatorios."));
      return;
    }
    if (activePage === "finance") {
      Promise.all([loadActivePageData(activePage), loadServerReports({})]).catch((error) => notify(error.message || "Nao foi possivel carregar os dados financeiros."));
      return;
    }
    loadActivePageData(activePage).catch((error) => notify(error.message || "Nao foi possivel carregar os dados desta tela."));
  }, [activePage, contextMode, selectedCompanyId, workspace?.workspaceVersion]);

  useEffect(() => {
    if (!isMasterUser) return undefined;
    let cancelled = false;

    async function loadMasterOverview() {
      try {
        const payload = await apiFetch("/core/master/overview");
        const overview = payload.overview || {};
        if (!cancelled) {
          setAppData((current) => ({
            ...current,
            masterCompanies: overview.companies || current.masterCompanies,
            users: overview.users || current.users,
            masterOverview: overview,
          }));
        }
      } catch (_error) {
        if (!cancelled) notify("Painel master indisponivel. Tente novamente em instantes.");
      }
    }

    loadMasterOverview();
    return () => {
      cancelled = true;
    };
  }, [isMasterUser]);

  useEffect(() => {
    const visibleIds = new Set(visibleNavGroups.flatMap((group) => group.items.map((item) => item.id)));
    if (!visibleIds.has(activePage)) setActivePage("dashboard");
  }, [activePage, visibleNavGroups]);

  async function refreshRuntimeWorkspace({ resources = [] } = {}) {
    const nextWorkspace = await fetchCompanyWorkspace(selectedCompanyId);
    const applied = applyWorkspaceSnapshot(nextWorkspace, { setAppData, setRuntimeMode, setWorkspace });
    const activeResources = new Set(resolvePageRuntimeResources(activePage, nextWorkspace?.configuration));
    if (activePage === "reports") {
      await loadServerReports(reportData?.filters || {});
    } else if (activePage === "finance") {
      await Promise.all([loadActivePageData(activePage, { force: true }), loadServerReports({})]);
    } else {
      await loadActivePageData(activePage, { force: true });
    }
    const extraResources = [...new Set(resources)].filter((resource) => (
      !activeResources.has(resource) && isRuntimeResourceAvailable(resource, nextWorkspace?.configuration)
    ));
    await Promise.all(extraResources.map((resource) => {
      const query = isPagedRuntimeResource(resource, nextWorkspace?.configuration)
        ? { page: 1, pageSize: 10 }
        : {};
      return loadRuntimeResource(resource, query, { silent: true });
    }));
    return applied;
  }

  async function refreshMasterData() {
    const payload = await apiFetch("/core/master/overview");
    const overview = payload.overview || {};
    setAppData((current) => ({
      ...current,
      masterCompanies: overview.companies || [],
      users: overview.users || [],
      masterOverview: overview,
    }));
    return overview;
  }

  async function handleSectorOnboarding(selection) {
    setRuntimeLoading(true);
    try {
      await apiFetch(`/core/runtime/companies/${selectedCompanyId}/onboarding/sector`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selection),
      });
      await refreshRuntimeWorkspace();
      notify("Tipo de negocio confirmado. Seu ambiente esta pronto.");
    } finally {
      setRuntimeLoading(false);
    }
  }

  async function handleCompanyProfileOnboarding(profile) {
    setRuntimeLoading(true);
    try {
      await apiFetch(`/core/runtime/companies/${selectedCompanyId}/onboarding/company-profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      await refreshRuntimeWorkspace();
      notify("Dados da empresa confirmados.");
    } finally {
      setRuntimeLoading(false);
    }
  }

  function notify(message) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  function navigateWithIntent(page, intent = {}) {
    setNavigationIntent({ page, ...intent, key: `${page}-${Date.now()}` });
    setActivePage(page);
  }

  useEffect(() => {
    if (!navigationIntent || navigationIntent.page !== activePage) return undefined;
    const timer = window.setTimeout(() => setNavigationIntent(null), 0);
    return () => window.clearTimeout(timer);
  }, [activePage, navigationIntent?.key]);

  function openActionModal(type, payload = {}) {
    setModal({ type, payload });
  }

  function handleSelectCompany(companyId, targetPage = "dashboard") {
    if (!companyId) return;
    setWorkspace(null);
    setRuntimeError("");
    setPendingCompanyPage(targetPage);
    setSelectedCompanyId(companyId);
    setContextMode("company");
    setActivePage(targetPage);
    notify("Ambiente da empresa carregado.");
  }

  function handleOpenMasterPanel() {
    if (isMasterUser) window.localStorage.removeItem(masterContextStorageKey);
    setContextMode("master");
    setActivePage("master_dashboard");
    setRuntimeError("");
  }

  async function runActionSubmit(type, values) {
    return await submitAction(type, values, {
      appData,
      databaseAvailable,
      isMasterContext,
      isMasterUser,
      newProductBrandValue: NEW_PRODUCT_BRAND_VALUE,
      notify,
      printReceipt,
      refreshMasterData,
      refreshRuntimeWorkspace,
      runtimeMode,
      selectedCompanyId,
      setAppData,
      setSelectedCompanyId,
      setWorkspace,
      workspace,
    });
  }

  async function handleActionSubmit(type, values) {
    const previousNavigation = {
      activePage,
      contextMode,
      selectedCompanyId,
    };
    const result = await runActionSubmit(type, values);
    if (isMasterUser && previousNavigation.contextMode === "company" && previousNavigation.selectedCompanyId) {
      setContextMode("company");
      setSelectedCompanyId(previousNavigation.selectedCompanyId);
      setActivePage(previousNavigation.activePage);
    }
    if (type === "sale" && result) {
      setCompletedSale(result);
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("volt:action-completed", { detail: { type } }));
    }
    setModal(null);
    return result;
  }

  const runtimeData = useMemo(() => ({
    draftScope: {
      companyId: selectedCompanyId,
      operatorId: user?.uid || user?.id || user?.email || "current",
    },
    lists: runtimeLists,
    loadResource: loadRuntimeResource,
    loadReports: loadServerReports,
    reportData,
    reportsLoading: Boolean(runtimeLists.reports?.loading),
  }), [loadRuntimeResource, loadServerReports, reportData, runtimeLists, selectedCompanyId, user?.email, user?.id, user?.uid]);

  return (
    <div className="app-shell min-h-screen">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <BrandLogo />
        </div>

        <nav className="nav-list" aria-label="Navegacao principal">
          {visibleNavGroups.map((group) => {
            const expanded = openNavGroup === group.label;
            const GroupIcon = group.icon || PanelsTopLeft;
            return (
              <section className={"nav-group " + (expanded ? "nav-group--open" : "")} key={group.label}>
                <button
                  className="nav-group__toggle"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpenNavGroup((current) => current === group.label ? null : group.label)}
                >
                  <span className="nav-group__icon"><GroupIcon size={16} /></span>
                  <span className="nav-group__meta">
                    <strong>{group.label}</strong>
                    <small>{group.hint}</small>
                  </span>
                  <span className="nav-group__chevron"><ChevronRight size={14} /></span>
                </button>
                {expanded ? (
                  <div className="nav-group__items">
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      const active = activePage === item.id;
                      return (
                        <button
                          key={item.id}
                          className={`nav-item ${active ? "nav-item--active" : ""}`}
                          data-page={item.id}
                          type="button"
                          title={item.name}
                          onClick={() => {
                            setOpenNavGroup(group.label);
                            setActivePage(item.id);
                          }}
                        >
                          <Icon size={19} strokeWidth={1.9} />
                          <span>{item.name}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            );
          })}
        </nav>

        <div className="sidebar__profile">
          <div className="profile-row">
            <div className="avatar">
              A
              <span className="sidebar__avatar-status status-dot--online" />
            </div>
            <div className="profile-copy">
              <strong>{user.fullName || user.username}</strong>
              <small>{isMasterUser ? "Admin master" : user.role || user.nivel || "Usuario"}</small>
            </div>
            <ChevronRight className="profile-chevron" size={16} />
          </div>
          <button className="nav-item nav-item--logout" type="button" onClick={onLogout}>
            <LogOut size={18} />
            <span>Sair</span>
          </button>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-copy">
            <h1>{title}</h1>
            <p>{description}</p>
          </div>

          <div className="topbar-actions">
            {!isMasterContext ? (
              <>
                <label className="topbar-select">
                  Empresa
                  <select
                    value={selectedCompanyId || ""}
                    onChange={(event) => handleSelectCompany(event.target.value)}
                  >
                    {(workspace?.companies || []).map((company) => (
                      <option key={company.id} value={company.id}>{company.name}</option>
                    ))}
                  </select>
                </label>
                <span className="badge topbar-sector">
                  {sectorConfirmed
                    ? `Setor: ${companyVerticalLabel(workspace?.configuration)}`
                    : "Setor pendente"}
                </span>
              </>
            ) : null}
            {isMasterUser && !isMasterContext ? (
              <button className="button-secondary" type="button" onClick={handleOpenMasterPanel}>
                <ShieldCheck size={17} />
                Painel master
              </button>
            ) : null}
            <button
              className="button-secondary"
              type="button"
              onClick={() => openActionModal("genericConfig", {
                title: "Perfil do usuario",
                label: "Operador",
                defaultName: user.fullName || user.username,
                feedback: "Perfil atualizado.",
              })}
            >
              {runtimeLoading ? "Carregando..." : user.fullName || user.name || user.email || "Usuario"}
            </button>
          </div>
        </header>

        <main className="page-content">
          {!isMasterContext && runtimeLoading && !workspace ? (
            <div className="panel panel-section runtime-state" role="status">
              <span className="spinner" />
              <div>
                <h2>Carregando ambiente</h2>
                <p>Buscando configuracoes, modulos e dados da empresa.</p>
              </div>
            </div>
          ) : !isMasterContext && runtimeError ? (
            <div className="panel panel-section runtime-state" role="alert">
              <ShieldCheck size={24} />
              <div>
                <h2>Ambiente indisponivel</h2>
                <p>{runtimeError}</p>
                {isMasterUser ? (
                  <button className="button-secondary" type="button" onClick={handleOpenMasterPanel}>
                    Voltar ao painel master
                  </button>
                ) : null}
              </div>
            </div>
          ) : requiresCompanyProfile ? (
            <CompanyProfileOnboarding
              canChoose={canChooseSector}
              company={(workspace?.companies || []).find((company) => String(company.id) === String(selectedCompanyId))}
              loading={runtimeLoading}
              onConfirm={handleCompanyProfileOnboarding}
            />
          ) : requiresSectorOnboarding ? (
            <SectorOnboarding
              canChoose={canChooseSector}
              loading={runtimeLoading}
              onConfirm={handleSectorOnboarding}
            />
          ) : (
            <PageContent
              activePage={activePage}
              appData={appData}
              onAction={openActionModal}
              onDirectSubmit={handleActionSubmit}
              setActivePage={setActivePage}
              navigateWithIntent={navigateWithIntent}
              navigationIntent={navigationIntent}
              canReadPage={canReadPage}
              workspace={workspace}
              isMasterUser={isMasterUser}
              isMasterContext={isMasterContext}
              canManageUsers={canManageUsers}
              canManageServices={canManageServices}
              onSelectCompany={handleSelectCompany}
              runtimeData={runtimeData}
            />
          )}
        </main>
      </div>
      {toast ? <div className="app-toast" role="status">{toast}</div> : null}
      {completedSale ? (
        <SaleCompletedModal
          receipt={completedSale.receipt}
          sale={completedSale.sale}
          onClose={() => setCompletedSale(null)}
          onPrint={() => completedSale.receipt?.html && printReceipt(completedSale.receipt)}
        />
      ) : null}
      {modal?.type === "spreadsheetImport" ? (
        <SpreadsheetImportModal
          data={appData}
          modal={modal}
          onClose={() => setModal(null)}
          onSubmit={runActionSubmit}
        />
      ) : modal?.type === "customerHistory" ? (
        <CustomerHistoryModal
          data={appData}
          modal={modal}
          onAction={openActionModal}
          onClose={() => setModal(null)}
          workspace={workspace}
        />
      ) : modal ? (
        <ActionModal
          data={appData}
          modal={modal}
          onClose={() => setModal(null)}
          onLookup={searchRuntimeResource}
          onSubmit={handleActionSubmit}
          workspace={workspace}
        />
      ) : null}
    </div>
  );
}

function PageContent({ activePage, appData, onAction, onDirectSubmit, setActivePage, navigateWithIntent, navigationIntent, canReadPage, workspace, isMasterUser, isMasterContext, canManageUsers, canManageServices, onSelectCompany, runtimeData }) {
  const extensionPage = resolveExtensionPage(activePage, workspace?.configuration || {});
  const extensionUi = { ModulePage, Toolbar, StatusPill, FeaturePanel, SummaryLine, StepList, RowActions, EmptyContent, HistoryRow, ReportCard };
  if (extensionPage) {
    return (
      <ExtensionPageHost
        pageId={activePage}
        configuration={workspace?.configuration || {}}
        componentProps={{ data: appData, onAction, onDirectSubmit, runtimeData, workspace, ui: extensionUi }}
      />
    );
  }

  const pageMap = {
    master_dashboard: <MasterDashboard overview={appData.masterOverview} setActivePage={setActivePage} onSelectCompany={onSelectCompany} />,
    master_links: <MasterLinks overview={appData.masterOverview} />,
    master_modules: <MasterSegments overview={appData.masterOverview} onSelectCompany={onSelectCompany} />,
    master_audit: <MasterAudit overview={appData.masterOverview} />,
    master_system: <MasterSystem overview={appData.masterOverview} />,
    dashboard: <DashboardPage onNavigate={navigateWithIntent || ((page) => setActivePage(page))} workspace={workspace} canReadPage={canReadPage} />,
    sales: <SalesPage data={appData} onAction={onAction} onDirectSubmit={onDirectSubmit} onNavigate={navigateWithIntent} workspace={workspace} runtimeData={runtimeData} navigationIntent={navigationIntent?.page === "sales" ? navigationIntent : null} />,
    customers: <CustomersPage data={appData} onAction={onAction} runtimeData={runtimeData} workspace={workspace} />,
    products: <ProductsPage data={appData} onAction={onAction} workspace={workspace} runtimeData={runtimeData} />,
    inventory: <InventoryPage data={appData} onAction={onAction} runtimeData={runtimeData} navigationIntent={navigationIntent?.page === "inventory" ? navigationIntent : null} />,
    payments: <PaymentsPage data={appData} onAction={onAction} runtimeData={runtimeData} navigationIntent={navigationIntent?.page === "payments" ? navigationIntent : null} />,
    receivables: <ReceivablesPage data={appData} onAction={onAction} runtimeData={runtimeData} navigationIntent={navigationIntent?.page === "receivables" ? navigationIntent : null} />,
    cash_register: <CashPage data={appData} onAction={onAction} runtimeData={runtimeData} />,
    receipts: <ReceiptsPage data={appData} runtimeData={runtimeData} />,
    finance: <FinancePage data={appData} onAction={onAction} runtimeData={runtimeData} />,
    service_orders: <ServiceOrdersPage data={appData} onAction={onAction} runtimeData={runtimeData} workspace={workspace} />,
    services: <VoltServicesPage workspace={workspace} onAction={onAction} isMasterUser={isMasterUser} canManageServices={canManageServices} />,
    reports: <ReportsPage data={appData} onAction={onAction} runtimeData={runtimeData} />,
    settings: <SettingsPage data={appData} onAction={onAction} />,
    users: <UsersPage data={appData} onAction={onAction} isMaster={isMasterContext} canManage={canManageUsers} runtimeData={runtimeData} />,
    companies: <CompaniesPage data={appData} onAction={onAction} onSelectCompany={onSelectCompany} isMaster={isMasterUser} />,
    modules: <ModulesPage data={appData} onAction={onAction} workspace={workspace} isMasterUser={isMasterUser} />,
  };

  return pageMap[activePage] || pageMap.dashboard;
}

function CompanyProfileOnboarding({ canChoose, company = {}, loading, onConfirm }) {
  const [name, setName] = useState(company.name === "Empresa a completar" ? "" : company.name || "");
  const [document, setDocument] = useState(company.document || "");
  const [error, setError] = useState("");

  async function confirmProfile() {
    setError("");
    if (!name.trim()) {
      setError("Informe o nome da empresa.");
      return;
    }
    try {
      await onConfirm({ name: name.trim(), document: document.trim() });
    } catch (submitError) {
      setError(submitError.message || "Nao foi possivel confirmar os dados da empresa.");
    }
  }

  if (!canChoose) {
    return (
      <div className="panel panel-section onboarding-waiting">
        <ShieldCheck size={28} />
        <div>
          <h2>Cadastro da empresa pendente</h2>
          <p>O primeiro administrador precisa confirmar os dados da empresa antes de liberar o ambiente.</p>
        </div>
      </div>
    );
  }

  return (
    <section className="sector-onboarding company-profile-onboarding">
      <header className="sector-onboarding__header">
        <span className="badge"><Building2 size={14} /> Primeiro acesso</span>
        <h2>Confirme os dados da empresa</h2>
        <p>O Hub ainda nao possui todo o cadastro. Informe o nome usado na operacao; o documento pode ser preenchido agora ou depois.</p>
      </header>
      <div className="panel panel-section company-profile-form">
        <label className="field-label">
          Nome da empresa
          <input className="input" value={name} autoFocus onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field-label">
          CPF ou CNPJ <span className="field-optional">Opcional</span>
          <input className="input" value={document} placeholder="Somente se estiver disponivel" onChange={(event) => setDocument(event.target.value)} />
        </label>
      </div>
      {error ? <div className="login-error">{error}</div> : null}
      <footer className="sector-onboarding__footer">
        <span>Esses dados poderao ser complementados nas configuracoes.</span>
        <button className="button-primary" type="button" disabled={loading} onClick={confirmProfile}>
          {loading ? <span className="spinner" /> : <ArrowRight size={18} />}
          {loading ? "Salvando..." : "Continuar"}
        </button>
      </footer>
    </section>
  );
}

function SectorOnboarding({ canChoose, loading, onConfirm }) {
  const [selection, setSelection] = useState("general");
  const [interestLabel, setInterestLabel] = useState("");
  const [error, setError] = useState("");
  const options = [
    {
      key: "general",
      name: "Empresa padrao",
      icon: BriefcaseBusiness,
      description: "Vendas, clientes, produtos, estoque, caixa, recebiveis e relatorios.",
      features: ["PDV e vendas", "Estoque e produtos", "Caixa e financeiro"],
    },
    {
      key: "optical",
      name: "Otica",
      icon: Glasses,
      description: "Nucleo completo com os fluxos especificos para operacao optica.",
      features: ["Tudo do Core", "Ordens de servico", "Receitas opticas"],
    },
    {
      key: "other",
      name: "Outro segmento",
      icon: Store,
      description: "Comece com o Core padrao e registre seu segmento para futuras extensoes.",
      features: ["Core completo", "Personalizacoes preservadas", "Interesse registrado"],
    },
  ];

  async function confirmSelection() {
    setError("");
    if (selection === "other" && !interestLabel.trim()) {
      setError("Informe qual e o segmento da empresa.");
      return;
    }
    try {
      await onConfirm({ sectorKey: selection, interestLabel: interestLabel.trim() });
    } catch (submitError) {
      setError(submitError.message || "Nao foi possivel confirmar o setor.");
    }
  }

  if (!canChoose) {
    return (
      <div className="panel panel-section onboarding-waiting">
        <ShieldCheck size={28} />
        <div>
          <h2>Configuracao inicial pendente</h2>
          <p>O primeiro administrador da empresa precisa definir o tipo de negocio antes de liberar o ambiente.</p>
        </div>
      </div>
    );
  }

  return (
    <section className="sector-onboarding">
      <header className="sector-onboarding__header">
        <span className="badge"><ShieldCheck size={14} /> Primeiro acesso</span>
        <h2>Qual e o tipo do seu negocio?</h2>
        <p>Essa escolha prepara as telas e os fluxos iniciais da empresa. Depois da confirmacao, apenas o suporte Master podera alterar o setor.</p>
      </header>

      <div className="sector-options" role="radiogroup" aria-label="Tipo de negocio">
        {options.map((option) => {
          const Icon = option.icon;
          const selected = selection === option.key;
          return (
            <button
              className={`sector-option ${selected ? "sector-option--selected" : ""}`}
              type="button"
              role="radio"
              aria-checked={selected}
              key={option.key}
              onClick={() => setSelection(option.key)}
            >
              <span className="card-icon"><Icon size={22} /></span>
              <strong>{option.name}</strong>
              <p>{option.description}</p>
              <span className="tag-list">{option.features.map((feature) => <span className="tag" key={feature}>{feature}</span>)}</span>
            </button>
          );
        })}
      </div>

      {selection === "other" ? (
        <label className="field-label sector-interest">
          Qual e o segmento?
          <input
            className="input"
            value={interestLabel}
            placeholder="Informe o segmento da empresa"
            onChange={(event) => setInterestLabel(event.target.value)}
          />
        </label>
      ) : null}

      {error ? <div className="login-error">{error}</div> : null}

      <footer className="sector-onboarding__footer">
        <span>A configuracao sera aplicada uma unica vez.</span>
        <button className="button-primary" type="button" disabled={loading} onClick={confirmSelection}>
          {loading ? <span className="spinner" /> : <CheckCircle2 size={18} />}
          {loading ? "Preparando ambiente..." : "Confirmar e continuar"}
        </button>
      </footer>
    </section>
  );
}

function MasterDashboard({ overview, setActivePage, onSelectCompany }) {
  const totals = overview?.totals || {};
  const activity = overview?.companyActivity || [];
  const companies = overview?.companies || [];
  const recentEvents = (overview?.auditEvents || []).slice(0, 6);

  return (
    <div className="master-workspace">
      <section className="report-grid">
        <ReportCard icon={Building2} title="Empresas" value={String(totals.companies ?? 0)} detail={`${totals.activeCompanies ?? 0} ativas`} />
        <ReportCard icon={UsersRound} title="Usuarios" value={String(totals.users ?? 0)} detail={`${totals.activeUsers ?? 0} ativos`} />
        <ReportCard icon={Eye} title="Eventos recentes" value={String(overview?.auditEvents?.length || 0)} detail="Ultimos 200 registros" />
        <ReportCard icon={PanelsTopLeft} title="Segmentos" value={String(overview?.segmentDistribution?.length || 0)} detail="Templates em uso" />
      </section>

      <section className="panel panel-section master-company-entry">
        <SectionTitle icon={Building2} title="Entrar em uma empresa" description="Abra qualquer ambiente no contexto master para consultar ou executar operacoes." />
        <div className="master-company-entry__list">
          {companies.slice(0, 6).map((company) => (
            <button className="master-company-entry__item" type="button" key={company.id} onClick={() => onSelectCompany(company.id)}>
              <span className="card-icon"><Building2 size={18} /></span>
              <span>
                <strong>{company.name}</strong>
                <small>{company.segment === "optical" ? "Otica" : "Core padrao"} - {company.plan || "starter"}</small>
              </span>
              <StatusPill status={company.status} />
              <ArrowRight size={18} />
            </button>
          ))}
          {!companies.length ? <span className="muted-copy">Nenhuma empresa cadastrada.</span> : null}
        </div>
        {companies.length > 6 ? (
          <button className="button-secondary master-company-entry__all" type="button" onClick={() => setActivePage("companies")}>
            Ver todas as empresas
            <ArrowRight size={17} />
          </button>
        ) : null}
      </section>

      <section className="workspace-grid grid">
        <div className="panel panel-section">
          <SectionTitle icon={ShieldCheck} title="Administracao central" description="Acessos diretos para governanca e suporte dos ambientes." />
          <div className="quick-list">
            <QuickRow title="Gerenciar empresas" subtitle="Cadastro, segmento, plano e acesso ao ambiente" action="Abrir" icon={Building2} onClick={() => setActivePage("companies")} />
            <QuickRow title="Revisar usuarios e vinculos" subtitle="Perfis e empresas associadas a cada acesso" action="Abrir" icon={UserCog} onClick={() => setActivePage("master_links")} />
            <QuickRow title="Consultar auditoria" subtitle="Operacoes registradas em todos os ambientes" action="Abrir" icon={ShieldCheck} onClick={() => setActivePage("master_audit")} />
          </div>
        </div>

        <div className="panel panel-section">
          <SectionTitle icon={TrendingUp} title="Atividade das empresas" description="Volume de eventos operacionais nos ultimos 30 dias." />
          <div className="summary-stack">
            {activity.slice(0, 6).map((company) => (
              <button className="master-activity-row" type="button" key={company.id} onClick={() => onSelectCompany(company.id)}>
                <span><strong>{company.name}</strong><small>{formatDateTime(company.lastActivityAt)}</small></span>
                <span className="badge">{company.events30d} eventos</span>
              </button>
            ))}
            {!activity.length ? <span className="muted-copy">Nenhuma atividade registrada.</span> : null}
          </div>
        </div>
      </section>

      <DataPanel title="Atividade recente" icon={Eye} columns={["Quando", "Empresa", "Ator", "Evento", "Entidade", "Status"]} searchable={false} pageSize={6}>
        {recentEvents.map((event) => (
          <tr key={event.id}>
            <td>{formatDateTime(event.createdAt)}</td>
            <td>{event.companyName}</td>
            <td>{event.actor}</td>
            <td>{event.action}</td>
            <td>{event.entityType || "-"}</td>
            <td><StatusPill status={event.status} /></td>
          </tr>
        ))}
      </DataPanel>
    </div>
  );
}

function MasterLinks({ overview }) {
  const users = overview?.users || [];
  return (
    <DataPanel title="Vinculos de acesso" icon={UsersRound} columns={["Usuario", "E-mail", "Empresa", "Perfil global", "Perfil na empresa", "Permissoes", "Status"]} pageSize={12}>
      {users.map((row) => (
        <tr key={`${row.id}-${row.companyId || "global"}`}>
          <td>{row.name}</td>
          <td>{row.email}</td>
          <td>{row.companyName || "Sem vinculo"}</td>
          <td>{row.role}</td>
          <td>{row.companyRole || "-"}</td>
          <td><span className="badge">{row.permissions?.includes("*") ? "Acesso total" : `${row.permissions?.length || 0} regras`}</span></td>
          <td><StatusPill status={row.status} /></td>
        </tr>
      ))}
    </DataPanel>
  );
}

function MasterSegments({ overview, onSelectCompany }) {
  const companies = overview?.companies || [];
  const segments = overview?.segmentDistribution || [];
  return (
    <div className="master-workspace">
      <section className="report-grid">
        {segments.map((item) => (
          <ReportCard key={item.segment} icon={PanelsTopLeft} title={item.segment === "optical" ? "Otica" : "Core padrao"} value={String(item.companies)} detail="Empresas neste template" />
        ))}
      </section>
      <DataPanel title="Configuracao por empresa" icon={PanelsTopLeft} columns={["Empresa", "Segmento", "Plano", "Modulos", "Usuarios", "Status", "Acao"]} pageSize={12}>
        {companies.map((row) => (
          <tr key={row.id}>
            <td>{row.name}</td>
            <td>{row.requestedSector ? `Outro: ${row.requestedSector}` : row.segment === "optical" ? "Otica" : "Core padrao"}</td>
            <td>{row.plan}</td>
            <td>{row.modules}</td>
            <td>{row.users}</td>
            <td><StatusPill status={row.status} /></td>
            <td><button className="table-action" type="button" onClick={() => onSelectCompany(row.id)}>Abrir ambiente</button></td>
          </tr>
        ))}
      </DataPanel>
    </div>
  );
}

function MasterAudit({ overview }) {
  const events = overview?.auditEvents || [];
  return (
    <DataPanel title="Eventos de auditoria" icon={ShieldCheck} columns={["Quando", "Empresa", "Ator", "Evento", "Entidade", "Identificador", "Detalhes"]} pageSize={15}>
      {events.map((event) => (
        <tr key={event.id}>
          <td>{formatDateTime(event.createdAt)}</td>
          <td>{event.companyName}</td>
          <td>{event.actor}</td>
          <td><StatusPill status={event.action} /></td>
          <td>{event.entityType || "-"}</td>
          <td>{event.entityId || "-"}</td>
          <td><pre className="meta-block">{JSON.stringify(event.metadata || {}, null, 2)}</pre></td>
        </tr>
      ))}
    </DataPanel>
  );
}

function MasterSystem({ overview }) {
  const system = overview?.system || {};
  return (
    <div className="master-workspace">
      <section className="report-grid">
        <ReportCard icon={ShieldCheck} title="Banco de dados" value={system.database === "connected" ? "Conectado" : "Desenvolvimento"} detail="Schema isolado volt_core" />
        <ReportCard icon={ClipboardCheck} title="Migrations" value={String(system.migrations ?? 0)} detail={system.latestMigration || "Nenhuma migration registrada"} />
        <ReportCard icon={CalendarClock} title="Processos pendentes" value={String(system.pendingJobs ?? 0)} detail="Importacoes e exportacoes" />
        <ReportCard icon={Lock} title="Acesso" value="Master" detail="Area restrita e autenticada" />
      </section>
      <div className="panel panel-section">
        <SectionTitle icon={Settings} title="Operacao do sistema" description="Informacoes tecnicas seguras para diagnostico do ambiente." />
        <div className="summary-list">
          <SummaryLine label="Banco" value={system.database === "connected" ? "Disponivel" : "Modo de desenvolvimento"} />
          <SummaryLine label="Ultima migration" value={system.latestMigration || "-"} />
          <SummaryLine label="Total de migrations" value={String(system.migrations ?? 0)} />
          <SummaryLine label="Jobs aguardando processamento" value={String(system.pendingJobs ?? 0)} />
        </div>
      </div>
    </div>
  );
}

function DashboardPage({ onNavigate, workspace, canReadPage }) {
  const dashboard = workspace?.dashboard || {};
  const metrics = Array.isArray(dashboard.metrics) ? dashboard.metrics : [];
  const alerts = Array.isArray(dashboard.alerts) ? dashboard.alerts : [];
  const operationWidgets = Array.isArray(dashboard.operationWidgets) ? dashboard.operationWidgets : [];
  const finance = dashboard.finance || null;
  const inventory = dashboard.inventory || null;
  const salesTrend = Array.isArray(dashboard.salesTrend) ? dashboard.salesTrend : [];
  const firstUse = dashboard.firstUse || {};
  const enabledScreens = new Set(workspace?.configuration?.screens || []);
  const canAccess = (page) => (!page || page === "dashboard" || enabledScreens.has(page)) && (!canReadPage || canReadPage(page));
  const resolveTarget = (page, intent = {}) => {
    if (page === "payments" && !canAccess("payments") && canAccess("receivables")) {
      return { page: "receivables", intent: { ...intent, tab: "agenda" } };
    }
    return { page, intent };
  };
  const firstUseTasks = [
    { label: "Cadastre produtos e servicos", done: workspace?.workspaceVersion === 2 ? Boolean(firstUse.hasProducts) : (workspace?.products || []).length > 0, page: "products" },
    { label: "Informe o estoque dos produtos", done: workspace?.workspaceVersion === 2 ? Boolean(firstUse.hasPositiveStock) : (workspace?.stock || []).some((item) => Number(item.quantity) > 0), page: "inventory" },
    { label: "Abra o caixa para comecar a vender", done: workspace?.workspaceVersion === 2 ? Boolean(firstUse.hasOpenCash) : (workspace?.cashSessions || []).some((item) => item.status === "open"), page: "cash_register" },
  ].filter((task) => canAccess(task.page));
  const showFirstUse = workspace?.workspaceVersion === 2
    ? !firstUse.hasSales && firstUseTasks.some((task) => !task.done)
    : !(workspace?.sales || []).length && firstUseTasks.some((task) => !task.done);
  const visibleAlerts = alerts.map((alert) => ({ ...alert, ...resolveTarget(alert.page || "dashboard", alert.intent || {}) })).filter((alert) => canAccess(alert.page || "dashboard"));
  const visibleOperationWidgets = operationWidgets.filter((widget) => canAccess(widget.page || "sales"));
  const visibleFinance = finance && (canAccess("payments") || canAccess("receivables")) ? finance : null;
  const visibleInventory = inventory && canAccess("inventory") ? inventory : null;
  const cashOpen = dashboard.cash?.status === "open";
  const receiveTarget = resolveTarget("payments", { tab: "pending", filter: "Pendentes" });
  const primaryOperation = visibleOperationWidgets[0] || null;
  const quickActions = [
    { id: "sale", label: "Nova venda", icon: BadgeDollarSign, page: "sales", intent: { tab: "pdv" } },
    { id: "customer", label: "Novo cliente", icon: UsersRound, page: "customers" },
    { id: "stock", label: "Receber produtos", icon: Boxes, page: "inventory", intent: { tab: "balance" } },
    { id: "receive", label: "Receber", icon: WalletCards, page: receiveTarget.page, intent: receiveTarget.intent },
    primaryOperation ? { id: "operation", label: primaryOperation.title || "Pedidos", icon: ClipboardList, page: primaryOperation.page || "sales", intent: primaryOperation.intent || {} } : null,
    { id: "cash", label: cashOpen ? "Ver caixa" : "Abrir caixa", icon: CircleDollarSign, page: "cash_register" },
  ].filter((item) => item && canAccess(item.page));

  return (
    <div className="dashboard-page-v2">
      {quickActions.length ? (
        <section className="panel dashboard-quick-panel">
          <div className="dashboard-section-heading dashboard-section-heading--compact">
            <div>
              <strong>Acoes rapidas</strong>
              <span>Atalhos para a rotina sem ocupar o painel inteiro.</span>
            </div>
          </div>
          <div className="dashboard-quick-actions">
            {quickActions.map((item) => {
              const Icon = item.icon;
              return (
                <button type="button" key={item.id} onClick={() => onNavigate(item.page, item.intent || {})}>
                  <span><Icon size={18} /></span>
                  <strong>{item.label}</strong>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="dashboard-kpi-grid">
        {metrics.map((metric) => {
          const target = resolveTarget(metric.page, metric.intent || {});
          return <DashboardMetricCard key={metric.id || metric.label} metric={metric} onClick={() => target.page && canAccess(target.page) && onNavigate(target.page, target.intent)} />;
        })}
      </section>

      {showFirstUse ? (
        <section className="panel first-use-guide">
          <div><strong>Prepare sua primeira venda</strong><span>Conclua estes passos uma vez. Depois este guia desaparece.</span></div>
          <div className="first-use-tasks">
            {firstUseTasks.map((task) => (
              <button type="button" key={task.label} className={task.done ? "done" : ""} onClick={() => onNavigate(task.page)}>
                <CheckCircle2 size={17} /><span>{task.label}</span><ChevronRight size={16} />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <DashboardAttention alerts={visibleAlerts} onNavigate={onNavigate} />

      {(visibleOperationWidgets.length || visibleFinance) ? (
        <section className={`dashboard-focus-grid ${!visibleOperationWidgets.length || !visibleFinance ? "dashboard-focus-grid--single" : ""}`}>
          {visibleOperationWidgets.slice(0, 1).map((widget) => (
            <DashboardOperationWidget key={widget.id || widget.title} widget={widget} onNavigate={onNavigate} />
          ))}
          {visibleFinance ? <DashboardFinanceWidget finance={visibleFinance} onNavigate={onNavigate} canAccess={canAccess} /> : null}
        </section>
      ) : null}

      {visibleInventory ? <DashboardInventorySummary inventory={visibleInventory} onNavigate={onNavigate} canAccess={canAccess} /> : null}

      {salesTrend.length ? <DashboardSalesTrend rows={salesTrend} onNavigate={onNavigate} canAccess={canAccess} /> : null}
    </div>
  );
}

function dashboardMetricValue(metric) {
  if (metric.format === "text") return metric.textValue || String(metric.value ?? "-");
  if (metric.format === "currency") return formatCurrency(metric.value || 0);
  return String(metric.value ?? "0");
}

function DashboardMetricCard({ metric, onClick }) {
  return (
    <button className={`dashboard-kpi dashboard-kpi--${metric.tone || "blue"}`} type="button" onClick={onClick} disabled={!metric.page}>
      <small>{metric.label}</small>
      <strong>{dashboardMetricValue(metric)}</strong>
      <span>{metric.hint || ""}</span>
    </button>
  );
}

function DashboardAttention({ alerts, onNavigate }) {
  return (
    <section className="panel dashboard-attention">
      <div className="dashboard-section-heading">
        <div>
          <strong>Precisa de atencao</strong>
          <span>Somente excecoes que pedem alguma acao agora.</span>
        </div>
        {alerts.length > 4 ? <small>{alerts.length} pendencias</small> : null}
      </div>
      <div className="dashboard-attention-list">
        {alerts.slice(0, 5).map((alert, index) => {
          const Icon = alert.icon ? extensionIcon(alert.icon, CalendarClock) : ({ receivable: WalletCards, expense: FileText, stock: Boxes }[alert.kind] || AlertTriangle);
          return (
            <button className={`dashboard-attention-row dashboard-attention-row--${alert.kind || "info"}`} key={`${alert.kind || "alert"}-${alert.id || index}`} type="button" onClick={() => onNavigate(alert.page || "dashboard", alert.intent || {})}>
              <span className="dashboard-attention-row__icon"><Icon size={17} /></span>
              <span className="dashboard-attention-row__copy">
                <strong>{alert.title || "Pendencia operacional"}</strong>
                <small>{alert.detail || "Revise esta pendencia."}</small>
              </span>
              <span className="dashboard-attention-row__value">{alert.amount !== undefined ? formatCurrency(alert.amount) : alert.meta || "Ver"}</span>
              <ChevronRight size={16} />
            </button>
          );
        })}
        {!alerts.length ? (
          <div className="dashboard-attention-empty">
            <CheckCircle2 size={19} />
            <span><strong>Nenhuma pendencia urgente</strong><small>Operacao sem alertas criticos neste momento.</small></span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function DashboardOperationWidget({ widget, onNavigate }) {
  const Icon = extensionIcon(widget.icon, ClipboardList);
  return (
    <section className="panel dashboard-focus-card">
      <div className="dashboard-section-heading">
        <div className="dashboard-section-title-with-icon">
          <span><Icon size={18} /></span>
          <div><strong>{widget.title || "Operacao"}</strong><small>{widget.detail || "Acompanhamento operacional"}</small></div>
        </div>
        <button type="button" className="dashboard-text-link" onClick={() => onNavigate(widget.page || "sales", widget.intent || {})}>Ver pedidos <ChevronRight size={15} /></button>
      </div>
      <div className="dashboard-summary-list">
        {(widget.items || []).slice(0, 4).map((item) => (
          <button type="button" key={item.id || item.label} onClick={() => onNavigate(widget.page || "sales", { ...(widget.intent || {}), ...(item.intent || {}) })}>
            <span>{item.label}</span>
            <strong className={item.tone === "danger" ? "danger" : ""}>{item.value ?? 0}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}

function DashboardFinanceWidget({ finance, onNavigate, canAccess }) {
  const receivablePage = canAccess("payments") ? "payments" : "receivables";
  const receivableIntent = (filter) => receivablePage === "payments" ? { tab: "pending", filter } : { tab: "agenda", filter };
  const items = [
    { id: "today", label: "Vence hoje", value: finance.dueTodayAmount, count: finance.dueTodayCount, page: receivablePage, intent: receivableIntent("Vence hoje") },
    { id: "next", label: "Proximos 7 dias", value: finance.next7Amount, count: finance.next7Count, page: receivablePage, intent: receivableIntent("Proximos 7 dias") },
    { id: "overdue", label: "Vencido", value: finance.overdueAmount, count: finance.overdueCount, page: receivablePage, intent: receivableIntent("Vencidos"), tone: "danger" },
    { id: "received", label: "Recebido hoje", value: finance.receivedTodayAmount, page: canAccess("cash_register") ? "cash_register" : receivablePage, intent: {} },
  ];
  return (
    <section className="panel dashboard-focus-card">
      <div className="dashboard-section-heading">
        <div className="dashboard-section-title-with-icon">
          <span><WalletCards size={18} /></span>
          <div><strong>Financeiro</strong><small>Recebimentos e vencimentos</small></div>
        </div>
        <button type="button" className="dashboard-text-link" onClick={() => onNavigate(receivablePage, receivableIntent("Pendentes"))}>Ver recebiveis <ChevronRight size={15} /></button>
      </div>
      <div className="dashboard-summary-list">
        {items.map((item) => (
          <button type="button" key={item.id} onClick={() => onNavigate(item.page, item.intent || {})}>
            <span>{item.label}{item.count !== undefined ? <small>{item.count} titulo{item.count === 1 ? "" : "s"}</small> : null}</span>
            <strong className={item.tone === "danger" && Number(item.value || 0) > 0 ? "danger" : ""}>{formatCurrency(item.value || 0)}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}

function DashboardInventorySummary({ inventory, onNavigate, canAccess }) {
  if (!canAccess("inventory")) return null;
  const items = [
    { id: "physical", label: "Fisico", value: inventory.physical, intent: { tab: "balance" } },
    { id: "reserved", label: "Reservado", value: inventory.reserved, intent: { tab: "reservations" } },
    { id: "available", label: "Disponivel", value: inventory.available, intent: { tab: "balance" } },
    { id: "critical", label: "Criticos", value: inventory.criticalCount, intent: { tab: "balance", filter: "Critico" }, tone: "danger" },
  ];
  return (
    <section className="panel dashboard-stock-summary">
      <div className="dashboard-section-heading">
        <div className="dashboard-section-title-with-icon">
          <span><Boxes size={18} /></span>
          <div><strong>Estoque</strong><small>Fisico, comprometido e realmente disponivel.</small></div>
        </div>
        <button type="button" className="dashboard-text-link" onClick={() => onNavigate("inventory", { tab: "balance" })}>Ver estoque <ChevronRight size={15} /></button>
      </div>
      <div className="dashboard-stock-values">
        {items.map((item) => (
          <button type="button" key={item.id} onClick={() => onNavigate("inventory", item.intent)}>
            <span>{item.label}</span>
            <strong className={item.tone === "danger" && Number(item.value || 0) > 0 ? "danger" : ""}>{Number(item.value || 0).toLocaleString("pt-BR")}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}

function DashboardSalesTrend({ rows, onNavigate, canAccess }) {
  const [period, setPeriod] = useState(7);
  if (!canAccess("sales")) return null;
  const visibleRows = rows.slice(-period);
  const maxValue = Math.max(1, ...visibleRows.map((row) => Number(row.amount || 0)));
  const total = visibleRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const count = visibleRows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const ticket = count ? total / count : 0;
  return (
    <section className="panel dashboard-sales-trend">
      <div className="dashboard-section-heading">
        <div className="dashboard-section-title-with-icon">
          <span><TrendingUp size={18} /></span>
          <div><strong>Vendas</strong><small>Evolucao sem competir com a rotina operacional.</small></div>
        </div>
        <div className="dashboard-period-toggle">
          {[7, 30].map((value) => <button className={period === value ? "active" : ""} type="button" key={value} onClick={() => setPeriod(value)}>{value} dias</button>)}
        </div>
      </div>
      <div className="dashboard-sales-trend__body">
        <div className="dashboard-sales-chart" aria-label={`Vendas dos ultimos ${period} dias`}>
          {visibleRows.map((row) => {
            const ratio = Number(row.amount || 0) / maxValue;
            return (
              <button type="button" className="dashboard-sales-bar" key={row.date} title={`${formatShortDate(row.date)} - ${formatCurrency(row.amount || 0)} - ${row.count || 0} vendas`} onClick={() => onNavigate("sales", { tab: "orders", dateFrom: row.date, dateTo: row.date })}>
                <span style={{ height: `${Math.max(Number(row.amount || 0) ? 8 : 2, ratio * 100)}%` }} />
              </button>
            );
          })}
        </div>
        <div className="dashboard-sales-trend__summary">
          <div><span>Faturamento</span><strong>{formatCurrency(total)}</strong></div>
          <div><span>Vendas</span><strong>{count}</strong></div>
          <div><span>Ticket medio</span><strong>{formatCurrency(ticket)}</strong></div>
        </div>
      </div>
    </section>
  );
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function SalesPage({ data, onAction, onDirectSubmit, onNavigate, workspace, runtimeData, navigationIntent }) {
  const [activeTab, setActiveTab] = useState(navigationIntent?.tab || "pdv");
  useEffect(() => {
    if (navigationIntent?.tab) setActiveTab(navigationIntent.tab);
  }, [navigationIntent?.key, navigationIntent?.tab]);
  const pdvExtension = listExtensionSlots("sales.pdv", workspace?.configuration || {})[0] || null;
  const pdvContent = pdvExtension ? (
    <ExtensionSlotHost
      extensionKey={pdvExtension.extensionKey}
      slot={pdvExtension.slot}
      contributionId={pdvExtension.id}
      configuration={workspace?.configuration || {}}
      componentProps={{ data, onSubmit: onDirectSubmit, onAction, runtimeData }}
      fallback={<div className="panel panel-section">Carregando modulo contratado...</div>}
    />
  ) : <SalesPdv data={data} onAction={onAction} runtimeData={runtimeData} />;
  const initialDateRange = navigationIntent?.dateRange === "today"
    ? { start: localDateKey(), end: localDateKey() }
    : { start: navigationIntent?.dateFrom || "", end: navigationIntent?.dateTo || navigationIntent?.dateFrom || "" };
  return (
    <ModulePage activeTab={activeTab} onTabChange={setActiveTab} tabs={[
      { id: "pdv", label: pdvExtension?.label || "PDV", icon: ShoppingCart, content: pdvContent },
      { id: "orders", label: "Pedidos", icon: ClipboardList, content: <SalesOrders sales={data.sales} receivables={data.receivables} onAction={onAction} onDirectSubmit={onDirectSubmit} onNavigate={onNavigate} runtimeData={runtimeData} initialFilter={navigationIntent?.filter} initialDateRange={initialDateRange} /> },
    ]} />
  );
}

function SalesPdv({ data, onAction, runtimeData }) {
  const [search, setSearch] = useState("");
  const [currentItems, setCurrentItems] = useState([]);
  useEffect(() => {
    if (!runtimeData?.loadResource) return undefined;
    const timer = window.setTimeout(() => {
      runtimeData.loadResource("products", { page: 1, pageSize: 50, search, filter: "Ativos" }, { silent: true });
    }, search.trim() ? 240 : 0);
    return () => window.clearTimeout(timer);
  }, [search]);
  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return data.products;
    return data.products.filter((product) => [product.name, product.sku, product.category].join(" ").toLowerCase().includes(term));
  }, [data.products, search]);
  const total = currentItems.reduce((sum, item) => sum + parseMoney(item.price) * Number(item.quantity || 1), 0);

  function addProduct(product) {
    setCurrentItems((items) => {
      const existing = items.find((item) => item.sku === product.sku);
      if (existing) {
        return items.map((item) => item.sku === product.sku ? { ...item, quantity: Number(item.quantity || 1) + 1 } : item);
      }
      return [...items, { ...product, quantity: 1 }];
    });
  }

  function removeProduct(product) {
    setCurrentItems((items) => items.filter((item) => item.sku !== product.sku));
  }

  function finishSale() {
    if (!currentItems.length) {
      onAction("sale");
      return;
    }
    onAction("sale", {
      items: currentItems.map((item) => ({ product: item.name, quantity: item.quantity })),
      product: currentItems[0].name,
      quantity: String(currentItems[0].quantity || 1),
      total,
    });
  }

  return (
    <div className="screen-grid">
      <div className="panel panel-section span-2">
        <Toolbar
          title="Venda balcao"
          description="Busca rapida, cliente avulso, desconto e pagamento misto."
          icon={ShoppingCart}
          action="Nova venda"
          onAction={() => onAction("sale")}
        />
        <div className="pos-layout">
          <div className="catalog-panel">
            <div className="compact-toolbar">
              <SearchBox placeholder="Buscar por SKU, nome ou codigo de barras" value={search} onChange={setSearch} />
              <button className="button-secondary" type="button" onClick={() => onAction("sale", { customer: "Cliente avulso" })}>Cliente avulso</button>
            </div>
            <div className="product-pick-grid">
              {filteredProducts.map((product) => (
                <button className="product-pick" key={product.sku} type="button" onClick={() => addProduct(product)}>
                  <strong>{product.name}</strong>
                  <span>{[product.sku, product.brand || "Sem marca", product.category].filter(Boolean).join(" - ")}</span>
                  <em>{product.price}</em>
                </button>
              ))}
              {!filteredProducts.length ? <div className="empty-state compact"><Search size={28} /><strong>Nenhum produto encontrado</strong><span>Revise a busca ou cadastre um item.</span></div> : null}
            </div>
          </div>
          <div className="checkout-panel sticky-panel">
            <h3>Venda atual</h3>
            {currentItems.map((product) => (
              <SaleLine key={product.sku} name={product.name} qty={String(product.quantity)} value={formatCurrency(parseMoney(product.price) * Number(product.quantity || 1))} onRemove={() => removeProduct(product)} />
            ))}
            {!currentItems.length ? (
              <div className="empty-state compact">
                <ShoppingCart size={28} />
                <strong>Nenhum item na venda</strong>
                <span>Selecione um produto ou inicie uma nova venda.</span>
              </div>
            ) : null}
            <SummaryLine label="Desconto" value="-R$ 0,00" />
            <div className="checkout-total">
              <span>Restante</span>
              <strong>{formatCurrency(total)}</strong>
            </div>
            <button className="button-primary button-full" type="button" onClick={finishSale}>
              <ReceiptText size={18} />
              Finalizar e imprimir
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function isoDateKey(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value).slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function dateKeyToLocalDate(key) {
  const [year, month, day] = String(key || "").split("-").map(Number);
  return year && month && day ? new Date(year, month - 1, day) : new Date();
}

function compareDateKeys(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function normalizeDateRange(start, end) {
  if (!start && !end) return { start: "", end: "" };
  if (!end) return { start, end: start };
  return compareDateKeys(start, end) <= 0 ? { start, end } : { start: end, end: start };
}

function paymentHasCustomerDueDate(payment) {
  return DUE_DATE_SALE_PAYMENTS.has(payment?.method);
}

function saleMatchesDateRange(sale, dateRange) {
  if (!dateRange.start) return true;
  const key = sale.dateKey || isoDateKey(sale.soldAt || sale.createdAt);
  if (!key) return false;
  const normalized = normalizeDateRange(dateRange.start, dateRange.end);
  return key >= normalized.start && key <= normalized.end;
}

function SalesDateRangeFilter({ dateRange, onChange }) {
  const todayKey = new Date().toISOString().slice(0, 10);
  const [visibleMonth, setVisibleMonth] = useState(() => dateKeyToLocalDate(dateRange.start || todayKey));
  const [hoveredDay, setHoveredDay] = useState("");
  const monthStart = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
  const firstGridDate = new Date(monthStart);
  firstGridDate.setDate(firstGridDate.getDate() - monthStart.getDay());
  const days = Array.from({ length: 42 }, (_item, index) => {
    const date = new Date(firstGridDate);
    date.setDate(firstGridDate.getDate() + index);
    return date;
  });
  const hasOpenRange = Boolean(dateRange.start && !dateRange.end);
  const previewRange = hasOpenRange && hoveredDay ? normalizeDateRange(dateRange.start, hoveredDay) : normalizeDateRange(dateRange.start, dateRange.end);
  const label = dateRange.start
    ? dateRange.end && dateRange.end !== dateRange.start
      ? `${formatShortDate(dateRange.start)} ate ${formatShortDate(dateRange.end)}`
      : formatShortDate(dateRange.start)
    : "Todos os dias";

  function selectDay(dayKey) {
    if (!dateRange.start || dateRange.end) {
      onChange({ start: dayKey, end: "" });
      return;
    }
    onChange(normalizeDateRange(dateRange.start, dayKey));
  }

  function shiftMonth(delta) {
    setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
    setHoveredDay("");
  }

  function applyQuickRange(kind) {
    const today = localDateKey();
    if (kind === "today") return onChange({ start: today, end: today });
    if (kind === "yesterday") {
      const yesterday = addDaysKey(today, -1);
      return onChange({ start: yesterday, end: yesterday });
    }
    if (kind === "week") return onChange({ start: addDaysKey(today, -6), end: today });
    if (kind === "month") {
      const date = dateKeyToLocalDate(today);
      const start = localDateKey(new Date(date.getFullYear(), date.getMonth(), 1));
      const end = localDateKey(new Date(date.getFullYear(), date.getMonth() + 1, 0));
      return onChange({ start, end });
    }
    return onChange({ start: "", end: "" });
  }

  return (
    <div className="sales-date-filter">
      <div className="sales-date-filter__head">
        <div>
          <strong>Periodo</strong>
          <span>{label}</span>
        </div>
        <button className="button-secondary" type="button" disabled={!dateRange.start} onClick={() => onChange({ start: "", end: "" })}>Limpar</button>
      </div>
      <div className="sales-date-filter__manual">
        <label>
          De
          <input type="date" value={dateRange.start || ""} onChange={(event) => onChange(normalizeDateRange(event.target.value, dateRange.end || event.target.value))} />
        </label>
        <label>
          Ate
          <input type="date" value={dateRange.end || dateRange.start || ""} onChange={(event) => onChange(normalizeDateRange(dateRange.start || event.target.value, event.target.value))} />
        </label>
      </div>
      <div className="sales-date-filter__quick">
        <button type="button" onClick={() => applyQuickRange("today")}>Hoje</button>
        <button type="button" onClick={() => applyQuickRange("yesterday")}>Ontem</button>
        <button type="button" onClick={() => applyQuickRange("week")}>7 dias</button>
        <button type="button" onClick={() => applyQuickRange("month")}>Mes</button>
      </div>
      <div className="sales-calendar">
        <div className="sales-calendar__nav">
          <button type="button" onClick={() => shiftMonth(-1)}>Anterior</button>
          <strong>{visibleMonth.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</strong>
          <button type="button" onClick={() => shiftMonth(1)}>Proximo</button>
        </div>
        <div className="sales-calendar__week">
          {["D", "S", "T", "Q", "Q", "S", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}
        </div>
        <div className="sales-calendar__grid" onMouseLeave={() => setHoveredDay("")}>
          {days.map((date) => {
            const key = localDateKey(date);
            const inMonth = date.getMonth() === visibleMonth.getMonth();
            const isStart = key === previewRange.start;
            const isEnd = key === previewRange.end;
            const inRange = previewRange.start && previewRange.end && key > previewRange.start && key < previewRange.end;
            return (
              <button
                className={[
                  !inMonth ? "muted" : "",
                  isStart || isEnd ? "selected" : "",
                  inRange ? "in-range" : "",
                ].filter(Boolean).join(" ")}
                key={key}
                type="button"
                onClick={() => selectDay(key)}
                onMouseEnter={() => setHoveredDay(key)}
              >
                {date.getDate()}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function saleOperationalStatus(sale) {
  if (normalizeFilterText(sale.status) === "cancelada" || sale.statusKey === "canceled") return "Cancelado";
  if (sale.statusKey === "finalized") return "Concluido";
  return "Em andamento";
}

function saleDeliverySummary(sale) {
  if (sale.statusKey === "canceled") return { label: "Cancelado", detail: sale.promisedDeliveryDate ? `Previsao ${formatShortDate(sale.promisedDeliveryDate)}` : "Pedido cancelado" };
  if (sale.statusKey === "finalized") {
    if (sale.paymentTiming === "delivery" || sale.deliveredAt) {
      return { label: "Entregue", detail: sale.deliveredAt ? formatShortDate(sale.deliveredAt) : "Pedido concluido" };
    }
    return { label: "Venda imediata", detail: "Concluida no PDV" };
  }
  if (sale.statusKey === "pending_delivery" && sale.fulfillmentReady) {
    return { label: "Pronto para retirada", detail: sale.promisedDeliveryDate ? `Previsao ${formatShortDate(sale.promisedDeliveryDate)}` : "Aguardando retirada" };
  }
  if (sale.statusKey === "pending_delivery") {
    return { label: "Em producao", detail: sale.promisedDeliveryDate ? `Previsao ${formatShortDate(sale.promisedDeliveryDate)}` : "Pedido em andamento" };
  }
  return { label: "Venda imediata", detail: sale.date || "" };
}

function saleFinancialSummary(sale, receivables) {
  if (sale.statusKey === "canceled" || normalizeFilterText(sale.status) === "cancelada") {
    return { label: "Cancelado", detail: "Financeiro encerrado pelo cancelamento", tone: "danger" };
  }
  const related = receivables.filter((item) => item.saleId === sale.recordId && item.status !== "Cancelado");
  const open = related.filter((item) => item.status !== "Pago" && Number(item.balanceAmount ?? parseMoney(item.value)) > 0.009);
  if (open.length) {
    const balance = open.reduce((sum, item) => sum + Number(item.balanceAmount ?? parseMoney(item.value)), 0);
    const overdueRows = open.filter((item) => item.isOverdue || item.status === "Vencido");
    const overdueBalance = overdueRows.reduce((sum, item) => sum + Number(item.balanceAmount ?? parseMoney(item.value)), 0);
    const futureBalance = Math.max(0, balance - overdueBalance);
    const partial = related.some((item) => Number(item.paidAmount || 0) > 0 || item.baseStatus === "Parcial" || item.status === "Parcial");
    if (overdueRows.length) {
      return {
        label: `${formatCurrency(overdueBalance)} vencidos`,
        detail: `${overdueRows.length} parcela${overdueRows.length === 1 ? "" : "s"} em atraso${futureBalance > 0.009 ? ` • ${formatCurrency(futureBalance)} a vencer` : ""}`,
        tone: "danger",
      };
    }
    return {
      label: `${formatCurrency(balance)} a receber`,
      detail: `${open.length} parcela${open.length === 1 ? "" : "s"} em aberto${partial ? " • pagamento parcial" : ""}`,
      tone: partial ? "warning" : "info",
    };
  }
  if (sale.paymentTiming === "delivery" && sale.statusKey === "pending_delivery") {
    return { label: `${sale.total} a receber`, detail: "Pagamento definido na retirada", tone: "info" };
  }
  return { label: "Pagamento concluido", detail: related.length ? `${related.length} parcela${related.length === 1 ? "" : "s"} quitada${related.length === 1 ? "" : "s"}` : sale.payment || "Pago", tone: "success" };
}

function saleFinancialStatus(sale, receivables) {
  const summary = saleFinancialSummary(sale, receivables);
  return <span className={`sale-financial-status sale-financial-status--${summary.tone || "info"}`}><strong>{summary.label}</strong><small>{summary.detail}</small></span>;
}

function OrderFinancialModal({ sale, receivables = [], onClose, onAction, onNavigate }) {
  const related = receivables.filter((item) => item.saleId === sale.recordId && item.status !== "Cancelado");
  const total = parseMoney(sale.total);
  const immediatePaid = (sale.payments || [])
    .filter((payment) => !DUE_DATE_SALE_PAYMENTS.has(payment.method))
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const receivablePaid = related.reduce((sum, item) => sum + Number(item.paidAmount || 0), 0);
  const openBalance = related.reduce((sum, item) => sum + (item.status === "Pago" ? 0 : Number(item.balanceAmount ?? parseMoney(item.value))), 0);
  const paidTotal = Math.min(total, immediatePaid + receivablePaid);
  const summary = saleFinancialSummary(sale, receivables);
  const saleSearch = String(sale.id || "").replace(/^#/, "");
  return <div className="sale-review-backdrop"><section className="sale-review order-financial-modal" role="dialog" aria-modal="true" aria-labelledby="order-financial-title">
    <header><div><h2 id="order-financial-title">Financeiro do pedido {sale.id}</h2><p>O pedido pode estar concluido e ainda manter parcelas futuras ou vencidas no Contas a receber.</p></div><button className="icon-button" type="button" aria-label="Fechar" onClick={onClose}><X size={18} /></button></header>
    <div className="order-financial-summary-grid">
      <div><span>Total</span><strong>{sale.total}</strong></div>
      <div><span>Recebido</span><strong>{formatCurrency(paidTotal)}</strong></div>
      <div><span>Saldo</span><strong>{sale.statusKey === "pending_delivery" && !related.length ? sale.total : formatCurrency(openBalance)}</strong></div>
      <div><span>Situacao</span><strong>{summary.label}</strong></div>
    </div>
    {related.length ? <div className="order-installments-list">
      <div className="order-installments-list__head"><strong>Parcelas</strong><span>{related.length} lancamento{related.length === 1 ? "" : "s"}</span></div>
      {related.map((row) => <div className="order-installment-row" key={row.id}>
        <div><strong>{row.installment !== "-" ? `Parcela ${row.installment}` : row.method}</strong><small>{row.due} • {row.method}</small></div>
        <div><strong>{row.balanceValue || row.value}</strong><StatusPill status={row.status} /></div>
        {!['Pago', 'Cancelado'].includes(row.status) ? <button className="table-action" type="button" onClick={() => onAction("receivableReceive", row)}>Receber</button> : null}
      </div>)}
    </div> : <div className="empty-state compact order-financial-empty"><WalletCards size={28} /><strong>Nenhuma parcela criada ainda</strong><span>{sale.statusKey === "pending_delivery" ? "O pagamento sera definido ao concluir o pedido." : "Nao ha recebiveis vinculados a este pedido."}</span></div>}
    <footer>
      <button className="button-secondary" type="button" onClick={onClose}>Fechar</button>
      {related.length && onNavigate ? <button className="button-primary" type="button" onClick={() => { onClose(); onNavigate("receivables", { tab: "agenda", filter: "Todos", search: saleSearch }); }}>Ver em Recebiveis</button> : null}
    </footer>
  </section></div>;
}

function secondarySaleActions({ sale, canceled, onAction, onDetail }) {
  const recordAction = canceled
    ? {
      label: "Excluir",
      tone: "danger",
      onClick: () => onAction("confirmAction", confirmRecordPayload({
        collection: "sales",
        record: sale,
        label: sale.id,
        actionKind: "delete",
        feedback: "Venda cancelada excluida.",
      })),
    }
    : {
      label: "Cancelar",
      tone: "warning",
      onClick: () => onAction("confirmAction", confirmRecordPayload({
        collection: "sales",
        record: sale,
        label: sale.id,
        nextStatus: "Cancelada",
        feedback: "Venda cancelada.",
      })),
    };
  return [
    { label: "Detalhes e historico", onClick: () => onDetail(sale) },
    ...(!canceled ? [{ label: "Editar", onClick: () => onAction("saleEdit", sale) }] : []),
    recordAction,
  ];
}

function addMonthsToDeliveryDate(value, months) {
  const dateKey = String(value || saleDefaultDueDate()).slice(0, 10);
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return saleDefaultDueDate();
  const targetMonthIndex = month - 1 + Number(months || 0);
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

function splitDeliveryInstallments(amount, installments) {
  const count = Math.max(1, Number.parseInt(installments || 1, 10) || 1);
  const cents = Math.max(0, Math.round(parseMoney(amount) * 100));
  const base = Math.floor(cents / count);
  const remainder = cents - base * count;
  return Array.from({ length: count }, (_item, index) => (base + (index < remainder ? 1 : 0)) / 100);
}

function buildDeliveryInstallmentSchedule(payment) {
  if (!DUE_DATE_SALE_PAYMENTS.has(payment.method)) return [];
  const count = Math.max(1, Number.parseInt(payment.installments || 1, 10) || 1);
  const firstDueDate = payment.dueDate || saleDefaultDueDate();
  return splitDeliveryInstallments(payment.amount, count).map((amount, index) => ({
    amount: formatMoneyInput(amount),
    dueDate: addMonthsToDeliveryDate(firstDueDate, index),
  }));
}

function deliveryScheduleDifference(payment) {
  if (!DUE_DATE_SALE_PAYMENTS.has(payment.method)) return 0;
  const schedule = Array.isArray(payment.installmentSchedule) ? payment.installmentSchedule : [];
  const scheduleTotal = schedule.reduce((sum, installment) => sum + parseMoney(installment.amount), 0);
  return Math.round((parseMoney(payment.amount) - scheduleTotal) * 100) / 100;
}

function DeliverySettlementModal({ sale, onClose, onSubmit }) {
  const initialPayment = {
    method: "pix",
    amount: sale.total,
    installments: "1",
    dueDate: "",
    installmentSchedule: [],
    redistributionAnchor: null,
  };
  const [payments, setPayments] = useState([initialPayment]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const total = parseMoney(sale.total);
  const paymentTotal = payments.reduce((sum, payment) => sum + parseMoney(payment.amount), 0);
  const paymentDifference = Math.round((total - paymentTotal) * 100) / 100;
  const remaining = Math.max(0, paymentDifference);
  const paymentMismatch = Math.abs(paymentDifference) > 0.009;
  const entryReceived = payments
    .filter((payment) => !DUE_DATE_SALE_PAYMENTS.has(payment.method))
    .reduce((sum, payment) => sum + parseMoney(payment.amount), 0);
  const financedBalance = payments
    .filter((payment) => DUE_DATE_SALE_PAYMENTS.has(payment.method))
    .reduce((sum, payment) => sum + parseMoney(payment.amount), 0);
  const conditionInstallments = payments.reduce((sum, payment) => {
    if (!INSTALLMENT_SALE_PAYMENTS.has(payment.method) && !DUE_DATE_SALE_PAYMENTS.has(payment.method)) return sum;
    return sum + Math.max(1, Number.parseInt(payment.installments || 1, 10) || 1);
  }, 0);
  const scheduleMismatch = payments.some((payment) => Math.abs(deliveryScheduleDifference(payment)) > 0.009);

  const update = (index, name, value) => setPayments((current) => current.map((payment, paymentIndex) => {
    if (paymentIndex !== index) return payment;
    let nextPayment;
    if (name === "method") {
      const needsDueDate = DUE_DATE_SALE_PAYMENTS.has(value);
      nextPayment = {
        ...payment,
        method: value,
        installments: INSTALLMENT_SALE_PAYMENTS.has(value) ? payment.installments || "1" : "1",
        dueDate: needsDueDate ? payment.dueDate || saleDefaultDueDate() : "",
        redistributionAnchor: null,
      };
    } else {
      nextPayment = { ...payment, [name]: value, redistributionAnchor: null };
    }
    if (["method", "amount", "installments", "dueDate"].includes(name)) {
      nextPayment.installmentSchedule = buildDeliveryInstallmentSchedule(nextPayment);
    }
    return nextPayment;
  }));

  const updateInstallment = (paymentIndex, installmentIndex, name, value) => setPayments((current) => current.map((payment, currentPaymentIndex) => {
    if (currentPaymentIndex !== paymentIndex) return payment;
    const schedule = Array.isArray(payment.installmentSchedule) && payment.installmentSchedule.length
      ? payment.installmentSchedule
      : buildDeliveryInstallmentSchedule(payment);
    return {
      ...payment,
      redistributionAnchor: name === "amount" ? installmentIndex : payment.redistributionAnchor,
      installmentSchedule: schedule.map((installment, currentInstallmentIndex) => currentInstallmentIndex === installmentIndex
        ? { ...installment, [name]: value }
        : installment),
    };
  }));

  const redistributePayment = (paymentIndex) => setPayments((current) => current.map((payment, currentPaymentIndex) => {
    if (currentPaymentIndex !== paymentIndex) return payment;
    const schedule = Array.isArray(payment.installmentSchedule) && payment.installmentSchedule.length
      ? payment.installmentSchedule
      : buildDeliveryInstallmentSchedule(payment);
    if (schedule.length <= 1) return { ...payment, installmentSchedule: buildDeliveryInstallmentSchedule(payment), redistributionAnchor: null };
    const anchor = Number.isInteger(payment.redistributionAnchor) ? payment.redistributionAnchor : null;
    if (anchor === null || anchor < 0 || anchor >= schedule.length) {
      return { ...payment, installmentSchedule: buildDeliveryInstallmentSchedule(payment), redistributionAnchor: null };
    }
    const targetCents = Math.round(parseMoney(payment.amount) * 100);
    const anchorCents = Math.round(parseMoney(schedule[anchor].amount) * 100);
    const remainingCents = targetCents - anchorCents;
    if (remainingCents < 0) return payment;
    const otherCount = schedule.length - 1;
    const base = Math.floor(remainingCents / otherCount);
    const remainderCents = remainingCents - base * otherCount;
    let otherIndex = 0;
    const nextSchedule = schedule.map((installment, installmentIndex) => {
      if (installmentIndex === anchor) return installment;
      const cents = base + (otherIndex < remainderCents ? 1 : 0);
      otherIndex += 1;
      return { ...installment, amount: formatMoneyInput(cents / 100) };
    });
    return { ...payment, installmentSchedule: nextSchedule };
  }));

  const addPayment = () => setPayments((current) => [...current, {
    method: "pix",
    amount: formatMoneyInput(Math.max(0, total - current.reduce((sum, payment) => sum + parseMoney(payment.amount), 0))),
    installments: "1",
    dueDate: "",
    installmentSchedule: [],
    redistributionAnchor: null,
  }]);
  const removePayment = (index) => setPayments((current) => current.filter((_payment, paymentIndex) => paymentIndex !== index));

  async function confirm() {
    setError("");
    const prepared = payments.map((payment) => ({
      method: payment.method,
      amount: parseMoney(payment.amount),
      installments: Math.max(1, Number(payment.installments || 1)),
      dueDate: payment.dueDate,
      dueDateSource: DUE_DATE_SALE_PAYMENTS.has(payment.method) ? (payment.dueDate ? "customer_agreement" : "automatic_30_days") : null,
      installmentSchedule: DUE_DATE_SALE_PAYMENTS.has(payment.method)
        ? (payment.installmentSchedule?.length ? payment.installmentSchedule : buildDeliveryInstallmentSchedule(payment)).map((installment) => ({
          amount: parseMoney(installment.amount),
          dueDate: installment.dueDate,
        }))
        : undefined,
    }));
    if (Math.abs(prepared.reduce((sum, payment) => sum + payment.amount, 0) - total) > 0.01) {
      setError("O total informado precisa ser igual ao valor do pedido.");
      return;
    }
    if (scheduleMismatch) {
      setError("Revise as parcelas: a soma das parcelas precisa ser igual ao saldo financiado.");
      return;
    }
    setSaving(true);
    try { await onSubmit("saleDelivery", { saleId: sale.recordId, payments: prepared }); onClose(); }
    catch (submitError) { setError(submitError?.message || "Nao foi possivel concluir a retirada."); }
    finally { setSaving(false); }
  }

  return <div className="sale-review-backdrop"><section className="sale-review delivery-settlement-modal" role="dialog" aria-modal="true" aria-labelledby="delivery-settlement-title">
    <header><div><h2 id="delivery-settlement-title">Concluir pedido</h2><p>Defina a entrada e, se houver, personalize as parcelas que continuarao no Contas a receber depois da entrega.</p></div><button className="icon-button" type="button" aria-label="Fechar" onClick={onClose}><X size={18} /></button></header>
    <div className="delivery-financial-summary" aria-label="Resumo financeiro da condicao">
      <div><span>Total</span><strong>{formatCurrency(total)}</strong></div>
      <div><span>Entrada recebida</span><strong>{formatCurrency(entryReceived)}</strong></div>
      <div><span>Saldo financiado</span><strong>{formatCurrency(financedBalance)}</strong></div>
      <div><span>Quantidade de parcelas</span><strong>{conditionInstallments || 0}</strong></div>
      <div><span>Total em aberto</span><strong>{formatCurrency(financedBalance)}</strong></div>
    </div>
    <div className="payment-heading"><h4>Pagamento e parcelas</h4><button className="button-link" type="button" onClick={addPayment}><Plus size={14} />Adicionar forma</button></div>
    <div className="mixed-payments">{payments.map((payment, index) => {
      const hasSchedule = DUE_DATE_SALE_PAYMENTS.has(payment.method);
      const schedule = hasSchedule
        ? (payment.installmentSchedule?.length ? payment.installmentSchedule : buildDeliveryInstallmentSchedule(payment))
        : [];
      const difference = deliveryScheduleDifference({ ...payment, installmentSchedule: schedule });
      return <div className="mixed-payment delivery-payment-card" key={`${index}-${payment.method}`}>
        <div className="mixed-payment__head"><strong>Pagamento {index + 1}</strong>{payments.length > 1 ? <button className="icon-button" type="button" aria-label="Remover forma de pagamento" onClick={() => removePayment(index)}><X size={14} /></button> : null}</div>
        <label className="field"><span>Forma</span><select value={payment.method} onChange={(event) => update(index, "method", event.target.value)}>{SALE_PAYMENT_METHODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label className="field"><span>Valor recebido ou financiado</span><input inputMode="decimal" value={payment.amount} onChange={(event) => update(index, "amount", event.target.value)} />{!payment.amount && remaining > 0.01 ? <small className="field-hint">Restante sugerido: {formatMoneyInput(remaining)}</small> : null}</label>
        {INSTALLMENT_SALE_PAYMENTS.has(payment.method) ? <label className="field"><span>Parcelas</span><input type="number" min="1" value={payment.installments} onChange={(event) => update(index, "installments", event.target.value)} />{!DUE_DATE_SALE_PAYMENTS.has(payment.method) && Number(payment.installments || 1) > 1 ? <small className="field-hint installment-preview-inline">Previa: {splitDeliveryInstallments(payment.amount, payment.installments).map((amount) => formatCurrency(amount)).join(" + ")}</small> : null}</label> : null}
        {DUE_DATE_SALE_PAYMENTS.has(payment.method) ? <label className="field"><span>Primeiro vencimento</span><input type="date" value={payment.dueDate} onChange={(event) => update(index, "dueDate", event.target.value)} /></label> : null}
        {hasSchedule ? <div className="delivery-installment-editor">
          <div className="delivery-installment-editor__head">
            <div><strong>Previa das parcelas</strong><small>{schedule.map((installment) => formatCurrency(parseMoney(installment.amount))).join(" + ")}</small></div>
            {Math.abs(difference) > 0.009 ? <button className="button-link" type="button" onClick={() => redistributePayment(index)}>Redistribuir automaticamente</button> : null}
          </div>
          <div className="delivery-installment-grid">
            {schedule.map((installment, installmentIndex) => <div className="delivery-installment-row" key={`${index}-${installmentIndex}`}>
              <strong>{installmentIndex + 1}/{schedule.length}</strong>
              <label className="field"><span>Valor</span><input inputMode="decimal" value={installment.amount} onChange={(event) => updateInstallment(index, installmentIndex, "amount", event.target.value)} /></label>
              <label className="field"><span>Vencimento</span><input type="date" value={installment.dueDate} onChange={(event) => updateInstallment(index, installmentIndex, "dueDate", event.target.value)} /></label>
            </div>)}
          </div>
          <div className={`delivery-installment-balance ${Math.abs(difference) < 0.009 ? "complete" : "warning"}`}>
            <span>{Math.abs(difference) < 0.009 ? "Parcelas conferidas" : difference > 0 ? "Saldo ainda nao distribuido" : "Parcelas acima do saldo financiado"}</span>
            <strong>{formatCurrency(Math.abs(difference))}</strong>
          </div>
        </div> : null}
      </div>;
    })}</div>
    <div className={`payment-balance ${!paymentMismatch && !scheduleMismatch ? "complete" : ""}`}><span>Total informado</span><strong>{formatCurrency(paymentTotal)}</strong><span>{paymentDifference > 0.009 ? "Falta informar" : paymentDifference < -0.009 ? "Valor acima do total" : scheduleMismatch ? "Revise as parcelas" : "Tudo certo"}</span><strong>{formatCurrency(Math.abs(paymentDifference))}</strong></div>
    {error ? <div className="inline-alert" role="alert"><AlertTriangle size={18} /><span>{error}</span></div> : null}
    <footer><button className="button-secondary" type="button" onClick={onClose}>Voltar</button><button className="button-primary" type="button" disabled={saving || scheduleMismatch || paymentMismatch} onClick={confirm}>{saving ? "Concluindo..." : "Concluir pedido"}</button></footer>
  </section></div>;
}

function SalesOrders({ sales, receivables = [], onAction, onDirectSubmit, onNavigate, runtimeData, initialFilter, initialDateRange }) {
  const [dateRange, setDateRange] = useState(initialDateRange?.start ? initialDateRange : { start: "", end: "" });
  useEffect(() => {
    if (initialDateRange?.start) setDateRange(initialDateRange);
  }, [initialDateRange?.start, initialDateRange?.end]);
  const [selectedSale, setSelectedSale] = useState(null);
  const [deliverySale, setDeliverySale] = useState(null);
  const [financialSale, setFinancialSale] = useState(null);
  const [markingReadyId, setMarkingReadyId] = useState(null);
  const saleFilters = ["Todos", "Em andamento", "Em producao", "Pronto para retirada", "Entrega atrasada", "A receber", "Vencidos", "Concluido", "Concluido hoje", "Cancelado"]
    .map((item) => ({ value: item, label: item }));
  const serverSales = Boolean(runtimeData?.lists?.sales?.pagination);
  const datedSales = useMemo(() => serverSales ? sales : sales.filter((sale) => saleMatchesDateRange(sale, dateRange)), [dateRange, sales, serverSales]);

  useEffect(() => {
    if (!serverSales || !runtimeData?.loadResource) return;
    const currentQuery = runtimeData.lists.sales?.query || {};
    const nextDateFrom = dateRange.start || "";
    const nextDateTo = dateRange.end || dateRange.start || "";
    const nextFilter = initialFilter || currentQuery.filter || "Todos";
    if ((currentQuery.dateFrom || "") === nextDateFrom && (currentQuery.dateTo || "") === nextDateTo && (currentQuery.filter || "Todos") === nextFilter) return;
    runtimeData.loadResource("sales", { ...currentQuery, filter: nextFilter, page: 1, dateFrom: nextDateFrom, dateTo: nextDateTo }, { silent: true });
  }, [dateRange.start, dateRange.end, initialFilter, serverSales]);

  async function markReady(sale) {
    const opticalOrderId = sale.workflowProgress?.entityId || sale.opticalOrderId;
    if (!opticalOrderId) return;
    setMarkingReadyId(sale.recordId);
    try {
      await onDirectSubmit("opticalMarkReady", { opticalOrderId });
    } finally {
      setMarkingReadyId(null);
    }
  }

  return (
    <div className="panel panel-section">
      <Toolbar title="Pedidos" description="O status do pedido e simples; entrega e financeiro seguem seus proprios ciclos." icon={ClipboardList} />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "sales", { dateFrom: dateRange.start || "", dateTo: dateRange.end || dateRange.start || "" })}
        actions={<SalesDateRangeFilter dateRange={dateRange} onChange={setDateRange} />}
        columns={["Pedido", "Data", "Cliente", "Itens", "Entrega", "Status", "Total", "Financeiro", "Acoes"]}
        emptyDescription="Ajuste a busca ou revise os filtros de pedido, entrega e financeiro."
        emptyTitle="Nenhum pedido encontrado"
        filters={saleFilters}
        initialFilter={initialFilter}
        filter={(sale, activeFilter) => {
          const finance = saleFinancialSummary(sale, receivables);
          const delivery = saleDeliverySummary(sale);
          return activeFilter === "Todos"
            || (activeFilter === "Entrega atrasada" && sale.statusKey === "pending_delivery" && sale.promisedDeliveryDate && sale.promisedDeliveryDate < localDateKey())
            || (activeFilter === "Concluido hoje" && sale.statusKey === "finalized" && sale.deliveredAt && isoDateKey(sale.deliveredAt) === localDateKey())
            || normalizeFilterText(saleOperationalStatus(sale)).includes(normalizeFilterText(activeFilter))
            || normalizeFilterText(delivery.label).includes(normalizeFilterText(activeFilter))
            || (activeFilter === "A receber" && normalizeFilterText(`${finance.label} ${finance.detail}`).includes("a receber"))
            || (activeFilter === "Vencidos" && normalizeFilterText(`${finance.label} ${finance.detail}`).includes("vencid"));
        }}
        getItemKey={(sale) => sale.id}
        items={datedSales}
        renderRow={(sale) => {
          const canceled = ["cancelada", "cancelado", "canceled"].includes(normalizeFilterText(sale.status)) || sale.statusKey === "canceled";
          const readyForDelivery = sale.statusKey === "pending_delivery" && sale.fulfillmentReady === true;
          const canMarkReady = sale.statusKey === "pending_delivery" && !readyForDelivery && Boolean(sale.workflowProgress?.entityId || sale.opticalOrderId);
          const delivery = saleDeliverySummary(sale);
          return (
            <tr key={sale.id}>
              <td><strong>{sale.id}</strong></td>
              <td className="entity-main-cell"><strong>{sale.date || "-"}</strong><small>{sale.createdAt ? `Lancada ${formatDateTime(sale.createdAt)}` : ""}</small></td>
              <td className="entity-main-cell"><strong>{sale.customer}</strong><small>{sale.customerDocument || "Cliente identificado"}</small></td>
              <td>{sale.items}</td>
              <td className="entity-main-cell"><strong>{delivery.label}</strong><small>{delivery.detail}</small></td>
              <td><StatusPill status={saleOperationalStatus(sale)} /></td>
              <td><strong>{sale.total}</strong></td>
              <td><button className="sale-financial-button" type="button" onClick={() => setFinancialSale(sale)}>{saleFinancialStatus(sale, receivables)}</button></td>
              <td>
                <span className="row-actions">
                  {canMarkReady ? <button className="table-action table-action--primary" type="button" disabled={markingReadyId === sale.recordId} onClick={() => markReady(sale)}>{markingReadyId === sale.recordId ? "Atualizando..." : "Marcar como pronto"}</button> : null}
                  {readyForDelivery ? <button className="table-action table-action--primary" type="button" onClick={() => setDeliverySale(sale)}>Concluir pedido</button> : null}
                  <MoreOptionsMenu compact items={secondarySaleActions({ sale, canceled, onAction, onDetail: setSelectedSale })} />
                </span>
              </td>
            </tr>
          );
        }}
        searchPlaceholder="Buscar por pedido, cliente, item, entrega, status ou financeiro"
        searchText={(sale) => {
          const finance = saleFinancialSummary(sale, receivables);
          const delivery = saleDeliverySummary(sale);
          return [sale.id, sale.date, sale.customer, sale.items, sale.promisedDeliveryDate, saleOperationalStatus(sale), delivery.label, delivery.detail, sale.total, finance.label, finance.detail].join(" ");
        }}
      />
      {selectedSale ? (
        <SaleDetailModal
          sale={selectedSale}
          receivables={receivables.filter((receivable) => receivable.saleId === selectedSale.recordId)}
          companyId={runtimeData?.draftScope?.companyId}
          onClose={() => setSelectedSale(null)}
        />
      ) : null}
      {deliverySale ? <DeliverySettlementModal sale={deliverySale} onClose={() => setDeliverySale(null)} onSubmit={onDirectSubmit} /> : null}
      {financialSale ? <OrderFinancialModal sale={financialSale} receivables={receivables} onClose={() => setFinancialSale(null)} onAction={onAction} onNavigate={onNavigate} /> : null}
    </div>
  );
}

function receivableDueDateSourceLabel(source) {
  const labels = {
    automatic_30_days: "Sugestao automatica de 30 dias",
    customer_agreement: "Data combinada com o cliente",
    administrative_correction: "Corrigido administrativamente",
    manual_entry: "Lancamento manual",
    legacy_unknown: "Origem nao registrada",
  };
  return labels[source] || labels.legacy_unknown;
}

function SaleDetailModal({ sale, receivables = [], companyId, onClose }) {
  const payments = Array.isArray(sale.payments) ? sale.payments : [];
  const items = Array.isArray(sale.itemRows) ? sale.itemRows : [];
  const [history, setHistory] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");

  useEffect(() => {
    let active = true;
    if (!companyId || !sale?.recordId) return undefined;
    setHistoryLoading(true);
    setHistoryError("");
    apiFetch(`/core/runtime/companies/${companyId}/sales/${sale.recordId}/history`)
      .then((payload) => { if (active) setHistory(payload.history || null); })
      .catch((error) => { if (active) setHistoryError(error.message || "Nao foi possivel carregar o historico do pedido."); })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [companyId, sale?.recordId]);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-shell sale-detail-modal" role="dialog" aria-modal="true" aria-labelledby="sale-detail-title">
        <header className="modal-header">
          <span className="card-icon"><ClipboardList size={23} /></span>
          <div>
            <h2 id="sale-detail-title">Detalhes da venda {sale.id}</h2>
            <p>{sale.date || "Data nao informada"} - {sale.status}</p>
          </div>
          <button className="icon-button" type="button" aria-label="Fechar" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="sale-detail-body">
          <section className="sale-detail-grid">
            <SummaryLine label="Cliente" value={sale.customer || "Cliente avulso"} />
            <SummaryLine label="Documento" value={sale.customerDocument || "-"} />
            <SummaryLine label="Telefone" value={sale.customerPhone || "-"} />
            <SummaryLine label="E-mail" value={sale.customerEmail || "-"} />
            <SummaryLine label="Venda realizada em" value={sale.soldAt ? formatDateTime(sale.soldAt) : sale.date || "-"} />
            <SummaryLine label="Lancada no sistema em" value={sale.createdAt ? formatDateTime(sale.createdAt) : "-"} />
          </section>

          <section className="sale-detail-section">
            <h3>Itens</h3>
            <div className="sale-detail-list">
              {items.length ? items.map((item, index) => (
                <div className="sale-detail-row" key={`${item.description}-${index}`}>
                  <span>
                    <strong>{item.description || "Item"}</strong>
                    <small>Qtd. {Number(item.quantity || 1)} - Unit. {formatCurrency(item.unitPrice || 0)}{Number(item.discount || 0) ? ` - Desc. ${formatCurrency(item.discount)}` : ""}</small>
                  </span>
                  <strong>{formatCurrency(item.total || 0)}</strong>
                </div>
              )) : <span className="muted-copy">{sale.items || "Nenhum item detalhado."}</span>}
            </div>
          </section>

          <section className="sale-detail-section">
            <h3>Pagamentos</h3>
            <div className="sale-detail-list">
              {payments.length ? payments.map((payment, index) => (
                <div className="sale-detail-row" key={`${payment.method}-${index}`}>
                  <span>
                    <strong>{paymentMethodLabel(payment.method)}</strong>
                    <small>
                      {[
                        payment.installments && Number(payment.installments) > 1 ? `${payment.installments} parcelas` : "",
                        paymentHasCustomerDueDate(payment) && payment.dueDate ? `Venc. ${formatShortDate(payment.dueDate)}` : "",
                        payment.checkNumber ? `Cheque ${payment.checkNumber}` : "",
                        payment.bank ? `Banco ${payment.bank}` : "",
                      ].filter(Boolean).join(" - ") || "Pagamento imediato"}
                    </small>
                  </span>
                  <strong>{formatCurrency(payment.amount || 0)}</strong>
                </div>
              )) : <span className="muted-copy">Nenhuma forma de pagamento detalhada.</span>}
            </div>
          </section>

          {receivables.length ? (
            <section className="sale-detail-section">
              <h3>Recebiveis vinculados</h3>
              <div className="sale-detail-list">
                {receivables.map((receivable) => {
                  const corrected = receivable.currentDueDateSource === "administrative_correction"
                    || (receivable.originalDueDate && receivable.dueDate && receivable.originalDueDate !== receivable.dueDate);
                  return (
                    <div className="sale-detail-row" key={receivable.id}>
                      <span>
                        <strong>{receivable.method} - {receivable.value}</strong>
                        <small>
                          {[
                            `Vencimento atual: ${formatShortDate(receivable.dueDate)}`,
                            corrected && receivable.originalDueDate ? `Original: ${formatShortDate(receivable.originalDueDate)}` : "",
                            receivableDueDateSourceLabel(receivable.currentDueDateSource || receivable.dueDateSource),
                          ].filter(Boolean).join(" - ")}
                        </small>
                        {corrected && receivable.lastDueDateCorrection?.reason ? (
                          <small>Motivo da correcao: {receivable.lastDueDateCorrection.reason}</small>
                        ) : null}
                      </span>
                      <StatusPill status={receivable.status} />
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          <section className="sale-detail-section order-history-section">
            <h3>Historico completo do pedido</h3>
            <p className="muted-copy">Venda, producao, reservas, estoque, recebimentos, parcelas e alteracoes administrativas em uma unica linha do tempo.</p>
            {history?.access && Object.values(history.access).some((allowed) => allowed === false) ? <div className="inline-alert"><AlertTriangle size={18} /><span>Historico parcial: eventos restritos pelas permissoes deste operador foram ocultados.</span></div> : null}
            {historyLoading ? <div className="order-history-loading">Carregando historico...</div> : null}
            {historyError ? <div className="inline-alert" role="alert"><AlertTriangle size={18} /><span>{historyError}</span></div> : null}
            {!historyLoading && !historyError ? <OrderHistoryTimeline events={history?.timeline || []} /> : null}
          </section>

          <section className="sale-detail-totals">
            <SummaryLine label="Subtotal" value={sale.subtotal || "-"} />
            <SummaryLine label="Desconto" value={sale.discount || "-"} />
            <SummaryLine label="Total" value={sale.total || "-"} />
          </section>
        </div>
        <footer className="modal-footer">
          <button className="button-secondary" type="button" onClick={onClose}>Fechar</button>
        </footer>
      </section>
    </div>
  );
}

function orderHistoryStatusLabel(status) {
  return ({
    pending_delivery: "Em andamento", finalized: "Concluido", canceled: "Cancelado",
    in_production: "Em producao", ready: "Pronto", delivered: "Entregue",
    open: "Aberto", partial: "Parcial", paid: "Pago", received: "Recebido",
    reserved: "Reservado", consumed: "Consumido", released: "Liberado", issued: "Emitido", reversed: "Estornado",
  })[String(status || "").toLowerCase()] || status || "";
}

function OrderHistoryTimeline({ events = [] }) {
  if (!events.length) return <EmptyContent icon={CalendarClock} title="Sem eventos adicionais" description="Os eventos do pedido aparecerao aqui conforme o fluxo for executado." />;
  return <div className="order-history-timeline">
    {events.map((event, index) => <div className="order-history-event" key={event.id || `${event.happenedAt}-${index}`}>
      <span className={`order-history-event__dot order-history-event__dot--${event.type || "audit"}`} />
      <div className="order-history-event__body">
        <div className="order-history-event__head">
          <div><strong>{event.title || "Evento"}</strong><small>{event.happenedAt ? formatDateTime(event.happenedAt) : "Data nao informada"}{event.actor ? ` • ${event.actor}` : ""}</small></div>
          {event.status ? <StatusPill status={orderHistoryStatusLabel(event.status)} /> : null}
        </div>
        <p>{event.detail || "Alteracao registrada."}</p>
      </div>
    </div>)}
  </div>;
}

function CustomersPage({ data, onAction, runtimeData, workspace }) {
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const selectedCustomer = (data.customers || []).find((customer) => String(customer.id) === String(selectedCustomerId));
  if (selectedCustomer) {
    return <CustomerDetailPage customer={selectedCustomer} data={data} onAction={onAction} onBack={() => setSelectedCustomerId("")} configuration={workspace?.configuration || {}} runtimeData={runtimeData} />;
  }
  return <CustomerList customers={data.customers} onAction={onAction} onOpenHistory={(customer) => setSelectedCustomerId(customer.id)} runtimeData={runtimeData} />;
}

function CustomerList({ customers, onAction, onOpenHistory, runtimeData }) {
  const customerFilters = ["Todos", "Ativos", "Inativos", "Com saldo"]
    .map((item) => ({ value: item, label: item }));

  return (
    <div className="panel panel-section">
      <Toolbar
        title="Base de clientes"
        description="Lista operacional para venda, contato e acompanhamento financeiro."
        icon={UsersRound}
        action="Novo cliente"
        onAction={() => onAction("customer")}
        secondaryActions={(
          <MoreOptionsMenu
            items={[
              { label: "Exportar clientes", onClick: () => exportCustomerRows(customers) },
              { label: "Baixar modelo de importacao", onClick: downloadCustomerTemplateXlsx },
              { label: "Importar clientes", onClick: () => onAction("spreadsheetImport", { entity: "customers" }) },
            ]}
          />
        )}
      />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "customers")}
        columns={["Cliente", "Documento", "Telefone", "E-mail", "Ultima compra", "Saldo", "Status", "Acoes"]}
        emptyDescription="Ajuste a busca, mude os filtros ou cadastre um novo cliente."
        emptyTitle="Nenhum cliente encontrado"
        filters={customerFilters}
        filter={(customer, activeFilter) => customerMatchesFilter(customer, activeFilter)}
        getItemKey={(customer) => customer.id || customer.document || customer.name}
        items={customers}
        renderRow={(customer) => (
          <tr
            key={customer.id || customer.document || customer.name}
          >
            <td className="entity-main-cell">
              <strong>{customer.name}</strong>
              {customer.phone ? <small>{customer.phone}</small> : null}
            </td>
            <td>{customer.document || "-"}</td>
            <td>{customer.phone || "-"}</td>
            <td>{customer.email || "-"}</td>
            <td>{customer.lastBuy || "Sem compras"}</td>
            <td><strong>{customer.balance || formatCurrency(0)}</strong></td>
            <td><StatusPill status={customer.status} /></td>
            <td>
              <span className="row-actions" onClick={(event) => event.stopPropagation()}>
                <button className="table-action" type="button" onClick={() => onOpenHistory(customer)}>Ver cliente</button>
                <button className="table-action" type="button" onClick={() => onAction("customer", editRecordPayload(customer))}>Editar ficha</button>
                <button className="table-action" type="button" onClick={() => onAction("receivable", { customer: customer.name })}>Recebivel</button>
                {isInactiveRecord(customer) ? (
                  <>
                    <button
                      className="table-action"
                      type="button"
                      onClick={() => onAction("confirmAction", confirmRecordPayload({
                        collection: "customers",
                        record: customer,
                        label: customer.name,
                        actionKind: "activate",
                        nextStatus: "Ativo",
                        feedback: "Cliente ativado.",
                      }))}
                    >
                      Ativar
                    </button>
                    <button
                      className="table-action table-action--danger"
                      type="button"
                      onClick={() => onAction("confirmAction", confirmRecordPayload({
                        collection: "customers",
                        record: customer,
                        label: customer.name,
                        actionKind: "delete",
                        feedback: "Cliente excluido.",
                      }))}
                    >
                      Excluir
                    </button>
                  </>
                ) : (
                  <button
                    className="table-action table-action--warning"
                    type="button"
                    onClick={() => onAction("confirmAction", confirmRecordPayload({
                      collection: "customers",
                      record: customer,
                      label: customer.name,
                      feedback: "Cliente desativado.",
                    }))}
                  >
                    Desativar
                  </button>
                )}
              </span>
            </td>
          </tr>
        )}
        searchPlaceholder="Buscar por nome, CPF/CNPJ, telefone, e-mail ou status"
        searchText={(customer) => [
          customer.name,
          customer.document,
          customer.phone,
          customer.email,
          customer.status,
        ].join(" ")}
      />
    </div>
  );
}

function customerMatchesRecord(customer, value, id) {
  if (id && customer.id && String(id) === String(customer.id)) return true;
  return normalizeFilterText(value) === normalizeFilterText(customer.name);
}

function customerSales(customer, data) {
  return (data.sales || [])
    .filter((sale) => customerMatchesRecord(customer, sale.customer, sale.customerId))
    .sort((a, b) => String(b.soldAt || b.createdAt || "").localeCompare(String(a.soldAt || a.createdAt || "")));
}

function customerReceivables(customer, data) {
  return (data.receivables || []).filter((item) => customerMatchesRecord(customer, item.customer, item.customerId));
}

function mapCustomerAccountSale(sale) {
  const items = Array.isArray(sale.items) ? sale.items : [];
  return {
    id: `#${sale.number}`,
    recordId: sale.id,
    customerId: sale.customerId || null,
    createdAt: sale.createdAt || sale.soldAt || "",
    soldAt: sale.soldAt || sale.createdAt || "",
    date: formatDateTime(sale.soldAt || sale.createdAt),
    items: items.map((item) => `${Number(item.quantity || 1)}x ${item.description || "Item"}`).join(", ") || "Itens da venda",
    itemRows: items,
    status: sale.status === "canceled" ? "Cancelada" : sale.status === "finalized" ? "Finalizada" : "Em andamento",
    statusKey: sale.status || "",
    total: formatCurrency(sale.total || 0),
    subtotal: formatCurrency(sale.subtotal || 0),
    discount: formatCurrency(sale.discountTotal || 0),
    payments: Array.isArray(sale.payments) ? sale.payments : [],
    paymentTiming: sale.paymentTiming || "immediate",
    promisedDeliveryDate: sale.promisedDeliveryDate || null,
    deliveredAt: sale.deliveredAt || null,
    notes: sale.notes || "",
  };
}

function CustomerDetailPage({ customer, data, onAction, onBack, configuration, runtimeData }) {
  const [tab, setTab] = useState("summary");
  const [account, setAccount] = useState(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [accountRevision, setAccountRevision] = useState(0);
  const localSales = customerSales(customer, data);
  const sales = account
    ? ((account.access?.sales === false ? [] : (account.sales || []).map(mapCustomerAccountSale)))
    : localSales;
  const receivables = customerReceivables(customer, data);
  const fallbackReceipts = (data.receipts || []).filter((receipt) => customerMatchesRecord(customer, receipt.customer, receipt.customerId));
  const receipts = account ? (account.receipts || []) : fallbackReceipts;
  const companyId = runtimeData?.draftScope?.companyId;

  useEffect(() => {
    let active = true;
    if (!companyId || !customer?.id) return undefined;
    setAccountLoading(true);
    setAccountError("");
    apiFetch(`/core/runtime/companies/${companyId}/customers/${customer.id}/account`)
      .then((payload) => { if (active) setAccount(payload.account || null); })
      .catch((error) => { if (active) setAccountError(error.message || "Nao foi possivel carregar a conta corrente do cliente."); })
      .finally(() => { if (active) setAccountLoading(false); });
    return () => { active = false; };
  }, [companyId, customer?.id, accountRevision]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const refreshAccount = () => setAccountRevision((value) => value + 1);
    window.addEventListener("volt:action-completed", refreshAccount);
    return () => window.removeEventListener("volt:action-completed", refreshAccount);
  }, []);

  const openBalance = account
    ? (account.summary?.openBalance ?? 0)
    : receivables
      .filter((item) => item.status !== "Pago" && item.status !== "Cancelado")
      .reduce((sum, item) => sum + parseMoney(item.value), 0);
  const totalPurchased = account
    ? (account.summary?.totalPurchased ?? 0)
    : sales.reduce((sum, sale) => sum + parseMoney(sale.total), 0);
  const extensionTabs = listExtensionSlots("customer.detail.tabs", configuration);
  const extensionActions = listExtensionSlots("customer.detail.actions", configuration);
  const tabs = [
    { id: "summary", label: "Resumo", icon: LayoutDashboard },
    { id: "purchases", label: "Compras", icon: ShoppingCart },
    { id: "finance", label: "Financeiro", icon: WalletCards },
    ...extensionTabs.map((item) => ({ id: item.id, label: item.label, icon: extensionIcon(item.icon) })),
    { id: "data", label: "Dados", icon: UsersRound },
  ];
  const activeExtensionTab = extensionTabs.find((item) => item.id === tab) || null;
  const extensionUi = { EmptyContent, HistoryRow, ReportCard, SummaryLine, Toolbar };

  return (
    <div className="customer-detail-page">
      <div className="panel panel-section customer-detail-header">
        <button className="button-secondary" type="button" onClick={onBack}>
          <ArrowRight size={17} style={{ transform: "rotate(180deg)" }} />
          Voltar para clientes
        </button>
        <div>
          <h2>{customer.name}</h2>
          <p>{[customer.phone, customer.document, customer.email].filter(Boolean).join(" - ") || "Cliente sem dados complementares."}</p>
        </div>
        <div className="customer-detail-actions">
          <button className="button-secondary" type="button" onClick={() => onAction("customer", editRecordPayload(customer))}>Editar ficha</button>
          {account?.access?.receivablesWrite === false ? null : <button className="button-secondary" type="button" onClick={() => onAction("receivable", { customer: customer.name, customerId: customer.id })}>Novo recebivel</button>}
          {extensionActions.map((action) => (
            <button className={action.style === "primary" ? "button-primary" : "button-secondary"} type="button" key={`${action.extensionKey}-${action.id}`} onClick={() => onAction(action.actionType, { customer: customer.name, customerId: customer.id })}>
              {action.label}
            </button>
          ))}
        </div>
      </div>

      <div className="customer-detail-tabs" role="tablist">
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <button className={tab === item.id ? "active" : ""} type="button" key={item.id} onClick={() => setTab(item.id)}>
              <Icon size={16} />
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === "summary" ? <CustomerDetailSummary customer={customer} openBalance={openBalance} sales={sales} totalPurchased={totalPurchased} account={account} accountLoading={accountLoading} configuration={configuration} data={data} /> : null}
      {tab === "purchases" ? <CustomerPurchases sales={sales} /> : null}
      {tab === "finance" ? <CustomerFinance customer={customer} account={account} accountLoading={accountLoading} accountError={accountError} fallbackReceivables={receivables} receipts={receipts} onAction={onAction} onRefresh={() => setAccountRevision((value) => value + 1)} /> : null}
      {activeExtensionTab ? (
        <ExtensionSlotHost
          extensionKey={activeExtensionTab.extensionKey}
          slot={activeExtensionTab.slot}
          contributionId={activeExtensionTab.id}
          configuration={configuration}
          componentProps={{ customer, data, onAction, ui: extensionUi }}
        />
      ) : null}
      {tab === "data" ? <CustomerData customer={customer} /> : null}
    </div>
  );
}

function CustomerDetailSummary({ customer, openBalance, sales, totalPurchased, account, accountLoading, configuration, data }) {
  const lastSale = sales[0];
  const accountSummary = account?.summary || {};
  const canSales = account?.access?.sales !== false;
  const canReceivables = account?.access?.receivables !== false;
  const canCash = account?.access?.cashRegister !== false;
  const summarySlots = listExtensionSlots("customer.summary.cards", configuration);
  const extensionUi = { ReportCard };
  const pendingCount = Number(accountSummary.pendingDeliveryCount || 0);
  const pendingDetail = pendingCount
    ? `${pendingCount} pedido${pendingCount === 1 ? "" : "s"} aguardando entrega`
    : "Recebiveis e pedidos pendentes";
  return (
    <div className="customer-detail-grid">
      <ReportCard icon={ShoppingCart} title="Total comprado" value={!canSales ? "Restrito" : formatCurrency(totalPurchased)} detail={!canSales ? "Sem permissao de vendas" : `${accountSummary.saleCount ?? sales.length} ${Number(accountSummary.saleCount ?? sales.length) === 1 ? "compra registrada" : "compras registradas"}`} />
      <ReportCard icon={CircleDollarSign} title="Total recebido" value={!canCash ? "Restrito" : accountLoading && !account ? "..." : formatCurrency(accountSummary.totalReceived || 0)} detail={!canCash ? "Sem permissao de caixa" : accountSummary.lastPaymentAt ? `Ultimo pagamento ${formatShortDate(accountSummary.lastPaymentAt)}` : "Recebimentos confirmados"} />
      <ReportCard icon={WalletCards} title="A receber" value={!canSales && !canReceivables ? "Restrito" : formatCurrency(openBalance)} detail={!canSales && !canReceivables ? "Sem permissao financeira" : accountSummary.pendingDeliveryBalance > 0 && canSales ? `${formatCurrency(accountSummary.pendingDeliveryBalance)} aguardando entrega • ${pendingDetail}${!canReceivables ? " • parcelas restritas" : ""}` : `${pendingDetail}${!canSales || !canReceivables ? " • visao parcial" : ""}`} />
      <ReportCard icon={AlertTriangle} title="Vencido" value={!canReceivables ? "Restrito" : formatCurrency(accountSummary.overdueBalance || 0)} detail={!canReceivables ? "Sem permissao de recebiveis" : `${Number(accountSummary.overdueCount || 0)} parcela${Number(accountSummary.overdueCount || 0) === 1 ? "" : "s"} em atraso`} />
      <ReportCard icon={CalendarClock} title="Ultima compra" value={!canSales ? "Restrito" : accountSummary.lastPurchaseAt ? formatShortDate(accountSummary.lastPurchaseAt) : lastSale?.date || customer.lastBuy || "Sem compras"} detail={canReceivables && accountSummary.nextDueDate ? `Proximo vencimento ${formatShortDate(accountSummary.nextDueDate)}` : lastSale?.items || "Nenhuma venda registrada"} />
      {summarySlots.map((slot) => (
        <ExtensionSlotHost key={`${slot.extensionKey}-${slot.id}`} extensionKey={slot.extensionKey} slot={slot.slot} contributionId={slot.id} configuration={configuration} componentProps={{ customer, data, ui: extensionUi }} />
      ))}
      <section className="panel panel-section span-2">
        <SectionTitle icon={ClockTimelineIcon} title="Linha do tempo" description="Eventos recentes do cliente, em ordem decrescente e conforme as permissoes do operador." />
        <div className="customer-timeline">
          {(account?.timeline || []).slice(0, 8).map((event) => <CustomerAccountTimelineRow key={event.id} event={event} />)}
          {!account?.timeline?.length && sales.slice(0, 6).map((sale) => <HistoryRow key={sale.recordId || sale.id} title={`${sale.id} - ${sale.date || "Venda"}`} detail={sale.items} meta={sale.total} status={sale.status} />)}
          {!account?.timeline?.length && !sales.length ? <EmptyContent icon={ShoppingCart} title="Sem eventos comerciais" description="Compras, pagamentos e pedidos aparecerao aqui quando houver acesso e movimentacao." /> : null}
        </div>
      </section>
    </div>
  );
}

function ClockTimelineIcon(props) {
  return <CalendarClock {...props} />;
}

function CustomerPurchases({ sales }) {
  return (
    <div className="panel panel-section">
      <Toolbar title="Compras do cliente" description="Uma linha por item vendido, agrupada pela venda e sempre do mais recente para o mais antigo." icon={ShoppingCart} />
      <div className="customer-purchase-list">
        {sales.map((sale) => (
          <article className="customer-purchase-card" key={sale.recordId || sale.id}>
            <header>
              <span>
                <strong>{sale.id}</strong>
                <small>{sale.date || "Data nao informada"}</small>
              </span>
              <span>
                <strong>{sale.total}</strong>
                <StatusPill status={sale.status} />
              </span>
            </header>
            <div className="customer-purchase-payments">
              {(sale.payments || []).map((payment, index) => (
                <span key={`${payment.method}-${index}`}>
                  {paymentMethodLabel(payment.method)} - {formatCurrency(payment.amount || 0)}
                  {paymentHasCustomerDueDate(payment) && payment.dueDate ? ` - venc. ${formatShortDate(payment.dueDate)}` : ""}
                </span>
              ))}
              {!sale.payments?.length ? <span>{sale.payment || "Pagamento nao informado"}</span> : null}
            </div>
            <div className="customer-purchase-items">
              {(sale.itemRows || []).map((item, index) => (
                <div className="customer-purchase-item" key={`${sale.id}-${item.description}-${index}`}>
                  <span>
                    <strong>{item.description || "Item"}</strong>
                    <small>Qtd. {Number(item.quantity || 1)} - Unit. {formatCurrency(item.unitPrice || 0)}{Number(item.discount || 0) ? ` - Desc. ${formatCurrency(item.discount)}` : ""}</small>
                  </span>
                  <strong>{formatCurrency(item.total || 0)}</strong>
                </div>
              ))}
            </div>
          </article>
        ))}
        {!sales.length ? <EmptyContent icon={ShoppingCart} title="Sem compras" description="As compras deste cliente aparecerao aqui." /> : null}
      </div>
    </div>
  );
}

function customerAccountStatusLabel(status) {
  return ({ open: "Aberto", overdue: "Vencido", partial: "Parcial", paid: "Pago", canceled: "Cancelado", received: "Recebido", reversed: "Estornado", pending_delivery: "Em andamento", finalized: "Concluido" })[String(status || "").toLowerCase()] || status || "-";
}

function CustomerAccountTimelineRow({ event }) {
  const amount = Number(event.amount || 0);
  return <div className="customer-account-timeline-row">
    <div>
      <strong>{event.title || "Movimento"}</strong>
      <small>{event.happenedAt ? formatDateTime(event.happenedAt) : "-"}{event.detail ? ` • ${event.detail}` : ""}{event.actor ? ` • ${event.actor}` : ""}</small>
    </div>
    <div className="customer-account-timeline-row__meta">
      {Math.abs(amount) > 0.009 ? <strong className={amount < 0 ? "negative" : ""}>{amount < 0 ? "-" : ""}{formatCurrency(Math.abs(amount))}</strong> : null}
      {event.status ? <StatusPill status={customerAccountStatusLabel(event.status)} /> : null}
    </div>
  </div>;
}

function customerAccountReceivableActionRow(customer, row) {
  const balance = Number(row.balanceAmount ?? (Number(row.amount || 0) - Number(row.paidAmount || 0)));
  return {
    id: row.id,
    customerId: customer.id,
    customer: customer.name,
    saleId: row.saleId || null,
    saleNumber: row.saleNumber || null,
    methodKey: row.type,
    method: paymentMethodLabel(row.type),
    dueDate: String(row.dueDate || "").slice(0, 10),
    due: formatShortDate(row.dueDate),
    amount: Number(row.amount || 0),
    paidAmount: Number(row.paidAmount || 0),
    balanceAmount: balance,
    originalValue: formatCurrency(row.amount || 0),
    paidValue: formatCurrency(row.paidAmount || 0),
    balanceValue: formatCurrency(balance),
    value: formatCurrency(balance),
    installment: row.installment || "-",
    status: customerAccountStatusLabel(row.displayStatus || row.status),
    metadata: row.metadata || {},
  };
}

function CustomerFinance({ customer, account, accountLoading, accountError, fallbackReceivables = [], receipts = [], onAction, onRefresh }) {
  const summary = account?.summary || {};
  const canSales = account?.access?.sales !== false;
  const canReceivables = account?.access?.receivables !== false;
  const canReceivablesWrite = account?.access?.receivablesWrite !== false;
  const canCash = account?.access?.cashRegister !== false;
  const canReceipts = account?.access?.receipts !== false;
  const receivables = account ? (account.receivables || []) : fallbackReceivables;
  const openReceivables = canReceivables
    ? receivables.filter((row) => !["paid", "received", "compensated", "canceled", "Pago", "Cancelado"].includes(String(row.displayStatus || row.status)))
    : [];
  const pendingDeliveryCount = Number(summary.pendingDeliveryCount || 0);
  const pendingParts = [
    canReceivables ? `${Number(summary.openCount || 0)} parcela${Number(summary.openCount || 0) === 1 ? "" : "s"}` : "",
    canSales && pendingDeliveryCount ? `${pendingDeliveryCount} pedido${pendingDeliveryCount === 1 ? "" : "s"} aguardando entrega` : "",
  ].filter(Boolean);
  const partialAccess = account && ["sales", "receivables", "cashRegister", "receipts"].some((key) => account.access?.[key] === false);

  return <div className="customer-account-page">
    <div className="customer-account-toolbar">
      <div><h3>Conta corrente</h3><p>Compras, valores recebidos, saldo, vencimentos e movimentacoes financeiras do cliente.</p></div>
      <button className="button-secondary" type="button" onClick={onRefresh} disabled={accountLoading}>{accountLoading ? "Atualizando..." : "Atualizar"}</button>
    </div>
    {accountError ? <div className="inline-alert" role="alert"><AlertTriangle size={18} /><span>{accountError}</span></div> : null}
    {partialAccess ? <div className="inline-alert"><AlertTriangle size={18} /><span>Visao parcial: alguns dados foram ocultados conforme as permissoes deste operador.</span></div> : null}
    <div className="customer-account-kpis">
      <ReportCard icon={ShoppingCart} title="Compras" value={!canSales ? "Restrito" : formatCurrency(summary.totalPurchased || 0)} detail={!canSales ? "Sem permissao de vendas" : `${Number(summary.saleCount || 0)} pedido${Number(summary.saleCount || 0) === 1 ? "" : "s"}`} />
      <ReportCard icon={CircleDollarSign} title="Recebido" value={!canCash ? "Restrito" : formatCurrency(summary.totalReceived || 0)} detail={!canCash ? "Sem permissao de caixa" : summary.lastPaymentAt ? `Ultimo em ${formatShortDate(summary.lastPaymentAt)}` : "Sem recebimentos"} />
      <ReportCard icon={WalletCards} title="A receber" value={!canSales && !canReceivables ? "Restrito" : formatCurrency(summary.openBalance || 0)} detail={!canSales && !canReceivables ? "Sem permissao financeira" : `${pendingParts.join(" • ") || "Sem saldo em aberto"}${!canSales || !canReceivables ? " • visao parcial" : ""}`} />
      <ReportCard icon={AlertTriangle} title="Vencido" value={!canReceivables ? "Restrito" : formatCurrency(summary.overdueBalance || 0)} detail={!canReceivables ? "Sem permissao de recebiveis" : `${Number(summary.overdueCount || 0)} parcela${Number(summary.overdueCount || 0) === 1 ? "" : "s"} em atraso`} />
    </div>
    <div className="customer-account-meta">
      <SummaryLine label="Ultima compra" value={!canSales ? "Restrito" : summary.lastPurchaseAt ? formatDateTime(summary.lastPurchaseAt) : "Sem compras"} />
      <SummaryLine label="Ultimo pagamento" value={!canCash ? "Restrito" : summary.lastPaymentAt ? formatDateTime(summary.lastPaymentAt) : "Sem pagamentos"} />
      <SummaryLine label="Proximo vencimento" value={!canReceivables ? "Restrito" : summary.nextDueDate ? formatShortDate(summary.nextDueDate) : "Nenhum"} />
      <SummaryLine label="Aguardando entrega" value={!canSales ? "Restrito" : `${formatCurrency(summary.pendingDeliveryBalance || 0)}${pendingDeliveryCount ? ` • ${pendingDeliveryCount} pedido${pendingDeliveryCount === 1 ? "" : "s"}` : ""}`} />
    </div>
    <div className="customer-account-grid">
      <section className="panel panel-section">
        <Toolbar title="Parcelas e recebiveis" description="Baixe cada parcela pela acao Receber; o status vencido e calculado automaticamente." icon={WalletCards} />
        <div className="customer-account-receivables">
          {openReceivables.map((row) => {
            const actionRow = customerAccountReceivableActionRow(customer, row);
            return <div className="customer-account-receivable" key={row.id}>
              <div><strong>{row.saleNumber ? `Pedido #${row.saleNumber}` : row.description || "Recebivel"}{row.installment ? ` • Parcela ${row.installment}` : ""}</strong><small>{paymentMethodLabel(row.type || row.methodKey)} • venc. {formatShortDate(row.dueDate || row.due)}</small></div>
              <div><strong>{formatCurrency(actionRow.balanceAmount)}</strong><StatusPill status={actionRow.status} /></div>
              {canReceivablesWrite ? <button className="table-action" type="button" onClick={() => onAction("receivableReceive", actionRow)}>Receber</button> : null}
            </div>;
          })}
          {!canReceivables ? <EmptyContent icon={WalletCards} title="Recebiveis restritos" description="Este operador nao possui permissao para visualizar parcelas." /> : null}
          {canReceivables && !openReceivables.length ? <EmptyContent icon={CheckCircle2} title="Sem parcelas pendentes" description="Nao ha saldo financeiro em aberto para este cliente." /> : null}
        </div>
      </section>
      <section className="panel panel-section">
        <Toolbar title="Movimentacao da conta" description="Historico consolidado de compras, parcelas, recebimentos e estornos conforme suas permissoes." icon={CalendarClock} />
        <div className="customer-account-timeline">
          {(account?.timeline || []).map((event) => <CustomerAccountTimelineRow key={event.id} event={event} />)}
          {!account?.timeline?.length ? <EmptyContent icon={CalendarClock} title="Sem movimentacoes visiveis" description="Nao ha movimentacoes para exibir ou parte do historico esta restrita pelas permissoes." /> : null}
        </div>
      </section>
    </div>
    {canReceipts && receipts.length ? <section className="panel panel-section customer-account-receipts"><Toolbar title="Recibos" description="Comprovantes emitidos para o cliente." icon={ReceiptText} /><div className="customer-detail-list">{receipts.map((item) => <HistoryRow key={item.id} title={item.id} detail={item.sale || "Recibo"} meta={typeof item.total === "number" ? formatCurrency(item.total) : item.total} status={item.status} />)}</div></section> : null}
  </div>;
}



function CustomerData({ customer }) {
  return (
    <div className="panel panel-section">
      <Toolbar title="Dados cadastrais" description="Ficha operacional do cliente." icon={UsersRound} />
      <div className="customer-data-grid">
        <SummaryLine label="Nome" value={customer.name || "-"} />
        <SummaryLine label="Telefone" value={customer.phone || "-"} />
        <SummaryLine label="Documento" value={customer.document || "-"} />
        <SummaryLine label="E-mail" value={customer.email || "-"} />
        <SummaryLine label="Segmento" value={customer.segment || "-"} />
        <SummaryLine label="Status" value={customer.status || "-"} />
      </div>
    </div>
  );
}

function CustomerHistoryModal({ data, modal, onAction, onClose, workspace }) {
  const payload = modal.payload || {};
  const configuration = workspace?.configuration || {};
  const customer = (data.customers || []).find((item) => String(item.id) === String(payload.customerId))
    || (data.customers || []).find((item) => normalizeFilterText(item.name) === normalizeFilterText(payload.customerName))
    || { id: payload.customerId, name: payload.customerName || "Cliente" };
  const matchesCustomer = (value, id) => {
    if (id && customer.id && String(id) === String(customer.id)) return true;
    return normalizeFilterText(value) === normalizeFilterText(customer.name);
  };
  const sales = (data.sales || []).filter((sale) => matchesCustomer(sale.customer, sale.customerId));
  const receivables = (data.receivables || []).filter((item) => matchesCustomer(item.customer, item.customerId));
  const receipts = (data.receipts || []).filter((receipt) => matchesCustomer(receipt.customer, receipt.customerId));
  const openReceivables = receivables.filter((item) => item.status !== "Pago" && item.status !== "Cancelado");
  const extensionActions = listExtensionSlots("customer.detail.actions", configuration);
  const historySlots = listExtensionSlots("customer.history.sections", configuration);
  const extensionUi = { EmptyContent, HistoryRow, SummaryLine };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-shell customer-history-modal" role="dialog" aria-modal="true" aria-labelledby="customer-history-title">
        <header className="modal-header">
          <span className="card-icon"><UsersRound size={23} /></span>
          <div>
            <h2 id="customer-history-title">Historico do cliente</h2>
            <p>{customer.name} - compras, atendimento e financeiro.</p>
          </div>
          <button className="icon-button" type="button" aria-label="Fechar" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="customer-history-summary">
          <SummaryLine label="Telefone" value={customer.phone || "-"} />
          <SummaryLine label="Documento" value={customer.document || "-"} />
          <SummaryLine label="Ultima compra" value={customer.lastBuy || "Sem compras"} />
          <SummaryLine label="Saldo em aberto" value={customer.balance || formatCurrency(0)} />
        </div>

        <div className="customer-history-actions">
          <button className="button-secondary" type="button" onClick={() => onAction("customer", editRecordPayload(customer))}>Editar cliente</button>
          <button className="button-secondary" type="button" onClick={() => onAction("receivable", { customer: customer.name, customerId: customer.id })}>Novo recebivel</button>
          {extensionActions.map((action) => <button className="button-secondary" type="button" key={`${action.extensionKey}-${action.id}`} onClick={() => onAction(action.actionType, { customer: customer.name, customerId: customer.id })}>{action.label}</button>)}
        </div>

        <div className="customer-history-grid">
          <section className="customer-history-card">
            <h3>Compras</h3>
            {sales.slice(0, 5).map((sale) => <HistoryRow key={sale.recordId || sale.id} title={sale.id} detail={sale.items || sale.payment} meta={sale.total} status={sale.status} />)}
            {!sales.length ? <EmptyContent icon={ShoppingCart} title="Sem compras" description="As vendas finalizadas deste cliente aparecerao aqui." /> : null}
          </section>

          {historySlots.map((slot) => (
            <ExtensionSlotHost key={`${slot.extensionKey}-${slot.id}`} extensionKey={slot.extensionKey} slot={slot.slot} contributionId={slot.id} configuration={configuration} componentProps={{ customer, data, ui: extensionUi }} />
          ))}

          <section className="customer-history-card">
            <h3>Financeiro e recibos</h3>
            {openReceivables.slice(0, 4).map((item) => <HistoryRow key={item.id} title={item.origin || "Recebivel"} detail={item.due || "Sem vencimento"} meta={item.value} status={item.status} />)}
            {receipts.slice(0, 3).map((receipt) => <HistoryRow key={receipt.id} title={receipt.id} detail={receipt.sale || "Recibo"} meta={receipt.total} status={receipt.status} />)}
            {!openReceivables.length && !receipts.length ? <EmptyContent icon={WalletCards} title="Sem financeiro vinculado" description="Recebiveis e recibos deste cliente aparecerao aqui." /> : null}
          </section>
        </div>
      </section>
    </div>
  );
}

function HistoryRow({ title, detail, meta, status }) {
  return (
    <div className="history-row">
      <div>
        <strong>{title}</strong>
        <small>{detail || "-"}</small>
      </div>
      <span>{meta || "-"}</span>
      {status ? <StatusPill status={status} /> : null}
    </div>
  );
}

function exportCustomerRows(customers) {
  downloadRowsXlsx("clientes-volt-core.xlsx", customers, [
    { key: "name", label: "nome" },
    { key: "document", label: "documento" },
    { key: "phone", label: "telefone" },
    { key: "email", label: "email" },
    { key: "segment", label: "segmento" },
    { key: "status", label: "status" },
    { key: "balance", label: "saldo" },
  ], "Clientes");
}

function customerListKey(customer) {
  return String(customer?.id || customer?.document || customer?.name || "");
}

function customerMatchesFilter(customer, activeFilter) {
  if (activeFilter === "Todos") return true;
  if (activeFilter === "Ativos") return !isInactiveRecord(customer);
  if (activeFilter === "Inativos") return isInactiveRecord(customer);
  if (activeFilter === "Com saldo") return parseMoney(customer.balance) > 0;
  return true;
}

function isInactiveRecord(record) {
  return record?.active === false || normalizeFilterText(record?.status) === "inativo";
}

function normalizeFilterText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function ProductsPage({ data, onAction, workspace, runtimeData }) {
  return (
    <ModulePage
      tabs={[
        { id: "catalog", label: "Produtos e servicos", icon: PackagePlus, content: <ProductCatalog categories={data.productCategories || []} products={data.products} onAction={onAction} runtimeData={runtimeData} configuration={workspace?.configuration || {}} /> },
        { id: "categories", label: "Categorias", icon: SlidersHorizontal, content: <ProductCategories categories={data.productCategories || []} onAction={onAction} /> },
        { id: "brands", label: "Marcas", icon: Store, content: <ProductBrands brands={data.productBrands || []} onAction={onAction} /> },
        { id: "pricing", label: "Precos", icon: BadgeDollarSign, content: <ProductPricing products={data.products} onAction={onAction} runtimeData={runtimeData} /> },
      ]}
    />
  );
}

function ProductCatalog({ categories, products, onAction, runtimeData, configuration }) {
  const typeFilters = ["Todos", "Ativos", "Inativos", ...extensionProductFilters(configuration), "Servico", "Estoque baixo"]
    .map((item) => ({ value: item, label: item }));

  return (
    <div className="panel panel-section">
      <Toolbar
        title="Catalogo de produtos e servicos"
        description="Lista operacional para PDV, estoque e servicos."
        icon={PackagePlus}
        action="Novo item"
        onAction={() => onAction("product")}
        secondaryActions={(
          <MoreOptionsMenu
            items={[
              { label: "Exportar produtos", onClick: () => exportProductRows(products) },
              { label: "Baixar modelo de importacao", onClick: () => downloadProductImportTemplate(categories, configuration) },
              { label: "Importar produtos", onClick: () => onAction("spreadsheetImport", { entity: "products", extensionSchema: extensionProductImportSchema(configuration) }) },
            ]}
          />
        )}
      />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "products")}
        columns={["Tipo", "Nome", "SKU", "EAN", "Categoria", "Marca", "Estoque", "Preco", "Status", "Acoes"]}
        emptyDescription="Ajuste a busca, mude os filtros ou cadastre um novo item."
        emptyTitle="Nenhum item encontrado"
        filters={typeFilters}
        filter={(product, activeFilter) => {
          const productType = productCatalogType(product);
          return activeFilter === "Todos"
            || (activeFilter === "Ativos" && !isInactiveRecord(product))
            || (activeFilter === "Inativos" && isInactiveRecord(product))
            || productType === activeFilter
            || (activeFilter === "Estoque baixo" && productHasLowStock(product));
        }}
        getItemKey={(product) => product.id || product.sku || product.name}
        items={products}
        renderRow={(product) => (
          <tr key={product.id || product.sku || product.name}>
            <td><span className="catalog-type">{productCatalogType(product)}</span></td>
            <td>
              <strong>{product.name}</strong>
              <small>{product.type === "Servico" ? "Nao movimenta estoque" : "Controla venda e estoque"}</small>
            </td>
            <td>{product.sku || "-"}</td>
            <td>{product.ean || "-"}</td>
            <td>{product.category || "-"}</td>
            <td>{product.brand || "-"}</td>
            <td>{productStockLabel(product)}</td>
            <td><strong>{product.price}</strong></td>
            <td><StatusPill status={product.status} /></td>
            <td>
              <RowActions
                onEdit={() => onAction("product", editRecordPayload(product))}
                onDeactivate={isInactiveRecord(product)
                  ? () => onAction("confirmAction", confirmRecordPayload({
                    collection: "products",
                    record: product,
                    label: product.name,
                    actionKind: "activate",
                    nextStatus: "Ativo",
                    feedback: "Produto ativado.",
                  }))
                  : () => onAction("confirmAction", confirmRecordPayload({
                    collection: "products",
                    record: product,
                    label: product.name,
                    feedback: "Produto desativado.",
                  }))}
                onDelete={isInactiveRecord(product) ? () => onAction("confirmAction", confirmRecordPayload({
                  collection: "products",
                  record: product,
                  label: product.name,
                  actionKind: "delete",
                  feedback: "Produto excluido.",
                })) : undefined}
                deactivateLabel={isInactiveRecord(product) ? "Ativar" : "Desativar"}
              />
            </td>
          </tr>
        )}
        searchPlaceholder="Buscar por nome, SKU, EAN, marca, categoria ou tipo"
        searchText={(product) => [
          product.name,
          product.sku,
          product.ean,
          product.brand,
          product.category,
          product.status,
          productCatalogType(product),
        ].join(" ")}
      />
    </div>
  );
}

function exportProductRows(products) {
  downloadRowsXlsx("produtos-volt-core.xlsx", products, [
    { key: "name", label: "name" },
    { key: "sku", label: "sku" },
    { key: "ean", label: "ean" },
    { key: "type", label: "type" },
    { key: "category", label: "category" },
    { key: "brand", label: "brand" },
    { key: "stock", label: "stock" },
    { key: "min", label: "min" },
    { key: "cost", label: "cost" },
    { key: "price", label: "price" },
    { key: "status", label: "status" },
  ], "Produtos");
}

function downloadProductImportTemplate(categories = [], configuration = {}) {
  const categoryNames = categories.map((category) => category.name || category).filter(Boolean);
  downloadProductTemplateXlsx(categoryNames, extensionProductImportSchema(configuration));
}

function productCatalogType(product) {
  if (product.catalogType) return product.catalogType;
  if (product.type === "Servico") return "Servico";
  return "Produto";
}

function productControlsStock(product) {
  return product.type !== "Servico" && product.stock !== "-" && product.status !== "Servico";
}

function productHasLowStock(product) {
  if (!productControlsStock(product)) return false;
  return Number(product.stock || 0) < Number(product.min || 0);
}

function productStockLabel(product) {
  if (!productControlsStock(product)) return "Nao controla";
  return `${product.stock ?? 0} / min. ${product.min ?? 0}`;
}

function ProductCategories({ categories, onAction }) {
  return (
    <DataPanel
      title="Categorias de produtos"
      icon={SlidersHorizontal}
      columns={["Categoria", "Descricao", "Status", "Acao"]}
      action="Nova categoria"
      onAction={() => onAction("productCategory")}
    >
      {categories.map((category) => (
        <tr key={category.id || category.name}>
          <td><strong>{category.name}</strong></td>
          <td>{category.description || "-"}</td>
          <td><StatusPill status={category.status || (category.active ? "Ativo" : "Inativo")} /></td>
          <td>
            <RowActions
              onEdit={() => onAction("productCategory", editRecordPayload(category))}
              onDeactivate={category.active === false ? undefined : () => onAction("confirmAction", confirmRecordPayload({
                collection: "productCategories",
                record: category,
                label: category.name,
                feedback: "Categoria desativada.",
              }))}
            />
          </td>
        </tr>
      ))}
      {!categories.length ? (
        <tr><td colSpan="4">Nenhuma categoria cadastrada. Crie a primeira para classificar os produtos.</td></tr>
      ) : null}
    </DataPanel>
  );
}

function ProductBrands({ brands, onAction }) {
  return (
    <DataPanel
      title="Marcas de produtos"
      icon={Store}
      columns={["Marca", "Descricao", "Status", "Acao"]}
      action="Nova marca"
      onAction={() => onAction("productBrand")}
    >
      {brands.map((brand) => (
        <tr key={brand.id || brand.name}>
          <td><strong>{brand.name}</strong></td>
          <td>{brand.description || "-"}</td>
          <td><StatusPill status={brand.status || (brand.active ? "Ativo" : "Inativo")} /></td>
          <td>
            <RowActions
              onEdit={() => onAction("productBrand", editRecordPayload(brand))}
              onDeactivate={brand.active === false ? undefined : () => onAction("confirmAction", confirmRecordPayload({
                collection: "productBrands",
                record: brand,
                label: brand.name,
                feedback: "Marca desativada.",
              }))}
            />
          </td>
        </tr>
      ))}
      {!brands.length ? (
        <tr><td colSpan="4">Nenhuma marca cadastrada. Crie marcas para padronizar a classificacao dos produtos.</td></tr>
      ) : null}
    </DataPanel>
  );
}

function ProductPricing({ products, onAction, runtimeData }) {
  return (
    <div className="panel panel-section">
      <Toolbar title="Precos e margem" description="Custo, venda e margem por produto ou servico." icon={BadgeDollarSign} />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "products")}
        columns={["SKU", "Produto", "Custo", "Venda", "Margem", "Status", "Acoes"]}
        emptyDescription="Cadastre produtos para acompanhar precos e margens."
        emptyTitle="Nenhum preco encontrado"
        filters={["Todos", "Ok", "Critico", "Servico"].map((item) => ({ value: item, label: item }))}
        filter={(product, activeFilter) => activeFilter === "Todos" || product.status === activeFilter}
        getItemKey={(product) => product.id || product.sku || product.name}
        items={products}
        renderRow={(product) => {
          const cost = parseMoney(product.cost);
          const price = parseMoney(product.price);
          const margin = price > 0 ? `${(((price - cost) / price) * 100).toFixed(1).replace(".", ",")}%` : "-";
          return (
            <tr key={product.id || product.sku || product.name}>
              <td>{product.sku || "-"}</td>
              <td className="entity-main-cell"><strong>{product.name}</strong><small>{product.category || productCatalogType(product)}</small></td>
              <td>{product.cost}</td>
              <td><strong>{product.price}</strong></td>
              <td>{margin}</td>
              <td><StatusPill status={product.status} /></td>
              <td>
                <RowActions onEdit={() => onAction("product", editRecordPayload(product))} />
              </td>
            </tr>
          );
        }}
        searchPlaceholder="Buscar por SKU, produto, categoria, custo, venda, margem ou status"
        searchText={(product) => [product.sku, product.name, product.category, product.cost, product.price, product.status, productCatalogType(product)].join(" ")}
      />
    </div>
  );
}

function InventoryPage({ data, onAction, runtimeData, navigationIntent }) {
  const [activeTab, setActiveTab] = useState(navigationIntent?.tab || "balance");
  useEffect(() => {
    if (navigationIntent?.tab) setActiveTab(navigationIntent.tab);
  }, [navigationIntent?.key, navigationIntent?.tab]);
  return (
    <ModulePage
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={[
        { id: "balance", label: "Inventario", icon: ClipboardList, content: <InventoryBalance products={data.products} onAction={onAction} runtimeData={runtimeData} initialFilter={navigationIntent?.filter} /> },
        { id: "reservations", label: "Reservas", icon: PackageCheck, content: <InventoryReservations reservations={data.stockReservations || []} runtimeData={runtimeData} /> },
        { id: "alerts", label: "Reposicao", icon: CalendarClock, content: <InventoryAlerts products={data.products} onAction={onAction} runtimeData={runtimeData} /> },
        { id: "history", label: "Historico", icon: FileText, content: <InventoryHistory movements={data.movements} onAction={onAction} runtimeData={runtimeData} /> },
      ]}
    />
  );
}

const inventoryMoveModes = {
  entry: {
    kind: "Entrada",
    label: "Receber mercadoria",
    title: "Mercadoria chegou",
    description: "Use quando uma armacao, lente ou acessorio entrou fisicamente no estoque.",
    impact: "Vai aumentar o saldo do produto selecionado.",
    action: "Receber item",
    reason: "Compra fornecedor",
    fields: ["Produto recebido", "Quantidade recebida", "Custo opcional", "Fornecedor ou observacao"],
  },
  exit: {
    kind: "Saida",
    label: "Registrar saida",
    title: "Saida sem venda",
    description: "Use para quebra, perda, amostra, devolucao ou retirada manual.",
    impact: "Vai reduzir o saldo sem criar venda.",
    action: "Registrar saida",
    reason: "Saida operacional",
    fields: ["Produto", "Quantidade retirada", "Motivo da saida", "Observacao"],
  },
  adjustment: {
    kind: "Ajuste",
    label: "Corrigir saldo",
    title: "Ajuste por contagem",
    description: "Use apos contagem fisica quando o saldo do sistema nao bate com a loja.",
    impact: "Vai registrar um ajuste para corrigir divergencia de estoque.",
    action: "Corrigir saldo",
    reason: "Ajuste por contagem",
    fields: ["Produto contado", "Diferenca encontrada", "Motivo obrigatorio", "Observacao da contagem"],
  },
};

function InventoryMove({ onAction }) {
  const [mode, setMode] = useState("entry");
  const selectedMode = inventoryMoveModes[mode];

  function openMovement(nextMode = selectedMode) {
    onAction("movement", {
      kind: nextMode.kind,
      reason: nextMode.reason,
      notes: nextMode.impact,
    });
  }

  return (
    <div className="screen-grid">
      <FeaturePanel
        title="Atualizar estoque"
        description="Escolha a movimentacao e abra o formulario certo para registrar no estoque."
        icon={Boxes}
        action={selectedMode.action}
        onAction={() => openMovement()}
      >
        <div className="segmented">
          {Object.entries(inventoryMoveModes).map(([key, item]) => (
            <button
              className={`segmented__item ${mode === key ? "segmented__item--active" : ""}`}
              key={key}
              type="button"
              onClick={() => setMode(key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="guided-action-card">
          <strong>{selectedMode.title}</strong>
          <span>{selectedMode.description}</span>
          <small>{selectedMode.impact}</small>
        </div>
      </FeaturePanel>
      <FeaturePanel
        title="Antes de registrar"
        description="Regras para evitar movimentacao errada no estoque."
        icon={CheckCircle2}
      >
        <StepList items={[
          selectedMode.impact,
          "Servico nao movimenta estoque.",
          "Item sob encomenda deve virar pendencia operacional, nao saldo fisico.",
          "Ajuste e saida manual precisam ter motivo claro para auditoria.",
        ]} />
      </FeaturePanel>
    </div>
  );
}

function InventoryBalance({ products, onAction, runtimeData, initialFilter }) {
  const stockFilters = ["Todos", "Ok", "Critico", "Servico", "Com estoque", "Sem estoque", "Com reserva"]
    .map((item) => ({ value: item, label: item }));

  return (
    <div className="panel panel-section">
      <Toolbar
        title="Saldo de estoque"
        description="Saldo fisico, quantidade reservada e disponibilidade real para novas vendas."
        icon={Boxes}
        secondaryActions={(
          <>
            <button className="button-secondary" type="button" onClick={() => onAction("movement", { kind: "Entrada", reason: "Compra fornecedor" })}>
              <Plus size={16} />
              Receber mercadoria
            </button>
            <button className="button-secondary" type="button" onClick={() => onAction("movement", { kind: "Saida", reason: "Saida operacional" })}>
              Registrar saida
            </button>
            <button className="button-primary" type="button" onClick={() => onAction("movement", { kind: "Ajuste", reason: "Ajuste por contagem" })}>
              Corrigir saldo
            </button>
          </>
        )}
      />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "products")}
        columns={["SKU", "Produto", "Tipo", "Fisico", "Reservado", "Disponivel", "Minimo", "Status"]}
        emptyDescription="Ajuste a busca ou altere o filtro de estoque."
        emptyTitle="Nenhum item encontrado"
        filters={stockFilters}
        initialFilter={initialFilter}
        filter={(product, activeFilter) => activeFilter === "Todos"
          || product.status === activeFilter
          || (activeFilter === "Com estoque" && Number((product.availableStock ?? product.stock) || 0) > 0)
          || (activeFilter === "Sem estoque" && productControlsStock(product) && Number((product.availableStock ?? product.stock) || 0) <= 0)
          || (activeFilter === "Com reserva" && productControlsStock(product) && Number(product.reservedStock || 0) > 0)}
        getItemKey={(product) => product.id || product.sku || product.name}
        items={products}
        renderRow={(product) => (
          <tr key={product.id || product.sku || product.name}>
            <td>{product.sku || "-"}</td>
            <td className="entity-main-cell"><strong>{product.name}</strong><small>{product.category || "-"}</small></td>
            <td>{productCatalogType(product)}</td>
            <td>{product.physicalStock ?? product.stock}</td>
            <td>{product.reservedStock ?? 0}</td>
            <td><strong>{product.availableStock ?? product.stock}</strong></td>
            <td>{product.min}</td>
            <td><StatusPill status={product.status} /></td>
          </tr>
        )}
        searchPlaceholder="Buscar por SKU, EAN, produto, categoria, marca ou status"
        searchText={(product) => [product.sku, product.ean, product.name, product.category, product.brand, product.physicalStock, product.reservedStock, product.availableStock, product.status, productCatalogType(product)].join(" ")}
      />
    </div>
  );
}

function InventoryReservations({ reservations, runtimeData }) {
  const filters = ["Todos", "Ativas", "Consumidas", "Liberadas"].map((item) => ({ value: item, label: item }));
  return (
    <div className="panel panel-section">
      <Toolbar title="Reservas de estoque" description="Itens comprometidos com pedidos futuros sem retirar o saldo fisico antes da entrega." icon={PackageCheck} />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "stockReservations")}
        columns={["Produto", "Pedido", "Cliente", "Qtd.", "Reservado em", "Entrega prevista", "Status"]}
        emptyDescription="Reservas sao criadas automaticamente para pedidos com entrega futura."
        emptyTitle="Nenhuma reserva encontrada"
        filters={filters}
        filter={(row, activeFilter) => activeFilter === "Todos"
          || (activeFilter === "Ativas" && row.statusKey === "active")
          || (activeFilter === "Consumidas" && row.statusKey === "consumed")
          || (activeFilter === "Liberadas" && row.statusKey === "released")}
        getItemKey={(row) => row.id}
        items={reservations}
        renderRow={(row) => <tr key={row.id}>
          <td className="entity-main-cell"><strong>{row.product}</strong><small>{row.sku}</small></td>
          <td><strong>{row.origin}</strong></td>
          <td>{row.customer}</td>
          <td><strong>{row.quantity}</strong></td>
          <td>{row.reservedDate}</td>
          <td>{row.promisedDelivery}</td>
          <td className="entity-main-cell"><StatusPill status={row.status} /><small>{row.releaseReason || (row.statusKey === "active" ? "Comprometido com o pedido" : "")}</small></td>
        </tr>}
        searchPlaceholder="Buscar por produto, SKU, pedido, cliente ou status"
        searchText={(row) => [row.product, row.sku, row.origin, row.customer, row.quantity, row.status].join(" ")}
      />
    </div>
  );
}

function InventoryAlerts({ products, onAction, runtimeData }) {
  const replenishmentRows = products
    .filter((product) => productControlsStock(product) && Number(product.stock || 0) < Number(product.min || 0))
    .map((product) => {
      const stock = Number(product.stock || 0);
      const min = Number(product.min || 0);
      const suggestedQuantity = Math.max(1, min - stock);
      const estimatedCost = suggestedQuantity * parseMoney(product.cost);
      return { ...product, suggestedQuantity, estimatedCost };
    });
  const replenishmentFilters = ["Todos", "Critico", "Estoque zerado", "Comprar hoje"]
    .map((item) => ({ value: item, label: item }));

  return (
    <div className="panel panel-section">
      <Toolbar
        title="Reposicao de estoque"
        description="Itens abaixo do minimo, com sugestao de compra e acao direta."
        icon={CalendarClock}
        action={replenishmentRows.length ? "Exportar lista" : undefined}
        onAction={replenishmentRows.length ? () => exportInventoryReplenishmentRows(replenishmentRows) : undefined}
      />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "products", { scope: "low_stock" })}
        columns={["Produto", "Tipo", "Atual", "Minimo", "Comprar", "Custo estimado", "Status", "Acoes"]}
        emptyDescription="Nenhum produto fisico abaixo do minimo no momento."
        emptyTitle="Estoque saudavel"
        filters={replenishmentFilters}
        filter={(product, activeFilter) => activeFilter === "Todos"
          || (activeFilter === "Critico" && product.status === "Critico")
          || (activeFilter === "Estoque zerado" && Number(product.stock || 0) <= 0)
          || activeFilter === "Comprar hoje"}
        getItemKey={(product) => product.id || product.sku || product.name}
        items={replenishmentRows}
        renderRow={(product) => (
          <tr key={product.id || product.sku || product.name}>
            <td className="entity-main-cell"><strong>{product.name}</strong><small>{product.sku || "Sem SKU"}</small></td>
            <td>{productCatalogType(product)}</td>
            <td>{product.stock}</td>
            <td>{product.min}</td>
            <td><strong>{product.suggestedQuantity}</strong></td>
            <td>{formatCurrency(product.estimatedCost)}</td>
            <td><StatusPill status={product.status || "Critico"} /></td>
            <td>
              <button
                className="table-action"
                type="button"
                onClick={() => onAction("movement", {
                  kind: "Entrada",
                  product: product.name,
                  sku: product.sku,
                  quantity: product.suggestedQuantity,
                  reason: "Reposicao de estoque",
                })}
              >
                Receber
              </button>
            </td>
          </tr>
        )}
        searchPlaceholder="Buscar por produto, SKU, EAN, categoria, marca ou status"
        searchText={(product) => [product.name, product.sku, product.ean, product.category, product.brand, product.status, productCatalogType(product)].join(" ")}
      />
    </div>
  );
}

function exportInventoryReplenishmentRows(rows) {
  downloadCsv("reposicao-estoque.csv", rows, [
    { key: "sku", label: "SKU" },
    { key: "name", label: "Produto" },
    { key: "category", label: "Categoria" },
    { key: "brand", label: "Marca" },
    { key: "stock", label: "Estoque atual" },
    { key: "min", label: "Estoque minimo" },
    { key: "suggestedQuantity", label: "Quantidade sugerida" },
    { key: "cost", label: "Custo unitario" },
    { key: "estimatedCost", label: "Custo estimado" },
    { key: "status", label: "Status" },
  ]);
}

function InventoryHistory({ movements, onAction, runtimeData }) {
  const movementFilters = ["Todos", "Entrada", "Saida", "Ajuste"]
    .map((item) => ({ value: item, label: item }));

  return (
    <div className="panel panel-section">
      <Toolbar title="Historico de movimentacoes" description="Entradas, saidas e ajustes com busca operacional." icon={ClipboardList} action="Nova movimentacao" onAction={() => onAction("movement")} />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "inventoryMovements")}
        columns={["Tipo", "Produto", "Qtd.", "Motivo", "Usuario", "Data"]}
        emptyDescription="Ajuste a busca ou filtre por tipo de movimentacao."
        emptyTitle="Nenhuma movimentacao encontrada"
        filters={movementFilters}
        filter={(movement, activeFilter) => activeFilter === "Todos" || movement.type === activeFilter}
        getItemKey={(movement) => movement.id || `${movement.product}-${movement.date}-${movement.quantity}`}
        items={movements}
        renderRow={(movement) => (
          <tr key={movement.id || `${movement.product}-${movement.date}-${movement.quantity}`}>
            <td><StatusPill status={movement.type} /></td>
            <td className="entity-main-cell"><strong>{movement.product}</strong><small>{movement.reason || "Sem motivo"}</small></td>
            <td>{movement.quantity}</td>
            <td>{movement.reason}</td>
            <td>{movement.user}</td>
            <td>{movement.date}</td>
          </tr>
        )}
        searchPlaceholder="Buscar por produto, tipo, motivo, usuario ou data"
        searchText={(movement) => [movement.type, movement.product, movement.quantity, movement.reason, movement.user, movement.date].join(" ")}
      />
    </div>
  );
}

function PaymentsPage({ data, onAction, runtimeData, navigationIntent }) {
  const [activeTab, setActiveTab] = useState(navigationIntent?.tab || "methods");
  useEffect(() => {
    if (navigationIntent?.tab) setActiveTab(navigationIntent.tab);
  }, [navigationIntent?.key, navigationIntent?.tab]);
  const pendingOverview = runtimeData?.lists?.receivables?.summary?.queueRows || (data.receivables || []).filter((item) => !["Pago", "Cancelado"].includes(item.status));
  return (
    <ModulePage
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={[
        { id: "methods", label: "Formas", icon: CreditCard, content: <PaymentMethods paymentMethods={data.paymentMethods} onAction={onAction} /> },
        { id: "pending", label: "Pendentes", icon: CalendarClock, content: <PaymentsPending receivables={pendingOverview} tableReceivables={data.receivables || []} onAction={onAction} runtimeData={runtimeData} initialFilter={navigationIntent?.filter} /> },
        { id: "reconcile", label: "Conciliacao", icon: CheckCircle2, content: <PaymentReconcile /> },
      ]}
    />
  );
}

function ReceivableSummaryCards({ receivables = [], runtimeData }) {
  const summary = runtimeData?.lists?.receivables?.summary;
  const today = new Date().toISOString().slice(0, 10);
  const inSeven = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const openRows = receivables.filter((item) => !["Pago", "Cancelado"].includes(item.status));
  const sum = (rows) => rows.reduce((total, item) => total + Number(item.balanceAmount ?? parseMoney(item.value)), 0);
  const openAmount = summary ? Number(summary.openAmount || 0) : sum(openRows);
  const overdueAmount = summary ? Number(summary.overdueAmount || 0) : sum(openRows.filter((item) => item.isOverdue || (item.dueDate && item.dueDate < today)));
  const dueTodayAmount = summary ? Number(summary.dueTodayAmount || 0) : sum(openRows.filter((item) => item.dueDate === today));
  const next7Amount = summary ? Number(summary.next7Amount || 0) : sum(openRows.filter((item) => item.dueDate > today && item.dueDate <= inSeven));
  return <div className="report-grid">
    <ReportCard icon={WalletCards} title="A receber" value={formatCurrency(openAmount)} detail={`${summary?.openCount ?? openRows.length} titulos em aberto`} />
    <ReportCard icon={AlertTriangle} title="Vencido" value={formatCurrency(overdueAmount)} detail={`${summary?.overdueCount ?? openRows.filter((item) => item.isOverdue).length} titulos atrasados`} />
    <ReportCard icon={CalendarClock} title="Vence hoje" value={formatCurrency(dueTodayAmount)} detail={`${summary?.dueTodayCount ?? openRows.filter((item) => item.dueDate === today).length} titulos`} />
    <ReportCard icon={CalendarDays} title="Proximos 7 dias" value={formatCurrency(next7Amount)} detail={`${summary?.next7Count ?? openRows.filter((item) => item.dueDate > today && item.dueDate <= inSeven).length} titulos`} />
  </div>;
}

function PaymentsPending({ receivables, tableReceivables, onAction, runtimeData, initialFilter }) {
  return <div className="screen-grid">
    <div className="span-2"><ReceivableSummaryCards receivables={receivables} runtimeData={runtimeData} /></div>
    <ReceivablesTable receivables={tableReceivables} onAction={onAction} runtimeData={runtimeData} pendingOnly initialFilter={initialFilter} />
  </div>;
}

function PaymentMethods({ paymentMethods, onAction }) {
  const methodFilters = ["Todos", "Pix", "Cartao", "Dinheiro", "Prazo", "Ativos"]
    .map((item) => ({ value: item, label: item }));

  return (
    <div className="panel panel-section">
      <Toolbar title="Formas aceitas" description="Taxas, prazos e meios usados no fechamento da venda." icon={CreditCard} action="Nova forma" onAction={() => onAction("paymentMethod")} />
      <OperationalList
        columns={["Forma", "Tipo", "Taxa", "Prazo", "Status", "Acoes"]}
        emptyDescription="Cadastre as formas aceitas pela empresa."
        emptyTitle="Nenhuma forma configurada"
        filters={methodFilters}
        filter={(method, activeFilter) => activeFilter === "Todos"
          || (activeFilter === "Ativos" && method.status !== "Inativo")
          || normalizeFilterText(method.name).includes(normalizeFilterText(activeFilter))
          || normalizeFilterText(method.type).includes(normalizeFilterText(activeFilter))}
        getItemKey={(method) => method.id || method.name}
        items={paymentMethods}
        renderRow={(method) => (
          <tr key={method.id || method.name}>
            <td className="entity-main-cell"><strong>{method.name}</strong><small>{method.settlement || "Sem prazo informado"}</small></td>
            <td>{method.type || "-"}</td>
            <td>{method.fee || "-"}</td>
            <td>{method.settlement || "-"}</td>
            <td><StatusPill status={method.status || "Ativo"} /></td>
            <td><RowActions onEdit={() => onAction("paymentMethod", editRecordPayload(method))} /></td>
          </tr>
        )}
        searchPlaceholder="Buscar por forma, tipo, taxa, prazo ou status"
        searchText={(method) => [method.name, method.type, method.fee, method.settlement, method.status].join(" ")}
      />
    </div>
  );
}

function PaymentReconcile() {
  return (
    <DataPanel title="Conciliacao" icon={CheckCircle2} columns={["Data", "Forma", "Previsto", "Recebido", "Diferenca", "Status"]}>
      {[]}
    </DataPanel>
  );
}

function ReceivablesPage({ data, onAction, runtimeData, navigationIntent }) {
  const [activeTab, setActiveTab] = useState(navigationIntent?.tab || "agenda");
  useEffect(() => {
    if (navigationIntent?.tab) setActiveTab(navigationIntent.tab);
  }, [navigationIntent?.key, navigationIntent?.tab]);
  const overviewReceivables = runtimeData?.lists?.receivables?.summary?.queueRows || data.receivables;
  return (
    <ModulePage
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={[
        { id: "agenda", label: "Agenda", icon: WalletCards, content: <ReceivablesAgenda receivables={overviewReceivables} tableReceivables={data.receivables} onAction={onAction} runtimeData={runtimeData} initialFilter={navigationIntent?.filter} initialSearch={navigationIntent?.search} /> },
        { id: "checks", label: "Cheques", icon: FileText, content: <ReceivablesChecks receivables={overviewReceivables} onAction={onAction} /> },
        { id: "actions", label: "Cobranca", icon: CalendarClock, content: <ReceivablesActions receivables={overviewReceivables} onAction={onAction} /> },
      ]}
    />
  );
}

function ReceivablesAgenda({ receivables, tableReceivables = receivables, onAction, runtimeData, initialFilter, initialSearch }) {
  const openItems = receivables.filter((item) => !["Pago", "Cancelado"].includes(item.status));
  const summary = runtimeData?.lists?.receivables?.summary;
  const openCount = summary ? Number(summary.openCount || 0) : openItems.length;
  const paidCount = summary ? Number(summary.paidCount || 0) : receivables.filter((item) => item.status === "Pago").length;
  const totalCount = summary ? Number(summary.total || 0) : receivables.length;
  return (
    <div className="screen-grid">
      <div className="panel panel-section span-2">
        <Toolbar title="Agenda de recebiveis" description="Parcelas, vencimentos e saldos organizados para cobranca." icon={WalletCards} action="Novo recebivel" onAction={() => onAction("receivable")} />
        <ReceivableSummaryCards receivables={receivables} runtimeData={runtimeData} />
        <div className="kanban-row">
          <KanbanColumn title="Abertos" count={String(openCount)} items={openItems.slice(0, 3).map((item) => `${item.customer} - ${item.balanceValue || item.value}`)} />
          <KanbanColumn title="Pagos" count={String(paidCount)} items={[]} />
          <KanbanColumn title="Total" count={String(totalCount)} items={receivables.slice(0, 3).map((item) => `${item.due} - ${item.customer}`)} />
        </div>
      </div>
      <ReceivablesTable receivables={tableReceivables} onAction={onAction} runtimeData={runtimeData} initialFilter={initialFilter} initialSearch={initialSearch} />
    </div>
  );
}

function ReceivablesTable({ receivables, onAction, runtimeData, pendingOnly = false, initialFilter, initialSearch }) {
  const receivableFilters = (pendingOnly
    ? ["Pendentes", "Vencidos", "Vence hoje", "Proximos 7 dias", "Parcial"]
    : ["Todos", "Aberto", "Parcial", "Vencidos", "Vence hoje", "Proximos 7 dias", "Pago", "Compensar"])
    .map((item) => ({ value: item, label: item }));

  return (
    <div className="panel panel-section span-2">
      <Toolbar title="Recebiveis" description="Parcelas, cheques e cobrancas com busca por cliente e vencimento." icon={WalletCards} />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "receivables")}
        columns={["Cliente", "Origem", "Parcela", "Vencimento", "Valor", "Recebido", "Saldo", "Status", "Acoes"]}
        emptyDescription="Ajuste a busca, mude o filtro ou cadastre um novo recebivel."
        emptyTitle="Nenhum recebivel encontrado"
        filters={receivableFilters}
        initialFilter={initialFilter}
        initialSearch={initialSearch}
        filter={(row, activeFilter) => {
          const today = new Date().toISOString().slice(0, 10);
          const inSeven = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
          return activeFilter === "Todos"
            || (activeFilter === "Pendentes" && !["Pago", "Cancelado"].includes(row.status))
            || row.status === activeFilter
            || (activeFilter === "Vencidos" && row.status === "Vencido")
            || (activeFilter === "Vence hoje" && !["Pago", "Cancelado"].includes(row.status) && row.dueDate === today)
            || (activeFilter === "Proximos 7 dias" && !["Pago", "Cancelado", "Vencido"].includes(row.status) && row.dueDate > today && row.dueDate <= inSeven);
        }}
        getItemKey={(row) => row.id || `${row.customer}-${row.origin}-${row.due}`}
        items={receivables}
        renderRow={(row) => (
          <tr key={row.id || `${row.customer}-${row.origin}-${row.due}`}>
            <td className="entity-main-cell"><strong>{row.customer}</strong><small>{row.method || "Recebivel"}</small></td>
            <td className="entity-main-cell"><strong>{row.origin}</strong><small>{row.description || row.method || "Recebivel"}</small></td>
            <td>{row.installment || "-"}</td>
            <td>{row.due}</td>
            <td>{row.originalValue || row.value}</td>
            <td>{row.paidValue || formatCurrency(0)}</td>
            <td><strong>{row.balanceValue || row.value}</strong></td>
            <td><StatusPill status={row.status} /></td>
            <td>
              <span className="row-actions">
                {!["Pago", "Cancelado"].includes(row.status) ? (
                  <>
                    <button className="table-action" type="button" onClick={() => onAction("receivableDueDate", row)}>
                      Corrigir vencimento
                    </button>
                    <button className="table-action" type="button" onClick={() => onAction("receivableReceive", row)}>
                      Receber
                    </button>
                    <button
                      className="table-action table-action--warning"
                      type="button"
                      onClick={() => onAction("confirmAction", confirmRecordPayload({
                        collection: "receivables",
                        record: row,
                        label: row.origin,
                        nextStatus: "Cancelado",
                        feedback: "Recebivel cancelado.",
                      }))}
                    >
                      Cancelar
                    </button>
                  </>
                ) : <span className="muted-copy">Sem acao</span>}
              </span>
            </td>
          </tr>
        )}
        searchPlaceholder="Buscar por cliente, venda, parcela, vencimento, valor, metodo ou status"
        searchText={(row) => [row.customer, row.origin, row.installment, row.due, row.originalValue, row.paidValue, row.balanceValue, row.method, row.status].join(" ")}
      />
    </div>
  );
}

function ReceivablesChecks({ receivables, onAction }) {
  const checkItems = receivables.filter((item) => item.methodKey === "check" || item.origin.toLowerCase().includes("cheque") || ["Compensar", "Depositado", "Devolvido"].includes(item.status));
  return (
    <div className="screen-grid">
      <FeaturePanel title="Cheques para depositar" icon={FileText} action="Depositar" onAction={() => checkItems[0] && onAction("receivableStatus", { ...checkItems[0], action: "deposit-check" })}>
        {checkItems.map((item) => (
          <QuickRow key={`${item.customer}-${item.due}`} title={item.origin} subtitle={`${item.customer} - ${item.value} - ${item.due}`} action="Depositar" icon={FileText} onClick={() => onAction("receivableStatus", { ...item, action: "deposit-check" })} />
        ))}
        {!checkItems.length ? <EmptyContent icon={FileText} title="Nenhum cheque pendente" description="Cheques cadastrados aparecerao nesta lista." /> : null}
      </FeaturePanel>
      <FeaturePanel title="Status de compensacao" icon={CheckCircle2} action="Registrar devolucao" onAction={() => checkItems[0] && onAction("receivableStatus", { ...checkItems[0], action: "return-check" })}>
        {checkItems.map((item) => (
          <QuickRow key={`return-${item.customer}-${item.due}`} title={item.origin} subtitle={`${item.status} - ${item.customer}`} action="Devolver" icon={CheckCircle2} onClick={() => onAction("receivableStatus", { ...item, action: "return-check" })} />
        ))}
        {!checkItems.length ? <StepList items={["Depositado", "Aguardando compensacao", "Compensado", "Devolvido"]} /> : null}
      </FeaturePanel>
    </div>
  );
}

function ReceivablesActions({ receivables, onAction }) {
  const queues = receivableWorkQueues(receivables);
  const nextReceivable = queues.find((queue) => queue.items.length)?.items[0];
  return (
    <div className="panel panel-section">
      <Toolbar
        title="Rotina de cobranca"
        description="Pendencias organizadas para receber, registrar contato ou renegociar."
        icon={CalendarClock}
        action="Receber prioridade"
        onAction={() => nextReceivable && onAction("receivableReceive", nextReceivable)}
      />
      <div className="receivable-work-grid">
        {queues.map((queue) => (
          <ReceivableWorkColumn key={queue.id} queue={queue} onAction={onAction} />
        ))}
      </div>
      {!nextReceivable ? <EmptyContent icon={WalletCards} title="Sem cobrancas pendentes" description="Recebiveis em aberto aparecerao aqui por prioridade." /> : null}
    </div>
  );
}

function receivableWorkQueues(receivables) {
  const today = todayIsoDate();
  const openItems = receivables.filter((item) => !["Pago", "Cancelado"].includes(item.status));
  const checkItems = openItems.filter((item) => item.methodKey === "check" || item.origin.toLowerCase().includes("cheque") || ["Compensar", "Depositado", "Devolvido"].includes(item.status));
  const isCheck = (item) => checkItems.includes(item);
  return [
    {
      id: "overdue",
      title: "Vencidos",
      description: "Receber ou registrar contato agora.",
      items: openItems.filter((item) => !isCheck(item) && normalizeReportDate(item.due) && normalizeReportDate(item.due) < today),
    },
    {
      id: "today",
      title: "Vence hoje",
      description: "Prioridade do dia.",
      items: openItems.filter((item) => !isCheck(item) && normalizeReportDate(item.due) === today),
    },
    {
      id: "next",
      title: "Proximos",
      description: "Acompanhar antes de virar atraso.",
      items: openItems.filter((item) => !isCheck(item) && (!normalizeReportDate(item.due) || normalizeReportDate(item.due) > today)),
    },
    {
      id: "checks",
      title: "Cheques",
      description: "Depositar, compensar ou registrar devolucao.",
      items: checkItems,
    },
  ];
}

function todayIsoDate() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function ReceivableWorkColumn({ queue, onAction }) {
  return (
    <div className="receivable-work-column">
      <div className="kanban-title">
        <div>
          <strong>{queue.title}</strong>
          <small>{queue.description}</small>
        </div>
        <span>{queue.items.length}</span>
      </div>
      {queue.items.slice(0, 6).map((item) => (
        <div className="receivable-work-card" key={item.id || `${item.customer}-${item.origin}-${item.due}`}>
          <div>
            <strong>{item.customer}</strong>
            <small>{item.origin} | {item.due || "Sem vencimento"} | {item.value}</small>
          </div>
          <StatusPill status={item.status} />
          <div className="row-actions">
            <button className="table-action" type="button" onClick={() => onAction("receivableReceive", item)}>Receber</button>
            <button className="table-action" type="button" onClick={() => onAction("genericConfig", { title: "Contato de cobranca", label: "Retorno", defaultName: item.customer, feedback: "Contato registrado." })}>Contato</button>
            <button className="table-action table-action--warning" type="button" onClick={() => onAction("genericConfig", { title: "Renegociacao", label: "Nova condicao", defaultName: item.value, feedback: "Renegociacao registrada." })}>Renegociar</button>
          </div>
        </div>
      ))}
      {!queue.items.length ? <span className="receivable-work-empty">Nada pendente nesta fila.</span> : null}
    </div>
  );
}

function CashPage({ data, onAction, runtimeData }) {
  return (
    <ModulePage
      tabs={[
        { id: "session", label: "Sessao", icon: CircleDollarSign, content: <CashSession cashRows={data.cashRows} cashSummary={data.cashSummary} cashSessions={data.cashSessions} onAction={onAction} /> },
        { id: "conference", label: "Conferencia", icon: BanknoteArrowDown, content: <CashConference cashRows={data.cashRows} cashSummary={data.cashSummary} cashSessions={data.cashSessions} /> },
        { id: "history", label: "Historico", icon: ReceiptText, content: <CashHistory cashRows={data.cashRows} cashSummary={data.cashSummary} cashSessions={data.cashSessions} onAction={onAction} runtimeData={runtimeData} /> },
      ]}
    />
  );
}

function getOpenCashSession(cashSessions = [], cashSummary = {}) {
  const listedSession = cashSessions.find((session) => session.status === "open");
  if (!cashSummary?.sessionId) return listedSession || null;
  return listedSession || {
    id: cashSummary.sessionId,
    number: cashSummary.sessionNumber,
    status: cashSummary.status || "open",
    openedAt: cashSummary.openedAt,
  };
}

function getCurrentCashRows(cashRows = [], cashSummary = {}, cashSessions = []) {
  const openSession = getOpenCashSession(cashSessions, cashSummary);
  if (!openSession?.id) return [];
  const openedAt = new Date(cashSummary?.openedAt || openSession.openedAt || 0).getTime();
  return cashRows.filter((row) => {
    if (String(row.sessionId || "") === String(openSession.id)) return true;
    if (row.sessionId || !openedAt) return false;
    const operationalAt = new Date(row.operationalAt || row.createdAt || 0).getTime();
    return Number.isFinite(operationalAt) && operationalAt >= openedAt;
  });
}

function CashSession({ cashRows, cashSummary = {}, cashSessions = [], onAction }) {
  const openSession = getOpenCashSession(cashSessions, cashSummary);
  const currentRows = getCurrentCashRows(cashRows, cashSummary, cashSessions);
  const balance = openSession ? Number(cashSummary.balance ?? cashSummary.expectedAmount ?? 0) : 0;
  const entryTotal = openSession ? Number(cashSummary.entryTotal ?? currentRows.filter((row) => row.type === "Entrada").reduce((sum, row) => sum + parseMoney(row.value), 0)) : 0;
  const exitTotal = openSession ? Number(cashSummary.exitTotal ?? currentRows.filter((row) => row.type === "Saida").reduce((sum, row) => sum + parseMoney(row.value), 0)) : 0;
  const movementCount = openSession ? Number(cashSummary.movementCount ?? currentRows.length) : 0;
  const latestRows = currentRows.slice(0, 4);
  return (
    <div className="screen-grid">
      <FeaturePanel
        title="Sessao de caixa"
        icon={CircleDollarSign}
        action={openSession ? "Fechar caixa" : "Abrir caixa"}
        onAction={() => onAction("cashSession", { sessionId: openSession?.id, mode: openSession ? "close" : "open", expected: balance })}
      >
        <div className="cash-summary">
          <small>Saldo esperado</small>
          <strong>{formatCurrency(balance)}</strong>
          <span>{openSession ? "Caixa aberto para operacao" : "Caixa fechado ou nao iniciado"}</span>
        </div>
        <div className="cash-kpi-grid">
          <SummaryLine label="Entradas" value={formatCurrency(entryTotal)} />
          <SummaryLine label="Saidas" value={`-${formatCurrency(exitTotal)}`} />
          <SummaryLine label="Movimentos" value={String(movementCount)} />
          <SummaryLine label="Status" value={openSession ? "Aberto" : "Fechado"} />
        </div>
        <div className="quick-actions">
          <button className="button-secondary" type="button" title="Adicionar dinheiro fisico ao caixa" disabled={!openSession} onClick={() => onAction("cashMovement", { type: "entry", sessionId: openSession?.id })}>Reforco</button>
          <button className="button-secondary" type="button" title="Retirar dinheiro fisico do caixa" disabled={!openSession} onClick={() => onAction("cashMovement", { type: "exit", sessionId: openSession?.id })}>Sangria</button>
          <button className="button-secondary" type="button" title="Contar o dinheiro e comparar com o sistema" disabled={!openSession} onClick={() => onAction("genericConfig", { title: "Conferencia de caixa", label: "Valor contado", feedback: "Conferencia registrada." })}>Conferir</button>
        </div>
        <div className="cash-latest-list">
          <strong>Ultimos movimentos</strong>
          {latestRows.map((row) => (
            <div key={row.id || `${row.label}-${row.time}`}>
              <span>{row.label}</span>
              <small>{row.type} | {row.method || "Forma nao informada"} | {row.value} | {row.time}</small>
            </div>
          ))}
          {!latestRows.length ? <small>Nenhum movimento registrado nesta sessao.</small> : null}
        </div>
      </FeaturePanel>
      <FeaturePanel title="Rotina do caixa" icon={ShieldCheck} action="Editar regra">
        <div className="cash-action-help">
          <div><strong>Reforco</strong><span>Entrada manual de dinheiro, como troco adicional.</span></div>
          <div><strong>Sangria</strong><span>Retirada de dinheiro para reduzir o valor fisico no caixa.</span></div>
          <div><strong>Conferir</strong><span>Compara o valor contado com o saldo esperado pelo sistema.</span></div>
          <div><strong>Recebimento</strong><span>Valores recebidos devem aparecer como entrada e reduzir pendencias.</span></div>
        </div>
        <ToggleList items={["Exigir caixa aberto para vender", "Permitir sangria por operador", "Solicitar senha no fechamento", "Imprimir relatorio ao fechar"]} />
      </FeaturePanel>
    </div>
  );
}

function CashConference({ cashRows, cashSummary = {}, cashSessions = [] }) {
  const currentRows = getCurrentCashRows(cashRows, cashSummary, cashSessions);
  const openSession = getOpenCashSession(cashSessions, cashSummary);
  const entryTotal = openSession ? Number(cashSummary.entryTotal ?? currentRows.filter((row) => row.type === "Entrada").reduce((sum, row) => sum + parseMoney(row.value), 0)) : 0;
  const exitTotal = openSession ? Number(cashSummary.exitTotal ?? currentRows.filter((row) => row.type === "Saida").reduce((sum, row) => sum + parseMoney(row.value), 0)) : 0;
  const expected = openSession ? Number(cashSummary.balance ?? cashSummary.expectedAmount ?? 0) : 0;
  return (
    <div className="screen-grid">
      <FeaturePanel title="Por forma de pagamento" icon={BanknoteArrowDown} action="Imprimir">
        <SummaryLine label="Entradas" value={formatCurrency(entryTotal)} />
        <SummaryLine label="Saidas" value={`-${formatCurrency(exitTotal)}`} />
        <SummaryLine label="Saldo esperado" value={formatCurrency(expected)} />
      </FeaturePanel>
      <FeaturePanel title="Divergencias" icon={Eye} action="Conferir">
        <AlertRow title="Sem divergencia critica" detail="Valores conferem com os pagamentos registrados." severity="success" />
      </FeaturePanel>
    </div>
  );
}

function CashHistory({ cashRows, cashSummary = {}, cashSessions = [], onAction, runtimeData }) {
  const openSession = getOpenCashSession(cashSessions, cashSummary);
  const cashFilters = ["Todos", "Entrada", "Saida"]
    .map((item) => ({ value: item, label: item }));

  return (
    <div className="panel panel-section">
      <Toolbar title="Movimentacoes do caixa" description="Historico completo de entradas e saidas do caixa." icon={ReceiptText} action="Nova movimentacao" hideAction={!openSession} onAction={() => onAction("cashMovement", { sessionId: openSession?.id })} />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "cashMovements")}
        columns={["Origem", "Forma", "Tipo", "Valor", "Hora", "Operador"]}
        emptyDescription="Ajuste a busca ou registre uma nova movimentacao."
        emptyTitle="Nenhuma movimentacao encontrada"
        filters={cashFilters}
        filter={(row, activeFilter) => activeFilter === "Todos" || row.type === activeFilter}
        getItemKey={(row) => row.id || `${row.label}-${row.time}`}
        items={cashRows}
        renderRow={(row) => (
          <tr key={row.id || `${row.label}-${row.time}`}>
            <td className="entity-main-cell"><strong>{row.label}</strong><small>{row.time || "-"}</small></td>
            <td>{row.method || "-"}</td>
            <td><StatusPill status={row.type} /></td>
            <td><strong>{row.value}</strong></td>
            <td>{row.time}</td>
            <td>{row.operator}</td>
          </tr>
        )}
        searchPlaceholder="Buscar por origem, tipo, valor, hora ou operador"
        searchText={(row) => [row.label, row.method, row.type, row.value, row.time, row.operator].join(" ")}
      />
    </div>
  );
}

function SaleCompletedModal({ receipt, sale, onClose, onPrint }) {
  const saleNumber = sale?.number ? `#${sale.number}` : sale?.id || "";
  const total = typeof sale?.total === "string" && sale.total.includes("R$")
    ? sale.total
    : sale?.total !== undefined
      ? formatCurrency(sale.total)
      : "";
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-shell sale-completed-modal" role="dialog" aria-modal="true" aria-labelledby="sale-completed-title">
        <header className="modal-header">
          <span className="card-icon">
            <CheckCircle2 size={23} />
          </span>
          <div>
            <h2 id="sale-completed-title">Venda concluida</h2>
            <p>{[saleNumber ? `Venda ${saleNumber}` : "", total ? `Total ${total}` : ""].filter(Boolean).join(" - ") || "Venda registrada com sucesso."}</p>
          </div>
          <button className="icon-button" type="button" aria-label="Fechar" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="sale-completed-body">
          <span className="card-icon"><ReceiptText size={23} /></span>
          <div>
            <strong>Recibo do cliente</strong>
            <p>{receipt?.html ? "Imprima apenas se o cliente desejar levar o comprovante." : "Recibo indisponivel para esta venda."}</p>
          </div>
        </div>
        <footer className="modal-footer">
          <button className="button-secondary" type="button" onClick={onClose}>Concluir</button>
          {receipt?.html ? (
            <button className="button-primary" type="button" onClick={onPrint}>
              <ReceiptText size={18} />
              Imprimir recibo
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function printReceipt(receipt) {
  if (!receipt?.html) return;
  const frame = document.createElement("iframe");
  frame.title = "Recibo para impressao";
  frame.className = "receipt-print-frame";
  document.body.appendChild(frame);
  const printDocument = frame.contentWindow?.document;
  if (!printDocument) {
    frame.remove();
    return;
  }
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    window.setTimeout(() => frame.remove(), 1000);
  };
  printDocument.open();
  printDocument.write(receipt.html);
  printDocument.close();
  window.setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    cleanup();
  }, 250);
}

function ReceiptsPage({ data, runtimeData }) {
  return (
    <ModulePage
      tabs={[
        { id: "issue", label: "Emitir", icon: ReceiptText, content: <ReceiptIssue receipts={data.receipts} /> },
        { id: "models", label: "Modelos", icon: SlidersHorizontal, content: <ReceiptModels /> },
        { id: "history", label: "Historico", icon: FileText, content: <ReceiptHistory receipts={data.receipts} runtimeData={runtimeData} /> },
      ]}
    />
  );
}

function ReceiptIssue({ receipts }) {
  const latest = receipts[0];
  return (
    <div className="screen-grid">
      <FeaturePanel
        title="Emissao de recibo"
        icon={ReceiptText}
        action={latest?.html ? "Imprimir" : undefined}
        onAction={latest?.html ? () => printReceipt(latest) : undefined}
      >
        {latest ? (
          <>
            <SummaryLine label="Venda" value={latest.sale} />
            <SummaryLine label="Cliente" value={latest.customer} />
            <SummaryLine label="Total" value={latest.total} />
          </>
        ) : <EmptyContent icon={ReceiptText} title="Nenhum recibo disponivel" description="Finalize uma venda para emitir o primeiro recibo." />}
      </FeaturePanel>
      <FeaturePanel title="Entrega ao cliente" icon={ArrowRight} action="Enviar">
        <TagList items={["Impressao termica", "PDF", "WhatsApp futuro", "Email futuro"]} />
      </FeaturePanel>
    </div>
  );
}

function ReceiptModels() {
  return (
    <div className="screen-grid">
      <FeaturePanel title="Modelo do recibo" icon={SlidersHorizontal} action="Salvar">
        <ToggleList items={["Exibir logo da empresa", "Exibir operador", "Exibir formas de pagamento", "Exibir politica de troca"]} />
      </FeaturePanel>
      <FeaturePanel title="Preview" icon={Eye} action="Visualizar">
        <div className="receipt-preview">
          <strong>Recibo nao fiscal</strong>
          <span>Os dados da empresa e da venda serao preenchidos na emissao.</span>
        </div>
      </FeaturePanel>
    </div>
  );
}

function ReceiptHistory({ receipts, runtimeData }) {
  return (
    <div className="panel panel-section">
      <Toolbar title="Recibos emitidos" description="Historico pesquisavel de recibos gerados no PDV." icon={ReceiptText} />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "receipts")}
        columns={["Recibo", "Cliente", "Venda", "Valor", "Status", "Acoes"]}
        emptyDescription="Finalize uma venda para emitir o primeiro recibo."
        emptyTitle="Nenhum recibo encontrado"
        filters={["Todos", "Emitido"].map((item) => ({ value: item, label: item }))}
        filter={(receipt, activeFilter) => activeFilter === "Todos" || receipt.status === activeFilter}
        getItemKey={(receipt) => receipt.id}
        items={receipts}
        renderRow={(receipt) => (
          <tr key={receipt.id}>
            <td><strong>{receipt.id}</strong></td>
            <td className="entity-main-cell"><strong>{receipt.customer}</strong><small>{receipt.sale || "-"}</small></td>
            <td>{receipt.sale}</td>
            <td><strong>{receipt.total}</strong></td>
            <td><StatusPill status={receipt.status} /></td>
            <td>
              {receipt.html ? (
                <button className="table-action" type="button" onClick={() => printReceipt(receipt)}>Imprimir</button>
              ) : (
                <span className="muted-cell">Indisponivel</span>
              )}
            </td>
          </tr>
        )}
        searchPlaceholder="Buscar por recibo, cliente, venda, valor ou status"
        searchText={(receipt) => [receipt.id, receipt.customer, receipt.sale, receipt.total, receipt.status].join(" ")}
      />
    </div>
  );
}

function FinancePage({ data, onAction, runtimeData }) {
  return (
    <ModulePage
      tabs={[
        { id: "flow", label: "Fluxo", icon: Landmark, content: <FinanceFlow data={data} runtimeData={runtimeData} /> },
        { id: "expenses", label: "Despesas", icon: FileText, content: <FinanceExpenses expenses={data.expenses} onAction={onAction} runtimeData={runtimeData} /> },
        { id: "forecast", label: "Previsao", icon: TrendingUp, content: <FinanceForecast data={data} onAction={onAction} runtimeData={runtimeData} /> },
      ]}
    />
  );
}

function FinanceFlow({ data, runtimeData }) {
  const summary = runtimeData?.reportData?.summary;
  const expectedEntries = summary ? Number(summary.receivables || 0) : data.receivables
    .filter((item) => !["Pago", "Cancelado"].includes(item.status))
    .reduce((sum, item) => sum + parseMoney(item.value), 0);
  const expectedExits = summary ? Number(summary.expenses || 0) : data.expenses
    .filter((item) => !["Pago", "Cancelado"].includes(item.status))
    .reduce((sum, item) => sum + parseMoney(item.value), 0);
  const pendingCount = summary ? Number(summary.receivableCount || 0) + Number(summary.expenseCount || 0) : data.receivables.filter((item) => item.status !== "Pago").length
    + data.expenses.filter((item) => item.status !== "Pago").length;
  return (
    <div className="report-grid">
      <ReportCard icon={TrendingUp} title="Entradas previstas" value={formatCurrency(expectedEntries)} detail="Recebiveis em aberto" />
      <ReportCard icon={FileText} title="Saidas previstas" value={formatCurrency(expectedExits)} detail="Despesas em aberto" />
      <ReportCard icon={Landmark} title="Saldo projetado" value={formatCurrency(expectedEntries - expectedExits)} detail="Com base nos lancamentos atuais" />
      <ReportCard icon={CalendarClock} title="Pendencias" value={String(pendingCount)} detail="Lancamentos em aberto" />
    </div>
  );
}

function FinanceExpenses({ expenses, onAction, runtimeData }) {
  const expenseFilters = ["Todos", "Aberto", "Pago", "Cancelado"]
    .map((item) => ({ value: item, label: item }));

  return (
    <div className="panel panel-section">
      <Toolbar title="Contas e despesas" description="Lancamentos a pagar com busca por vencimento, categoria e status." icon={FileText} action="Nova despesa" onAction={() => onAction("expense")} />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "expenses")}
        columns={["Despesa", "Categoria", "Vencimento", "Valor", "Status", "Acoes"]}
        emptyDescription="Ajuste a busca, mude o filtro ou cadastre uma despesa."
        emptyTitle="Nenhuma despesa encontrada"
        filters={expenseFilters}
        filter={(row, activeFilter) => activeFilter === "Todos" || row.status === activeFilter}
        getItemKey={(row) => row.id || `${row.name}-${row.due}`}
        items={expenses}
        renderRow={(row) => (
          <tr key={row.id || `${row.name}-${row.due}`}>
            <td className="entity-main-cell"><strong>{row.name}</strong><small>{row.category || "Sem categoria"}</small></td>
            <td>{row.category}</td>
            <td>{row.due}</td>
            <td><strong>{row.value}</strong></td>
            <td><StatusPill status={row.status} /></td>
            <td>
              <RowActions
                onEdit={() => onAction("expense", editRecordPayload(row))}
                onDeactivate={() => onAction("confirmAction", confirmRecordPayload({
                  collection: "expenses",
                  record: row,
                  label: row.name,
                  nextStatus: "Pago",
                  feedback: "Despesa marcada como paga.",
                }))}
                onDelete={() => onAction("confirmAction", confirmRecordPayload({
                  collection: "expenses",
                  record: row,
                  label: row.name,
                  actionKind: "delete",
                  feedback: "Despesa excluida.",
                }))}
                deactivateLabel="Pagar"
              />
            </td>
          </tr>
        )}
        searchPlaceholder="Buscar por despesa, categoria, vencimento, valor ou status"
        searchText={(row) => [row.name, row.category, row.due, row.value, row.status].join(" ")}
      />
    </div>
  );
}

function FinanceForecast({ data, onAction, runtimeData }) {
  const openReceivables = data.receivables.filter((item) => !["Pago", "Cancelado"].includes(item.status));
  const summary = runtimeData?.reportData?.summary;
  const total = summary ? Number(summary.receivables || 0) : openReceivables.reduce((sum, item) => sum + parseMoney(item.value), 0);
  const openCount = summary ? Number(summary.receivableCount || 0) : openReceivables.length;
  return (
    <div className="screen-grid">
      <FeaturePanel title="Projecao semanal" icon={TrendingUp} action="Exportar">
        <SummaryLine label="Recebiveis em aberto" value={formatCurrency(total)} />
        <SummaryLine label="Lancamentos considerados" value={String(openCount)} />
        <SummaryLine label="Periodo" value="Conforme vencimentos cadastrados" />
      </FeaturePanel>
      <FeaturePanel title="Categorias" icon={SlidersHorizontal} action="Gerenciar" onAction={() => onAction("genericConfig", { title: "Categoria financeira", label: "Categoria", feedback: "Categoria financeira salva." })}>
        <TagList items={["Mercadoria", "Operacional", "Pessoas", "Impostos", "Marketing"]} />
      </FeaturePanel>
    </div>
  );
}

function ServiceOrdersPage({ data, onAction, runtimeData, workspace }) {
  const summary = runtimeData?.lists?.serviceOrders?.summary;
  const overviewOrders = summary?.queueRows || data.serviceOrders;
  const configuration = workspace?.configuration || {};
  const productionExtension = listExtensionSlots("service_orders.production", configuration)[0] || null;
  const productionContent = productionExtension ? (
    <ExtensionSlotHost
      extensionKey={productionExtension.extensionKey}
      slot="service_orders.production"
      contributionId={productionExtension.id}
      configuration={configuration}
      componentProps={{
        serviceOrders: overviewOrders,
        onAction,
        workspace,
        ui: { Toolbar, EmptyContent },
      }}
    />
  ) : <ServiceProduction serviceOrders={overviewOrders} onAction={onAction} />;
  return (
    <ModulePage
      tabs={[
        { id: "board", label: "Painel", icon: Wrench, content: <ServiceBoard serviceOrders={data.serviceOrders} overviewOrders={overviewOrders} summary={summary} onAction={onAction} runtimeData={runtimeData} configuration={configuration} /> },
        { id: "production", label: "Producao", icon: CalendarClock, content: productionContent },
      ]}
    />
  );
}

function ServiceBoard({ serviceOrders, overviewOrders = serviceOrders, summary, onAction, runtimeData, configuration }) {
  const opened = overviewOrders.filter((order) => serviceOrderStatusKey(order) === "open");
  const producing = overviewOrders.filter((order) => !["open", "ready", "delivered", "canceled"].includes(serviceOrderStatusKey(order)));
  const ready = overviewOrders.filter((order) => ["ready", "delivered"].includes(serviceOrderStatusKey(order)));
  const openedCount = summary ? Number(summary.openedCount || 0) : opened.length;
  const producingCount = summary ? Number(summary.producingCount || 0) : producing.length;
  const readyCount = summary ? Number(summary.readyCount || 0) : ready.length;
  const serviceFilters = [
    { value: "Todos", label: "Todos" },
    { value: "open", label: "Aberta" },
    { value: "producing", label: "Em andamento" },
    { value: "waiting_part", label: "Aguardando recurso" },
    { value: "ready", label: "Pronto" },
    { value: "delivered", label: "Entregue" },
    { value: "canceled", label: "Cancelada" },
    ...extensionServiceOrderFilters(configuration),
  ];

  return (
    <div className="screen-grid">
      <div className="panel panel-section span-2">
        <Toolbar title="Painel de OS" description="Acompanhamento por etapa e prazo." icon={Wrench} action="Nova OS" onAction={() => onAction("serviceOrder")} />
        <div className="kanban-row">
          <KanbanColumn title="Aberta" count={String(openedCount)} items={opened.slice(0, 6).map((item) => `${item.id} - ${item.customer}`)} />
          <KanbanColumn title="Em andamento" count={String(producingCount)} items={producing.slice(0, 6).map((item) => `${item.id} - ${item.customer}`)} />
          <KanbanColumn title="Pronto" count={String(readyCount)} items={ready.slice(0, 6).map((item) => `${item.id} - ${item.customer}`)} />
        </div>
      </div>
      <div className="panel panel-section span-2">
        <Toolbar title="Ordens recentes" description="Busca por OS, cliente, etapa, prazo e responsavel." icon={Wrench} />
        <OperationalList
          {...runtimeOperationalListProps(runtimeData, "serviceOrders")}
          columns={["OS", "Cliente", "Servico", "Status", "Prazo", "Responsavel", "Acoes"]}
          emptyDescription="Ajuste a busca, mude o filtro ou abra uma nova OS."
          emptyTitle="Nenhuma OS encontrada"
          filters={serviceFilters}
          filter={(row, activeFilter) => activeFilter === "Todos"
            || serviceOrderStatusKey(row) === activeFilter
            || (activeFilter === "producing" && !["open", "ready", "delivered", "canceled"].includes(serviceOrderStatusKey(row)))}
          getItemKey={(row) => row.id}
          items={serviceOrders}
          renderRow={(row) => (
            <tr key={row.id}>
              <td><strong>{row.id}</strong></td>
              <td className="entity-main-cell"><strong>{row.customer}</strong><small>{row.service || "Servico nao informado"}</small></td>
              <td>{row.service || "-"}</td>
              <td><StatusPill status={row.status} /></td>
              <td>{row.due}</td>
              <td>{row.owner}</td>
              <td>
                <RowActions
                  onEdit={() => onAction("serviceOrder", editRecordPayload(row))}
                  onDeactivate={() => onAction("confirmAction", confirmRecordPayload({
                    collection: "serviceOrders",
                    record: row,
                    label: row.id,
                    nextStatus: "Cancelada",
                    feedback: "OS cancelada.",
                  }))}
                  deactivateLabel="Cancelar"
                />
              </td>
            </tr>
          )}
          searchPlaceholder="Buscar por OS, cliente, servico, status, prazo ou responsavel"
          searchText={(row) => [row.id, row.customer, row.service, row.status, row.due, row.owner].join(" ")}
        />
      </div>
    </div>
  );
}

function ServiceProduction({ serviceOrders, onAction }) {
  const activeOrders = serviceOrders.filter((order) => serviceOrderStatusKey(order) !== "canceled");
  const queues = serviceProductionQueues(activeOrders);
  return (
    <div className="panel panel-section">
      <Toolbar
        title="Fila de execucao"
        description="Ordens de servico organizadas pelo proximo passo operacional."
        icon={CalendarClock}
        action="Atualizar etapa"
        onAction={() => onAction("genericConfig", { title: "Atualizar execucao", label: "Etapa", defaultName: "Em producao", feedback: "Etapa atualizada." })}
      />
      <div className="production-queue-grid">
        {queues.map((queue) => (
          <ProductionQueueColumn key={queue.id} queue={queue} onAction={onAction} />
        ))}
      </div>
      {!activeOrders.length ? <EmptyContent icon={CalendarClock} title="Nenhuma OS em andamento" description="Ordens abertas e em execucao aparecerao aqui." /> : null}
    </div>
  );
}

function serviceProductionQueues(serviceOrders) {
  const queues = [
    { id: "open", title: "Aguardando inicio", description: "Ordens abertas aguardando atendimento.", items: [] },
    { id: "waiting", title: "Aguardando recurso", description: "Dependencias, pecas ou informacoes pendentes.", items: [] },
    { id: "production", title: "Em andamento", description: "Servico em execucao e acompanhamento.", items: [] },
    { id: "delivery", title: "Pronto", description: "Servico concluido ou pronto para entrega.", items: [] },
  ];
  const byId = Object.fromEntries(queues.map((queue) => [queue.id, queue]));
  serviceOrders.forEach((order) => {
    const nextStep = serviceOrderNextStep(order);
    byId[nextStep.queue].items.push({ ...order, nextStep });
  });
  return queues;
}

function serviceOrderNextStep(order) {
  const status = serviceOrderStatusKey(order);
  if (["ready", "delivered"].includes(status)) return { queue: "delivery", label: "Concluir", action: "Concluir" };
  if (status === "waiting_part") return { queue: "waiting", label: "Resolver pendencia", action: "Resolver" };
  if (status === "open") return { queue: "open", label: "Iniciar atendimento", action: "Iniciar" };
  return { queue: "production", label: "Atualizar etapa", action: "Atualizar" };
}

function serviceOrderStatusKey(order) {
  return order?.statusKey || order?.status || "open";
}

function ProductionQueueColumn({ queue, onAction }) {
  return (
    <div className="production-queue-column">
      <div className="kanban-title">
        <div>
          <strong>{queue.title}</strong>
          <small>{queue.description}</small>
        </div>
        <span>{queue.items.length}</span>
      </div>
      {queue.items.map((order) => (
        <div className="production-queue-card" key={order.id}>
          <div>
            <strong>{order.id} - {order.customer}</strong>
            <small>{order.service || "Servico nao informado"} | Prazo: {order.due || "nao informado"}</small>
          </div>
          <StatusPill status={order.status} />
          <button className="table-action" type="button" onClick={() => onAction("serviceOrder", editRecordPayload(order))}>
            {order.nextStep.action}
          </button>
        </div>
      ))}
      {!queue.items.length ? <span className="production-queue-empty">Sem pendencias agora.</span> : null}
    </div>
  );
}

function commercialStatusLabel(status) {
  const labels = {
    active: "Ativo",
    contracted: "Contratado",
    configuring: "Configurando",
    suspended: "Suspenso",
    available: "Disponivel",
    coming_soon: "Em breve",
  };
  return labels[String(status || "").toLowerCase()] || status || "Disponivel";
}

function commercialPlanPrice(plan) {
  if (plan?.monthlyPriceCents === null || plan?.monthlyPriceCents === undefined) return "Incluso/contratado a parte";
  if (Number(plan.monthlyPriceCents) === 0) return "Gratis";
  return `${formatCurrency(Number(plan.monthlyPriceCents) / 100)}/mes`;
}

function commercialPlanLimit(plan) {
  const entry = Object.entries(plan?.limits || {}).find(([, value]) => value !== undefined && value !== null && Number.isFinite(Number(value)));
  if (!entry) return "";
  const [, limit] = entry;
  return `${Number(limit).toLocaleString("pt-BR")} unidades/mes`;
}

function CommercialProductCard({ product, onAction, isMasterUser, canManageServices }) {
  const plans = Array.isArray(product.plans) ? product.plans : [];
  const canMasterManage = isMasterUser && product.key !== "core" && !product.comingSoon;
  const canRequest = !isMasterUser
    && canManageServices
    && !product.comingSoon
    && product.key !== "core"
    && ["available", "suspended"].includes(product.status);
  const actionLabel = canMasterManage
    ? "Gerenciar"
    : canRequest
      ? product.status === "suspended" ? "Solicitar reativacao" : "Solicitar ativacao"
      : null;

  const actionPayload = {
    productKey: product.key,
    productName: product.name,
    status: product.status,
    planKey: product.planKey,
    masterMode: Boolean(isMasterUser),
    plans: plans.map((plan) => ({
      ...plan,
      priceLabel: commercialPlanPrice(plan),
      limitLabel: commercialPlanLimit(plan),
    })),
  };

  return (
    <article className={`commercial-product-card ${product.active ? "commercial-product-card--active" : ""}`}>
      <header className="commercial-product-card__header">
        <div>
          <span className="commercial-product-card__kind">
            {product.kind === "vertical" ? "Vertical" : product.kind === "service" ? "Servico" : product.kind === "channel" ? "Canal" : "Base"}
          </span>
          <h3>{product.name}</h3>
        </div>
        <StatusPill status={commercialStatusLabel(product.status)} />
      </header>
      <p className="commercial-product-card__description">{product.description}</p>

      {product.selectedPlan && product.status !== "available" && product.status !== "coming_soon" ? (
        <div className="commercial-current-plan">
          <strong>{product.selectedPlan.name}</strong>
          <span>{[commercialPlanLimit(product.selectedPlan), commercialPlanPrice(product.selectedPlan)].filter(Boolean).join(" · ")}</span>
        </div>
      ) : null}

      {plans.length > 1 ? (
        <div className="commercial-plan-grid">
          {plans.map((plan) => (
            <div className={`commercial-plan-mini ${product.planKey === plan.key ? "commercial-plan-mini--selected" : ""}`} key={plan.key}>
              <strong>{plan.name}</strong>
              <span>{commercialPlanLimit(plan)}</span>
              <b>{commercialPlanPrice(plan)}</b>
              {plan.featured ? <small>Mais indicado</small> : null}
            </div>
          ))}
        </div>
      ) : null}

      {product.usage && product.status !== "available" && product.status !== "coming_soon" ? (
        <div className="commercial-usage">
          <div className="commercial-usage__header">
            <span>Uso no mes</span>
            <strong>{product.usage.used.toLocaleString("pt-BR")} / {product.usage.limit?.toLocaleString?.("pt-BR") ?? "∞"}</strong>
          </div>
          {product.usage.limit ? <div className="commercial-usage__bar"><span style={{ width: `${product.usage.percent}%` }} /></div> : null}
          <small>{product.usage.remaining === null ? "Sem limite configurado" : `${product.usage.remaining.toLocaleString("pt-BR")} disponiveis`}</small>
        </div>
      ) : null}

      <footer className="commercial-product-card__footer">
        {product.comingSoon ? <span>Disponibilidade futura no ecossistema Volt.</span> : null}
        {product.status === "contracted" && !isMasterUser ? <span>Solicitacao recebida. Aguardando configuracao.</span> : null}
        {product.status === "configuring" && !isMasterUser ? <span>Configuracao em andamento.</span> : null}
        {actionLabel ? (
          <button className="button-primary" type="button" onClick={() => onAction("commercialProduct", actionPayload)}>
            {actionLabel}
          </button>
        ) : null}
      </footer>
    </article>
  );
}

function CommercialCatalogSection({ products, emptyText, onAction, isMasterUser, canManageServices }) {
  if (!products.length) return <div className="empty-state compact"><BriefcaseBusiness size={28} /><strong>{emptyText}</strong></div>;
  return (
    <div className="commercial-product-grid">
      {products.map((product) => (
        <CommercialProductCard
          key={product.key}
          product={product}
          onAction={onAction}
          isMasterUser={isMasterUser}
          canManageServices={canManageServices}
        />
      ))}
    </div>
  );
}

function VoltServicesPage({ workspace, onAction, isMasterUser, canManageServices }) {
  const commercial = workspace?.configuration?.commercial || { products: [], summary: {} };
  const products = commercial.products || [];
  const core = products.find((product) => product.key === "core");
  const verticals = products.filter((product) => product.kind === "vertical");
  const services = products.filter((product) => product.kind === "service");
  const channels = products.filter((product) => product.kind === "channel");
  const summary = commercial.summary || {};

  return (
    <div className="services-store-page">
      <section className="panel services-store-hero">
        <div>
          <span className="services-store-hero__eyebrow">Ecossistema Volt</span>
          <h2>Monte o Volt conforme a sua operacao</h2>
          <p>O DACHBYTE Core e a base. Verticais, servicos e canais sao adicionados conforme a necessidade de cada empresa.</p>
        </div>
        <div className="services-store-hero__core">
          <StatusPill status="Ativo" />
          <strong>{core?.name || "DACHBYTE Core"}</strong>
          <span>Plano {summary.corePlanKey || workspace?.configuration?.planKey || "starter"}</span>
        </div>
      </section>

      <div className="report-grid commercial-summary-grid">
        <ReportCard icon={Glasses} title="Verticais ativos" value={String(summary.verticals || 0)} detail="Nichos adicionados ao Core" />
        <ReportCard icon={FileCheck2} title="Servicos ativos" value={String(summary.services || 0)} detail="Add-ons contratados" />
        <ReportCard icon={Store} title="Canais ativos" value={String(summary.channels || 0)} detail="Marketplaces e canais externos" />
      </div>

      <ModulePage tabs={[
        {
          id: "verticals",
          label: "Verticais",
          icon: Glasses,
          content: <CommercialCatalogSection products={verticals} emptyText="Nenhum vertical disponivel" onAction={onAction} isMasterUser={isMasterUser} canManageServices={canManageServices} />,
        },
        {
          id: "services",
          label: "Servicos",
          icon: BriefcaseBusiness,
          content: <CommercialCatalogSection products={services} emptyText="Nenhum servico disponivel" onAction={onAction} isMasterUser={isMasterUser} canManageServices={canManageServices} />,
        },
        {
          id: "channels",
          label: "Canais",
          icon: Store,
          content: <CommercialCatalogSection products={channels} emptyText="Nenhum canal disponivel" onAction={onAction} isMasterUser={isMasterUser} canManageServices={canManageServices} />,
        },
      ]} />
    </div>
  );
}


function ReportsPage({ data, onAction, runtimeData }) {
  const [filters, setFilters] = useState({ search: "", status: "", dateFrom: "", dateTo: "" });
  const hasServerReports = Boolean(runtimeData?.loadReports);
  const fallbackReportData = useMemo(() => buildClientReports(data, filters), [data, filters]);
  const reportData = runtimeData?.reportData
    ? normalizeServerReports(runtimeData.reportData)
    : (hasServerReports ? null : fallbackReportData);
  const reportError = runtimeData?.lists?.reports?.error || "";

  useEffect(() => {
    if (!runtimeData?.loadReports) return undefined;
    const timer = window.setTimeout(() => {
      runtimeData.loadReports(filters).catch(() => {});
    }, filters.search ? 320 : 0);
    return () => window.clearTimeout(timer);
  }, [filters.search, filters.status, filters.dateFrom, filters.dateTo]);

  if (hasServerReports && !reportData) {
    return (
      <div className="panel panel-section">
        <SectionTitle
          icon={BarChart3}
          title={reportError ? "Nao foi possivel carregar os relatorios" : "Carregando relatorios"}
          description={reportError || "Calculando os indicadores diretamente no servidor..."}
        />
      </div>
    );
  }

  return (
    <ModulePage
      tabs={[
        { id: "overview", label: "Visao geral", icon: BarChart3, content: <ReportsOverview reports={reportData} filters={filters} setFilters={setFilters} /> },
        { id: "sales", label: "Vendas", icon: ShoppingCart, content: <ReportsSales reports={reportData} filters={filters} setFilters={setFilters} /> },
        { id: "inventory", label: "Estoque", icon: Boxes, content: <ReportsInventory reports={reportData} filters={filters} setFilters={setFilters} /> },
        { id: "finance", label: "Financeiro", icon: Landmark, content: <ReportsFinance reports={reportData} filters={filters} setFilters={setFilters} /> },
        { id: "exports", label: "Exportar", icon: Download, content: <ReportsExports reports={reportData} onAction={onAction} /> },
      ]}
    />
  );
}

function normalizeServerReports(report = {}) {
  const summary = report.summary || {};
  return {
    sales: report.sales || [],
    movements: report.movements || [],
    expenses: report.expenses || [],
    receivables: report.receivables || [],
    products: report.products || [],
    lowStock: report.lowStock || report.products || [],
    counts: {
      sales: Number(summary.salesCount || 0),
      expenses: Number(summary.expenseCount || 0),
      receivables: Number(summary.receivableCount || 0),
      products: Number(summary.productCount || 0),
      lowStock: Number(summary.lowStockCount || 0),
      movements: Number(report.detailPagination?.inventoryMovements?.total || (report.movements || []).length),
    },
    totals: {
      revenue: Number(summary.revenue || 0),
      ticket: Number(summary.ticket || 0),
      expenses: Number(summary.expenses || 0),
      receivables: Number(summary.receivables || 0),
      net: Number(summary.net || 0),
    },
  };
}

function buildClientReports(data, filters) {
  const search = filters.search.trim().toLowerCase();
  const filteredSales = data.sales.filter((sale) => {
    const haystack = [sale.id, sale.customer, sale.items, sale.status, sale.payment].join(" ").toLowerCase();
    if (search && !haystack.includes(search)) return false;
    if (filters.status && sale.status !== filters.status) return false;
    return matchesReportDate(sale.date || sale.soldAt || sale.id, filters);
  });
  const filteredMovements = data.movements.filter((movement) => {
    const haystack = [movement.type, movement.product, movement.reason, movement.user].join(" ").toLowerCase();
    if (search && !haystack.includes(search)) return false;
    return matchesReportDate(movement.date, filters);
  });
  const filteredExpenses = data.expenses.filter((expense) => {
    const haystack = [expense.name, expense.category, expense.status].join(" ").toLowerCase();
    if (search && !haystack.includes(search)) return false;
    if (filters.status && expense.status !== filters.status) return false;
    return matchesReportDate(expense.due, filters);
  });
  const filteredReceivables = data.receivables.filter((receivable) => {
    const haystack = [receivable.customer, receivable.origin, receivable.status].join(" ").toLowerCase();
    if (search && !haystack.includes(search)) return false;
    if (filters.status && receivable.status !== filters.status) return false;
    return matchesReportDate(receivable.due, filters);
  });
  const revenue = filteredSales.reduce((sum, sale) => sum + parseMoney(sale.total), 0);
  const openReceivables = filteredReceivables.filter((row) => !["Pago", "Cancelado"].includes(row.status));
  const expensesTotal = filteredExpenses.reduce((sum, expense) => sum + parseMoney(expense.value), 0);
  const lowStock = data.products.filter((product) => product.category !== "Servico" && Number(product.stock || 0) <= Number(product.min || 0));

  return {
    sales: filteredSales,
    movements: filteredMovements,
    expenses: filteredExpenses,
    receivables: filteredReceivables,
    products: data.products,
    lowStock,
    counts: {
      sales: filteredSales.length,
      expenses: filteredExpenses.length,
      receivables: filteredReceivables.length,
      products: data.products.length,
      lowStock: lowStock.length,
      movements: filteredMovements.length,
    },
    totals: {
      revenue,
      ticket: filteredSales.length ? revenue / filteredSales.length : 0,
      expenses: expensesTotal,
      receivables: openReceivables.reduce((sum, row) => sum + parseMoney(row.value), 0),
      net: revenue - expensesTotal,
    },
  };
}

function ReportsOverview({ reports, filters, setFilters }) {
  return (
    <>
      <ReportFilters filters={filters} setFilters={setFilters} />
      <div className="report-grid">
        <ReportCard icon={TrendingUp} title="Vendas filtradas" value={formatCurrency(reports.totals.revenue)} detail={`${reports.counts?.sales ?? reports.sales.length} vendas - ticket ${formatCurrency(reports.totals.ticket)}`} />
        <ReportCard icon={Landmark} title="Resultado previsto" value={formatCurrency(reports.totals.net)} detail={`${formatCurrency(reports.totals.expenses)} em despesas`} />
        <ReportCard icon={WalletCards} title="Recebiveis abertos" value={formatCurrency(reports.totals.receivables)} detail={`${reports.counts?.receivables ?? reports.receivables.length} lancamentos filtrados`} />
        <ReportCard icon={Boxes} title="Estoque critico" value={String(reports.counts?.lowStock ?? reports.lowStock.length)} detail={`${reports.counts?.products ?? reports.products.length} itens no catalogo`} />
      </div>
    </>
  );
}

function ReportsSales({ reports, filters, setFilters }) {
  return (
    <>
      <ReportFilters filters={filters} setFilters={setFilters} />
      <div className="panel panel-section">
        <Toolbar title="Vendas detalhadas" description="Resultado filtrado com busca e paginacao." icon={ShoppingCart} />
        <OperationalList
          columns={["Venda", "Cliente", "Itens", "Status", "Total", "Pagamento"]}
          emptyDescription="Ajuste os filtros do relatorio para encontrar vendas."
          emptyTitle="Nenhuma venda no periodo"
          filters={["Todos", "Finalizada", "Cancelada"].map((item) => ({ value: item, label: item }))}
          filter={(sale, activeFilter) => activeFilter === "Todos" || sale.status === activeFilter}
          getItemKey={(sale) => sale.id}
          items={reports.sales}
          renderRow={(sale) => (
            <tr key={sale.id}>
              <td><strong>{sale.id}</strong></td>
              <td className="entity-main-cell"><strong>{sale.customer}</strong><small>{sale.payment || "Pagamento nao informado"}</small></td>
              <td>{sale.items}</td>
              <td><StatusPill status={sale.status} /></td>
              <td><strong>{sale.total}</strong></td>
              <td>{sale.payment}</td>
            </tr>
          )}
          searchPlaceholder="Buscar por venda, cliente, itens, status, total ou pagamento"
          searchText={(sale) => [sale.id, sale.customer, sale.items, sale.status, sale.total, sale.payment].join(" ")}
        />
      </div>
    </>
  );
}

function ReportsInventory({ reports, filters, setFilters }) {
  return (
    <>
      <ReportFilters filters={filters} setFilters={setFilters} />
      <div className="screen-grid">
        <div className="panel panel-section span-2">
          <Toolbar title="Movimento de estoque" description="Movimentacoes filtradas com busca por produto e motivo." icon={Boxes} />
          <OperationalList
            columns={["Tipo", "Produto", "Qtd.", "Motivo", "Usuario", "Data"]}
            emptyDescription="Ajuste os filtros do relatorio para encontrar movimentacoes."
            emptyTitle="Nenhuma movimentacao no periodo"
            filters={["Todos", "Entrada", "Saida", "Ajuste"].map((item) => ({ value: item, label: item }))}
            filter={(movement, activeFilter) => activeFilter === "Todos" || movement.type === activeFilter}
            getItemKey={(movement) => movement.id || `${movement.product}-${movement.date}-${movement.quantity}`}
            items={reports.movements}
            renderRow={(movement) => (
              <tr key={movement.id || `${movement.product}-${movement.date}-${movement.quantity}`}>
                <td><StatusPill status={movement.type} /></td>
                <td className="entity-main-cell"><strong>{movement.product}</strong><small>{movement.reason || "Sem motivo"}</small></td>
                <td>{movement.quantity}</td>
                <td>{movement.reason}</td>
                <td>{movement.user}</td>
                <td>{movement.date}</td>
              </tr>
            )}
            searchPlaceholder="Buscar por tipo, produto, quantidade, motivo, usuario ou data"
            searchText={(movement) => [movement.type, movement.product, movement.quantity, movement.reason, movement.user, movement.date].join(" ")}
          />
        </div>
        <FeaturePanel title="Alertas de estoque" icon={CalendarClock} action="Exportar" onAction={() => exportReportRows("estoque-critico.csv", reports.lowStock, "inventory")}>
          {reports.lowStock.length ? reports.lowStock.map((product) => (
            <AlertRow key={product.sku} title={product.name} detail={`${product.stock} em estoque - minimo ${product.min}`} severity="warning" />
          )) : <AlertRow title="Sem itens criticos" detail="Nenhum produto abaixo do minimo no filtro atual." severity="success" />}
        </FeaturePanel>
      </div>
    </>
  );
}

function ReportsFinance({ reports, filters, setFilters }) {
  const cashIn = Number(reports.totals?.revenue ?? reports.sales.reduce((sum, sale) => sum + parseMoney(sale.total), 0));
  const cashOut = Number(reports.totals?.expenses ?? reports.expenses.reduce((sum, expense) => sum + parseMoney(expense.value), 0));
  const pending = reports.receivables.filter((row) => row.status !== "Pago");
  const pendingTotal = Number(reports.totals?.receivables ?? pending.reduce((sum, row) => sum + parseMoney(row.value), 0));

  return (
    <>
      <ReportFilters filters={filters} setFilters={setFilters} />
      <div className="report-grid">
        <ReportCard icon={TrendingUp} title="Entradas no filtro" value={formatCurrency(cashIn)} detail={`${reports.counts?.sales ?? reports.sales.length} vendas consideradas`} />
        <ReportCard icon={FileText} title="Saidas no filtro" value={formatCurrency(cashOut)} detail={`${reports.counts?.expenses ?? reports.expenses.length} despesas consideradas`} />
        <ReportCard icon={WalletCards} title="Recebiveis pendentes" value={formatCurrency(pendingTotal)} detail={`${reports.counts?.receivables ?? pending.length} titulos considerados`} />
        <ReportCard icon={Landmark} title="Resultado" value={formatCurrency(cashIn - cashOut)} detail="Vendas menos despesas filtradas" />
      </div>
      <div className="panel panel-section">
        <Toolbar title="Financeiro detalhado" description="Despesas e recebiveis filtrados em uma lista unica." icon={Landmark} />
        <OperationalList
          columns={["Tipo", "Nome/Cliente", "Origem/Categoria", "Vencimento", "Valor", "Status"]}
          emptyDescription="Ajuste os filtros do relatorio para encontrar lancamentos."
          emptyTitle="Nenhum lancamento no periodo"
          filters={["Todos", "Despesa", "Recebivel", "Aberto", "Pago", "Cancelado"].map((item) => ({ value: item, label: item }))}
          filter={(row, activeFilter) => activeFilter === "Todos" || row.kind === activeFilter || row.status === activeFilter}
          getItemKey={(row) => `${row.kind}-${row.name}-${row.origin}-${row.due}`}
          items={[...reports.expenses.map((expense) => ({ kind: "Despesa", name: expense.name, origin: expense.category, due: expense.due, value: expense.value, status: expense.status })),
            ...reports.receivables.map((receivable) => ({ kind: "Recebivel", name: receivable.customer, origin: receivable.origin, due: receivable.due, value: receivable.value, status: receivable.status }))]}
          renderRow={(row) => (
            <tr key={`${row.kind}-${row.name}-${row.origin}-${row.due}`}>
              <td>{row.kind}</td>
              <td className="entity-main-cell"><strong>{row.name}</strong><small>{row.origin}</small></td>
              <td>{row.origin}</td>
              <td>{row.due}</td>
              <td><strong>{row.value}</strong></td>
              <td><StatusPill status={row.status} /></td>
            </tr>
          )}
          searchPlaceholder="Buscar por tipo, cliente, origem, vencimento, valor ou status"
          searchText={(row) => [row.kind, row.name, row.origin, row.due, row.value, row.status].join(" ")}
        />
      </div>
    </>
  );
}

function ReportsExports({ reports, onAction }) {
  return (
    <div className="screen-grid">
      <FeaturePanel title="Exportacoes" icon={Download} action="Baixar CSV" onAction={() => exportReportRows("vendas.csv", reports.sales, "sales")}>
        <QuickRow title="Vendas detalhadas" subtitle={`${reports.counts?.sales ?? reports.sales.length} vendas filtradas`} action="CSV" icon={FileText} onClick={() => exportReportRows("vendas.csv", reports.sales, "sales")} />
        <QuickRow title="Movimento de estoque" subtitle={`${reports.counts?.movements ?? reports.movements.length} movimentacoes`} action="CSV" icon={Boxes} onClick={() => exportReportRows("estoque.csv", reports.movements, "movements")} />
        <QuickRow title="Financeiro" subtitle={`${reports.counts?.expenses ?? reports.expenses.length} despesas e ${reports.counts?.receivables ?? reports.receivables.length} recebiveis`} action="CSV" icon={Landmark} onClick={() => exportReportRows("financeiro.csv", [...reports.expenses, ...reports.receivables], "finance")} />
      </FeaturePanel>
      <FeaturePanel title="Agendamento" icon={CalendarClock} action="Criar" onAction={() => onAction("genericConfig", { title: "Agendamento de relatorio", label: "Nome", defaultName: "Resumo diario", feedback: "Agendamento preparado." })}>
        <ToggleList items={["Enviar resumo diario", "Enviar fechamento semanal", "Enviar estoque baixo", "Enviar recebiveis vencidos"]} />
      </FeaturePanel>
    </div>
  );
}

function ReportFilters({ filters, setFilters }) {
  function updateFilter(name, value) {
    setFilters((current) => ({ ...current, [name]: value }));
  }

  return (
    <div className="panel panel-section report-filters">
      <label className="field-label">
        Buscar
        <input className="input" value={filters.search} placeholder="Cliente, venda, produto ou status" onChange={(event) => updateFilter("search", event.target.value)} />
      </label>
      <label className="field-label">
        Status
        <select className="input" value={filters.status} onChange={(event) => updateFilter("status", event.target.value)}>
          <option value="">Todos</option>
          <option value="Finalizada">Finalizada</option>
          <option value="Pendente">Pendente</option>
          <option value="Aberto">Aberto</option>
          <option value="Pago">Pago</option>
          <option value="Cancelada">Cancelada</option>
        </select>
      </label>
      <label className="field-label">
        De
        <input className="input" type="date" value={filters.dateFrom} onChange={(event) => updateFilter("dateFrom", event.target.value)} />
      </label>
      <label className="field-label">
        Ate
        <input className="input" type="date" value={filters.dateTo} onChange={(event) => updateFilter("dateTo", event.target.value)} />
      </label>
      <button className="button-secondary" type="button" onClick={() => setFilters({ search: "", status: "", dateFrom: "", dateTo: "" })}>Limpar</button>
    </div>
  );
}

function exportReportRows(filename, rows, type) {
  const columnsByType = {
    sales: [
      { key: "id", label: "Venda" },
      { key: "customer", label: "Cliente" },
      { key: "items", label: "Itens" },
      { key: "status", label: "Status" },
      { key: "total", label: "Total" },
      { key: "payment", label: "Pagamento" },
    ],
    movements: [
      { key: "type", label: "Tipo" },
      { key: "product", label: "Produto" },
      { key: "quantity", label: "Quantidade" },
      { key: "reason", label: "Motivo" },
      { key: "user", label: "Usuario" },
      { key: "date", label: "Data" },
    ],
    inventory: [
      { key: "sku", label: "SKU" },
      { key: "name", label: "Produto" },
      { key: "category", label: "Categoria" },
      { key: "stock", label: "Estoque" },
      { key: "min", label: "Minimo" },
      { key: "status", label: "Status" },
    ],
    finance: [
      { key: "name", label: "Nome" },
      { key: "customer", label: "Cliente" },
      { key: "category", label: "Categoria" },
      { key: "origin", label: "Origem" },
      { key: "due", label: "Vencimento" },
      { key: "value", label: "Valor" },
      { key: "status", label: "Status" },
    ],
    audit: [
      { key: "date", label: "Data" },
      { key: "time", label: "Hora" },
      { key: "actor", label: "Ator" },
      { key: "title", label: "Evento" },
      { key: "entityType", label: "Entidade" },
      { key: "entityId", label: "ID entidade" },
      { key: "status", label: "Status" },
      { key: "description", label: "Descricao" },
    ],
  };
  downloadCsv(filename, rows, columnsByType[type] || columnsByType.sales);
}

function SettingsPage({ data, onAction }) {
  return (
    <ModulePage
      tabs={[
        { id: "rules", label: "Regras operacionais", icon: Settings, content: <RulesSettings settings={data.settings} onAction={onAction} /> },
        { id: "company", label: "Empresa", icon: Store, content: <CompanySettings settings={data.settings} onAction={onAction} /> },
        { id: "fields", label: "Campos avancados", icon: SlidersHorizontal, content: <FieldsSettings customFields={data.customFields} onAction={onAction} /> },
        { id: "workflows", label: "Workflows", icon: Wrench, content: <WorkflowSettings workflows={data.workflows || []} onAction={onAction} /> },
        { id: "branding", label: "Identidade", icon: PanelsTopLeft, content: <BrandingSettings onAction={onAction} /> },
      ]}
    />
  );
}

function CompanySettings({ settings, onAction }) {
  return (
    <div className="screen-grid">
      <FeaturePanel title="Dados da empresa" icon={Store} action="Salvar" onAction={() => onAction("settings", settings)}>
        <SummaryLine label="Nome fantasia" value={settings.companyName || "Nao informado"} />
        <SummaryLine label="Razao social" value={settings.legalName || "Nao informada"} />
        <SummaryLine label="CNPJ" value={settings.document || "Nao informado"} />
        <SummaryLine label="Contato" value={[settings.phone, settings.email].filter(Boolean).join(" / ") || "Nao informado"} />
      </FeaturePanel>
      <FeaturePanel title="Implantacao setorial" icon={PanelsTopLeft} action="Aplicar template" onAction={() => onAction("genericConfig", { title: "Aplicar template", label: "Template", defaultName: "Core padrao", feedback: "Template preparado para aplicacao." })}>
        <TagList items={["Empresa padrao", "Otica", "Loja comum", "Assistencia tecnica"]} />
      </FeaturePanel>
    </div>
  );
}

function FieldsSettings({ customFields, onAction }) {
  return (
    <DataPanel title="Campos avancados" icon={SlidersHorizontal} columns={["Campo", "Modulo", "Tipo", "Obrigatorio", "Acao"]} onAction={() => onAction("customField")}>
      {customFields.map((field) => (
        <tr key={field.name}>
          <td>{field.name}</td>
          <td>{field.module}</td>
          <td>{field.type}</td>
          <td>{field.required}</td>
          <td>
            <RowActions
              onEdit={() => onAction("customField", editRecordPayload(field))}
              onDelete={() => onAction("confirmAction", confirmRecordPayload({
                collection: "customFields",
                record: field,
                label: field.name,
                actionKind: "delete",
                feedback: "Campo personalizado excluido.",
              }))}
            />
          </td>
        </tr>
      ))}
    </DataPanel>
  );
}

function WorkflowSettings({ workflows, onAction }) {
  return (
    <DataPanel title="Workflows operacionais" icon={Wrench} columns={["Workflow", "Chave", "Inicial", "Estados", "Acao"]} onAction={() => onAction("workflow")}>
      {(workflows || []).map((workflow) => (
        <tr key={workflow.key || workflow.name}>
          <td>{workflow.name || workflow.key}</td>
          <td>{workflow.key}</td>
          <td>{workflow.initial || "-"}</td>
          <td>{Array.isArray(workflow.states) ? workflow.states.length : 0}</td>
          <td>
            <RowActions
              onEdit={() => onAction("workflow", editRecordPayload(workflow))}
              onDelete={() => onAction("confirmAction", confirmRecordPayload({
                collection: "workflows",
                record: workflow,
                label: workflow.name || workflow.key,
                actionKind: "delete",
                feedback: "Workflow excluido.",
              }))}
            />
          </td>
        </tr>
      ))}
    </DataPanel>
  );
}

function RulesSettings({ settings, onAction }) {
  return (
    <div className="screen-grid">
      <FeaturePanel title="Parametros operacionais" icon={Settings} action="Editar regras" onAction={() => onAction("operationalRules", settings)}>
        <SummaryLine label="Venda sem estoque" value="Bloqueada" />
        <SummaryLine label="Cliente avulso" value={settings.allowAnonymousCustomer ? "Permitido" : "Bloqueado"} />
        <SummaryLine label="Caixa aberto" value={settings.requireOpenCashSession ? "Obrigatorio" : "Opcional"} />
        <SummaryLine label="Motivo em ajuste" value={settings.requireInventoryAdjustmentReason ? "Obrigatorio" : "Opcional"} />
      </FeaturePanel>
      <FeaturePanel title="Numeracao" icon={FileText} action="Atualizar" onAction={() => onAction("genericConfig", { title: "Numeracao", label: "Serie", feedback: "Numeracao atualizada." })}>
        <SummaryLine label="Vendas" value="Sequencial automatico" />
        <SummaryLine label="Ordens de servico" value="Sequencial automatico" />
        <SummaryLine label="Recibos" value="Sequencial automatico" />
      </FeaturePanel>
    </div>
  );
}

function BrandingSettings({ onAction }) {
  return (
    <div className="screen-grid">
      <FeaturePanel title="Identidade da empresa" icon={PanelsTopLeft} action="Salvar" onAction={() => onAction("genericConfig", { title: "Identidade visual", label: "Cor principal", defaultName: "#2478f2", feedback: "Identidade salva." })}>
        <FormGrid fields={["Logo", "Cor principal", "Mensagem do recibo", "Rodape impresso"]} />
      </FeaturePanel>
      <FeaturePanel title="Preferencias de interface" icon={Eye} action="Preview" onAction={() => onAction("genericConfig", { title: "Preview da experiencia", label: "Modo", defaultName: "Compacto", feedback: "Preview preparado." })}>
        <ToggleList items={["Exibir atalhos no dashboard", "Exibir atalhos contratados", "Mostrar modulos opcionais", "Modo compacto"]} />
      </FeaturePanel>
    </div>
  );
}

function UsersPage({ data, onAction, isMaster, canManage, runtimeData }) {
  const tabs = [
    { id: "team", label: isMaster ? "Todos usuarios" : "Equipe", icon: UserCog, content: <UsersTeam users={data.users} companies={data.masterCompanies} onAction={onAction} isMaster={isMaster} canManage={canManage} runtimeData={runtimeData} /> },
    ...(!isMaster ? [
      { id: "roles", label: "Permissoes", icon: ShieldCheck, content: <UsersRoles onAction={onAction} /> },
      { id: "audit", label: "Auditoria", icon: Eye, content: <UsersAudit auditEvents={data.auditEvents} onAction={onAction} runtimeData={runtimeData} /> },
    ] : []),
  ];
  return (
    <ModulePage tabs={tabs} />
  );
}

function UsersTeam({ users, companies, onAction, isMaster, canManage, runtimeData }) {
  const columns = isMaster
    ? ["Nome", "E-mail", "Empresa", "Perfil", "Ultimo acesso", "Status", "Acao"]
    : ["Nome", "Perfil", "Ultimo acesso", "Status", "Acao"];

  const rows = users.map((row) => (
    <tr key={`${row.id || row.email || row.name}-${row.companyId || "global"}`}>
      <td>{row.name}</td>
      {isMaster ? <td>{row.email || "-"}</td> : null}
      {isMaster ? <td>{row.companyName || "-"}</td> : null}
      <td>{row.role}</td>
      <td>{row.lastAccess}</td>
      <td><StatusPill status={row.status} /></td>
      <td>
        {!canManage ? <span className="muted-copy">Somente leitura</span> : isMaster ? (
          <RowActions
            onEdit={() => onAction("user", {
              ...editRecordPayload(row),
              masterContext: true,
              companies,
            })}
          />
        ) : (
          <RowActions
            onEdit={() => onAction("user", editRecordPayload(row))}
            onDeactivate={() => onAction("confirmAction", confirmRecordPayload({
              collection: "users",
              record: row,
              label: row.name,
              feedback: "Usuario desativado.",
            }))}
          />
        )}
      </td>
    </tr>
  ));

  if (isMaster) {
    return (
      <DataPanel
        title="Usuarios de todos ambientes"
        icon={UserCog}
        columns={columns}
        onAction={canManage ? () => onAction("user", { masterContext: true, companies }) : undefined}
      >
        {rows}
      </DataPanel>
    );
  }

  return (
    <div className="panel panel-section">
      <Toolbar title="Usuarios" description="Equipe da empresa com busca e paginacao no servidor." icon={UserCog} action={canManage ? "Novo usuario" : undefined} onAction={canManage ? () => onAction("user") : undefined} />
      <OperationalList
        {...runtimeOperationalListProps(runtimeData, "users")}
        columns={columns}
        emptyDescription="Ajuste a busca ou cadastre um novo usuario."
        emptyTitle="Nenhum usuario encontrado"
        getItemKey={(row) => row.id || row.email || row.name}
        items={users}
        renderRow={(row) => rows[users.indexOf(row)]}
        searchPlaceholder="Buscar por nome, e-mail, perfil ou status"
        searchText={(row) => [row.name, row.email, row.role, row.status].join(" ")}
      />
    </div>
  );
}

function UsersRoles({ onAction }) {
  const roleMatrix = [
    { role: "Owner", description: "Acesso total ao ambiente", permissions: ["Todas as permissoes", "Usuarios", "Configuracoes", "Auditoria"] },
    { role: "Gerente", description: "Gestao operacional completa", permissions: ["Vendas", "Estoque", "Caixa", "Servicos", "Relatorios"] },
    { role: "Operador", description: "Rotina de venda e atendimento", permissions: ["Clientes", "Vendas", "Relatorios leitura"] },
    { role: "Estoque", description: "Catalogo e inventario", permissions: ["Produtos", "Movimentacoes", "Exportar estoque"] },
    { role: "Financeiro", description: "Caixa e contas", permissions: ["Caixa", "Recebiveis", "Despesas", "Auditoria"] },
  ];

  return (
    <div className="screen-grid">
      <DataPanel title="Perfis e permissoes" icon={ShieldCheck} columns={["Perfil", "Descricao", "Permissoes", "Acao"]} onAction={() => onAction("genericConfig", { title: "Perfil de acesso", label: "Perfil", defaultName: "Operador", feedback: "Perfil salvo." })}>
        {roleMatrix.map((role) => (
          <tr key={role.role}>
            <td>{role.role}</td>
            <td>{role.description}</td>
            <td><TagList items={role.permissions} /></td>
            <td><button className="table-action" type="button" onClick={() => onAction("genericConfig", { title: `Perfil ${role.role}`, label: "Permissao", defaultName: role.permissions[0], feedback: "Permissoes salvas." })}>Ajustar</button></td>
          </tr>
        ))}
      </DataPanel>
      <FeaturePanel title="Como a regra funciona" icon={PanelsTopLeft} action="Salvar excecao" onAction={() => onAction("genericConfig", { title: "Excecao de permissao", label: "Permissao", feedback: "Excecao salva." })}>
        <StepList items={["Master Davantti ignora bloqueios", "Usuario comum precisa estar vinculado a empresa", "Perfil define permissoes base", "Excecao por usuario pode permitir ou bloquear uma acao"]} />
      </FeaturePanel>
    </div>
  );
}

function UsersAudit({ auditEvents = [], onAction, runtimeData }) {
  return (
    <div className="screen-grid audit-layout">
      <div className="panel panel-section span-2">
        <Toolbar
          title="Auditoria"
          description="Eventos rastreaveis por ator, entidade, status e detalhes tecnicos."
          icon={Eye}
          action="Exportar pagina CSV"
          onAction={() => exportReportRows("auditoria.csv", auditEvents, "audit")}
        />
        <OperationalList
          {...runtimeOperationalListProps(runtimeData, "auditLogs")}
          columns={["Quando", "Ator", "Evento", "Entidade", "Status", "Detalhes"]}
          emptyDescription="Ajuste a busca ou o status para refinar a auditoria."
          emptyTitle="Nenhum evento encontrado"
          filters={[
            { label: "Todos", value: "Todos" },
            { label: "Sucesso", value: "success" },
            { label: "Informacao", value: "info" },
            { label: "Alerta", value: "warn" },
            { label: "Erro", value: "error" },
          ]}
          getItemKey={(event) => event.id || `${event.title}-${event.time}-${event.description}`}
          items={auditEvents}
          renderRow={(event, { key }) => (
            <tr key={key}>
              <td>{event.date || event.time}<br /><small>{event.time}</small></td>
              <td>{event.actor}</td>
              <td><span className="event-badge">{event.title}</span></td>
              <td>{event.entityType}<br /><small>{event.entityId}</small></td>
              <td><StatusPill status={event.status || "info"} /></td>
              <td><pre className="meta-block">{JSON.stringify(event.metadata || {}, null, 2)}</pre></td>
            </tr>
          )}
          searchPlaceholder="Buscar por ator, acao, entidade ou detalhe"
          searchText={(event) => [event.actor, event.title, event.entityType, event.entityId, event.description, JSON.stringify(event.metadata || {})].join(" ")}
        />
      </div>
      <FeaturePanel title="Seguranca" icon={Lock} action="Configurar" onAction={() => onAction("genericConfig", { title: "Seguranca", label: "Regra", feedback: "Seguranca configurada." })}>
        <ToggleList items={["Sessao expira automaticamente", "Exigir senha para desconto", "Registrar IP de acesso", "Bloquear usuario inativo"]} />
      </FeaturePanel>
      <FeaturePanel title="Retencao" icon={CalendarClock} action="Salvar regra" onAction={() => onAction("genericConfig", { title: "Retencao da auditoria", label: "Dias", defaultName: "365", feedback: "Retencao configurada." })}>
        <SummaryLine label="Padrao recomendado" value="365 dias" />
        <SummaryLine label="Eventos sensiveis" value="730 dias" />
      </FeaturePanel>
    </div>
  );
}

function CompaniesPage({ data, onAction, onSelectCompany, isMaster }) {
  return (
    <ModulePage
      tabs={[
        { id: "clients", label: "Empresas", icon: Building2, content: <CompaniesList companies={data.masterCompanies} onAction={onAction} onSelectCompany={onSelectCompany} /> },
        { id: "overview", label: "Resumo", icon: ShieldCheck, content: <MasterOverview overview={data.masterOverview} isMaster={isMaster} /> },
        { id: "setup", label: "Implantacao", icon: ClipboardCheck, content: <CompaniesSetup onAction={onAction} /> },
        { id: "health", label: "Saude", icon: TrendingUp, content: <CompaniesHealth overview={data.masterOverview} /> },
      ]}
    />
  );
}

function MasterOverview({ overview, isMaster }) {
  const totals = overview?.totals || {};
  return (
    <div className="report-grid">
      <ReportCard icon={ShieldCheck} title="Perfil atual" value={isMaster ? "Admin master" : "Usuario"} detail={isMaster ? "Acesso a todos ambientes" : "Acesso limitado a empresa"} />
      <ReportCard icon={Building2} title="Empresas" value={String(totals.companies ?? "-")} detail={`${totals.activeCompanies ?? "-"} ativas`} />
      <ReportCard icon={UsersRound} title="Usuarios" value={String(totals.users ?? "-")} detail={`${totals.activeUsers ?? "-"} ativos`} />
      <ReportCard icon={LayoutDashboard} title="Entrada" value="Dashboard" detail="Selecione uma empresa e acesse o ambiente" />
    </div>
  );
}

function CompaniesList({ companies, onAction, onSelectCompany }) {
  const [search, setSearch] = useState("");
  const filteredCompanies = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return companies;
    return companies.filter((company) => [company.name, company.segment, company.plan, company.status]
      .join(" ")
      .toLowerCase()
      .includes(term));
  }, [companies, search]);

  return (
    <div className="panel panel-section">
      <Toolbar
        title="Empresas"
        description="Escolha uma empresa para entrar no ambiente ou gerencie seu cadastro."
        icon={Building2}
        action="Nova empresa"
        onAction={() => onAction("company")}
      />
      <SearchBox placeholder="Buscar por empresa, segmento, plano ou status" value={search} onChange={setSearch} />
      <div className="company-access-grid">
        {filteredCompanies.map((row) => (
          <article className="company-access-card" key={row.id || row.name}>
            <header className="company-access-card__header">
              <span className="card-icon"><Building2 size={21} /></span>
              <span>
                <strong>{row.name}</strong>
                <small>{row.requestedSector ? `Outro: ${row.requestedSector}` : row.segment === "optical" ? "Otica" : "Core padrao"}</small>
              </span>
              <StatusPill status={row.status} />
            </header>
            <dl className="company-access-card__meta">
              <div><dt>Plano</dt><dd>{row.plan || "starter"}</dd></div>
              <div><dt>Modulos</dt><dd>{row.modules ?? "-"}</dd></div>
              <div><dt>Usuarios</dt><dd>{row.users ?? "-"}</dd></div>
            </dl>
            <footer className="company-access-card__footer">
              <button className="button-primary" type="button" disabled={!row.id} onClick={() => onSelectCompany(row.id)}>
                Entrar na empresa
                <ArrowRight size={17} />
              </button>
              <RowActions
                onEdit={() => onAction("company", editRecordPayload(row))}
                onDeactivate={() => onAction("confirmAction", confirmRecordPayload({
                  collection: "masterCompanies",
                  record: row,
                  label: row.name,
                  feedback: "Empresa desativada.",
                }))}
              />
            </footer>
          </article>
        ))}
        {!filteredCompanies.length ? (
          <div className="empty-state compact"><Search size={28} /><strong>Nenhuma empresa encontrada</strong><span>Revise a busca ou cadastre uma empresa.</span></div>
        ) : null}
      </div>
    </div>
  );
}

function CompaniesSetup({ onAction }) {
  return (
    <div className="screen-grid">
      <FeaturePanel title="Onboarding da primeira empresa" icon={ClipboardCheck} action="Iniciar" onAction={() => onAction("company")}>
        <StepList items={["Criar empresa real", "Escolher setor/template", "Cadastrar usuario gerente", "Importar clientes/produtos", "Abrir caixa e testar venda"]} />
        <div className="quick-actions">
          <button className="button-secondary" type="button" onClick={() => onAction("company")}>Criar empresa</button>
          <button className="button-secondary" type="button" onClick={() => onAction("user")}>Criar usuario</button>
          <button className="button-secondary" type="button" onClick={() => onAction("importData")}>Importar CSV</button>
        </div>
      </FeaturePanel>
      <FeaturePanel title="Checklist de implantacao" icon={ShieldCheck} action="Atualizar" onAction={() => onAction("genericConfig", { title: "Checklist de implantacao", label: "Item", feedback: "Checklist atualizado." })}>
        <ToggleList items={["Dados fiscais conferidos", "Modulos ativos conferidos", "Permissoes de equipe revisadas", "Estoque inicial importado", "Venda teste validada"]} />
      </FeaturePanel>
      <FeaturePanel title="Proximo passo recomendado" icon={ArrowRight} action="Configurar empresa" onAction={() => onAction("settings")}>
        <SummaryLine label="Ambiente" value="Banco real + migrations" />
        <SummaryLine label="Login" value="Master via variavel global" />
        <SummaryLine label="Meta" value="Primeira venda real em staging" />
      </FeaturePanel>
    </div>
  );
}

function CompaniesHealth({ overview }) {
  const totals = overview?.totals || {};
  const inactiveCompanies = Math.max(0, Number(totals.companies || 0) - Number(totals.activeCompanies || 0));
  const inactiveUsers = Math.max(0, Number(totals.users || 0) - Number(totals.activeUsers || 0));
  return (
    <div className="report-grid">
      <ReportCard icon={Building2} title="Empresas ativas" value={String(totals.activeCompanies ?? 0)} detail={`${inactiveCompanies} inativas ou pendentes`} />
      <ReportCard icon={UsersRound} title="Usuarios ativos" value={String(totals.activeUsers ?? 0)} detail={`${inactiveUsers} inativos ou pendentes`} />
      <ReportCard icon={ShieldCheck} title="Ambientes cadastrados" value={String(totals.companies ?? 0)} detail="Base real do DACHBYTE Core" />
      <ReportCard icon={UserCog} title="Acessos cadastrados" value={String(totals.users ?? 0)} detail="Usuarios vinculados ao ecossistema" />
    </div>
  );
}

function ModulesPage({ data, onAction, workspace, isMasterUser }) {
  return (
    <ModulePage
      tabs={[
        { id: "active", label: "Modulos da empresa", icon: PanelsTopLeft, content: <ModulesActive onAction={onAction} workspace={workspace} isMasterUser={isMasterUser} /> },
        { id: "screens", label: "Telas do sistema", icon: LayoutDashboard, content: <ModulesScreens onAction={onAction} workspace={workspace} isMasterUser={isMasterUser} /> },
      ]}
    />
  );
}

function ModulesActive({ onAction, workspace, isMasterUser }) {
  const activeModules = workspace?.configuration?.modules || [];
  const moduleCatalog = workspace?.configuration?.availableModules || [];
  const moduleNames = new Map(moduleCatalog.map((module) => [module.key, module.name]));
  const activeModuleNames = activeModules.map((moduleId) => moduleNames.get(moduleId) || moduleId);

  return (
    <div className="screen-grid">
      <FeaturePanel title="Implantacao de modulos" icon={PanelsTopLeft} action={isMasterUser ? "Configurar" : undefined} onAction={isMasterUser ? () => onAction("companyModules") : undefined}>
        <ToggleList items={activeModuleNames.length ? activeModuleNames : pages.filter((page) => page.id !== "dashboard").map((page) => page.name)} />
      </FeaturePanel>
      <FeaturePanel title="Composicao comercial" icon={Store} description="Verticais, servicos e canais nao sao habilitados manualmente como modulos.">
        <TagList items={[
          "DACHBYTE Core sempre ativo",
          "Verticais via Servicos Volt",
          "Servicos via contratacao",
          "Canais via conexao",
        ]} />
      </FeaturePanel>
    </div>
  );
}

function ModulesScreens({ onAction, workspace, isMasterUser }) {
  const activeScreens = new Set(workspace?.configuration?.screens || []);
  const screenCatalog = workspace?.configuration?.availableScreens || [];
  const moduleNames = new Map((workspace?.configuration?.availableModules || []).map((module) => [module.key, module.name]));
  return (
    <DataPanel
      title="Telas de implantacao"
      icon={LayoutDashboard}
      columns={["Tela", "Modulo", "Exibicao", "Status"]}
      actionLabel="Configurar"
      onAction={isMasterUser ? () => onAction("companyScreens") : undefined}
    >
      {screenCatalog.map((screen) => (
        <tr key={screen.key}>
          <td>{screen.name}</td>
          <td>{moduleNames.get(screen.moduleKey) || screen.moduleKey}</td>
          <td>Menu lateral</td>
          <td><StatusPill status={activeScreens.has(screen.key) ? "Ativo" : "Inativo"} /></td>
        </tr>
      ))}
    </DataPanel>
  );
}

function ModulesPlans({ modulePlans, onAction }) {
  return (
    <div className="screen-grid">
      <FeaturePanel title="Planos comerciais" icon={BadgeDollarSign} action="Novo plano" onAction={() => onAction("modulePlan")}>
        <div className="toggle-list">
          {modulePlans.map((plan) => (
            <QuickRow
              key={plan.name}
              title={plan.name}
              subtitle={`${plan.modules} modulos - ${plan.price} - ${plan.status}`}
              action="Editar"
              icon={BadgeDollarSign}
              onClick={() => onAction("modulePlan", editRecordPayload(plan))}
            />
          ))}
        </div>
      </FeaturePanel>
      <FeaturePanel title="Plano Custom" icon={SlidersHorizontal} action="Montar plano" onAction={() => onAction("modulePlan", { name: "Plano Custom" })}>
        <TagList items={["OS", "Verticais", "Servicos", "Financeiro", "Campos customizados", "Painel master"]} />
      </FeaturePanel>
    </div>
  );
}

function ModulePage({ activeTab: controlledActiveTab, onTabChange, tabs }) {
  const [internalActiveTab, setInternalActiveTab] = useState(tabs[0].id);
  const activeTab = controlledActiveTab || internalActiveTab;
  const current = tabs.find((tab) => tab.id === activeTab) || tabs[0];

  function changeTab(tabId) {
    if (onTabChange) {
      onTabChange(tabId);
      return;
    }
    setInternalActiveTab(tabId);
  }

  return (
    <div className="module-page">
      <div className="tabbar" role="tablist">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              className={`tabbar__item ${activeTab === tab.id ? "tabbar__item--active" : ""}`}
              data-tab={tab.id}
              type="button"
              onClick={() => changeTab(tab.id)}
            >
              <Icon size={17} />
              {tab.label}
            </button>
          );
        })}
      </div>
      <div className="module-page__body">{current.content}</div>
    </div>
  );
}

function MetricCard({ label, value, hint, tone, onClick }) {
  return (
    <button className={`metric-card metric-card--${tone} metric-card--button`} type="button" onClick={onClick}>
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{hint}</span>
    </button>
  );
}

function SectionTitle({ icon: Icon, title, description }) {
  return (
    <div className="section-title">
      <span className="card-icon">
        <Icon size={23} />
      </span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}

function MoreOptionsMenu({ items, compact = false }) {
  const [open, setOpen] = useState(false);
  const [pendingLabel, setPendingLabel] = useState("");
  const [error, setError] = useState("");

  async function runAction(item) {
    setError("");
    setPendingLabel(item.label);
    try {
      await item.onClick?.();
      setOpen(false);
    } catch (actionError) {
      setError(actionError?.message || "Nao foi possivel concluir esta acao.");
    } finally {
      setPendingLabel("");
    }
  }

  return (
    <div className={`more-options ${compact ? "more-options--compact" : ""}`}>
      <button className="more-options__trigger" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)} disabled={Boolean(pendingLabel)}>
        <MoreVertical size={16} />
        {pendingLabel ? "Processando..." : "Mais opcoes"}
      </button>
      {open ? (
        <div className="more-options__menu">
          {items.map((item) => (
            <button className={item.tone ? `more-options__item--${item.tone}` : ""} key={item.label} type="button" onClick={() => runAction(item)} disabled={Boolean(pendingLabel)}>
              {pendingLabel === item.label ? "Processando..." : item.label}
            </button>
          ))}
          {error ? <span className="more-options__error">{error}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function SpreadsheetImportModal({ data, modal, onClose, onSubmit }) {
  const entity = modal.payload?.entity || "products";
  const isProducts = entity === "products";
  const columns = isProducts ? productImportColumns(modal.payload?.extensionSchema) : customerImportColumns();
  const [file, setFile] = useState(null);
  const [phase, setPhase] = useState("idle");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState(null);
  const title = isProducts ? "Importar produtos" : "Importar clientes";
  const noun = isProducts ? "produto" : "cliente";
  const nounPlural = isProducts ? "produtos" : "clientes";

  async function processFile(event) {
    event.preventDefault();
    if (!file) {
      setMessage("Selecione uma planilha .xlsx para importar.");
      return;
    }
    setPhase("processing");
    setMessage("Lendo planilha...");
    setResult(null);
    try {
      const rows = await readImportSheetRows(file);
      if (!rows.length) throw new Error("A aba Importacao nao possui linhas preenchidas.");
      setMessage("Validando dados...");
      const validation = validateSpreadsheetRows({ data, entity, rows });
      if (validation.validRows.length) {
        setMessage(`Importando ${validation.validRows.length} ${nounPlural}...`);
        await onSubmit("importData", {
          entity,
          csv: rowsToCsv(validation.validRows, columns),
        });
      }
      setResult({
        success: validation.validRows.length,
        errors: validation.errorRows.length,
        errorRows: validation.errorRows,
        finishedAt: new Date().toLocaleString("pt-BR"),
      });
      setPhase("done");
      setMessage("");
    } catch (error) {
      setPhase("idle");
      setMessage(error?.message || "Nao foi possivel processar a planilha.");
    }
  }

  async function downloadErrors() {
    if (!result?.errorRows?.length) return;
    await downloadErrorRowsXlsx(`erros-${entity}-volt-core.xlsx`, result.errorRows, columns);
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-shell spreadsheet-modal" role="dialog" aria-modal="true" aria-labelledby="spreadsheet-modal-title">
        <header className="modal-header">
          <span className="card-icon"><Download size={23} /></span>
          <div>
            <h2 id="spreadsheet-modal-title">{title}</h2>
            <p>Envie o arquivo .xlsx do modelo. A aba Importacao sera validada antes de gravar.</p>
          </div>
          <button className="icon-button" type="button" aria-label="Fechar" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        {phase === "done" ? (
          <div className="spreadsheet-result">
            <div className={`spreadsheet-progress ${result.errors ? "spreadsheet-progress--warning" : ""}`}>
              <span style={{ width: "100%" }} />
            </div>
            <p>{result.errors ? "Importacao finalizada com pendencias." : "Importacao concluida com sucesso."}</p>
            <SummaryLine label="Concluido em" value={result.finishedAt} />
            <SummaryLine label={`${nounPlural} importados ou atualizados`} value={String(result.success)} />
            <SummaryLine label={`${nounPlural} com erro`} value={String(result.errors)} />
            {result.errors ? (
              <div className="spreadsheet-guidance">
                <strong>O que fazer agora?</strong>
                <ol>
                  <li>Baixe a planilha com erros.</li>
                  <li>Corrija as linhas indicadas na coluna erro_identificado.</li>
                  <li>Envie novamente o arquivo corrigido.</li>
                </ol>
              </div>
            ) : null}
            <footer className="modal-footer">
              {result.errors ? (
                <>
                  <button className="button-secondary" type="button" onClick={() => {
                    setFile(null);
                    setResult(null);
                    setPhase("idle");
                  }}>Enviar arquivo corrigido</button>
                  <button className="button-primary" type="button" onClick={downloadErrors}>Baixar planilha com erros</button>
                </>
              ) : (
                <button className="button-primary" type="button" onClick={onClose}>Voltar para {nounPlural}</button>
              )}
            </footer>
          </div>
        ) : (
          <form className="modal-form" onSubmit={processFile}>
            <label className="spreadsheet-upload">
              <FileText size={28} />
              <strong>{file ? file.name : "Selecione a planilha .xlsx"}</strong>
              <span>Use o modelo baixado pelo menu Mais opcoes.</span>
              <input accept=".xlsx" type="file" onChange={(event) => setFile(event.target.files?.[0] || null)} />
            </label>
            {message ? <div className={phase === "processing" ? "inline-alert inline-alert--soft" : "login-error"}>{message}</div> : null}
            <footer className="modal-footer">
              <button className="button-secondary" type="button" onClick={onClose}>Cancelar</button>
              <button className="button-primary" type="submit" disabled={phase === "processing"}>
                {phase === "processing" ? <span className="spinner" /> : <CheckCircle2 size={18} />}
                {phase === "processing" ? "Processando..." : `Importar ${noun}`}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}

function validateSpreadsheetRows({ data, entity, rows }) {
  const validRows = [];
  const errorRows = [];
  const isProducts = entity === "products";
  const seenSku = new Set();
  const seenEan = new Set();

  rows.forEach((row, index) => {
    const errors = [];
    if (isProducts) {
      const name = row.nome || row.name;
      const sku = row.sku;
      const ean = row.ean;
      const type = row.tipo || row.type;
      const category = row.categoria || row.category;
      const price = row.preco || row.price;
      const normalizedSku = normalizeFilterText(sku);
      const normalizedEan = normalizeFilterText(ean);
      if (!name || normalizeFilterText(name) === "preencha") errors.push("nome obrigatorio");
      if (!type || normalizeFilterText(type) === "selecione") errors.push("tipo obrigatorio");
      if (!category || normalizeFilterText(category) === "selecione") errors.push("categoria obrigatoria");
      if (!price || parseMoney(price) <= 0) errors.push("preco obrigatorio ou invalido");
      if (normalizedSku && seenSku.has(normalizedSku)) errors.push("sku duplicado na planilha");
      if (normalizedEan && seenEan.has(normalizedEan)) errors.push("ean duplicado na planilha");
      if (normalizedSku) seenSku.add(normalizedSku);
      if (normalizedEan) seenEan.add(normalizedEan);
    } else {
      const name = row.nome || row.name;
      const phone = row.telefone || row.phone;
      if (!name || normalizeFilterText(name) === "preencha") errors.push("nome obrigatorio");
      if (!phone || normalizeFilterText(phone) === "preencha") errors.push("telefone obrigatorio");
    }
    if (errors.length) {
      errorRows.push({ ...row, erro_identificado: `Linha ${index + 2}: ${errors.join("; ")}` });
    } else {
      validRows.push(row);
    }
  });

  return { validRows, errorRows };
}

function Toolbar({ icon: Icon, title, description, action, onAction, hideAction = false, secondaryActions }) {
  const canAct = Boolean(action && onAction) && !hideAction;

  function handleClick() {
    onAction?.();
  }

  return (
    <div className="toolbar">
      <SectionTitle icon={Icon} title={title} description={description} />
      <div className="toolbar__actions">
        {secondaryActions}
        {canAct ? (
          <button className="button-primary" type="button" onClick={handleClick}>
            <Plus size={17} />
            {action}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FeaturePanel({ title, icon, action, onAction, children, description = "Dados e configuracoes do ambiente selecionado." }) {
  const Icon = icon;
  return (
    <div className="panel panel-section">
      <Toolbar title={title} description={description} icon={Icon} action={action} onAction={onAction} />
      {children}
    </div>
  );
}

function EmptyContent({ icon: Icon, title, description, action, onAction }) {
  return (
    <div className="empty-state compact">
      <Icon size={28} />
      <strong>{title}</strong>
      <span>{description}</span>
      {action && onAction ? (
        <button className="button-secondary" type="button" onClick={onAction}>{action}</button>
      ) : null}
    </div>
  );
}

function QuickRow({ title, subtitle, action, icon: Icon, onClick }) {
  function handleClick() {
    onClick?.();
  }

  return (
    <div className="quick-row">
      <span className="quick-row__icon">
        <Icon size={19} />
      </span>
      <span className="quick-row__copy">
        <strong>{title}</strong>
        <small>{subtitle}</small>
      </span>
      {onClick ? <button className="button-secondary" type="button" onClick={handleClick}>{action}</button> : null}
    </div>
  );
}

function SearchBox({ placeholder, value, onChange }) {
  return (
    <label className="search-box">
      <Search size={18} />
      <input value={value} placeholder={placeholder} onChange={(event) => onChange?.(event.target.value)} />
    </label>
  );
}

function DataPanel({ title, icon: Icon, columns, onAction, children, searchable = true, pageSize = 8, actionLabel = "Novo" }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const rows = React.Children.toArray(children).filter(Boolean);
  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) => extractNodeText(row).toLowerCase().includes(term));
  }, [rows, search]);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleRows = filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize);

  useEffect(() => {
    setPage(1);
  }, [search, rows.length]);

  return (
    <div className="panel panel-section span-2">
      <Toolbar
        title={title}
        description={onAction ? "Dados do ambiente selecionado e operacoes disponiveis." : "Visao consolidada dos ambientes cadastrados."}
        icon={Icon}
        action={actionLabel}
        onAction={onAction}
        hideAction={!onAction}
      />
      {searchable ? (
        <div className="table-controls">
          <label className="search-box table-search">
            <Search size={18} />
            <input
              value={search}
              placeholder={`Buscar em ${title.toLowerCase()}`}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <span className="badge">{filteredRows.length} registro{filteredRows.length === 1 ? "" : "s"}</span>
        </div>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {visibleRows.length ? visibleRows : (
              <tr>
                <td colSpan={columns.length}>
                  <div className="empty-state compact">
                    <Search size={28} />
                    <strong>Nenhum registro encontrado</strong>
                    <span>Ajuste a busca ou cadastre um novo item.</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {filteredRows.length > pageSize ? (
        <div className="table-footer">
          <span>
            Mostrando {(safePage - 1) * pageSize + 1}-{Math.min(safePage * pageSize, filteredRows.length)} de {filteredRows.length}
          </span>
          <div className="pager">
            <button className="button-secondary" type="button" disabled={safePage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Anterior</button>
            <strong>{safePage} / {totalPages}</strong>
            <button className="button-secondary" type="button" disabled={safePage >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Proxima</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RowActions({ onEdit, onDeactivate, onDelete, deactivateLabel = "Desativar", deleteLabel = "Excluir" }) {
  return (
    <span className="row-actions">
      {onEdit ? <button className="table-action" type="button" onClick={onEdit}>Editar</button> : null}
      {onDeactivate ? <button className="table-action table-action--warning" type="button" onClick={onDeactivate}>{deactivateLabel}</button> : null}
      {onDelete ? <button className="table-action table-action--danger" type="button" onClick={onDelete}>{deleteLabel}</button> : null}
    </span>
  );
}

function StatusPill({ status }) {
  const label = String(status || "Indefinido");
  const normalized = label.toLowerCase();
  let tone = "neutral";
  if (["finalizada", "concluido", "ativo", "ok", "entrada", "pago", "servico", "emitido", "pronto", "pronto para retirada", "success"].includes(normalized)) tone = "success";
  if (["pendente", "aberto", "compensar", "ajuste", "em andamento", "em producao", "aguardando peca", "contratado", "configurando", "warn", "warning"].includes(normalized)) tone = "warning";
  if (["cancelada", "cancelado", "critico", "saida", "vencido", "suspenso", "error"].includes(normalized)) tone = "danger";
  if (["credito", "disponivel", "em breve", "info"].includes(normalized)) tone = "info";
  return <span className={`status-pill status-pill--${tone}`}>{label}</span>;
}

function FormGrid({ fields }) {
  return (
    <div className="field-preview-grid" aria-label="Campos do formulario">
      {fields.map((field) => (
        <div className="field-preview" key={field}>
            <CheckCircle2 size={16} />
            <span>
              <strong>{field}</strong>
            <small>Editado pela acao principal desta tela</small>
            </span>
          </div>
      ))}
    </div>
  );
}

function SaleLine({ name, qty, value, onRemove }) {
  return (
    <div className="sale-line">
      <span>
        <strong>{name}</strong>
        <small>Qtd. {qty}</small>
      </span>
      <em>{value}</em>
      {onRemove ? <button className="table-action table-action--danger" type="button" onClick={onRemove}>Remover</button> : null}
    </div>
  );
}

function ProgressRow({ label, value, width }) {
  return (
    <div className="progress-row">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div className="progress-track">
        <i style={{ width }} />
      </div>
    </div>
  );
}

function TimelineItem({ title, description }) {
  return (
    <div className="timeline-item">
      <span />
      <div>
        <strong>{title}</strong>
        <small>{description}</small>
      </div>
    </div>
  );
}

function AlertRow({ title, detail, severity }) {
  return (
    <div className={`alert-row alert-row--${severity}`}>
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function SummaryLine({ label, value }) {
  return (
    <div className="summary-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function KanbanColumn({ title, count, items }) {
  return (
    <div className="kanban-column">
      <div className="kanban-title">
        <strong>{title}</strong>
        <span>{count}</span>
      </div>
      {items.map((item) => <div className="kanban-card" key={item}>{item}</div>)}
    </div>
  );
}

function ReportCard({ icon: Icon, title, value, detail }) {
  return (
    <article className="report-card">
      <span className="card-icon">
        <Icon size={23} />
      </span>
      <div>
        <small>{title}</small>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </article>
  );
}

function ToggleList({ items }) {
  return (
    <div className="toggle-list">
      {items.map((item) => (
        <label className="toggle-row" key={item}>
          <span>{item}</span>
          <input type="checkbox" defaultChecked />
        </label>
      ))}
    </div>
  );
}

function PermissionRow({ role, description }) {
  return (
    <div className="permission-row">
      <span className="avatar avatar--small">{role.charAt(0)}</span>
      <div>
        <strong>{role}</strong>
        <small>{description}</small>
      </div>
    </div>
  );
}

function PaymentChip({ label, value }) {
  return (
    <div className="payment-chip">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StepList({ items }) {
  return (
    <div className="step-list">
      {items.map((item, index) => (
        <div className="step-item" key={item}>
          <span>{index + 1}</span>
          <strong>{item}</strong>
        </div>
      ))}
    </div>
  );
}

function TagList({ items }) {
  return (
    <div className="tag-list">
      {items.map((item) => <span className="tag" key={item}>{item}</span>)}
    </div>
  );
}

function ActionTile({ icon: Icon, title, detail }) {
  return (
    <div className="action-tile">
      <Icon size={20} />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function UserAccessMatrix({ enabledScreens, screens, permissions, onChange }) {
  const enabled = new Set(enabledScreens || []);
  const areas = userAccessAreas.filter((area) => enabled.has(area.screen));
  const selectedScreens = new Set(screens || []);
  const allPermissions = areas.flatMap((area) => [area.read, area.write].filter(Boolean));
  const selectedPermissions = new Set((permissions || []).includes("*") ? allPermissions : permissions || []);

  function updateArea(area, kind, checked) {
    const nextScreens = new Set(selectedScreens);
    const nextPermissions = new Set(selectedPermissions);

    if (kind === "read") {
      if (checked) {
        nextScreens.add(area.screen);
        nextPermissions.add(area.read);
      } else {
        nextScreens.delete(area.screen);
        nextPermissions.delete(area.read);
        if (area.write) nextPermissions.delete(area.write);
      }
    } else if (area.write) {
      if (checked) {
        nextScreens.add(area.screen);
        nextPermissions.add(area.read);
        nextPermissions.add(area.write);
      } else {
        nextPermissions.delete(area.write);
      }
    }

    onChange({ screens: [...nextScreens], permissions: [...nextPermissions] });
  }

  return (
    <div className="access-matrix">
      <div className="access-matrix__head">
        <strong>Tela</strong>
        <strong>Visualizar</strong>
        <strong>Editar / agir</strong>
      </div>
      {areas.map((area) => (
        <div className="access-matrix__row" key={area.screen}>
          <span>{area.label}</span>
          <label className="access-check">
            <input
              type="checkbox"
              checked={selectedScreens.has(area.screen) && selectedPermissions.has(area.read)}
              onChange={(event) => updateArea(area, "read", event.target.checked)}
            />
            <span>Visualizar</span>
          </label>
          {area.write ? (
            <label className="access-check">
              <input
                type="checkbox"
                checked={selectedPermissions.has(area.write)}
                onChange={(event) => updateArea(area, "write", event.target.checked)}
              />
              <span>{area.writeLabel || "Editar"}</span>
            </label>
          ) : <span className="muted-copy">Somente leitura</span>}
        </div>
      ))}
      {!areas.length ? <div className="access-matrix__empty">Selecione uma empresa com telas configuradas.</div> : null}
    </div>
  );
}

function ActionModal({ data, modal, onClose, onLookup, onSubmit, workspace }) {
  const config = buildModalConfig(modal.type, data, modal.payload || {}, workspace);
  const [values, setValues] = useState(config.defaults);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const Icon = config.icon;

  useEffect(() => {
    setValues(config.defaults);
    setError("");
  }, [modal.type]);

  const {
    payments,
    paymentRemaining,
    paymentTotal,
    saleCartItems,
    saleTotal,
    selectedProduct,
    visibleFields,
  } = deriveActionModalState({ type: modal.type, config, data, values });

  function updateValue(name, value) {
    setValues((current) => updateActionModalValue({ type: modal.type, config, data, current, name, value }));
  }

  function updatePayment(index, name, value) {
    setValues((current) => updateActionModalPayment({ current, index, name, value }));
  }

  function addPayment() {
    setValues((current) => addActionModalPayment({ current, saleTotal }));
  }

  function removePayment(index) {
    setValues((current) => removeActionModalPayment({ current, index }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const validationError = validateActionModal({
      type: modal.type,
      data,
      values,
      visibleFields,
      saleCartItems,
      selectedProduct,
      payments,
      paymentRemaining,
    });
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError("");
    try {
      const submittedValues = prepareActionModalValues({ type: modal.type, values, payments });
      await onSubmit(modal.type, submittedValues);
    } catch (submitError) {
      setError(submitError?.message || "Nao foi possivel salvar agora. Confira os dados e tente novamente.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-shell" role="dialog" aria-modal="true" aria-labelledby="action-modal-title" data-modal={modal.type}>
        <header className="modal-header">
          <span className="card-icon">
            <Icon size={23} />
          </span>
          <div>
            <h2 id="action-modal-title">{config.title}</h2>
            <p>{config.description}</p>
          </div>
          <button className="icon-button" type="button" aria-label="Fechar" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <form className="modal-form" onSubmit={handleSubmit}>
          <ActionModalFields
            AccessMatrixComponent={UserAccessMatrix}
            fields={visibleFields}
            modalType={modal.type}
            onAccessChange={(access) => setValues((current) => ({ ...current, ...access }))}
            onLookup={onLookup}
            onValueChange={updateValue}
            saleCartItems={saleCartItems}
            values={values}
          />

          {modal.type === "sale" || modal.type === "saleEdit" ? (
            <>
              {modal.type === "sale" ? <SaleCartSummary items={saleCartItems} /> : null}
              <SalePaymentsSection
                onPaymentAdd={addPayment}
                onPaymentChange={updatePayment}
                onPaymentRemove={removePayment}
                payments={payments}
              />
              <SaleTotalSummary
                paymentRemaining={paymentRemaining}
                paymentTotal={paymentTotal}
                saleTotal={saleTotal}
              />
            </>
          ) : null}

          {error ? <div className="login-error">{error}</div> : null}

          <footer className="modal-footer">
            <button className="button-secondary" type="button" onClick={onClose}>Cancelar</button>
            <button className={config.danger ? "button-danger" : "button-primary"} type="submit" disabled={saving}>
              {saving ? <span className="spinner" /> : <CheckCircle2 size={18} />}
              {saving ? "Salvando..." : config.submitLabel}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function Root() {
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const payload = await apiFetch("/core/auth/me");
        if (!cancelled) {
          setUser({
            ...payload.user,
            companies: payload.companies || payload.user?.companies || [],
            selectedCompanyId: payload.selectedCompanyId || payload.user?.selectedCompanyId || payload.user?.companies?.[0]?.id || null,
          });
        }
      } catch (_error) {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    }

    loadSession();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    await apiFetch("/core/auth/logout", { method: "POST" }).catch(() => {});
    try {
      Object.keys(window.localStorage)
        .filter((key) => key.startsWith("volt_core_master_context_"))
        .forEach((key) => window.localStorage.removeItem(key));
    } catch (_error) {
      // localStorage can be unavailable in restricted browser modes.
    }
    setUser(null);
  }

  if (checkingSession) {
    return (
      <div className="login-page min-h-screen">
        <section className="login-hero">
          <BrandLogo />
          <div className="login-copy">
            <span className="badge badge--hero">
              <ShieldCheck size={14} />
              Validando sessao
            </span>
            <h1>Preparando seu ambiente DACHBYTE Core.</h1>
          </div>
        </section>
        <section className="login-panel-wrap min-h-screen">
          <div className="panel login-panel">
            <span className="spinner spinner--brand" />
            <h2>Carregando</h2>
            <p>Conferindo sua sessao de acesso.</p>
          </div>
        </section>
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  return <AppShell user={user} onLogout={handleLogout} />;
}

createRoot(document.getElementById("root")).render(<Root />);
