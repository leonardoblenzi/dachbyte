import { useCallback, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { API_BASE_URL } from "../config";
import {
  buildAssistantFollowUpCommand,
  isAssistantConfirmation,
  polishAssistantReply,
} from "../utils/assistantText";

const requestBolt = async (payload) => {
  const response = await fetch(`${API_BASE_URL}/assistant/requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${localStorage.getItem("token")}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || "Não foi possível acionar a IA.");
  }
  return response.json();
};

const uploadAssistantAttachment = async (file) => {
  if (!file) return null;
  const body = new FormData();
  body.append("file", file);
  const response = await fetch(`${API_BASE_URL}/files/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    body,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || "Nao foi possivel enviar o anexo do ticket.");
  }
  return response.json();
};

const transcriptItem = (role, content, assistantName = null) => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  role,
  content,
  assistantName,
});

const useBoltAssistant = () => {
  const [message, setMessageValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [urgency, setUrgency] = useState("");
  const [pendingCommand, setPendingCommand] = useState("");
  const [conversation, setConversation] = useState([]);
  const [attachmentFile, setAttachmentFile] = useState(null);

  const setMessage = useCallback((value) => {
    // Digitar uma correção ou "Confirmo" faz parte da mesma conversa.
    // O plano pendente só é descartado explicitamente por cancelPlan ou após execução.
    setMessageValue(value);
  }, []);

  const submitRequest = useCallback(async (event) => {
    event?.preventDefault?.();
    const userMessage = message.trim();
    if (!userMessage) {
      toast.error("Descreva o que Volt ou Mitty deve fazer ou consultar.");
      return;
    }

    const pending = result && !result.executed
      ? { ...result, command: pendingCommand || result.command }
      : null;
    const naturalConfirmation = Boolean(
      pending?.requires_confirmation && !pending?.needs_input && isAssistantConfirmation(userMessage),
    );
    const command = buildAssistantFollowUpCommand({ pending, content: userMessage });
    setConversation((current) => [...current, transcriptItem("user", userMessage)]);
    setMessageValue("");
    setLoading(true);
    try {
      if (naturalConfirmation) {
        if (pending.intent === "ticket" && !urgency) {
          throw new Error("Selecione o nível de urgência antes de confirmar.");
        }
        const uploaded = pending.intent === "ticket" && attachmentFile
          ? await uploadAssistantAttachment(attachmentFile)
          : null;
        const data = await requestBolt({
          message: pending.command || pendingCommand,
          urgency: pending.intent === "ticket" ? urgency : undefined,
          attachment_file_id: uploaded?.id || undefined,
          execute: true,
          confirmed: true,
        });
        setResult(data);
        setUrgency(data.plan?.ticket_priority || "");
        setPendingCommand("");
        setAttachmentFile(null);
        setConversation((current) => [
          ...current,
          transcriptItem("assistant", polishAssistantReply(data.reply), data.assistant_name || "IA"),
        ]);
        toast.success(data.reply || `Ação executada por ${data.assistant_name || "IA"}.`);
        return;
      }

      const data = await requestBolt({ message: command, execute: false });
      setResult(data);
      setUrgency(data.plan?.ticket_priority || "");
      if (data.needs_input) {
        setPendingCommand(data.continue_context === false ? "" : (data.command || command));
        setConversation((current) => [
          ...current,
          transcriptItem("assistant", polishAssistantReply(data.reply), data.assistant_name || "IA"),
        ]);
      } else {
        setPendingCommand(data.command || command);
      }
      if (data.intent === "ticket_summary") {
        toast.success("Resumo de tickets atualizado.");
      }
    } catch (error) {
      setConversation((current) => [
        ...current,
        transcriptItem("assistant", polishAssistantReply(error.message), "IA"),
      ]);
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  }, [attachmentFile, message, pendingCommand, result, urgency]);

  const confirmRequest = useCallback(async () => {
    if (!result || result.needs_input) return;
    if (result.intent === "ticket" && !urgency) {
      toast.error("Selecione o nível de urgência.");
      return;
    }
    setLoading(true);
    try {
      const uploaded = result.intent === "ticket" && attachmentFile
        ? await uploadAssistantAttachment(attachmentFile)
        : null;
      const data = await requestBolt({
        message: result.command || pendingCommand || message,
        urgency: result.intent === "ticket" ? urgency : undefined,
        attachment_file_id: uploaded?.id || undefined,
        execute: true,
        confirmed: true,
      });
      setResult(data);
      setMessageValue("");
      setPendingCommand("");
      setAttachmentFile(null);
      setConversation((current) => [
        ...current,
        transcriptItem("assistant", polishAssistantReply(data.reply), data.assistant_name || "IA"),
      ]);
      toast.success(data.reply || `Ação executada por ${data.assistant_name || "IA"}.`);
    } catch (error) {
      setConversation((current) => [
        ...current,
        transcriptItem("assistant", polishAssistantReply(error.message), result.assistant_name || "IA"),
      ]);
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  }, [attachmentFile, message, pendingCommand, result, urgency]);

  const cancelPlan = useCallback(() => {
    setResult(null);
    setUrgency("");
    setPendingCommand("");
    setAttachmentFile(null);
  }, []);

  const actionLabel = useMemo(() => {
    if (!result) return "Online";
    if (result.needs_input) return `${result.assistant_name || "IA"} aguarda sua resposta`;
    if (result.intent === "ticket_summary") return "Resumo de tickets pelo Volt";
    if (!result.executed) return `${result.assistant_name || "IA"} aguarda confirmação`;
    if (result.intent === "task_edit") return "Tarefa atualizada pela Mitty";
    if (result.intent === "meeting_edit") return "Agenda atualizada pela Mitty";
    if (result.intent === "task" && result.tasks?.length > 1) return `${result.tasks.length} tarefas criadas pela Mitty`;
    if (result.intent === "task") return "Tarefa criada pela Mitty";
    if (result.intent === "meeting") return "Reunião agendada pela Mitty";
    if (result.intent === "agenda_task") return "Tarefa agendada pela Mitty";
    if (result.intent === "reminder") return "Compromisso agendado pela Mitty";
    return `Ticket #${result.ticket?.id} criado pelo Volt`;
  }, [result]);

  return {
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
  };
};

export default useBoltAssistant;