import React, { useState, useEffect, useCallback } from "react";
import { PageView, SyncJobStatus } from "../types";
import { useTheme } from "../contexts/ThemeContext";
import { useAuth } from "../contexts/AuthContext";
import {
  LayoutDashboard,
  Package,
  UploadCloud,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronLeft,
  BellRing,
  Shield,
  LogOut,
  Sun,
  Moon,
  Quote,
  RefreshCcw,
  AlertTriangle,
  Timer,
  Sparkles,
  Star,
  Activity,
} from "lucide-react";
import { clsx } from "clsx";

interface SidebarProps {
  currentView: PageView;
  onChangeView: (view: PageView) => void;
  onSync: () => void;
  onCancelSync?: () => void;
  isSyncing: boolean;
  lastSync: Date | null;
  syncJob: SyncJobStatus | null;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

const VERSES = [
  { text: "Tudo posso naquele que me fortalece.", ref: "Filipenses 4:13" },
  {
    text: "Entrega o teu caminho ao Senhor; confia nele, e ele o fara.",
    ref: "Salmos 37:5",
  },
  {
    text: "Mil cairo ao teu lado, e dez mil a tua direita, mas nao chegara a ti.",
    ref: "Salmos 91:7",
  },
  { text: "O Senhor e o meu pastor, nada me faltara.", ref: "Salmos 23:1" },
  {
    text: "Esforcai-vos, e ele fortalecera o vosso coracao, vos todos que esperais no Senhor.",
    ref: "Salmos 31:24",
  },
  {
    text: "Porque sou eu que conheco os planos que tenho para voces, diz o Senhor, planos de faze-los prosperar.",
    ref: "Jeremias 29:11",
  },
  {
    text: "O temor do Senhor e o principio da sabedoria.",
    ref: "Proverbios 9:10",
  },
];

const LOGISTICS_TIPS = [
  "Dica: Revise enderecos com CEPs genericos para evitar devolucoes por endereco nao encontrado.",
  "Dica: Monitore de perto os pedidos Em Rota no final do dia para garantir o sucesso da entrega.",
  "Dica: Mantenha o cliente informado proativamente. Isso reduz chamados de suporte.",
  "Dica: Pedidos parados sem atualizacao ha mais de 3 dias devem ter chamado aberto na transportadora.",
  "Dica: Analise o ranking de transportadoras mensalmente para renegociar contratos.",
  "Dica: Use a importacao em massa para ganhar tempo no cadastro de novos pedidos.",
  "Dica: Verifique a cubagem das embalagens. Otimizar o tamanho reduz custos de frete significativamente.",
  "Dica: Em datas comemorativas, antecipe a operacao de expedicao em 2 horas.",
];

const extractBirthdayMonthDay = (
  birthDateValue?: string | null,
): { day: number; month: number } | null => {
  const normalized = String(birthDateValue || "").trim();
  if (!normalized) return null;

  const isoLikeMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoLikeMatch) {
    return {
      month: Number(isoLikeMatch[2]),
      day: Number(isoLikeMatch[3]),
    };
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;

  return {
    month: parsed.getUTCMonth() + 1,
    day: parsed.getUTCDate(),
  };
};

const isBirthdayToday = (birthDateValue?: string | null, now = new Date()) => {
  const birthday = extractBirthdayMonthDay(birthDateValue);
  if (!birthday) return false;

  return birthday.day === now.getDate() && birthday.month === now.getMonth() + 1;
};

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onChangeView,
  onSync,
  onCancelSync,
  isSyncing,
  syncJob,
  isCollapsed,
  onToggleCollapse,
}) => {
  const { theme, toggleTheme } = useTheme();
  const { user, logout } = useAuth();

  const [currentTipIndex, setCurrentTipIndex] = useState(0);
  const [verse, setVerse] = useState(VERSES[0]);
  const [animatingTip, setAnimatingTip] = useState(false);
  const [isLogsCollapsed, setIsLogsCollapsed] = useState(false);

  const handleNextTip = useCallback(() => {
    setAnimatingTip(true);
    setTimeout(() => {
      setCurrentTipIndex((prev) => (prev + 1) % LOGISTICS_TIPS.length);
      setAnimatingTip(false);
    }, 300);
  }, []);

  useEffect(() => {
    setCurrentTipIndex(Math.floor(Math.random() * LOGISTICS_TIPS.length));

    const dayIndex = new Date().getDate() % VERSES.length;
    setVerse(VERSES[dayIndex]);

    const tipInterval = setInterval(() => {
      handleNextTip();
    }, 300000);

    return () => clearInterval(tipInterval);
  }, [handleNextTip]);

  useEffect(() => {
    if (syncJob?.status === "running") {
      setIsLogsCollapsed(false);
    }
  }, [syncJob?.status]);

  const NavItem = ({
    view,
    icon: Icon,
    label,
  }: {
    view: PageView;
    icon: any;
    label: string;
  }) => (
    <button
      onClick={() => onChangeView(view)}
      title={isCollapsed ? label : undefined}
      className={clsx(
        "flex items-center w-full p-3 mb-2 rounded-lg transition-all duration-200 group relative overflow-hidden",
        isCollapsed ? "justify-center px-2" : "",
        currentView === view
          ? "bg-accent/10 text-accent font-medium border-r-4 border-accent dark:bg-accent/20 dark:text-neon-blue dark:border-neon-blue"
          : "text-slate-400 hover:bg-slate-800 dark:hover:bg-white/5 hover:text-white",
      )}
    >
      <div
        className={clsx(
          "absolute inset-0 opacity-0 transition-opacity",
          currentView === view &&
            "bg-gradient-to-r from-accent/0 to-accent/5 dark:to-neon-blue/10 opacity-100",
        )}
      ></div>
      <Icon
        className={clsx(
          "w-5 h-5 relative z-10",
          !isCollapsed && "mr-3",
          currentView === view
            ? "text-accent dark:text-neon-blue"
            : "text-slate-500 group-hover:text-white",
        )}
      />
      {!isCollapsed && <span className="relative z-10">{label}</span>}
      {!isCollapsed && currentView === view && (
        <ChevronRight className="w-4 h-4 ml-auto relative z-10" />
      )}
    </button>
  );

  const syncProgress =
    syncJob && syncJob.total > 0
      ? Math.min(100, Math.round((syncJob.processed / syncJob.total) * 100))
      : 0;
  const showBirthdayAvatarStyle = isBirthdayToday(user?.birthDate || null);

  const recentLogs = syncJob?.logs.slice().reverse() || [];

  return (
    <aside
      className={clsx(
        "bg-primary dark:bg-[#08090f] text-white flex flex-col shadow-xl z-20 hidden md:flex border-r border-slate-800 dark:border-white/5 transition-all duration-300 relative",
        isCollapsed ? "w-20" : "w-64",
      )}
    >
      <div
        className={clsx(
          "border-b border-slate-800 dark:border-white/5 relative overflow-hidden group shrink-0",
          isCollapsed ? "p-3" : "p-6",
        )}
      >
        <div className={clsx("relative z-10", isCollapsed ? "flex flex-col items-center gap-3" : "")}> 
          <button
            onClick={onToggleCollapse}
            type="button"
            title={isCollapsed ? "Expandir menu" : "Recolher menu"}
            className={clsx(
              "rounded-lg border border-white/10 bg-black/20 text-slate-300 hover:text-white hover:bg-white/10 transition-colors relative z-20",
              isCollapsed ? "p-2" : "absolute top-0 right-0 p-2",
            )}
          >
            {isCollapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </button>

          <img
            src="/brand/dachbyte/seller/mark-transparent.png"
            alt="DACHBYTE Tracking"
            className={clsx(
              "object-contain drop-shadow-[0_0_8px_rgba(59,130,246,0.6)]",
              isCollapsed ? "w-10 h-10 mt-8 rounded-lg" : "w-16 h-16 mb-2 rounded-xl",
            )}
          />

          {!isCollapsed && (
            <p className="text-[10px] text-slate-500 text-center tracking-[0.2em] uppercase mt-2 font-tech relative z-10">
              DACHBYTE Tracking
            </p>
          )}
        </div>
      </div>

      <nav
        className={clsx(
          "flex-1 overflow-y-auto overflow-x-hidden relative z-10 custom-scrollbar flex flex-col",
          isCollapsed ? "p-3" : "p-4",
        )}
      >
        <NavItem view="dashboard" icon={LayoutDashboard} label="Dashboard" />
        <NavItem
          view="monitoring-panel"
          icon={Activity}
          label="Painel"
        />
        <NavItem view="alerts" icon={BellRing} label="Alertas de Risco" />
        <NavItem
          view="delivery-failures"
          icon={AlertTriangle}
          label="Falhas na Entrega"
        />
        <NavItem view="orders" icon={Package} label="Pedidos" />
        <NavItem
          view="monitored-orders"
          icon={Star}
          label="Monitorados"
        />
        <NavItem view="no-movement" icon={Timer} label="Sem Movimentacao" />
        <NavItem view="upload" icon={UploadCloud} label="Importar CSV" />
        <NavItem
          view="latest-updates"
          icon={Sparkles}
          label="Ultimas Atualizacoes"
        />

        <>
          <div className="my-4 border-t border-slate-800 dark:border-white/10 mx-2"></div>
        <NavItem
          view="admin"
          icon={Shield}
          label={user?.role === "ADMIN" ? "Administracao" : "Configuracoes"}
        />
        </>

        <div className="flex-1"></div>

        {!isCollapsed && (
          <div className="mt-4 mx-1">
            <div className="relative mt-2 bg-blue-900/40 border border-blue-500/20 rounded-lg p-3 transition-all duration-300">
              <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-blue-900/40 border-t border-l border-blue-500/20 rotate-45"></div>

              <div className="flex items-start gap-2">
                <p
                  className={clsx(
                    "text-[10px] text-blue-200 leading-relaxed italic flex-1 transition-opacity duration-300",
                    animatingTip ? "opacity-0" : "opacity-100",
                  )}
                >
                  "{LOGISTICS_TIPS[currentTipIndex]}"
                </p>
                <button
                  onClick={handleNextTip}
                  className="text-blue-400 hover:text-white transition-colors p-1"
                  title="Nova dica"
                >
                  <RefreshCcw
                    className={clsx("w-3 h-3", animatingTip && "animate-spin")}
                  />
                </button>
              </div>
            </div>
          </div>
        )}
      </nav>

      <div className="p-4 border-t border-slate-800 dark:border-white/5 bg-slate-900/50 dark:bg-black/20 relative z-10 shrink-0">
        {!isCollapsed && (
          <div className="mb-4 text-center group cursor-default">
            <div className="flex items-center justify-center gap-2 mb-1 opacity-50 group-hover:opacity-100 transition-opacity">
              <div className="h-[1px] w-4 bg-slate-600"></div>
              <Quote className="w-3 h-3 text-slate-500" />
              <div className="h-[1px] w-4 bg-slate-600"></div>
            </div>
            <p className="text-[10px] text-slate-400 italic font-serif leading-tight">
              "{verse.text}"
            </p>
            <p className="text-[9px] text-slate-600 font-bold mt-1 uppercase">
              {verse.ref}
            </p>
          </div>
        )}

        <div className={clsx("mb-4", isCollapsed ? "flex flex-col items-center gap-3" : "")}> 
          <div className={clsx("flex items-center", isCollapsed ? "justify-center" : "justify-between")}> 
            <div className="flex items-center gap-2">
              <div className="relative">
                <div
                  className={clsx(
                    "w-8 h-8 rounded-full overflow-hidden bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-xs font-bold",
                    showBirthdayAvatarStyle &&
                      "ring-2 ring-amber-300/90 ring-offset-1 ring-offset-slate-900",
                  )}
                >
                  {user?.profileImageData ? (
                    <img
                      src={user.profileImageData}
                      alt={`Foto de perfil de ${user?.name || "usuario"}`}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <>{user?.name?.charAt(0)}</>
                  )}
                </div>

                {showBirthdayAvatarStyle && (
                  <>
                    <div className="pointer-events-none absolute -top-[10px] left-1/2 z-10 -translate-x-1/2 rotate-[-12deg]">
                      <div className="h-0 w-0 border-l-[7px] border-r-[7px] border-b-[14px] border-l-transparent border-r-transparent border-b-fuchsia-500" />
                      <div className="absolute -top-[4px] left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-yellow-300" />
                      <div className="absolute top-[10px] left-1/2 h-[2px] w-[12px] -translate-x-1/2 rounded-full bg-yellow-200/90" />
                    </div>

                    <span className="pointer-events-none absolute -left-1.5 -top-0.5 h-1.5 w-1.5 rounded-sm bg-fuchsia-400" />
                    <span className="pointer-events-none absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-emerald-300" />
                    <span className="pointer-events-none absolute -right-2 top-3 h-1.5 w-1.5 rounded-sm bg-yellow-300" />
                    <span className="pointer-events-none absolute -left-1 bottom-0.5 h-1.5 w-1.5 rounded-full bg-sky-300" />
                    <span className="pointer-events-none absolute right-0 bottom-[-3px] h-1.5 w-1.5 rounded-sm bg-pink-300" />
                    <span className="pointer-events-none absolute left-2 -bottom-1.5 h-1.5 w-1.5 rounded-full bg-orange-300" />
                  </>
                )}
              </div>
              {!isCollapsed && (
                <div className="flex flex-col">
                  <span className="text-xs font-medium text-white">{user?.name}</span>
                  <span className="text-[10px] text-slate-400">{user?.role}</span>
                </div>
              )}
            </div>
            {!isCollapsed && (
              <button
                onClick={toggleTheme}
                className="p-2 rounded-lg hover:bg-white/10 transition-colors text-slate-400 hover:text-white"
                title="Alternar tema"
              >
                {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
            )}
          </div>

          {isCollapsed && (
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg hover:bg-white/10 transition-colors text-slate-400 hover:text-white"
              title="Alternar tema"
            >
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          )}
        </div>

        <button
          onClick={onSync}
          disabled={isSyncing}
          title={isCollapsed ? (isSyncing ? "Sincronizando" : "Sincronizar") : undefined}
          className={clsx(
            "w-full flex items-center justify-center rounded-lg font-medium transition-all mb-2",
            isCollapsed ? "p-2" : "p-3",
            isSyncing
              ? "bg-slate-700 text-slate-400 cursor-not-allowed"
              : "bg-accent hover:bg-blue-600 text-white shadow-lg shadow-blue-900/50 dark:shadow-[0_0_15px_rgba(59,130,246,0.3)]",
          )}
        >
          <RefreshCw
            className={clsx("w-4 h-4", !isCollapsed && "mr-2", isSyncing && "animate-spin")}
          />
          {!isCollapsed && (isSyncing ? "Sync..." : "Sincronizar")}
        </button>

        {!isCollapsed && isSyncing && onCancelSync && (
          <button
            onClick={onCancelSync}
            className="w-full flex items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm font-medium text-red-300 transition-all mb-2 hover:bg-red-500/20"
          >
            Cancelar Rastreio
          </button>
        )}

        {!isCollapsed && syncJob && (
          <div className="mb-3 rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-300">
              <div className="flex items-center gap-2">
                <span className="font-semibold uppercase tracking-wide">
                  {syncJob.status === "running" ? "Logs do Sync" : "Logs do Ultimo Sync"}
                </span>
                <span>
                  {syncJob.processed}/{syncJob.total || 0}
                </span>
              </div>
              <button
                onClick={() => setIsLogsCollapsed((current) => !current)}
                type="button"
                className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
              >
                {isLogsCollapsed ? "Expandir" : "Recolher"}
                {isLogsCollapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
              </button>
            </div>

            {!isLogsCollapsed && (
              <>
                <div className="mb-2 mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                  <div
                    className={clsx(
                      "h-full transition-all duration-300",
                      syncJob.status === "failed"
                        ? "bg-red-500"
                        : syncJob.status === "canceled"
                          ? "bg-amber-500"
                        : syncJob.status === "completed"
                          ? "bg-emerald-500"
                          : "bg-accent",
                    )}
                    style={{ width: `${syncProgress}%` }}
                  />
                </div>

                <div className="mb-2 text-[10px] text-slate-400">
                  <div>Sucesso: {syncJob.success}</div>
                  <div>Falhas: {syncJob.failed}</div>
                  {syncJob.currentOrderNumber && (
                    <div className="truncate">Atual: #{syncJob.currentOrderNumber}</div>
                  )}
                </div>

                <div className="max-h-48 space-y-1 overflow-auto pr-1 text-[10px]">
                  {recentLogs.length === 0 && (
                    <div className="rounded px-2 py-1 bg-white/5 text-slate-400">
                      Nenhum log disponivel.
                    </div>
                  )}
                  {recentLogs.map((log, index) => (
                    <div
                      key={`${log.timestamp}-${index}`}
                      className={clsx(
                        "rounded px-2 py-1",
                        log.level === "error"
                          ? "bg-red-500/10 text-red-300"
                          : log.level === "success"
                            ? "bg-emerald-500/10 text-emerald-300"
                            : "bg-white/5 text-slate-300",
                      )}
                    >
                      <div className="mb-0.5 text-[9px] text-slate-500">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </div>
                      <div>{log.message}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <button
          onClick={logout}
          title={isCollapsed ? "Sair" : undefined}
          className="w-full flex items-center justify-center p-2 text-xs text-slate-400 hover:text-red-400 transition-colors gap-2"
        >
          <LogOut className="w-3 h-3" /> {!isCollapsed && "Sair"}
        </button>
      </div>
    </aside>
  );
};
