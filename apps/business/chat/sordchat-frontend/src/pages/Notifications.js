import React, { useEffect, useMemo, useState } from 'react';
import { Bell, CheckCheck, Clock3, FileUp, MessageSquare, Ticket } from 'lucide-react';
import toast from 'react-hot-toast';
import { normalizeDisplayText } from '../utils/assistantText';

const initialNotifications = [
  {
    id: 'notif-1',
    type: 'Chat',
    title: 'Chat em tempo real ativo',
    description: 'O socket esta conectado e pronto para novas mensagens.',
    time: 'Agora',
    unread: true,
  },
  {
    id: 'notif-2',
    type: 'Ticket',
    title: 'Fila de tickets disponivel',
    description: 'Novos chamados podem ser criados pela aba Tickets.',
    time: 'Hoje',
    unread: true,
  },
  {
    id: 'notif-3',
    type: 'Arquivo',
    title: 'Upload ampliado',
    description: 'Formatos comuns de documentos e imagens estao liberados.',
    time: 'Hoje',
    unread: false,
  },
];

const typeIcon = {
  Chat: MessageSquare,
  Ticket,
  Arquivo: FileUp,
};

const Notifications = () => {
  const [notifications, setNotifications] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('voltcorp:notifications')) || initialNotifications;
    } catch {
      return initialNotifications;
    }
  });
  const [filter, setFilter] = useState('Todas');

  useEffect(() => {
    const refreshNotifications = (event) => {
      if (Array.isArray(event.detail)) {
        setNotifications(event.detail);
        return;
      }

      try {
        setNotifications(JSON.parse(localStorage.getItem('voltcorp:notifications')) || initialNotifications);
      } catch {
        setNotifications(initialNotifications);
      }
    };

    window.addEventListener('voltcorp:notifications-updated', refreshNotifications);
    window.addEventListener('storage', refreshNotifications);
    return () => {
      window.removeEventListener('voltcorp:notifications-updated', refreshNotifications);
      window.removeEventListener('storage', refreshNotifications);
    };
  }, []);

  const saveNotifications = (nextNotifications) => {
    setNotifications(nextNotifications);
    localStorage.setItem('voltcorp:notifications', JSON.stringify(nextNotifications));
  };

  const filteredNotifications = useMemo(() => {
    if (filter === 'Nao lidas') return notifications.filter((item) => item.unread);
    return notifications;
  }, [filter, notifications]);

  const markAllRead = () => {
    saveNotifications(notifications.map((item) => ({ ...item, unread: false })));
    toast.success('Notificacoes marcadas como lidas.');
  };

  return (
    <div className="work-page">
      <section className="panel p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <span className="badge">Alertas</span>
            <h2 className="m-0 mt-3 text-2xl font-extrabold text-slate-950">Central de notificacoes</h2>
            <p className="m-0 mt-1 text-sm text-slate-500">Acompanhe eventos importantes do workspace em um unico lugar.</p>
          </div>
          <button className="button-primary" type="button" onClick={markAllRead}>
            <CheckCheck size={17} />
            Marcar lidas
          </button>
        </div>
      </section>

      <section className="flex flex-wrap gap-2">
        {['Todas', 'Nao lidas'].map((item) => (
          <button key={item} className={`button-secondary ${filter === item ? 'button-secondary--active' : ''}`} type="button" onClick={() => setFilter(item)}>
            {item}
          </button>
        ))}
      </section>

      <section className="grid gap-3">
        {filteredNotifications.length === 0 ? (
          <section className="empty-state">
            <div className="empty-state__icon">
              <Bell size={28} />
            </div>
            <h2>Nenhum alerta pendente</h2>
            <p>Novos eventos aparecem aqui.</p>
          </section>
        ) : (
          filteredNotifications.map((item) => {
            const Icon = typeIcon[item.type] || Bell;
            return (
              <article className={`panel p-4 ${item.unread ? 'ring-1 ring-teal-200' : ''}`} key={item.id}>
                <div className="flex items-start gap-3">
                  <div className="grid h-11 w-11 place-items-center rounded-lg bg-teal-50 text-teal-700">
                    <Icon size={20} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="badge">{item.type}</span>
                      {item.unread && <span className="badge badge--success">Nova</span>}
                      <span className="badge">
                        <Clock3 size={13} />
                        {item.time}
                      </span>
                    </div>
                    <h3 className="m-0 mt-3 text-base font-extrabold text-slate-950">{normalizeDisplayText(item.title)}</h3>
                    <p className="m-0 mt-1 text-sm text-slate-500">{normalizeDisplayText(item.description)}</p>
                  </div>
                </div>
              </article>
            );
          })
        )}
      </section>
    </div>
  );
};

export default Notifications;
