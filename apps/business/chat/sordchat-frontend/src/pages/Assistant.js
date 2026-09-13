import React from "react";
import {
  Bot,
  CalendarClock,
  CheckCircle2,
  KanbanSquare,
  Loader2,
  Paperclip,
  Send,
  Sparkles,
  Ticket,
} from "lucide-react";
import { Link } from "react-router-dom";
import BoltConfirmation from "../components/common/BoltConfirmation";
import BoltTicketSummary from "../components/common/BoltTicketSummary";
import AssistantIdentityMenu from "../components/common/AssistantIdentityMenu";
import useBoltAssistant from "../hooks/useBoltAssistant";
import boltAssistantImage from "../assets/bolt-assistant.jpeg";
import mittyAssistantImage from "../assets/mitty-assistant.png";

const examples = [
  "Quantos tickets tenho em aberto e quais aguardam minha resposta?",
  "Abrir um ticket urgente para TI",
  "Criar uma tarefa para revisar contratos",
  "Agende uma reuniao com Ana amanha as 14:30 sobre planejamento",
];

const resultDestination = (intent) =>
  ["meeting", "agenda_task", "reminder"].includes(intent)
    ? "/meetings"
    : intent === "task"
      ? "/tasks"
      : "/tickets";

const resultLabel = (intent) => ({
  ticket: "Ticket",
  task: "Tarefa",
  meeting: "Reuniao",
  agenda_task: "Tarefa agendada",
  reminder: "Compromisso",
}[intent] || "Acao");

const ResultIcon = ({ intent }) =>
  ["meeting", "agenda_task", "reminder"].includes(intent)
    ? <CalendarClock size={22} />
    : intent === "task"
      ? <KanbanSquare size={22} />
      : <Ticket size={22} />;

const Assistant = () => {
  const {
    actionLabel,
    attachmentFile,
    cancelPlan,
    confirmRequest,
    conversation,
    loading,
    message,
    result,
    setAttachmentFile,
    setMessage,
    setUrgency,
    submitRequest,
    urgency,
  } = useBoltAssistant();

  const assistantName = result?.assistant_name || "IA";
  const assistantImage =
    assistantName === "Mitty" ? mittyAssistantImage : boltAssistantImage;
  const createdItem = result?.ticket || result?.task || result?.meeting;

  return (
    <div className="work-page assistant-page">
      <section className="bolt-chat-shell panel">
        <header className="bolt-chat-head">
          <div className="assistant-page__duo-avatars" aria-hidden="true">
            <img src={boltAssistantImage} alt="" />
            <img src={mittyAssistantImage} alt="" />
          </div>
          <div className="bolt-chat-head__identity">
            <h2>IA</h2>
            <p>Volt e Mitty <span>·</span> assistentes inteligentes</p>
          </div>
          <span className="badge badge--success">
            <Sparkles size={13} />
            {actionLabel}
          </span>
          <AssistantIdentityMenu />
        </header>

        <div className="bolt-thread">
          <div className="bolt-day-divider"><span>Hoje</span></div>

          <div className="bolt-message-row">
            <div className="bolt-avatar bolt-avatar--message" aria-hidden="true">
              <img src={boltAssistantImage} alt="" />
            </div>
            <div className="bolt-message-content">
              <div className="bolt-message-meta"><strong>Volt</strong><span>tickets</span></div>
              <div className="bolt-message-bubble">
                Eu cuido de abertura, consulta, atribuicao e atualizacoes de tickets. Sempre apresento o plano para sua confirmacao.
              </div>
            </div>
          </div>

          <div className="bolt-message-row">
            <div className="bolt-avatar bolt-avatar--message" aria-hidden="true">
              <img src={mittyAssistantImage} alt="" />
            </div>
            <div className="bolt-message-content">
              <div className="bolt-message-meta"><strong>Mitty</strong><span>agenda e tarefas</span></div>
              <div className="bolt-message-bubble bolt-message-bubble--mitty">
                Eu sou sua secretaria virtual. Organizo tarefas, compromissos, participantes, reunioes e lembretes com dia e horario.
              </div>
            </div>
          </div>

          {conversation.map((item) => {
            const assistant = item.role === "assistant";
            const avatar = item.assistantName === "Mitty" ? mittyAssistantImage : boltAssistantImage;
            return (
              <div className={`assistant-transcript-message ${assistant ? "assistant-transcript-message--assistant" : "assistant-transcript-message--user"}`} key={item.id}>
                {assistant && <img src={avatar} alt={item.assistantName || "IA"} />}
                <div>
                  <strong>{assistant ? (item.assistantName || "IA") : "Você"}</strong>
                  <p>{item.content}</p>
                </div>
              </div>
            );
          })}

          {result?.needs_input ? null : !result ? (
            <div className="bolt-guide-card">
              <Bot size={22} />
              <div>
                <strong>O que voce quer organizar?</strong>
                <p>Escreva naturalmente. A IA identifica o assunto e direciona ao assistente correto.</p>
              </div>
            </div>
          ) : result.intent === "ticket_summary" ? (
            <div className="bolt-result-row assistant-created">
              <BoltTicketSummary result={result} />
            </div>
          ) : !result.executed ? (
            <div className="bolt-result-row assistant-result-with-avatar">
              <img src={assistantImage} alt={assistantName} />
              <BoltConfirmation
                result={result}
                urgency={urgency}
                setUrgency={setUrgency}
                onConfirm={confirmRequest}
                onCancel={cancelPlan}
                loading={loading}
              />
            </div>
          ) : (
            <div className="bolt-result-row assistant-created">
              <div className="assistant-created__bot">
                <img src={assistantImage} alt={assistantName} />
                <strong>{assistantName}</strong>
              </div>
              <div className="assistant-created__icon">
                <ResultIcon intent={result.intent} />
              </div>
              <div className="assistant-created__content">
                <span className="badge badge--success">
                  <CheckCircle2 size={13} /> Acao concluida
                </span>
                <h3>
                  {result.ticket?.id ? "#" + result.ticket.id + " · " : ""}
                  {createdItem?.title}
                </h3>
                <p>{result.reply}</p>
                <dl>
                  <div><dt>Tipo</dt><dd>{resultLabel(result.intent)}</dd></div>
                  <div><dt>Responsaveis</dt><dd>{result.plan?.assigned_to_names?.join(", ") || "Voce"}</dd></div>
                  {result.plan?.departments?.length > 0 && (
                    <div><dt>Setores</dt><dd>{result.plan.departments.join(", ")}</dd></div>
                  )}
                  {result.plan?.starts_at && (
                    <div><dt>Inicio</dt><dd>{new Date(result.plan.starts_at).toLocaleString("pt-BR")}</dd></div>
                  )}
                </dl>
                <Link className="button-secondary" to={resultDestination(result.intent)}>
                  Abrir {resultLabel(result.intent)}
                </Link>
              </div>
            </div>
          )}
        </div>

        <div className="bolt-chip-row" aria-label="Sugestoes rapidas">
          {examples.map((item) => (
            <button key={item} type="button" onClick={() => setMessage(item)}>
              {item}
            </button>
          ))}
        </div>

        <form className="bolt-composer" onSubmit={submitRequest}>
          <div className="bolt-composer__inner">
            <Bot size={18} aria-hidden="true" />
            <textarea
              id="assistant-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Converse com Volt e Mitty"
              rows={1}
              aria-label="Solicitacao para a IA"
            />
            {result?.intent === "ticket" && (
              <label className="assistant-attachment-picker">
                <Paperclip size={16} />
                <span>{attachmentFile ? attachmentFile.name : "Anexar arquivo fixo ao ticket (opcional)"}</span>
                <input type="file" hidden onChange={(event) => setAttachmentFile(event.target.files?.[0] || null)} />
              </label>
            )}
            <button
              className="button-primary"
              type="submit"
              disabled={loading || !message.trim()}
            >
              {loading ? <Loader2 className="assistant-spin" size={17} /> : <Send size={17} />}
              Enviar
            </button>
          </div>
        </form>
      </section>
    </div>
  );
};

export default Assistant;