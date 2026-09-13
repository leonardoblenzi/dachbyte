import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  GripVertical,
  KanbanSquare,
  Loader2,
  Paperclip,
  Send,
  Ticket,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import BoltConfirmation from "./common/BoltConfirmation";
import BoltTicketSummary from "./common/BoltTicketSummary";
import AssistantIdentityMenu from "./common/AssistantIdentityMenu";
import useBoltAssistant from "../hooks/useBoltAssistant";
import boltAssistantImage from "../assets/bolt-assistant.jpeg";
import mittyAssistantImage from "../assets/mitty-assistant.png";

const examples = [
  "Quantos tickets tenho em aberto e quais aguardam minha resposta?",
  "Abra um ticket urgente para TI e atribua para Ana.",
  "Crie uma tarefa para Carlos revisar contratos ate amanha.",
  "Agende uma reuniao com Ana amanha as 14:30 sobre planejamento.",
];

const priorityLabel = { high: "Alta", medium: "Media", low: "Baixa" };
const AI_POSITION_KEY = "voltchat:ai-position-y";

const resultDestination = (intent) =>
  ["meeting", "agenda_task", "reminder"].includes(intent)
    ? "/meetings"
    : intent === "task"
      ? "/tasks"
      : "/tickets";

const resultType = (intent) => ({
  ticket: "Ticket",
  task: "Tarefa",
  meeting: "Reuniao",
  agenda_task: "Tarefa agendada",
  reminder: "Compromisso",
}[intent] || "Acao");

const ResultIcon = ({ intent }) =>
  ["meeting", "agenda_task", "reminder"].includes(intent)
    ? <CalendarClock size={18} />
    : intent === "task"
      ? <KanbanSquare size={18} />
      : <Ticket size={18} />;

const AssistantPopup = () => {
  const [open, setOpen] = useState(false);
  const [messageContext, setMessageContext] = useState(null);
  const [positionY, setPositionY] = useState(() => {
    const saved = Number(localStorage.getItem(AI_POSITION_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : window.innerHeight / 2;
  });
  const popupRef = useRef(null);
  const dragRef = useRef(null);
  const ignoreClickRef = useRef(false);
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

  const clampPosition = useCallback((value) => {
    const viewportHeight = window.innerHeight;
    const popupHeight = Math.min(
      popupRef.current?.offsetHeight || 60,
      viewportHeight - 24,
    );
    const halfHeight = popupHeight / 2;
    return Math.min(
      viewportHeight - halfHeight - 12,
      Math.max(halfHeight + 12, value),
    );
  }, []);

  const startDrag = (event) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startPosition: positionY,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveDrag = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientY - drag.startY;
    if (Math.abs(delta) > 4) drag.moved = true;
    setPositionY(clampPosition(drag.startPosition + delta));
  };

  const endDrag = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clampPosition(
      drag.startPosition + event.clientY - drag.startY,
    );
    setPositionY(next);
    localStorage.setItem(AI_POSITION_KEY, String(Math.round(next)));
    ignoreClickRef.current = drag.moved;
    dragRef.current = null;
    window.setTimeout(() => { ignoreClickRef.current = false; }, 0);
  };

  useEffect(() => {
    const fitToViewport = () =>
      setPositionY((current) => clampPosition(current));
    const frame = window.requestAnimationFrame(fitToViewport);
    window.addEventListener("resize", fitToViewport);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", fitToViewport);
    };
  }, [clampPosition, open]);

  useEffect(() => {
    const openFromMessage = (event) => {
      const detail = event.detail || {};
      cancelPlan();
      setMessage(detail.prompt || "");
      setMessageContext(detail);
      setOpen(true);
    };
    window.addEventListener("voltchat:assistant-context", openFromMessage);
    return () => window.removeEventListener("voltchat:assistant-context", openFromMessage);
  }, [cancelPlan, setMessage]);

  return (
    <div
      ref={popupRef}
      className={"assistant-popup " + (open ? "assistant-popup--open" : "")}
      style={{ "--bolt-position-y": positionY + "px" }}
    >
      {open ? (
        <section className="assistant-popup__panel" aria-label="IA VoltChat">
          <header className="assistant-popup__header">
            <div className="assistant-popup__title">
              <span className="assistant-popup__duo-avatars" aria-hidden="true">
                <img src={boltAssistantImage} alt="" />
                <img src={mittyAssistantImage} alt="" />
              </span>
              <div>
                <h2>IA</h2>
                <p>Volt e Mitty <span>·</span> {actionLabel}</p>
              </div>
            </div>
            <div className="assistant-popup__actions">
              <AssistantIdentityMenu />
              <button
                className="assistant-popup__drag"
                type="button"
                onPointerDown={startDrag}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                aria-label="Mover IA para cima ou para baixo"
                title="Arraste para mover"
              >
                <GripVertical size={18} />
              </button>
              <button
                className="icon-button icon-button--light"
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Recolher IA"
                title="Recolher IA"
              >
                <ChevronDown size={18} />
              </button>
              <button
                className="icon-button icon-button--light"
                type="button"
                onClick={() => { setOpen(false); setMessage(""); setMessageContext(null); }}
                aria-label="Fechar IA"
                title="Fechar IA"
              >
                <X size={18} />
              </button>
            </div>
          </header>

          <div className="assistant-popup__duo-intro">
            <article>
              <img src={boltAssistantImage} alt="Volt" />
              <span><strong>Volt</strong><small>Tickets, chamados e atualizacoes.</small></span>
            </article>
            <article>
              <img src={mittyAssistantImage} alt="Mitty" />
              <span><strong>Mitty</strong><small>Agenda, reunioes, lembretes e tarefas.</small></span>
            </article>
          </div>

          {messageContext && (
            <div className="assistant-popup__message-context">
              <span><Bot size={17} /></span>
              <div>
                <strong>{messageContext.assistant} assumirá esta ação</strong>
                <small>Mensagem de {messageContext.sourceSender}: “{messageContext.sourceExcerpt}”</small>
                <em>{messageContext.guidance}</em>
              </div>
              <button type="button" onClick={() => { setMessageContext(null); setMessage(""); }} aria-label="Remover contexto">
                <X size={14} />
              </button>
            </div>
          )}

          <form className="assistant-popup__form" onSubmit={submitRequest}>
            <label htmlFor="assistant-popup-message">Converse com a IA</label>
            <textarea
              id="assistant-popup-message"
              className="textarea"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Descreva naturalmente o ticket, tarefa, compromisso ou reuniao."
              rows={4}
            />
            {result?.intent === "ticket" && (
              <label className="assistant-attachment-picker">
                <Paperclip size={16} />
                <span>{attachmentFile ? attachmentFile.name : "Anexar arquivo fixo ao ticket (opcional)"}</span>
                <input type="file" hidden onChange={(event) => setAttachmentFile(event.target.files?.[0] || null)} />
              </label>
            )}
            <div className="assistant-popup__examples">
              {examples.map((item) => (
                <button key={item} type="button" onClick={() => setMessage(item)}>
                  {item}
                </button>
              ))}
            </div>
            <button className="button-primary" type="submit" disabled={loading || !message.trim()}>
              {loading ? <Loader2 className="assistant-spin" size={17} /> : <Send size={17} />}
              Revisar
            </button>
          </form>

          <div className="assistant-popup__result">
            {conversation.length > 0 && (
              <div className="assistant-popup__transcript">
                {conversation.map((item) => {
                  const assistant = item.role === "assistant";
                  const avatar = item.assistantName === "Mitty" ? mittyAssistantImage : boltAssistantImage;
                  return (
                    <div className={`assistant-transcript-message ${assistant ? "assistant-transcript-message--assistant" : "assistant-transcript-message--user"}`} key={item.id}>
                      {assistant && <img src={avatar} alt={item.assistantName || "IA"} />}
                      <div><strong>{assistant ? (item.assistantName || "IA") : "Você"}</strong><p>{item.content}</p></div>
                    </div>
                  );
                })}
              </div>
            )}
            <span className={result ? "badge badge--success" : "badge"}>
              {result ? <CheckCircle2 size={13} /> : <Bot size={13} />}
              {actionLabel}
            </span>

            {result?.needs_input ? (
              <div className="assistant-popup__empty assistant-popup__empty--continue">
                <Bot size={25} />
                <p>Responda no campo acima para continuar. A revisão aparecerá quando todos os dados estiverem completos.</p>
              </div>
            ) : !result ? (
              <div className="assistant-popup__empty">
                <Bot size={28} />
                <p>A IA encaminha tickets ao Volt e agenda ou tarefas a Mitty.</p>
              </div>
            ) : result.intent === "ticket_summary" ? (
              <BoltTicketSummary result={result} compact onOpen={() => setOpen(false)} />
            ) : !result.executed ? (
              <div className="assistant-popup__assistant-response">
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
              <div className="assistant-popup__created">
                <div className="assistant-popup__assistant-meta">
                  <img src={assistantImage} alt={assistantName} />
                  <strong>{assistantName}</strong>
                </div>
                <div className="assistant-popup__created-title">
                  <span><ResultIcon intent={result.intent} /></span>
                  <h3>
                    {result.ticket?.id ? "#" + result.ticket.id + " · " : ""}
                    {createdItem?.title}
                  </h3>
                </div>
                <p>{result.reply}</p>
                <dl>
                  <div><dt>Tipo</dt><dd>{resultType(result.intent)}</dd></div>
                  <div><dt>Responsaveis</dt><dd>{result.plan?.assigned_to_names?.join(", ") || "Voce"}</dd></div>
                  {result.intent === "ticket" && (
                    <div><dt>Urgencia</dt><dd>{result.plan?.ticket_priority || "-"}</dd></div>
                  )}
                  {result.intent === "task" && (
                    <div><dt>Prioridade</dt><dd>{priorityLabel[createdItem?.priority] || createdItem?.priority || "-"}</dd></div>
                  )}
                  {result.plan?.starts_at && (
                    <div><dt>Inicio</dt><dd>{new Date(result.plan.starts_at).toLocaleString("pt-BR")}</dd></div>
                  )}
                </dl>
                <Link
                  className="button-secondary"
                  to={resultDestination(result.intent)}
                  onClick={() => setOpen(false)}
                >
                  Abrir {resultType(result.intent)}
                </Link>
              </div>
            )}
          </div>
        </section>
      ) : (
        <button
          className="assistant-popup__launcher assistant-popup__launcher--ia"
          type="button"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClick={() => { if (!ignoreClickRef.current) setOpen(true); }}
          aria-label="Abrir IA"
          title="Abrir Volt e Mitty"
        >
          <span>IA</span>
        </button>
      )}
    </div>
  );
};

export default AssistantPopup;