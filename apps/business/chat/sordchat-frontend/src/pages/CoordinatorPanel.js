import React, { useEffect, useMemo, useState } from 'react';
import {
  BriefcaseBusiness,
  CheckCircle2,
  MessageSquareText,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Ticket,
  UserPlus,
  Users,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { API_BASE_URL } from '../config';
import { useAuth } from '../contexts/AuthContext';
import { formatBirthday, formatBirthdayInput } from '../utils/birthdays';

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

const CoordinatorPanel = () => {
  const { user } = useAuth();
  const [overview, setOverview] = useState(null);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [messageQuery, setMessageQuery] = useState('');
  const [newGroup, setNewGroup] = useState({ name: '', description: '' });
  const [newUser, setNewUser] = useState({
    username: '',
    email: '',
    full_name: '',
    password: '',
    role_title: '',
    phone_extension: '',
    birthday: '',
  });

  const department = overview?.department || user?.department || 'Setor';

  const loadData = async () => {
    setLoading(true);
    try {
      const [overviewData, groupData] = await Promise.all([
        requestJson('/coordinator/overview'),
        requestJson('/groups/'),
      ]);
      setOverview(overviewData);
      setGroups(groupData);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const filteredUsers = useMemo(() => {
    const users = overview?.users || [];
    const term = query.trim().toLowerCase();
    if (!term) return users;
    return users.filter((item) =>
      [item.full_name, item.username, item.email, item.role_title, item.phone_extension].join(' ').toLowerCase().includes(term)
    );
  }, [overview, query]);

  const filteredMessages = useMemo(() => {
    const term = messageQuery.trim().toLowerCase();
    const messages = overview?.messages || [];
    if (!term) return messages;
    return messages.filter((message) => [message.sender_name, message.receiver_name, message.content]
      .join(' ').toLowerCase().includes(term));
  }, [messageQuery, overview]);

  const handleCreateUser = async (event) => {
    event.preventDefault();
    try {
      await requestJson('/users/', {
        method: 'POST',
        body: JSON.stringify({
          ...newUser,
          access_level: 'usuario',
          department,
        }),
      });
      toast.success('Usuario do setor criado.');
      setNewUser({ username: '', email: '', full_name: '', password: '', role_title: '', phone_extension: '', birthday: '' });
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const updateTicket = async (ticketId, status) => {
    try {
      await requestJson(`/tickets/${ticketId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      toast.success('Ticket atualizado.');
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleCreateGroup = async (event) => {
    event.preventDefault();
    try {
      await requestJson('/groups/', {
        method: 'POST',
        body: JSON.stringify({ ...newGroup, department }),
      });
      toast.success('Grupo criado.');
      setNewGroup({ name: '', description: '' });
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const stats = overview?.stats || {};

  return (
    <div className="work-page">
      <section className="panel p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <span className="badge">
              <ShieldCheck size={13} />
              Coordenacao
            </span>
            <h2 className="m-0 mt-3 text-2xl font-extrabold text-slate-950">Painel do setor {department}</h2>
            <p className="m-0 mt-1 text-sm text-slate-500">
              Acompanhe tickets, conversas e usuarios vinculados ao setor que voce coordena.
            </p>
          </div>
          <button className="button-secondary" type="button" onClick={loadData} disabled={loading}>
            <RefreshCw size={17} />
            Atualizar
          </button>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          ['Usuarios do setor', stats.users || 0, Users],
          ['Tickets do setor', stats.tickets || 0, Ticket],
          ['Tickets abertos', stats.open_tickets || 0, BriefcaseBusiness],
          ['Conversas', stats.messages || 0, MessageSquareText],
        ].map(([label, value, Icon]) => (
          <article className="metric-card" key={label}>
            <Icon className="text-teal-700" size={20} />
            <p className="m-0 mt-4 text-sm font-bold text-slate-500">{label}</p>
            <p className="m-0 mt-2 text-3xl font-extrabold text-slate-950">{value}</p>
          </article>
        ))}
      </section>

      <section className="panel p-5">
        <div className="mb-4 flex items-center gap-2">
          <UserPlus size={18} className="text-teal-700" />
          <h3 className="m-0 text-lg font-extrabold text-slate-950">Criar usuario no setor</h3>
        </div>
        <form className="coordinator-form" onSubmit={handleCreateUser}>
          <input className="input" value={newUser.full_name} onChange={(event) => setNewUser((prev) => ({ ...prev, full_name: event.target.value }))} placeholder="Nome completo" />
          <input className="input" value={newUser.username} onChange={(event) => setNewUser((prev) => ({ ...prev, username: event.target.value }))} placeholder="Usuario" />
          <input className="input" value={newUser.email} onChange={(event) => setNewUser((prev) => ({ ...prev, email: event.target.value }))} placeholder="Email" />
          <input className="input" type="password" value={newUser.password} onChange={(event) => setNewUser((prev) => ({ ...prev, password: event.target.value }))} placeholder="Senha inicial" />
          <input className="input" value={newUser.role_title} onChange={(event) => setNewUser((prev) => ({ ...prev, role_title: event.target.value }))} placeholder="Cargo" />
          <input className="input" value={newUser.phone_extension} onChange={(event) => setNewUser((prev) => ({ ...prev, phone_extension: event.target.value }))} placeholder="Ramal" />
          <input className="input" value={newUser.birthday} onChange={(event) => setNewUser((prev) => ({ ...prev, birthday: formatBirthdayInput(event.target.value) }))} placeholder="Nascimento DD-MM-AA ou DD-MM-AAAA" inputMode="numeric" maxLength={10} title="Aceita 24/09/03, 24-09-2003 ou 24092003" />
          <button className="button-primary" type="submit">
            <Save size={17} />
            Criar
          </button>
        </form>
      </section>

      <section className="panel p-5">
        <h3 className="m-0 text-lg font-extrabold text-slate-950">Grupos do setor</h3>
        <form className="mt-4 grid gap-2 md:grid-cols-[1fr_1fr_auto]" onSubmit={handleCreateGroup}>
          <input
            className="input"
            value={newGroup.name}
            onChange={(event) => setNewGroup((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="Novo grupo"
          />
          <input
            className="input"
            value={newGroup.description}
            onChange={(event) => setNewGroup((prev) => ({ ...prev, description: event.target.value }))}
            placeholder="Descricao"
          />
          <button className="button-primary" type="submit">
            Criar grupo
          </button>
        </form>
        <div className="mt-4 flex flex-wrap gap-2">
          {groups.map((group) => (
            <span className="badge" key={group.id}>
              {group.name}
            </span>
          ))}
          {groups.length === 0 && <p className="m-0 text-sm text-slate-500">Nenhum grupo criado para este setor.</p>}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <article className="panel p-5">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h3 className="m-0 text-lg font-extrabold text-slate-950">Equipe do setor</h3>
            <div className="relative w-full md:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={17} />
              <input className="input pl-10" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar no setor" />
            </div>
          </div>
          <div className="grid gap-3">
            {filteredUsers.map((item) => (
              <div className="rounded-lg border border-slate-200 bg-white p-3" key={item.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="m-0 font-extrabold text-slate-950">{item.full_name}</p>
                    <p className="m-0 text-sm text-slate-500">@{item.username} - {item.email}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className={`badge ${item.is_active ? 'badge--success' : 'badge--danger'}`}>
                      <CheckCircle2 size={13} />
                      {item.is_active ? 'Ativo' : 'Inativo'}
                    </span>
                    {item.phone_extension && <span className="badge">Ramal {item.phone_extension}</span>}
                  </div>
                </div>
                <p className="m-0 mt-2 text-sm text-slate-500">
                  {item.role_title || 'Sem cargo definido'} {item.birthday ? `- Aniversario ${formatBirthday(item.birthday)}` : ''}
                </p>
              </div>
            ))}
          </div>
        </article>

        <article className="panel p-5">
          <h3 className="m-0 text-lg font-extrabold text-slate-950">Tickets do setor</h3>
          <div className="mt-4 grid gap-3">
            {(overview?.tickets || []).map((ticket) => (
              <div className="rounded-lg border border-slate-200 bg-white p-3" key={ticket.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="m-0 font-extrabold text-slate-950">{ticket.title}</p>
                  <span className="badge">{ticket.status}</span>
                </div>
                <p className="m-0 mt-1 text-sm text-slate-500">{ticket.description}</p>
                <p className="m-0 mt-2 text-xs font-bold text-slate-400">
                  Responsavel: {ticket.assigned_to_name || 'Nao atribuido'}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {['Aberto', 'Em andamento', 'Resolvido'].map((status) => (
                    <button key={status} className="button-secondary" type="button" disabled={ticket.status === status} onClick={() => updateTicket(ticket.id, status)}>
                      {status}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {(overview?.tickets || []).length === 0 && <p className="m-0 text-sm text-slate-500">Nenhum ticket do setor.</p>}
          </div>
        </article>
      </section>

      <section className="panel p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="m-0 text-lg font-extrabold text-slate-950">Conversas recentes da empresa</h3>
            <p className="m-0 mt-1 text-sm text-slate-500">Disponível somente para o administrador master da empresa.</p>
          </div>
          {overview?.can_view_messages && (
            <div className="relative w-full md:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={17} />
              <input className="input pl-10" value={messageQuery} onChange={(event) => setMessageQuery(event.target.value)} placeholder="Buscar por nome de usuário" />
            </div>
          )}
        </div>
        <div className="recent-conversations-list mt-4 grid gap-3">
          {overview?.can_view_messages && filteredMessages.map((message) => (
            <div className="rounded-lg border border-slate-200 bg-white p-3" key={message.id}>
              <p className="m-0 text-sm font-bold text-slate-700">
                {message.sender_name} {message.receiver_name ? `para ${message.receiver_name}` : 'no chat geral'}
              </p>
              <p className="m-0 mt-1 text-sm text-slate-500">{message.content}</p>
            </div>
          ))}
          {!overview?.can_view_messages && <p className="m-0 text-sm text-slate-500">Seu perfil não possui acesso ao conteúdo das mensagens.</p>}
          {overview?.can_view_messages && filteredMessages.length === 0 && <p className="m-0 text-sm text-slate-500">Nenhuma conversa encontrada.</p>}
        </div>
      </section>
    </div>
  );
};

export default CoordinatorPanel;
