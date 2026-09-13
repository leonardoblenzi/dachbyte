import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Building2,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Headphones,
  Hourglass,
  Inbox,
  ListTodo,
  MessageSquare,
  Radio,
  Ticket,
  UsersRound,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { useWebSocket } from "../contexts/WebSocketContext";
import { API_BASE_URL } from "../config";

const emptyTicketBoard = {
  total: 0,
  open: 0,
  waiting_attendant: 0,
  waiting_user: 0,
  closed: 0,
};

const initials = (name) =>
  String(name || "U")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

const formatConversationTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
};

const DashboardAvatar = ({ item, online = false }) => {
  if (item.type === "general") {
    return <span className="dashboard-avatar dashboard-avatar--general"><MessageSquare size={19} /></span>;
  }
  return (
    <span className="dashboard-avatar">
      {item.profile_photo ? <img src={item.profile_photo} alt="" /> : initials(item.name || item.full_name)}
      {online && <i className="dashboard-avatar__presence" aria-label="Online" />}
    </span>
  );
};

const TicketBoard = ({ title, icon: Icon, board = emptyTicketBoard, accent }) => {
  const cards = [
    { key: "open", label: "Abertos", icon: Inbox, tone: "blue" },
    { key: "waiting_attendant", label: "Aguardando atendente", icon: Hourglass, tone: "amber" },
    { key: "waiting_user", label: "Aguardando usuário", icon: UsersRound, tone: "green" },
    { key: "closed", label: "Fechados", icon: CheckCircle2, tone: "slate" },
  ];
  const total = Number(board.total || 0);

  return (
    <section className="dashboard-ticket-board">
      <header className="dashboard-section__header">
        <div>
          <span className={`dashboard-section__icon dashboard-section__icon--${accent}`}><Icon size={16} /></span>
          <h3>{title}</h3>
        </div>
        <span className="dashboard-section__count">{total}</span>
      </header>
      <div className="dashboard-ticket-board__cards">
        {cards.map(({ key, label, icon: CardIcon, tone }) => {
          const value = Number(board[key] || 0);
          const percent = total ? Math.round((value / total) * 100) : 0;
          return (
            <article className={`dashboard-ticket-stat dashboard-ticket-stat--${tone}`} key={key}>
              <span className="dashboard-ticket-stat__icon"><CardIcon size={16} /></span>
              <strong>{value}</strong>
              <small>{label}</small>
              <div className="dashboard-ticket-stat__footer">
                <div className="dashboard-ticket-stat__progress"><i style={{ width: `${percent}%` }} /></div>
                <em>{percent}%</em>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
};

const Dashboard = () => {
  const { user, isPlatformAdmin } = useAuth();
  const { connected, onlineUsers } = useWebSocket();
  const navigate = useNavigate();
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState("");
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return undefined;
    let active = true;
    const loadCompanies = async () => {
      if (!isPlatformAdmin()) {
        setCompanyId(user.company_id || "");
        setCompanies([]);
        return;
      }
      try {
        const response = await fetch(`${API_BASE_URL}/companies/available`, {
          headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
        });
        if (!response.ok) throw new Error("Não foi possível carregar as empresas.");
        const data = await response.json();
        if (!active) return;
        setCompanies(data);
        setCompanyId((current) => current || data[0]?.id || "");
      } catch (requestError) {
        if (active) {
          setError(requestError.message);
          setLoading(false);
        }
      }
    };
    loadCompanies();
    return () => { active = false; };
  }, [isPlatformAdmin, user]);

  useEffect(() => {
    if (!companyId) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch(`${API_BASE_URL}/dashboard/overview?company_id=${encodeURIComponent(companyId)}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.detail || "Não foi possível carregar o dashboard.");
        }
        return response.json();
      })
      .then(setOverview)
      .catch((requestError) => requestError.name !== "AbortError" && setError(requestError.message))
      .finally(() => !controller.signal.aborted && setLoading(false));
    return () => controller.abort();
  }, [companyId]);

  const onlineUserIds = useMemo(() => new Set((onlineUsers || []).map((item) => Number(item.id))), [onlineUsers]);
  const conversations = overview?.recent_conversations || [];
  const birthdays = overview?.birthdays_today || [];
  const boards = overview?.ticket_dashboards || {};
  const stats = overview?.stats || {};
  const scopeLabel = overview?.scope?.type === "company"
    ? "Toda a empresa"
    : overview?.scope?.type === "assigned"
      ? "Participação direta"
      : "Atribuído a mim";

  return (
    <div className="dashboard-page">
      <section className="dashboard-hero panel">
        <div className="dashboard-hero__identity">
          <DashboardAvatar item={{ name: user?.nickname || user?.full_name || user?.username, profile_photo: user?.profile_photo }} />
          <div>
            <span className={`badge ${connected ? "badge--success" : "badge--danger"}`}>
              <Radio size={13} /> {connected ? "Sistema online" : "Reconectando"}
            </span>
            <h2>Olá, {user?.nickname || user?.full_name || user?.username}.</h2>
            <p>Seu resumo de conversas, chamados e atendimentos.</p>
          </div>
        </div>
        <div className="dashboard-hero__meta">
          {isPlatformAdmin() ? (
            <label>
              <span><Building2 size={14} /> Empresa</span>
              <select className="select" value={companyId} onChange={(event) => setCompanyId(event.target.value)} disabled={companies.length < 2}>
                {companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}
              </select>
            </label>
          ) : (
            <span className="dashboard-hero__company"><Building2 size={14} /> {user?.company_name || overview?.company?.name || "Empresa"}</span>
          )}
          <span className="badge badge--info">{scopeLabel}</span>
          <span><CalendarDays size={15} /> {new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long" })}</span>
        </div>
      </section>

      {error && <section className="dashboard-error">{error}</section>}

      <section className="dashboard-section panel">
        <header className="dashboard-section__header">
          <div>
            <span className="dashboard-section__icon dashboard-section__icon--blue"><MessageSquare size={16} /></span>
            <h3>Conversas recentes</h3>
          </div>
          <span className="dashboard-section__count">{loading ? "…" : conversations.length}</span>
        </header>
        {conversations.length ? (
          <div className="dashboard-conversations">
            {conversations.map((conversation) => (
              <button
                className="dashboard-conversation"
                key={`${conversation.type}-${conversation.id}`}
                onClick={() => conversation.type === "direct" ? navigate("/chat", { state: { startChatUser: conversation } }) : navigate("/chat")}
                type="button"
              >
                <DashboardAvatar item={conversation} online={conversation.type === "direct" && onlineUserIds.has(Number(conversation.id))} />
                <strong>{conversation.name}</strong>
                <small>{conversation.last_message || "Sem mensagens"}</small>
                <time>{formatConversationTime(conversation.last_message_at)}</time>
              </button>
            ))}
          </div>
        ) : (
          <div className="dashboard-empty"><MessageSquare size={20} /> {loading ? "Carregando conversas…" : "Nenhuma conversa recente neste momento."}</div>
        )}
      </section>

      <section className="dashboard-ticket-stack panel">
        <TicketBoard title="Meus chamados" icon={Ticket} board={boards.my_requests} accent="blue" />
        <TicketBoard title="Meus atendimentos" icon={Headphones} board={boards.my_services} accent="green" />
      </section>

      <section className="dashboard-bottom-grid">
        <section className="dashboard-section panel">
          <header className="dashboard-section__header">
            <div>
              <span className="dashboard-section__icon dashboard-section__icon--violet"><CalendarDays size={16} /></span>
              <h3>Aniversariantes de hoje</h3>
            </div>
            <span className="dashboard-section__count">{birthdays.length}</span>
          </header>
          {birthdays.length ? (
            <div className="dashboard-birthdays">
              {birthdays.map((birthday) => (
                <article className="dashboard-birthday" key={birthday.id}>
                  <DashboardAvatar item={birthday} />
                  <div><strong>{birthday.name}</strong><span>{birthday.age ? `${birthday.age} anos hoje` : "Feliz aniversário!"}</span></div>
                </article>
              ))}
            </div>
          ) : <div className="dashboard-empty"><CalendarDays size={20} /> Nenhum aniversário hoje.</div>}
        </section>

        <section className="dashboard-section dashboard-actions panel">
          <header className="dashboard-section__header">
            <div>
              <span className="dashboard-section__icon dashboard-section__icon--amber"><Clock3 size={16} /></span>
              <h3>Visão rápida</h3>
            </div>
          </header>
          <div className="dashboard-actions__stats">
            <span><strong>{stats.tasks || 0}</strong> tarefas pessoais</span>
            <span><strong>{stats.active_tasks || 0}</strong> tarefas pendentes</span>
          </div>
          <div className="dashboard-actions__buttons">
            <button className="button-secondary" type="button" onClick={() => navigate("/chat")}><MessageSquare size={16} /> Abrir chat <ArrowRight size={15} /></button>
            <button className="button-secondary" type="button" onClick={() => navigate("/tickets")}><Ticket size={16} /> Ver tickets <ArrowRight size={15} /></button>
            <button className="button-secondary" type="button" onClick={() => navigate("/tasks")}><ListTodo size={16} /> Minhas tarefas <ArrowRight size={15} /></button>
          </div>
        </section>
      </section>
    </div>
  );
};

export default Dashboard;