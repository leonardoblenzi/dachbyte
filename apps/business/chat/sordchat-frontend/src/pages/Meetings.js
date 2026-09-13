import React, { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Headphones,
  Plus,
  Pencil,
  Trash2,
  Users,
  Video,
} from "lucide-react";
import toast from "react-hot-toast";
import { API_BASE_URL } from "../config";
import { useAuth } from "../contexts/AuthContext";
import { useWebSocket } from "../contexts/WebSocketContext";
import { usePlatformDialog } from "../contexts/PlatformDialogContext";

const BRAZIL_TZ = "America/Sao_Paulo";
const HOUR_HEIGHT = 54;
const tokenHeaders = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${localStorage.getItem("token")}`,
});
const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1);
const startOfDay = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());
const endOfDay = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
const startOfWeek = (date) => {
  const value = startOfDay(date);
  value.setDate(value.getDate() - value.getDay());
  return value;
};
const addDays = (date, amount) => {
  const value = new Date(date);
  value.setDate(value.getDate() + amount);
  return value;
};
const isoLocal = (date) => {
  const copy = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return copy.toISOString().slice(0, 16);
};
const toSaoPauloIso = (value) => new Date(`${value}:00-03:00`).toISOString();
const sameDay = (left, right) =>
  left.toLocaleDateString("en-CA", { timeZone: BRAZIL_TZ }) ===
  right.toLocaleDateString("en-CA", { timeZone: BRAZIL_TZ });
const overlapsDay = (meeting, day) =>
  new Date(meeting.starts_at) < endOfDay(day) &&
  new Date(meeting.ends_at) > startOfDay(day);
const formatBrazilTime = (value) =>
  new Date(value).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: BRAZIL_TZ,
  });
const itemIcon = (type, size = 15) =>
  type === "video" ? <Video size={size} /> : <Clock size={size} />;
const itemLabel = (type) =>
  type === "video" ? "Reunião" : type === "task" ? "Tarefa" : "Compromisso";
async function api(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { ...tokenHeaders(), ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(body.detail || "Não foi possível concluir.");
  return body;
}

export default function Meetings() {
  const { user, isCompanyAdmin } = useAuth();
  const { startMeetingVideo } = useWebSocket();
  const dialog = usePlatformDialog();
  const [cursor, setCursor] = useState(startOfMonth(new Date()));
  const [viewMode, setViewMode] = useState("month");
  const [meetings, setMeetings] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [selectedDay, setSelectedDay] = useState(new Date());
  const [creating, setCreating] = useState(false);
  const [editingMeeting, setEditingMeeting] = useState(null);
  const initialStart = new Date(Date.now() + 60 * 60 * 1000);
  initialStart.setMinutes(0, 0, 0);
  const [form, setForm] = useState({
    title: "",
    description: "",
    link_url: "",
    meeting_type: "reminder",
    starts_at: isoLocal(initialStart),
    ends_at: isoLocal(new Date(initialStart.getTime() + 60 * 60 * 1000)),
    color: "#2563eb",
    participant_ids: [],
  });
  const openCreate = () => {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    start.setMinutes(0, 0, 0);
    setEditingMeeting(null);
    setForm({
      title: "",
      description: "",
      link_url: "",
      meeting_type: "reminder",
      starts_at: isoLocal(start),
      ends_at: isoLocal(new Date(start.getTime() + 60 * 60 * 1000)),
      color: "#2563eb",
      participant_ids: [],
    });
    setCreating(true);
  };
  const openEdit = (meeting) => {
    setEditingMeeting(meeting);
    setForm({
      title: meeting.title || "",
      description: meeting.description || "",
      link_url: meeting.link_url || "",
      meeting_type: meeting.meeting_type || "reminder",
      starts_at: isoLocal(new Date(meeting.starts_at)),
      ends_at: isoLocal(new Date(meeting.ends_at)),
      color: meeting.color || "#2563eb",
      participant_ids: (meeting.participants || []).map((item) => item.id),
    });
    setCreating(true);
  };
  const closeForm = () => {
    setCreating(false);
    setEditingMeeting(null);
  };

  const load = async () => {
    try {
      const [agenda, people] = await Promise.all([
        api("/meetings"),
        api("/chat/contacts"),
      ]);
      setMeetings(agenda);
      setContacts(people);
    } catch (error) {
      toast.error(error.message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    const remove = (event) =>
      setMeetings((current) =>
        current.filter(
          (item) => String(item.id) !== String(event.detail?.meeting_id),
        ),
      );
    window.addEventListener("voltchat:meeting-deleted", remove);
    return () => window.removeEventListener("voltchat:meeting-deleted", remove);
  }, []);

  const monthDays = useMemo(() => {
    const first = startOfMonth(cursor),
      gridStart = addDays(first, -first.getDay());
    return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  }, [cursor]);
  const agendaDays = useMemo(
    () =>
      viewMode === "day"
        ? [startOfDay(selectedDay)]
        : Array.from({ length: 7 }, (_, index) =>
            addDays(startOfWeek(selectedDay), index),
          ),
    [selectedDay, viewMode],
  );
  const selectedMeetings = meetings.filter((item) =>
    overlapsDay(item, selectedDay),
  );
  const navigatePeriod = (amount) => {
    if (viewMode === "month")
      setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + amount, 1));
    else
      setSelectedDay(
        addDays(selectedDay, amount * (viewMode === "week" ? 7 : 1)),
      );
  };
  const save = async (event) => {
    event.preventDefault();
    try {
      await api(editingMeeting ? `/meetings/${editingMeeting.id}` : "/meetings", {
        method: editingMeeting ? "PATCH" : "POST",
        body: JSON.stringify({
          ...form,
          starts_at: toSaoPauloIso(form.starts_at),
          ends_at: toSaoPauloIso(form.ends_at),
        }),
      });
      toast.success(
        editingMeeting
          ? `${itemLabel(form.meeting_type)} atualizado e participantes notificados.`
          : `${itemLabel(form.meeting_type)} agendado e participantes notificados.`,
      );
      closeForm();
      await load();
    } catch (error) {
      toast.error(error.message);
    }
  };
  const toggleParticipant = (id) =>
    setForm((current) => ({
      ...current,
      participant_ids: current.participant_ids.includes(id)
        ? current.participant_ids.filter((item) => item !== id)
        : [...current.participant_ids, id],
    }));
  const join = async (meeting, camera = true) => {
    await api(`/meetings/${meeting.id}/response`, {
      method: "PUT",
      body: JSON.stringify({ status: "joined" }),
    });
    const participants = meeting.participants.filter(
      (item) => Number(item.id) !== Number(user?.id),
    );
    startMeetingVideo(
      { ...meeting, member_ids: participants.map((item) => item.id) },
      participants,
      { camera },
    );
  };
  const removeMeeting = async (meeting) => {
    const confirmed = await dialog.confirm({
      title: `Excluir ${itemLabel(meeting.meeting_type)}?`,
      message: `“${meeting.title}” será excluído da agenda de todos os participantes.`,
      confirmLabel: "Excluir para todos",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/meetings/${meeting.id}`, { method: "DELETE" });
      setMeetings((current) =>
        current.filter((item) => String(item.id) !== String(meeting.id)),
      );
      toast.success("Item excluído para todos.");
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <div className="meeting-page">
      <section className="meeting-hero">
        <div>
          <span className="meeting-hero__icon">
            <CalendarDays />
          </span>
          <div>
            <h1>Agenda</h1>
            <p>Agenda, tarefas, lembretes e reuniões internas.</p>
          </div>
        </div>
        <button
          className="button button--primary"
          onClick={openCreate}
        >
          <Plus size={17} />
          Novo item
        </button>
      </section>
      <section className="meeting-toolbar card">
        <div>
          <button className="icon-button" onClick={() => navigatePeriod(-1)}>
            <ChevronLeft />
          </button>
          <button
            className="button"
            onClick={() => {
              const today = new Date();
              setCursor(startOfMonth(today));
              setSelectedDay(today);
            }}
          >
            Hoje
          </button>
          <button className="icon-button" onClick={() => navigatePeriod(1)}>
            <ChevronRight />
          </button>
        </div>
        <strong>
          {viewMode === "month"
            ? cursor.toLocaleDateString("pt-BR", {
                month: "long",
                year: "numeric",
              })
            : selectedDay.toLocaleDateString("pt-BR", {
                day: "2-digit",
                month: "long",
                year: "numeric",
              })}
        </strong>
        <div className="meeting-view-switch">
          {[
            ["month", "Mês"],
            ["week", "Semana"],
            ["day", "Dia"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={viewMode === id ? "active" : ""}
              onClick={() => setViewMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
      {viewMode === "month" ? (
        <div className="meeting-layout">
          <MonthCalendar
            days={monthDays}
            cursor={cursor}
            selectedDay={selectedDay}
            meetings={meetings}
            onSelect={(day) => {
              setSelectedDay(day);
            }}
          />
          <aside className="meeting-day card">
            <header>
              <div>
                <small>AGENDA DO DIA</small>
                <h2>
                  {selectedDay.toLocaleDateString("pt-BR", {
                    day: "2-digit",
                    month: "long",
                  })}
                </h2>
              </div>
              <span>{selectedMeetings.length}</span>
            </header>
            {selectedMeetings.length === 0 ? (
              <div className="meeting-empty">
                <CalendarDays />
                <p>Nenhum compromisso neste dia.</p>
              </div>
            ) : (
              selectedMeetings.map((item) => (
                <MeetingCard
                  key={item.id}
                  meeting={item}
                  onJoin={(camera) => join(item, camera)}
                  canDelete={Number(item.creator_user_id) === Number(user?.id) || isCompanyAdmin()}
                  onDelete={() => removeMeeting(item)}
                  canEdit={Number(item.creator_user_id) === Number(user?.id) || isCompanyAdmin()}
                  onEdit={() => openEdit(item)}
                />
              ))
            )}
          </aside>
        </div>
      ) : (
        <TimeAgenda
          days={agendaDays}
          meetings={meetings}
          onSelectDay={setSelectedDay}
        />
      )}
      {creating && (
        <MeetingForm
          form={form}
          setForm={setForm}
          contacts={contacts}
          onToggle={toggleParticipant}
          editing={Boolean(editingMeeting)}
          onClose={closeForm}
          onSubmit={save}
        />
      )}
    </div>
  );
}

function MonthCalendar({ days, cursor, selectedDay, meetings, onSelect }) {
  return (
    <section className="meeting-calendar card">
      <div className="meeting-weekdays">
        {["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="meeting-grid">
        {days.map((day) => {
          const items = meetings.filter((item) => overlapsDay(item, day));
          return (
            <button
              key={day.toISOString()}
              className={`${day.getMonth() !== cursor.getMonth() ? "outside " : ""}${sameDay(day, selectedDay) ? "selected " : ""}${sameDay(day, new Date()) ? "today" : ""}`}
              onClick={() => onSelect(day)}
            >
              <strong>{day.getDate()}</strong>
              <div>
                {items.slice(0, 3).map((item) => (
                  <span
                    key={item.id}
                    style={{ "--meeting-color": item.color }}
                    title={item.title}
                  >
                    {itemIcon(item.meeting_type, 10)} {item.title}
                  </span>
                ))}
              </div>
              {items.length > 3 && <small>+{items.length - 3}</small>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function TimeAgenda({ days, meetings, onSelectDay }) {
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  return (
    <section
      className="meeting-time-agenda card"
      style={{ "--agenda-days": days.length }}
    >
      <div className="meeting-time-head">
        <span>Horário</span>
        {days.map((day) => (
          <button
            key={day.toISOString()}
            className={sameDay(day, new Date()) ? "today" : ""}
            onClick={() => onSelectDay(day)}
          >
            <small>
              {day.toLocaleDateString("pt-BR", { weekday: "short" })}
            </small>
            <strong>{day.getDate()}</strong>
          </button>
        ))}
      </div>
      <div className="meeting-time-body">
        <div className="meeting-hour-labels">
          {hours.map((hour) => (
            <span key={hour} style={{ height: HOUR_HEIGHT }}>
              {String(hour).padStart(2, "0")}:00
            </span>
          ))}
        </div>
        {days.map((day) => (
          <div
            className="meeting-day-column"
            key={day.toISOString()}
            style={{ height: HOUR_HEIGHT * 24 }}
          >
            {hours.map((hour) => (
              <i key={hour} style={{ top: hour * HOUR_HEIGHT }} />
            ))}
            {meetings
              .filter((item) => overlapsDay(item, day))
              .map((item) => (
                <TimeEvent key={item.id} meeting={item} day={day} />
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}
function TimeEvent({ meeting, day }) {
  const start = new Date(meeting.starts_at),
    end = new Date(meeting.ends_at),
    dayStart = startOfDay(day),
    dayEnd = endOfDay(day);
  const visibleStart = new Date(Math.max(start, dayStart)),
    visibleEnd = new Date(Math.min(end, dayEnd));
  const startMinutes = (visibleStart - dayStart) / 60000,
    endMinutes = (visibleEnd - dayStart) / 60000;
  const top = (startMinutes / 60) * HOUR_HEIGHT,
    height = Math.max(28, ((endMinutes - startMinutes) / 60) * HOUR_HEIGHT);
  return (
    <article
      className="meeting-time-event"
      style={{ top, height, "--meeting-color": meeting.color }}
      title={`${meeting.title} · ${formatBrazilTime(start)}–${formatBrazilTime(end)}`}
    >
      <strong>{meeting.title}</strong>
      <small>
        {sameDay(start, day) ? formatBrazilTime(start) : "00:00"} –{" "}
        {sameDay(end, day) ? formatBrazilTime(end) : "24:00"}
      </small>
      {meeting.link_url && (
        <a
          href={meeting.link_url}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
        >
          <ExternalLink size={12} />
        </a>
      )}
    </article>
  );
}

function MeetingCard({ meeting, onJoin, canEdit, onEdit, canDelete, onDelete }) {
  const start = new Date(meeting.starts_at),
    end = new Date(meeting.ends_at);
  const active =
    meeting.meeting_type === "video" &&
    Date.now() >= start.getTime() - 10 * 60000 &&
    Date.now() < end.getTime();
  return (
    <article
      className="meeting-card"
      style={{ "--meeting-color": meeting.color }}
    >
      <div className="meeting-card__time">
        <strong>{formatBrazilTime(start)}</strong>
        <small>{formatBrazilTime(end)}</small>
      </div>
      <div>
        <div className="meeting-card__title">
          <h3>
            {itemIcon(meeting.meeting_type)} {meeting.title}
          </h3>
          {canEdit && (
            <button
              type="button"
              className="icon-button meeting-card__edit"
              onClick={onEdit}
              title="Editar item"
              aria-label={`Editar ${meeting.title}`}
            >
              <Pencil size={15} />
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className="icon-button meeting-card__delete"
              onClick={onDelete}
              title="Excluir para todos"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
        <span className="meeting-card__kind">
          {itemLabel(meeting.meeting_type)}
        </span>
        <p>{meeting.description || "Sem descrição"}</p>
        {meeting.link_url && (
          <a
            className="meeting-card__link"
            href={meeting.link_url}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} />
            Abrir link
          </a>
        )}
        <div className="meeting-avatars">
          {meeting.participants.slice(0, 5).map((item) => (
            <span key={item.id} title={item.nickname || item.full_name}>
              {(item.nickname || item.full_name || item.username)[0]}
            </span>
          ))}
          <small>{meeting.participants.length} participantes</small>
        </div>
        {active && (
          <>
            <div className="meeting-card__join">
              <button className="button" onClick={() => onJoin(false)}>
                <Headphones size={15} />
                Entrar sem câmera
              </button>
              <button
                className="button button--primary"
                onClick={() => onJoin(true)}
              >
                <Video size={15} />
                Entrar com câmera
              </button>
            </div>
            <small className="meeting-card__join-help">
              Sem microfone? Entre como ouvinte.
            </small>
          </>
        )}
      </div>
    </article>
  );
}

function MeetingForm({ form, setForm, contacts, onToggle, editing, onClose, onSubmit }) {
  return (
    <div className="platform-dialog">
      <form className="platform-dialog__panel meeting-form" onSubmit={onSubmit}>
        <div className="platform-dialog__header">
          <span className="platform-dialog__icon">
            <CalendarDays />
          </span>
          <div>
            <small>NOVO ITEM</small>
            <h2>Adicionar à agenda</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="platform-dialog__body">
          <label>
            Título
            <input
              className="input"
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          <label>
            Descrição
            <textarea
              className="input"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </label>
          <label>
            Link opcional
            <input
              className="input"
              type="url"
              placeholder="https://..."
              value={form.link_url}
              onChange={(e) => setForm({ ...form, link_url: e.target.value })}
            />
            <small>O link aparecerá no card para todos os participantes.</small>
          </label>
          <div className="meeting-form__row">
            <label>
              Início
              <input
                type="datetime-local"
                className="input"
                required
                value={form.starts_at}
                onChange={(e) =>
                  setForm({ ...form, starts_at: e.target.value })
                }
              />
            </label>
            <label>
              Término
              <input
                type="datetime-local"
                className="input"
                required
                value={form.ends_at}
                onChange={(e) => setForm({ ...form, ends_at: e.target.value })}
              />
            </label>
          </div>
          <label>
            Tipo
            <select
              className="select"
              value={form.meeting_type}
              onChange={(e) =>
                setForm({ ...form, meeting_type: e.target.value })
              }
            >
              <option value="reminder">Compromisso / lembrete</option>
              <option value="task">Tarefa</option>
              <option value="video">Reunião interna por vídeo</option>
            </select>
          </label>
          <label>
            Cor
            <input
              type="color"
              value={form.color}
              onChange={(e) => setForm({ ...form, color: e.target.value })}
            />
          </label>
          <fieldset className="meeting-participants">
            <legend>
              <Users size={15} /> Participantes
            </legend>
            {contacts.map((contact) => (
              <button
                type="button"
                key={contact.id}
                className={
                  form.participant_ids.includes(contact.id) ? "selected" : ""
                }
                onClick={() => onToggle(contact.id)}
              >
                <span>
                  {
                    (contact.nickname ||
                      contact.full_name ||
                      contact.username)[0]
                  }
                </span>
                <div>
                  <strong>
                    {contact.nickname || contact.full_name || contact.username}
                  </strong>
                  <small>{contact.department || "Sem setor"}</small>
                </div>
                <b>{form.participant_ids.includes(contact.id) ? "✓" : "+"}</b>
              </button>
            ))}
          </fieldset>
        </div>
        <div className="platform-dialog__actions">
          <button type="button" className="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="button button--primary">{editing ? "Atualizar e notificar" : "Salvar e notificar"}</button>
        </div>
      </form>
    </div>
  );
}
