import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  Bot,
  BriefcaseBusiness,
  Cake,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Files,
  LayoutDashboard,
  ListTodo,
  LoaderCircle,
  LogOut,
  MessageSquare,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Ticket,
  Users,
} from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";
import { useWebSocket } from "../../contexts/WebSocketContext";
import ProfileModal from "../ProfileModal";
import { isBirthdayToday } from "../../utils/birthdays";
import { usePlatformDialog } from "../../contexts/PlatformDialogContext";
import { checkDesktopRelease } from "../../utils/desktopUpdater";

const pageMeta = {
  "/dashboard": ["Dashboard", "Visao geral operacional do DACHBYTE Chat"],
  "/chat": ["Chat", "Conversas em tempo real"],
  "/meetings": ["Agenda", "Calendario, compromissos e reunioes internas"],
  "/tickets": ["Tickets", "Fila de suporte e atendimento"],
  "/ticket-reports": [
    "Relatório de tickets",
    "Indicadores, tempos e controle operacional",
  ],
  "/tasks": ["Tarefas", "Quadro de execucao do time"],
  "/kanban": ["Tarefas", "Quadro de execucao do time"],
  "/files": ["Arquivos", "Documentos e anexos compartilhados"],
  "/users": ["Usuarios", "Equipe e permissoes"],
  "/birthdays": ["Aniversarios", "Ultimos e proximos aniversariantes"],
  "/admin": ["Admin Master", "Gestao multi-tenant da plataforma"],
  "/company-admin": [
    "Coordenacao",
    "Setores, usuarios e mapa mental da empresa",
  ],
  "/coordinator": ["Coordenacao", "Gestao do setor coordenado"],
  "/notifications": ["Notificacoes", "Eventos recentes do workspace"],
  "/assistant": [
    "Assistente",
    "Delegue tickets e tarefas em linguagem natural",
  ],
};

const publicUrl = process.env.PUBLIC_URL || "";

const compareVersions = (current, available) => {
  const currentParts = String(current || "0").split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const availableParts = String(available || "0").split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(currentParts.length, availableParts.length);
  for (let index = 0; index < length; index += 1) {
    const currentPart = currentParts[index] || 0;
    const availablePart = availableParts[index] || 0;
    if (availablePart !== currentPart) return availablePart - currentPart;
  }
  return 0;
};

const desktopReleasePayload = (release) => ({
  url: release?.download_url,
  filename: release?.filename,
  sha256: release?.sha256,
  version: release?.version,
  fileSize: release?.file_size,
});

const statusOptions = [
  { value: "online", label: "Online", dotClass: "status-dot--online" },
  { value: "busy", label: "Ocupado", dotClass: "status-dot--busy" },
  { value: "meeting", label: "Em reunião", dotClass: "status-dot--meeting" },
];

const Layout = ({ children }) => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileStatus, setProfileStatus] = useState("online");
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState(null);
  const {
    user,
    logout,
    isAdmin,
    isCompanyAdmin,
    isCoordinator,
  } = useAuth();
  const { connected, sendPresenceStatus } = useWebSocket();
  const navigate = useNavigate();
  const location = useLocation();
  const dialog = usePlatformDialog();

  useEffect(() => {
    const savedStatus = localStorage.getItem("voltchat:userStatus") || "online";
    const normalizedStatus = savedStatus === "away" ? "meeting" : savedStatus;
    const validStatus = statusOptions.some(
      (item) => item.value === normalizedStatus,
    )
      ? normalizedStatus
      : "online";
    setProfileStatus(validStatus);
    localStorage.setItem("voltchat:userStatus", validStatus);
  }, []);

  useEffect(() => {
    if (connected) sendPresenceStatus(profileStatus);
  }, [connected, profileStatus, sendPresenceStatus]);

  useEffect(() => {
    if (!window.voltChatDesktop?.onUpdateProgress) return undefined;
    return window.voltChatDesktop.onUpdateProgress((payload = {}) => {
      if (payload.status === "downloading") {
        const percent = Number(payload.percent);
        setUpdateProgress(Number.isFinite(percent) ? Math.max(0, Math.min(99, percent)) : null);
      } else if (payload.status === "ready") {
        setUpdateProgress(100);
      } else if (payload.status === "error") {
        setUpdateProgress(null);
      }
    });
  }, []);

  const handleStatusChange = (value) => {
    setProfileStatus(value);
    localStorage.setItem("voltchat:userStatus", value);
    setStatusMenuOpen(false);
  };

  const menuItems = [
    {
      group: "Principal",
      name: "Dashboard",
      icon: LayoutDashboard,
      path: "/dashboard",
      show: true,
    },
    {
      group: "Principal",
      name: "Chat",
      icon: MessageSquare,
      path: "/chat",
      show: true,
    },
    {
      group: "Principal",
      name: "Agenda",
      icon: CalendarDays,
      path: "/meetings",
      show: true,
    },
    {
      group: "Principal",
      name: "Tickets",
      icon: Ticket,
      path: "/tickets",
      show: true,
    },
    {
      group: "Principal",
      name: "Tarefas",
      icon: ListTodo,
      path: "/tasks",
      show: true,
    },
    {
      group: "Principal",
      name: "Assistente",
      icon: Bot,
      path: "/assistant",
      show: true,
    },
    {
      group: "Gestão",
      name: "Arquivos",
      icon: Files,
      path: "/files",
      show: true,
    },
    {
      group: "Gestão",
      name: "Usuários",
      icon: Users,
      path: "/users",
      show: isCoordinator(),
    },
    {
      group: "Gestão",
      name: "Aniversários",
      icon: Cake,
      path: "/birthdays",
      show: true,
    },
    {
      group: "Gestão",
      name: "Admin Master",
      icon: ShieldCheck,
      path: "/admin",
      show: isAdmin(),
    },
    {
      group: "Gestão",
      name: "Coordenação",
      icon: BriefcaseBusiness,
      path: isCompanyAdmin() ? "/company-admin" : "/coordinator",
      show: isCoordinator(),
    },
    {
      group: "Sistema",
      name: "Alertas",
      icon: Bell,
      path: "/notifications",
      show: true,
    },
  ];

  const [title, description] = pageMeta[location.pathname] || [
    "DACHBYTE Chat",
    "Sistema corporativo de comunicacao",
  ];
  const userBirthdayToday = isBirthdayToday(user?.birthday);

  const handleManualUpdate = async () => {
    if (checkingUpdate) return;
    if (!window.voltChatDesktop?.checkForUpdate || !window.voltChatDesktop?.getAppVersion) {
      await dialog.alert({
        title: "Atualização disponível somente no desktop",
        message: "A verificação manual pelo Cloudflare R2 está disponível no aplicativo DACHBYTE Chat para Windows.",
      });
      return;
    }

    setCheckingUpdate(true);
    setUpdateProgress(null);
    try {
      const currentVersion = await window.voltChatDesktop.getAppVersion();
      const release = await checkDesktopRelease(currentVersion);

      if (!release?.version || compareVersions(currentVersion, release.version) <= 0) {
        await dialog.alert({
          title: "DACHBYTE Chat atualizado",
          message: "Você já está na versão mais atualizada.",
          detail: currentVersion ? `Versão instalada: ${currentVersion}` : undefined,
          confirmLabel: "OK",
        });
        return;
      }

      if (!release.sha256 || release.external_url) {
        throw new Error("A versão encontrada não possui um instalador válido no Cloudflare R2.");
      }

      const payload = desktopReleasePayload(release);
      if (window.voltChatDesktop?.prepareUpdate && window.voltChatDesktop?.installPreparedUpdate) {
        await window.voltChatDesktop.prepareUpdate(payload);
        setUpdateProgress(100);
        await window.voltChatDesktop.installPreparedUpdate(payload);
        return;
      }
      if (window.voltChatDesktop?.installUpdate) {
        await window.voltChatDesktop.installUpdate(payload);
        return;
      }
      throw new Error("O atualizador nativo não está disponível nesta instalação do DACHBYTE Chat.");
    } catch (error) {
      await dialog.alert({
        title: "Não foi possível atualizar",
        message: error?.message || "Falha ao consultar ou baixar a atualização pelo Cloudflare R2.",
        detail: "Tente novamente em alguns instantes.",
      });
    } finally {
      setCheckingUpdate(false);
      setUpdateProgress(null);
    }
  };

  const handleReconnect = async () => {
    const confirmed = await dialog.confirm({
      title: "Reconectar o VoltChat?",
      message: "O aplicativo será reiniciado para atualizar conversas, prévias e arquivos. Sua sessão permanecerá conectada.",
      confirmLabel: "Reiniciar agora",
    });
    if (!confirmed) return;

    if (window.voltChatDesktop?.relaunchApp) {
      await window.voltChatDesktop.relaunchApp();
      return;
    }
    window.location.reload();
  };

  const handleLogout = async () => {
    await logout();
    if (window.voltChatDesktop?.quitApp) {
      await window.voltChatDesktop.quitApp();
      return;
    }
    navigate("/login");
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "" : "sidebar--collapsed"}`}>
        <div className="sidebar__brand">
          <div className="sidebar__brand-row">
            <button
              className="sidebar__brand-lockup"
              type="button"
              onClick={() => navigate("/chat")}
              title="DACHBYTE Chat"
            >
              <img
                className="sidebar__brand-icon"
                src={publicUrl + "/brand/dachbyte/business/mark.svg"}
                alt="DACHBYTE Chat"
              />
              {sidebarOpen && (
                <span className="sidebar__brand-copy">
                  <strong>DACHBYTE Chat</strong>
                  <small>{user?.company_name || "Corporativo"}</small>
                </span>
              )}
            </button>
            <button
              className="icon-button sidebar__collapse"
              onClick={() => setSidebarOpen((value) => !value)}
              aria-label={sidebarOpen ? "Recolher menu" : "Expandir menu"}
              title={sidebarOpen ? "Recolher menu" : "Expandir menu"}
            >
              {sidebarOpen ? (
                <ChevronLeft size={18} />
              ) : (
                <ChevronRight size={18} />
              )}
            </button>
          </div>
        </div>

        <nav className="nav-list" aria-label="Navegação principal">
          {menuItems
            .filter((item) => item.show)
            .map((item, index, visibleItems) => {
              const Icon = item.icon;
              const active =
                location.pathname === item.path ||
                (item.path === "/tasks" && location.pathname === "/kanban");
              const showGroup =
                sidebarOpen &&
                (index === 0 || visibleItems[index - 1]?.group !== item.group);

              return (
                <React.Fragment key={item.path}>
                  {showGroup && (
                    <span className="nav-group-label">{item.group}</span>
                  )}
                  <button
                    className={"nav-item " + (active ? "nav-item--active" : "")}
                    onClick={() => navigate(item.path)}
                    title={item.name}
                  >
                    <Icon size={18} strokeWidth={1.9} />
                    {sidebarOpen && (
                      <span className="truncate font-semibold">
                        {item.name}
                      </span>
                    )}
                    {sidebarOpen && item.tag && (
                      <span className="nav-item__tag">{item.tag}</span>
                    )}
                    {sidebarOpen && item.path === "/chat" && (
                      <span
                        className={
                          "status-dot ml-auto " +
                          (connected ? "status-dot--online" : "")
                        }
                      />
                    )}
                  </button>
                </React.Fragment>
              );
            })}
        </nav>

        <div className="sidebar__profile mt-auto">
          <div className="sidebar-profile-card flex items-start gap-3">
            <button
              className="sidebar-profile-button flex-1 flex items-center gap-3"
              type="button"
              onClick={() => setProfileOpen(true)}
              title="Configurar perfil"
            >
              <div
                className={`sidebar__avatar grid h-10 w-10 place-items-center rounded-lg bg-slate-700 text-sm font-bold text-white ${
                  userBirthdayToday ? "sidebar__avatar--birthday" : ""
                }`}
              >
                {user?.profile_photo ? (
                  <img src={user.profile_photo} alt="Foto de perfil" />
                ) : (
                  (user?.full_name || user?.username || "U")
                    .charAt(0)
                    .toUpperCase()
                )}
                <span
                  className={`sidebar__avatar-status ${
                    statusOptions.find((item) => item.value === profileStatus)
                      ?.dotClass || "status-dot--online"
                  }`}
                />
                {userBirthdayToday && (
                  <>
                    <span className="party-hat" />
                    <span className="avatar-confetti avatar-confetti--one" />
                    <span className="avatar-confetti avatar-confetti--two" />
                    <span className="avatar-confetti avatar-confetti--three" />
                  </>
                )}
              </div>
              {sidebarOpen && (
                <div className="min-w-0">
                  <p className="m-0 truncate text-sm font-bold text-white">
                    {user?.nickname || user?.full_name || user?.username}
                  </p>
                  <p className="m-0 truncate text-xs text-slate-400">
                    {user?.nickname && user?.full_name
                      ? "(" + user.full_name + ")"
                      : user?.company_name || "Configurar perfil"}
                  </p>
                </div>
              )}
              {sidebarOpen && (
                <ChevronRight className="ml-auto text-slate-400" size={16} />
              )}
            </button>
          </div>

          <div className="sidebar-profile-status-wrapper">
            <button
              className={`sidebar-profile-status ${profileStatus}`}
              type="button"
              onClick={() => setStatusMenuOpen((current) => !current)}
              title="Alterar status"
              aria-expanded={statusMenuOpen}
            >
              <span
                className={`status-dot ${
                  statusOptions.find((item) => item.value === profileStatus)
                    ?.dotClass || "status-dot--online"
                }`}
              />
              {sidebarOpen && (
                <>
                  <span>
                    {statusOptions.find((item) => item.value === profileStatus)
                      ?.label || "Online"}
                  </span>
                  <ChevronDown className="ml-auto" size={15} />
                </>
              )}
            </button>
            {statusMenuOpen && (
              <div className="sidebar-profile-status-menu">
                {statusOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={option.value === profileStatus ? "active" : ""}
                    onClick={() => handleStatusChange(option.value)}
                  >
                    <span className={`status-dot ${option.dotClass}`} />
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="sidebar-profile-actions">
            <button
              className="nav-item sidebar-update-button"
              type="button"
              onClick={handleManualUpdate}
              title={checkingUpdate ? "Atualizando DACHBYTE Chat" : "Verificar atualizações"}
              disabled={checkingUpdate}
            >
              {checkingUpdate ? (
                <LoaderCircle className="animate-spin" size={18} />
              ) : (
                <RefreshCw size={18} />
              )}
              {sidebarOpen && (
                <span className="font-semibold">
                  {checkingUpdate
                    ? updateProgress !== null && updateProgress < 100
                      ? `${updateProgress}%`
                      : "Atualizando"
                    : "Atualizar"}
                </span>
              )}
            </button>
            <button
              className="nav-item sidebar-reconnect-button"
              type="button"
              onClick={handleReconnect}
              title="Reconectar e atualizar o aplicativo"
            >
              <RotateCw size={18} />
              <span className="sidebar-profile-action__label">Reconectar</span>
            </button>
            <button
              className="nav-item text-red-200 hover:text-white"
              type="button"
              onClick={handleLogout}
              title="Sair"
            >
              <LogOut size={18} />
              <span className="sidebar-profile-action__label">Sair</span>
            </button>
          </div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="topbar__title min-w-0">
            <h1>{title}</h1>
            <p>{description}</p>
          </div>

          <div className="topbar__actions">
            <span className="topbar__secure">
              <ShieldCheck size={15} /> Ambiente seguro
            </span>
            <span
              className={
                "badge " + (connected ? "badge--success" : "badge--danger")
              }
            >
              <span
                className={
                  "status-dot " + (connected ? "status-dot--online" : "")
                }
              />
              {connected ? "Online" : "Offline"}
            </span>
            <button
              className="icon-button icon-button--light"
              onClick={() => navigate("/notifications")}
              aria-label="Notificações"
              title="Notificações"
            >
              <Bell size={18} />
            </button>
          </div>
        </header>

        <main className="page-content">{children}</main>
      </div>
      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </div>
  );
};

export default Layout;
