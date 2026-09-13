import React from "react";
import {
  BellRing,
  Building2,
  CalendarClock,
  CheckCircle2,
  ShieldQuestion,
  Users,
  X,
} from "lucide-react";

const formatSchedule = (value) =>
  value
    ? new Date(value).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

const intentLabel = (intent) => ({
  ticket: "Ticket",
  task: "Tarefa",
  meeting: "Reuniao",
  agenda_task: "Tarefa agendada",
  reminder: "Compromisso",
  task_edit: "Edicao de tarefa",
  meeting_edit: "Edicao de agenda",
}[intent] || "Acao");

const BoltConfirmation = ({
  result,
  urgency,
  setUrgency,
  onConfirm,
  onCancel,
  loading,
}) => {
  const assistantName = result.assistant_name || (result.intent === "ticket" ? "Volt" : "Mitty");
  const people =
    result.plan?.assigned_to_names?.join(", ") ||
    (result.intent === "ticket"
      ? "equipes dos departamentos selecionados"
      : "voce");
  const departments =
    result.plan?.departments?.join(", ") ||
    result.plan?.department ||
    "Nao definido";
  const isTicket = result.intent === "ticket";
  const isAgenda = ["meeting", "agenda_task", "reminder", "meeting_edit"].includes(result.intent);

  return (
    <div className="bolt-confirmation" role="status" aria-live="polite">
      <div className="bolt-confirmation__header">
        <span><ShieldQuestion size={24} /></span>
        <div>
          <small>{assistantName} pede sua confirmacao</small>
          <h3>Revise a acao antes de executar</h3>
        </div>
      </div>

      <div className="bolt-confirmation__subject">
        <strong>{intentLabel(result.intent)} sobre</strong>
        <p>{result.plan?.subject || result.plan?.title}</p>
      </div>

      <div className="bolt-confirmation__scope">
        <div>
          <Users size={17} />
          <span><strong>{isAgenda ? "Participantes" : "Pessoas"}</strong>{people}</span>
        </div>
        {isTicket && (
          <div>
            <Building2 size={17} />
            <span><strong>Departamentos</strong>{departments}</span>
          </div>
        )}
        {isAgenda && (
          <div>
            <CalendarClock size={17} />
            <span>
              <strong>Horario</strong>
              {formatSchedule(result.plan?.starts_at)} ate {formatSchedule(result.plan?.ends_at)}
            </span>
          </div>
        )}
        <div>
          <BellRing size={17} />
          <span>
            <strong>Notificacoes</strong>
            {isTicket
              ? "Volt notificara todos os envolvidos com o ID do ticket."
              : isAgenda
                ? "Mitty enviara convites e lembretes aos participantes."
                : "Mitty notificara os responsaveis pela tarefa."}
          </span>
        </div>
      </div>

      {isTicket && (
        <label className="bolt-confirmation__urgency">
          Nivel de urgencia
          <select
            className="select"
            value={urgency}
            onChange={(event) => setUrgency(event.target.value)}
          >
            <option value="">Selecione a urgencia</option>
            {(result.plan?.urgency_options || []).map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
      )}

      <p className="bolt-confirmation__summary">
        {isTicket
          ? "Confirmo que o Volt abrira este ticket para " + people
            + ", em " + departments + ", com urgencia "
            + (urgency || "a selecionar")
            + ", e notificara todos os envolvidos."
          : result.confirmation_summary}
      </p>

      <div className="bolt-confirmation__actions">
        <button
          className="button-secondary"
          type="button"
          onClick={onCancel}
          disabled={loading}
        >
          <X size={17} />
          Corrigir pedido
        </button>
        <button
          className="button-primary"
          type="button"
          onClick={onConfirm}
          disabled={loading || (isTicket && !urgency)}
        >
          <CheckCircle2 size={17} />
          Confirmar com {assistantName}
        </button>
      </div>
    </div>
  );
};

export default BoltConfirmation;