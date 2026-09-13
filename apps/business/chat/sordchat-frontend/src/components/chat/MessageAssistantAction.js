import React from "react";
import {
  Bot,
  CalendarPlus,
  CheckCircle2,
  ListTodo,
  Ticket,
  X,
} from "lucide-react";

const ACTIONS = [
  {
    key: "ticket",
    assistant: "Volt",
    title: "Criar ticket",
    description: "Defina envolvidos, setores e urgência antes de confirmar.",
    icon: Ticket,
    guidance: "Informe pessoas relacionadas e setores; a urgência será escolhida na revisão.",
  },
  {
    key: "task",
    assistant: "Mitty",
    title: "Criar task",
    description: "Transforme a mensagem em uma tarefa pessoal ou atribuída.",
    icon: ListTodo,
    guidance: "Informe para quem é a task e ajuste a prioridade, se necessário.",
  },
  {
    key: "agenda",
    assistant: "Mitty",
    title: "Adicionar à agenda",
    description: "Agende compromisso, tarefa ou reunião com data e horário.",
    icon: CalendarPlus,
    guidance: "Informe o tipo, participantes, data, início e término; o link é opcional.",
  },
];

const messageExcerpt = (message) => {
  if (message?.message_type === "file") {
    const caption = String(message?.caption || "").trim();
    return caption
      ? `Anexo ${message.content || "compartilhado"}: ${caption}`
      : `Anexo compartilhado: ${message.content || "arquivo"}`;
  }
  if (message?.message_type === "sticker") return "Figurinha compartilhada";
  return String(message?.content || "").trim() || "Mensagem sem texto";
};

export const buildAssistantMessageContext = (message, action) => {
  const quoted = messageExcerpt(message).replace(/\s+/g, " ").slice(0, 1200);

  if (action === "ticket") {
    return `Crie um ticket sobre: ${quoted}`;
  }
  if (action === "task") {
    return `Crie uma tarefa sobre: ${quoted}`;
  }
  return `Agende um compromisso sobre: ${quoted}`;
};

const MessageAssistantAction = ({ message, onClose }) => {
  const chooseAction = (action) => {
    window.dispatchEvent(new CustomEvent("voltchat:assistant-context", {
      detail: {
        action: action.key,
        assistant: action.assistant,
        sourceMessageId: message?.id,
        sourceSender: message?.sender_name || "Usuário",
        sourceExcerpt: messageExcerpt(message).slice(0, 220),
        prompt: buildAssistantMessageContext(message, action.key),
        guidance: action.guidance,
      },
    }));
    onClose();
  };

  return (
    <div className="message-ai-action" role="dialog" aria-modal="true" aria-label="Criar ação a partir da mensagem">
      <button className="message-ai-action__backdrop" type="button" onClick={onClose} aria-label="Fechar" />
      <section className="message-ai-action__panel">
        <header>
          <span className="message-ai-action__robot"><Bot size={22} /></span>
          <div>
            <h2>Transformar mensagem em ação</h2>
            <p>Volt e Mitty usarão a mensagem como contexto.</p>
          </div>
          <button className="icon-button icon-button--light" type="button" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </header>

        <blockquote>
          <strong>{message?.sender_name || "Usuário"}</strong>
          <span>{messageExcerpt(message)}</span>
        </blockquote>

        <div className="message-ai-action__options">
          {ACTIONS.map((action) => {
            const Icon = action.icon;
            return (
              <button key={action.key} type="button" onClick={() => chooseAction(action)}>
                <span className={`message-ai-action__option-icon message-ai-action__option-icon--${action.key}`}>
                  <Icon size={20} />
                </span>
                <span>
                  <strong>{action.title}</strong>
                  <small>{action.description}</small>
                </span>
                <span className="message-ai-action__assistant">
                  {action.assistant}<CheckCircle2 size={13} />
                </span>
              </button>
            );
          })}
        </div>

        <footer>Nenhuma ação será criada sem sua confirmação.</footer>
      </section>
    </div>
  );
};

export default MessageAssistantAction;