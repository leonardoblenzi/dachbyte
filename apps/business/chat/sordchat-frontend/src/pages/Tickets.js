import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  ArrowLeft,
  ArrowRightLeft,
  CheckCircle2,
  Clock3,
  Download,
  MessageCircle,
  MessageSquarePlus,
  MoreHorizontal,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings2,
  SmilePlus,
  Star,
  Ticket,
  Upload,
  X,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { useAuth } from "../contexts/AuthContext";
import { usePlatformDialog } from "../contexts/PlatformDialogContext";
import { API_BASE_URL } from "../config";
import {
  ACCEPTED_UPLOAD_LABEL,
  ACCEPTED_UPLOAD_TYPES,
} from "../constants/uploads";
import { downloadAuthenticatedFile } from "../utils/downloads";
import TicketAssignmentCards from "../components/tickets/TicketAssignmentCards";
import AudioRecorderButton from "../components/chat/AudioRecorderButton";
import AuthenticatedAudio from "../components/chat/AuthenticatedAudio";
import { ticketMatchesSearch } from "../utils/ticketSearch";

const ticketEmojiGroups = [
  {
    label: "Reacoes",
    emojis: [
      "\u{1F600}",
      "\u{1F602}",
      "\u{1F642}",
      "\u{1F60D}",
      "\u{1F44F}",
      "\u{1F44D}",
      "\u{1F44E}",
      "\u{2705}",
      "\u{1F525}",
      "\u{1F64F}",
    ],
  },
  {
    label: "Trabalho",
    emojis: [
      "\u{1F4CC}",
      "\u{1F4CE}",
      "\u{1F4C4}",
      "\u{1F4DD}",
      "\u{1F4CA}",
      "\u{2699}\u{FE0F}",
      "\u{1F6E0}\u{FE0F}",
      "\u{1F4C5}",
      "\u{1F3AF}",
      "\u{1F4AC}",
    ],
  },
  {
    label: "Status",
    emojis: [
      "\u{1F7E2}",
      "\u{1F7E1}",
      "\u{1F534}",
      "\u{26A0}\u{FE0F}",
      "\u{1F6A7}",
      "\u{2B50}",
      "\u{1F4AF}",
      "\u{2728}",
      "\u{1F4E3}",
      "\u{274C}",
    ],
  },
];
const isAudioAttachment = (message = {}) =>
  String(message.attachment_content_type || "").startsWith("audio/") ||
  /\\.(webm|ogg|mp3|m4a|wav)$/i.test(message.attachment_filename || "");

const statusMeta = {
  Aberto: ["ticket-status--open", AlertCircle],
  "Em andamento": ["ticket-status--progress", Clock3],
  Resolvido: ["ticket-status--closed", CheckCircle2],
  "Em atraso": ["ticket-status--overdue", AlertCircle],
};

const formatBytes = (bytes = 0) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const getTicketDisplayStatus = (ticket = {}) =>
  ticket.is_overdue ? "Em atraso" : ticket.status || "Aberto";

const formatDateTime = (value) => {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatResponseTime = (minutes) => {
  if (minutes === null || minutes === undefined) return "Aguardando resposta";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}min` : `${hours}h`;
};

const requestJson = async (path, options = {}) => {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${localStorage.getItem("token")}`,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || "Operacao nao concluida.");
  }
  return response.status === 204 ? null : response.json();
};

const uploadAttachment = async (file) => {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${API_BASE_URL}/files/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    body: formData,
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || "Nao foi possivel enviar o anexo.");
  }
  return response.json();
};

const Tickets = () => {
  const { user, isAdmin, isCompanyAdmin, isCoordinator } = useAuth();
  const [searchParams] = useSearchParams();
  const managementMode = searchParams.get("management") === "1";
  const managementStatus = searchParams.get("status") || "Todos";
  const dialog = usePlatformDialog();
  const fileInputRef = useRef(null);
  const messageFileRef = useRef(null);
  const ticketThreadRef = useRef(null);
  const [tickets, setTickets] = useState([]);
  const [users, setUsers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(
    ["Todos", "Aberto", "Em andamento", "Resolvido"].includes(managementStatus)
      ? managementStatus
      : "Todos",
  );
  const [formOpen, setFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [attachment, setAttachment] = useState(null);
  const [selectedTicketId, setSelectedTicketId] = useState(null);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [ticketMessages, setTicketMessages] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [messageAttachment, setMessageAttachment] = useState(null);
  const [messageExtraAttachments, setMessageExtraAttachments] = useState([]);
  const [ticketDropActive, setTicketDropActive] = useState(false);
  const [audioUploading, setAudioUploading] = useState(false);
  const [replyingToMessage, setReplyingToMessage] = useState(null);
  const [reactionMessageId, setReactionMessageId] = useState(null);
  const [showTicketEmojiPicker, setShowTicketEmojiPicker] = useState(false);
  const [ticketEmojiCategory, setTicketEmojiCategory] = useState(
    ticketEmojiGroups[0].label,
  );
  const [customTicketEmoji, setCustomTicketEmoji] = useState("");
  const [transferUserId, setTransferUserId] = useState("");
  const [groupUserIds, setGroupUserIds] = useState([]);
  const [groupDepartmentNames, setGroupDepartmentNames] = useState([]);
  const [transferNote, setTransferNote] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [ratingScore, setRatingScore] = useState("5");
  const [ratingComment, setRatingComment] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [draft, setDraft] = useState({
    title: "",
    priority: "Moderado",
    delivery_due_at: "",
    channel: "Interno",
    department: user?.department || "",
    assigned_to_ids: [],
    assigned_departments: [],
    description: "",
  });

  const toggleValue = (values, value) =>
    values.includes(value)
      ? values.filter((item) => item !== value)
      : [...values, value];

  const loadTicketDetail = async (ticketId = selectedTicketId) => {
    if (!ticketId) return;
    setDetailLoading(true);
    try {
      const [ticketData, messageData] = await Promise.all([
        requestJson(`/tickets/${ticketId}`),
        requestJson(`/tickets/${ticketId}/messages`),
      ]);
      setSelectedTicket(ticketData);
      setSelectedTicketId(ticketData.id);
      setTicketMessages(messageData);
      setTransferUserId(
        ticketData.assigned_to_id ? String(ticketData.assigned_to_id) : "",
      );
      setGroupUserIds(
        (ticketData.assigned_users || []).map((item) => String(item.id)),
      );
      setGroupDepartmentNames(
        (ticketData.assigned_departments || [])
          .map((item) => String(item.name || item))
          .filter(Boolean),
      );
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDetailLoading(false);
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const ticketPath = managementMode
        ? "/tickets/?management=true"
        : "/tickets/";
      const [ticketData, assignmentOptions] = await Promise.all([
        requestJson(ticketPath),
        requestJson("/tickets/assignment-options"),
      ]);
      setTickets(ticketData);
      setUsers(assignmentOptions.users || []);
      setDepartments(assignmentOptions.departments || []);
      setDraft((prev) => {
        const defaultDepartment =
          prev.department ||
          user?.department ||
          assignmentOptions.departments?.[0] ||
          "Operacao";
        return {
          ...prev,
          department: defaultDepartment,
          assigned_departments: prev.assigned_departments?.length
            ? prev.assigned_departments
            : defaultDepartment
              ? [defaultDepartment]
              : [],
        };
      });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managementMode]);

  useEffect(() => {
    setStatus(
      ["Todos", "Aberto", "Em andamento", "Resolvido"].includes(
        managementStatus,
      )
        ? managementStatus
        : "Todos",
    );
  }, [managementStatus]);

  useEffect(() => {
    const thread = ticketThreadRef.current;
    if (detailLoading || !thread) return;
    const frame = window.requestAnimationFrame(() => {
      thread.scrollTo({
        top: thread.scrollHeight,
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detailLoading, selectedTicketId, ticketMessages.length]);

  const adminCanViewAllTickets = isAdmin();
  const managerCanViewScope = managementMode && isCoordinator();
  const visibleTickets = useMemo(
    () =>
      tickets.filter((ticketItem) => {
        if (!ticketItem || !user?.id) return false;
        if (managerCanViewScope || adminCanViewAllTickets) return true;
        const currentUserId = Number(user.id);
        if (Number(ticketItem.created_by_id) === currentUserId) return true;
        if (Number(ticketItem.assigned_to_id) === currentUserId) return true;
        return (ticketItem.assigned_users || []).some(
          (item) => Number(item.id) === currentUserId,
        );
      }),
    [adminCanViewAllTickets, managerCanViewScope, tickets, user?.id],
  );

  const filteredTickets = useMemo(() => {
    return visibleTickets.filter((ticketItem) => {
      const matchesStatus = status === "Todos" || (status === "Em atraso" ? ticketItem.is_overdue : ticketItem.status === status);
      const matchesQuery = ticketMatchesSearch(ticketItem, query);
      return matchesStatus && matchesQuery;
    });
  }, [query, status, visibleTickets]);

  const stats = [
    ["Abertos", visibleTickets.filter((item) => item.status === "Aberto").length],
    [
      "Em andamento",
      visibleTickets.filter((item) => item.status === "Em andamento").length,
    ],
    [
      "Resolvidos",
      visibleTickets.filter((item) => item.status === "Resolvido").length,
    ],
    ["Em atraso", visibleTickets.filter((item) => item.is_overdue).length],
  ];

  const selectedTicketEmojiGroup =
    ticketEmojiGroups.find((group) => group.label === ticketEmojiCategory) ||
    ticketEmojiGroups[0];

  const canCloseSelected =
    selectedTicket &&
    selectedTicket.status !== "Resolvido" &&
    (isAdmin() ||
      isCoordinator() ||
      selectedTicket.created_by_id === user?.id ||
      (selectedTicket.assigned_users || []).some(
        (item) => item.id === user?.id,
      ));

  const canManageGroupSelected =
    selectedTicket &&
    (isCompanyAdmin() || selectedTicket.created_by_id === user?.id);

  const canRateSelected =
    selectedTicket &&
    selectedTicket.status === "Resolvido" &&
    selectedTicket.created_by_id === user?.id &&
    !selectedTicket.rating_score;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!draft.title.trim() || !draft.description.trim()) {
      toast.error("Informe titulo e descricao.");
      return;
    }

    setSaving(true);
    try {
      let attachmentFileId = null;
      if (attachment) {
        const uploaded = await uploadAttachment(attachment);
        attachmentFileId = uploaded.id;
      }

      const createdTicket = await requestJson("/tickets/", {
        method: "POST",
        body: JSON.stringify({
          ...draft,
          channel: "Interno",
          department:
            draft.assigned_departments?.[0] ||
            draft.department ||
            user?.department ||
            "Operacao",
          assigned_to_ids: draft.assigned_to_ids,
          assigned_departments: draft.assigned_departments || [],
          attachment_file_id: attachmentFileId,
        }),
      });

      setDraft({
        title: "",
        priority: "Moderado",
        delivery_due_at: "",
        channel: "Interno",
        department: user?.department || departments[0] || "Operacao",
        assigned_to_ids: [],
        assigned_departments: [user?.department || departments[0] || "Operacao"].filter(Boolean),
        description: "",
      });
      setAttachment(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setFormOpen(false);
      toast.success("Ticket criado.");
      await loadData();
      await loadTicketDetail(createdTicket.id);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const moveTicket = async (ticketId, nextStatus) => {
    let closeReason = null;
    if (nextStatus === "Resolvido") {
      closeReason = (await dialog.prompt({
        title: "Concluir ticket",
        message: "Informe o motivo do fechamento para registrar no histórico.",
        inputLabel: "Motivo do fechamento",
        confirmLabel: "Concluir ticket",
      }))?.trim();
      if (!closeReason) {
        toast.error("O motivo do fechamento é obrigatório.");
        return;
      }
    }
    try {
      const updatedTicket = await requestJson(`/tickets/${ticketId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus, close_reason: closeReason }),
      });
      setTickets((current) =>
        current.map((item) => (item.id === ticketId ? updatedTicket : item)),
      );
      if (selectedTicketId === ticketId) {
        await loadTicketDetail(ticketId);
      }
      toast.success("Ticket atualizado.");
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleOpenTicket = async (ticketId) => {
    setSettingsOpen(false);
    setMoreMenuOpen(false);
    setSelectedTicketId(ticketId);
    await loadTicketDetail(ticketId);
  };

  const handleBackToTickets = () => {
    setSettingsOpen(false);
    setMoreMenuOpen(false);
    setSelectedTicket(null);
    setSelectedTicketId(null);
    setTicketMessages([]);
    setMessageText("");
    setMessageAttachment(null);
    setMessageExtraAttachments([]);
    setReplyingToMessage(null);
    setReactionMessageId(null);
    setShowTicketEmojiPicker(false);
    setTransferNote("");
    setCloseNote("");
  };

const selectTicketAttachments = (files) => {
    const selectedFiles = Array.from(files || []).filter(Boolean);
    if (!selectedFiles.length) return;
    setMessageAttachment(selectedFiles[0]);
    setMessageExtraAttachments(selectedFiles.slice(1));
  };

  const handleTicketDrop = (event) => {
    event.preventDefault();
    setTicketDropActive(false);
    selectTicketAttachments(event.dataTransfer?.files);
  };  const handleSendMessage = async (event) => {
    event.preventDefault();
    if (!selectedTicket) return;
    if (!messageText.trim() && !messageAttachment) {
      toast.error("Digite uma mensagem ou anexe um arquivo.");
      return;
    }

try {
      const attachments = messageAttachment
        ? [messageAttachment, ...messageExtraAttachments]
        : [null];
      for (let index = 0; index < attachments.length; index += 1) {
        const attachment = attachments[index];
        const uploaded = attachment ? await uploadAttachment(attachment) : null;
        await requestJson(`/tickets/${selectedTicket.id}/messages`, {
          method: "POST",
          body: JSON.stringify({
            content: index === 0 ? messageText : attachment.name,
            file_id: uploaded?.id || null,
            reply_to_id: index === 0 ? replyingToMessage?.id || null : null,
          }),
        });
      }
      setMessageText("");
      setMessageAttachment(null);
      setMessageExtraAttachments([]);
      setReplyingToMessage(null);
      setShowTicketEmojiPicker(false);
      if (messageFileRef.current) messageFileRef.current.value = "";
      await loadTicketDetail(selectedTicket.id);
      await loadData();
      if (attachments.length > 1) toast.success(`${attachments.length} arquivos enviados.`);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleRecordedTicketAudio = async (file) => {
    if (!selectedTicket) return;
    setAudioUploading(true);
    try {
      const uploaded = await uploadAttachment(file);
      await requestJson(`/tickets/${selectedTicket.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content: "Mensagem de áudio",
          file_id: uploaded.id,
          reply_to_id: replyingToMessage?.id || null,
        }),
      });
      setReplyingToMessage(null);
      toast.success("Áudio enviado.");
      await loadTicketDetail(selectedTicket.id);
      await loadData();
    } catch (error) {
      toast.error(error.message || "Não foi possível enviar o áudio.");
      throw error;
    } finally {
      setAudioUploading(false);
    }
  };
  const handleTicketReaction = async (messageId, emoji) => {
    const normalizedEmoji = String(emoji || "").trim();
    if (!selectedTicket || !normalizedEmoji) return;
    try {
      const result = await requestJson(
        `/tickets/${selectedTicket.id}/messages/${messageId}/reactions`,
        {
          method: "POST",
          body: JSON.stringify({ emoji: normalizedEmoji }),
        },
      );
      setTicketMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? { ...message, reactions: result.reactions || [] }
            : message,
        ),
      );
      setReactionMessageId(null);
      setCustomTicketEmoji("");
    } catch (error) {
      toast.error(error.message);
    }
  };
  const handleTicketMessageKeyDown = (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent?.isComposing
    ) {
      event.preventDefault();
      handleSendMessage(event);
    }
  };

  const handleTransferTicket = async () => {
    if (!selectedTicket || !transferUserId) {
      toast.error("Selecione para quem passar o ticket.");
      return;
    }

    try {
      await requestJson(`/tickets/${selectedTicket.id}/transfer`, {
        method: "PATCH",
        body: JSON.stringify({
          assigned_to_id: transferUserId,
          message: transferNote,
        }),
      });
      setTransferNote("");
      toast.success("Ticket repassado.");
      await loadTicketDetail(selectedTicket.id);
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleSaveGroupAssignment = async () => {
    if (!selectedTicket) return;
    try {
      await requestJson(`/tickets/${selectedTicket.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          assigned_to_ids: groupUserIds.map(Number),
          assigned_departments: groupDepartmentNames,
        }),
      });
      toast.success("Pessoas e setores do ticket atualizados.");
      await loadTicketDetail(selectedTicket.id);
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleCloseTicket = async () => {
    if (!selectedTicket) return;
    if (!closeNote.trim()) {
      toast.error("Informe o motivo do fechamento.");
      return;
    }
    try {
      await requestJson(`/tickets/${selectedTicket.id}/close`, {
        method: "POST",
        body: JSON.stringify({ message: closeNote }),
      });
      setCloseNote("");
      toast.success("Ticket fechado.");
      await loadTicketDetail(selectedTicket.id);
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleRateTicket = async (event) => {
    event.preventDefault();
    if (!selectedTicket) return;
    try {
      await requestJson(`/tickets/${selectedTicket.id}/rating`, {
        method: "POST",
        body: JSON.stringify({
          rating_score: ratingScore,
          rating_comment: ratingComment,
        }),
      });
      setRatingScore("5");
      setRatingComment("");
      toast.success("Avaliacao registrada.");
      await loadTicketDetail(selectedTicket.id);
      await loadData();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleDownloadFile = async (fileId, filename = "anexo") => {
    try {
      const savedPath = await downloadAuthenticatedFile(fileId, filename);
      toast.success(
        savedPath ? `Arquivo salvo em ${savedPath}` : "Download iniciado.",
      );
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <div className="work-page">
      {!selectedTicket && (
        <>
          <section className="panel p-5">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <span className="badge">Atendimento</span>
                <h2 className="m-0 mt-3 text-2xl font-extrabold text-slate-950">
                  Fila de tickets
                </h2>
                <p className="m-0 mt-1 text-sm text-slate-500">
                  Registre solicitacoes, converse dentro do ticket, repasse
                  responsaveis e acompanhe o tempo de resposta.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {isCoordinator() && (
                  <Link className="button-secondary" to="/ticket-reports">
                    <BarChart3 size={17} />
                    Relatório
                  </Link>
                )}
                <button
                  className="button-secondary"
                  type="button"
                  onClick={loadData}
                  disabled={loading}
                >
                  <RefreshCw size={17} />
                  Atualizar
                </button>
                <button
                  className="button-primary"
                  type="button"
                  onClick={() => setFormOpen((value) => !value)}
                >
                  <Plus size={17} />
                  Novo ticket
                </button>
              </div>
            </div>

            {managementMode && isCoordinator() && (
              <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-800">
                Visão gerencial ativa. Administradores visualizam a empresa inteira e
                coordenadores visualizam somente os tickets do próprio setor. Abrir,
                responder ou alterar um ticket por esta visão não adiciona você como
                participante.
              </div>
            )}

            {formOpen && (
              <form
                className="mt-5 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4"
                onSubmit={handleSubmit}
              >
                <textarea
                  className="textarea min-h-[76px]"
                  value={draft.description}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      description: event.target.value,
                    }))
                  }
                  placeholder="Descreva o atendimento e o resultado esperado"
                  rows={3}
                />
                <div className="grid gap-3 xl:grid-cols-[170px_minmax(260px,1fr)_230px_auto]">
                  <select
                    className="select"
                    aria-label="Nivel de urgencia"
                    value={draft.priority}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        priority: event.target.value,
                      }))
                    }
                  >
                    <option>Leve</option>
                    <option>Moderado</option>
                    <option>Alto</option>
                    <option>Urgente</option>
                    <option>Extrema Urgência</option>
                  </select>
                  <input
                    className="input"
                    value={draft.title}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        title: event.target.value,
                      }))
                    }
                    placeholder="Assunto personalizado do ticket"
                    aria-label="Assunto personalizado do ticket"
                  />
                  <input
                    className="input"
                    type="datetime-local"
                    value={draft.delivery_due_at}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, delivery_due_at: event.target.value }))
                    }
                    aria-label="Prazo de entrega"
                    title="Prazo de entrega"
                  />
                  <div>
                    <input
                      ref={fileInputRef}
                      accept={ACCEPTED_UPLOAD_TYPES}
                      className="hidden"
                      type="file"
                      onChange={(event) =>
                        setAttachment(event.target.files?.[0] || null)
                      }
                    />
                    <button
                      className="button-secondary w-full"
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload size={17} />
                      Anexo fixo do ticket
                    </button>
                  </div>
                  <button
                    className="button-primary"
                    type="submit"
                    disabled={saving}
                  >
                    {saving ? (
                      <span className="spinner h-4 w-4" />
                    ) : (
                      <MessageSquarePlus size={17} />
                    )}
                    Criar
                  </button>
                </div>
                <TicketAssignmentCards
                  users={users}
                  departments={departments}
                  selectedUserIds={draft.assigned_to_ids}
                  selectedDepartments={draft.assigned_departments}
                  onToggleUser={(id) =>
                    setDraft((prev) => ({
                      ...prev,
                      assigned_to_ids: toggleValue(prev.assigned_to_ids, id),
                    }))
                  }
                  onToggleDepartment={(departmentName) =>
                    setDraft((prev) => {
                      const nextDepartments = toggleValue(prev.assigned_departments || [], departmentName);
                      return {
                        ...prev,
                        assigned_departments: nextDepartments,
                        department: nextDepartments[0] || prev.department,
                      };
                    })
                  }
                />
                <p className="m-0 text-xs font-bold text-slate-500">
                  Selecione explicitamente as pessoas que terão acesso ao ticket e um ou mais setores para classificação. Marcar um setor não adiciona seus usuários ao ticket. O anexo fixo permanecerá na aba Informações do ticket.{" "}
                  {attachment
                    ? ` Arquivo: ${attachment.name} (${formatBytes(attachment.size)})`
                    : ` Formatos aceitos: ${ACCEPTED_UPLOAD_LABEL}.`}
                </p>
              </form>
            )}
          </section>

          <section className="grid gap-4 md:grid-cols-3">
            {stats.map(([label, value]) => (
              <article className="metric-card" key={label}>
                <p className="m-0 text-sm font-bold text-slate-500">{label}</p>
                <p className="m-0 mt-2 text-3xl font-extrabold text-slate-950">
                  {value}
                </p>
              </article>
            ))}
          </section>

          <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full max-w-md">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                size={17}
              />
              <input
                className="input pl-10"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar por número (#123) ou assunto"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {["Todos", "Aberto", "Em andamento", "Em atraso", "Resolvido"].map((item) => (
                <button
                  key={item}
                  className={`button-secondary ${status === item ? "button-secondary--active" : ""}`}
                  type="button"
                  onClick={() => setStatus(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      <section
        className={`tickets-workspace ${selectedTicket ? "tickets-workspace--detail" : ""}`}
      >
        <div className="grid content-start gap-3">
          {loading ? (
            <section className="empty-state">
              <div className="spinner h-6 w-6" />
              <h2>Carregando tickets</h2>
            </section>
          ) : filteredTickets.length === 0 ? (
            <section className="empty-state">
              <div className="empty-state__icon">
                <Ticket size={28} />
              </div>
              <h2>Nenhum ticket encontrado</h2>
              <p>Ajuste a busca ou abra um novo ticket.</p>
            </section>
          ) : (
            filteredTickets.map((ticketItem) => {
              const displayStatus = getTicketDisplayStatus(ticketItem);
              const [badgeClass, StatusIcon] =
                statusMeta[displayStatus] || statusMeta.Aberto;
              return (
                <article
                  className={`panel ticket-card ticket-card--${ticketItem.is_overdue ? "overdue" : ticketItem.status === "Resolvido" ? "closed" : ticketItem.status === "Em andamento" ? "progress" : "open"} p-4 ${selectedTicketId === ticketItem.id ? "ticket-card--active" : ""}`}
                  key={ticketItem.id}
                >
                  <div className="grid gap-4 xl:grid-cols-[1fr_auto] xl:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`badge ${badgeClass}`}>
                          <StatusIcon size={13} />
                          {displayStatus}
                        </span>
                        <span className="badge">{ticketItem.priority}</span>
                        <span className="badge">{ticketItem.channel}</span>
                        <span className="badge">
                          {ticketItem.department || "Sem setor"}
                        </span>
                      </div>
                      <div className="ticket-card__title-row">
                        <span className="ticket-id">#{ticketItem.id}</span>
                        <h3 className="m-0 text-lg font-extrabold text-slate-950">
                          {ticketItem.title}
                        </h3>
                      </div>
                      <p className="m-0 mt-1 line-clamp-2 text-sm text-slate-500">
                        {ticketItem.description}
                      </p>
                      <p className="m-0 mt-2 text-xs font-bold text-slate-400">
                        {ticketItem.created_by_name || "Solicitante"} - Time:{" "}
                        {(ticketItem.assigned_users || [])
                          .map((item) => item.name)
                          .join(", ") || "Não atribuído"}{" "}
                        - Setor: {ticketItem.department || "Sem setor"}{" "}
                        - Prazo: {ticketItem.delivery_due_at ? formatDateTime(ticketItem.delivery_due_at) : "Sem prazo"}
                        {ticketItem.is_overdue ? " - EM ATRASO" : ""}
                        - Resposta:{" "}
                        {formatResponseTime(ticketItem.first_response_minutes)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="button-primary"
                        type="button"
                        onClick={() => handleOpenTicket(ticketItem.id)}
                      >
                        <MessageCircle size={16} />
                        Abrir
                      </button>
                      {["Aberto", "Em andamento", "Resolvido"].map(
                        (nextStatus) => (
                          <button
                            key={nextStatus}
                            className="button-secondary"
                            type="button"
                            disabled={ticketItem.status === nextStatus}
                            onClick={() =>
                              moveTicket(ticketItem.id, nextStatus)
                            }
                          >
                            {nextStatus}
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>

        <aside
          className={`ticket-detail panel ${selectedTicket ? "ticket-detail--full" : ""}`}
        >
          {!selectedTicket ? (
            <div className="ticket-detail__empty">
              <Ticket size={32} />
              <h3>Abra um ticket</h3>
              <p>
                Selecione um atendimento para ver conversa, anexos, repasse,
                fechamento e avaliacao.
              </p>
            </div>
          ) : (
            <div className="ticket-detail__body">
              <div className="ticket-detail__toolbar">
                <button
                  className="button-secondary"
                  type="button"
                  onClick={handleBackToTickets}
                >
                  <ArrowLeft size={17} />
                  Voltar para tickets
                </button>
                <div className="ticket-detail__toolbar-actions">
                  {selectedTicket.status === "Resolvido" && (
                    <button
                      className="button-secondary"
                      type="button"
                      onClick={() => moveTicket(selectedTicket.id, "Aberto")}
                      disabled={detailLoading}
                    >
                      <ArrowRightLeft size={16} />
                      Reabrir ticket
                    </button>
                  )}
                  <button
                    className="ticket-icon-button"
                    type="button"
                    title="Configurações do ticket"
                    aria-label="Configurações do ticket"
                    onClick={() => {
                      setSettingsOpen(true);
                      setMoreMenuOpen(false);
                    }}
                  >
                    <Settings2 size={18} />
                  </button>
                  <div className="ticket-more">
                    <button
                      className="ticket-icon-button"
                      type="button"
                      title="Mais ações"
                      aria-label="Mais ações do ticket"
                      aria-expanded={moreMenuOpen}
                      onClick={() => setMoreMenuOpen((current) => !current)}
                    >
                      <MoreHorizontal size={20} />
                    </button>
                    {moreMenuOpen && (
                      <div className="ticket-more__menu" role="menu">
                        <button
                          type="button"
                          onClick={() => {
                            loadTicketDetail(selectedTicket.id);
                            setMoreMenuOpen(false);
                          }}
                          disabled={detailLoading}
                        >
                          <RefreshCw size={16} /> Atualizar ticket
                        </button>
                        {selectedTicket.status === "Resolvido" && (
                          <button
                            type="button"
                            onClick={() => {
                              moveTicket(selectedTicket.id, "Aberto");
                              setMoreMenuOpen(false);
                            }}
                            disabled={detailLoading}
                          >
                            <ArrowRightLeft size={16} /> Reabrir ticket
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setSettingsOpen(true);
                            setMoreMenuOpen(false);
                          }}
                        >
                          <Settings2 size={16} /> Pessoas e configurações
                        </button>
                        {selectedTicket.attachment_file_id && (
                          <button
                            type="button"
                            onClick={() => {
                              handleDownloadFile(
                                selectedTicket.attachment_file_id,
                                selectedTicket.attachment_filename,
                              );
                              setMoreMenuOpen(false);
                            }}
                          >
                            <Download size={16} /> Baixar anexo inicial
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <header className="ticket-detail__header">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`badge ${(statusMeta[getTicketDisplayStatus(selectedTicket)] || statusMeta.Aberto)[0]}`}
                    >
                      {getTicketDisplayStatus(selectedTicket)}
                    </span>
                    {selectedTicket.delivery_due_at && (
                      <span className={`badge ${selectedTicket.is_overdue ? "badge--danger" : ""}`}>
                        Prazo: {formatDateTime(selectedTicket.delivery_due_at)}
                      </span>
                    )}
                    <span className="badge">
                      Resposta:{" "}
                      {formatResponseTime(
                        selectedTicket.first_response_minutes,
                      )}
                    </span>
                    {selectedTicket.rating_score && (
                      <span className="badge badge--success">
                        <Star size={13} />
                        {selectedTicket.rating_score}/5
                      </span>
                    )}
                  </div>
                  <div className="ticket-detail__title-row">
                    <span className="ticket-id">#{selectedTicket.id}</span>
                    <h3>{selectedTicket.title}</h3>
                  </div>
                  <p>{selectedTicket.description}</p>
                </div>
              </header>

              <button
                className="ticket-participants-summary"
                type="button"
                onClick={() => setSettingsOpen(true)}
              >
                <span>
                  <strong>
                    {(selectedTicket.assigned_users || []).length || 0}
                  </strong>
                  pessoas
                </span>
                <span>
                  <strong>{selectedTicket.department || "Sem setor"}</strong>
                  setor classificatório
                </span>
                <span className="ticket-participants-summary__action">
                  <Settings2 size={15} /> Ver detalhes e configurações
                </span>
              </button>

              <section
                ref={ticketThreadRef}
                className="ticket-thread"
                aria-label="Conversa do ticket"
              >
                {detailLoading ? (
                  <div className="ticket-thread__empty">
                    <div className="spinner h-5 w-5" />
                    Carregando atendimento
                  </div>
                ) : ticketMessages.length === 0 ? (
                  <div className="ticket-thread__empty">
                    Nenhuma conversa registrada ainda.
                  </div>
                ) : (
                  ticketMessages.map((message) => (
                    <article
                      id={`ticket-message-${message.id}`}
                      className={`ticket-message ${message.sender_id === user?.id ? "ticket-message--own" : ""}`}
                      key={message.id}
                      onDoubleClick={() => setReplyingToMessage(message)}
                      title="Clique duas vezes para responder"
                    >
                      <div className="ticket-message__head">
                        <strong>{message.sender_name}</strong>
                        <span>{formatDateTime(message.created_at)}</span>
                      </div>
                      {message.reply_to && (
                        <button
                          className="chat-message__reply-preview"
                          type="button"
                          onClick={() =>
                            document
                              .getElementById(
                                `ticket-message-${message.reply_to.id}`,
                              )
                              ?.scrollIntoView({
                                behavior: "smooth",
                                block: "center",
                              })
                          }
                        >
                          <strong>{message.reply_to.sender_name}</strong>
                          <span>
                            {message.reply_to.attachment_filename
                              ? `Arquivo: ${message.reply_to.attachment_filename}`
                              : message.reply_to.content}
                          </span>
                        </button>
                      )}
                      {message.content && (
                        <p className="whitespace-pre-wrap">{message.content}</p>
                      )}
                      {message.file_id && isAudioAttachment(message) && (
                        <AuthenticatedAudio
                          fileId={message.file_id}
                          className="ticket-message__audio"
                        />
                      )}
                      {message.file_id && (
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() =>
                            handleDownloadFile(
                              message.file_id,
                              message.attachment_filename,
                            )
                          }
                        >
                          <Paperclip size={15} />
                          {message.attachment_filename || "Baixar anexo"}
                          {message.attachment_file_size
                            ? ` (${formatBytes(message.attachment_file_size)})`
                            : ""}
                        </button>
                      )}
                      <div className="ticket-message__actions">
                        <button
                          type="button"
                          title="Responder"
                          aria-label="Responder"
                          onClick={() => setReplyingToMessage(message)}
                        >
                          <Reply size={14} />
                        </button>
                        <button
                          type="button"
                          title="Reagir"
                          aria-label="Reagir"
                          onClick={() =>
                            setReactionMessageId((current) =>
                              current === message.id ? null : message.id,
                            )
                          }
                        >
                          <SmilePlus size={14} />
                        </button>
                      </div>
                      {(message.reactions || []).length > 0 && (
                        <div className="chat-message__reactions">
                          {message.reactions.map((reaction) => (
                            <button
                              className={
                                reaction.user_ids?.includes(user?.id)
                                  ? "active"
                                  : ""
                              }
                              key={reaction.emoji}
                              type="button"
                              title={(reaction.users || []).join(", ")}
                              onClick={() =>
                                handleTicketReaction(message.id, reaction.emoji)
                              }
                            >
                              <span>{reaction.emoji}</span>
                              <strong>{reaction.count}</strong>
                            </button>
                          ))}
                        </div>
                      )}
                      {reactionMessageId === message.id && (
                        <div className="chat-reaction-picker ticket-reaction-picker">
                          <div className="emoji-picker__tabs">
                            {ticketEmojiGroups.map((group) => (
                              <button
                                key={group.label}
                                className={
                                  ticketEmojiCategory === group.label
                                    ? "active"
                                    : ""
                                }
                                type="button"
                                onClick={() =>
                                  setTicketEmojiCategory(group.label)
                                }
                              >
                                {group.label}
                              </button>
                            ))}
                          </div>
                          <div className="emoji-picker__grid">
                            {selectedTicketEmojiGroup.emojis.map((emoji) => (
                              <button
                                className="emoji-button"
                                key={emoji}
                                type="button"
                                onClick={() =>
                                  handleTicketReaction(message.id, emoji)
                                }
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                          <div className="emoji-custom-input">
                            <input
                              value={customTicketEmoji}
                              onChange={(event) =>
                                setCustomTicketEmoji(event.target.value)
                              }
                              placeholder="Qualquer emoji (Windows: Win + .)"
                            />
                            <button
                              className="button-secondary"
                              type="button"
                              onClick={() =>
                                handleTicketReaction(
                                  message.id,
                                  customTicketEmoji,
                                )
                              }
                            >
                              Reagir
                            </button>
                          </div>
                        </div>
                      )}
                    </article>
                  ))
                )}
              </section>

              {selectedTicket.status !== "Resolvido" ? (
                <form
                  className={`ticket-composer ${ticketDropActive ? "ticket-composer--dragging" : ""}`}
                  onSubmit={handleSendMessage}
                  onDragOver={(event) => { event.preventDefault(); setTicketDropActive(true); }}
                  onDragLeave={() => setTicketDropActive(false)}
                  onDrop={handleTicketDrop}
                >
                  {replyingToMessage && (
                    <div className="chat-composer__replying">
                      <Reply size={17} />
                      <div>
                        <strong>
                          Respondendo a{" "}
                          {replyingToMessage.sender_name || "mensagem"}
                        </strong>
                        <span>
                          {replyingToMessage.attachment_filename
                            ? `Arquivo: ${replyingToMessage.attachment_filename}`
                            : replyingToMessage.content}
                        </span>
                      </div>
                      <button
                        className="icon-button icon-button--light"
                        type="button"
                        onClick={() => setReplyingToMessage(null)}
                        aria-label="Cancelar resposta"
                      >
                        <X size={15} />
                      </button>
                    </div>
                  )}
                  {showTicketEmojiPicker && (
                    <div className="emoji-picker">
                      <div
                        className="emoji-picker__tabs"
                        role="tablist"
                        aria-label="Categorias de emoji"
                      >
                        {ticketEmojiGroups.map((group) => (
                          <button
                            key={group.label}
                            className={
                              ticketEmojiCategory === group.label
                                ? "active"
                                : ""
                            }
                            type="button"
                            onClick={() => setTicketEmojiCategory(group.label)}
                          >
                            {group.label}
                          </button>
                        ))}
                      </div>
                      <div className="emoji-picker__grid">
                        {selectedTicketEmojiGroup.emojis.map((emoji) => (
                          <button
                            key={emoji}
                            className="emoji-button"
                            type="button"
                            onClick={() =>
                              setMessageText((current) => current + emoji)
                            }
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                      <div className="emoji-custom-input">
                        <input
                          value={customTicketEmoji}
                          onChange={(event) =>
                            setCustomTicketEmoji(event.target.value)
                          }
                          placeholder="Digite ou cole qualquer emoji • Windows: Win + ."
                        />
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() => {
                            if (customTicketEmoji.trim()) {
                              setMessageText(
                                (current) => current + customTicketEmoji.trim(),
                              );
                              setCustomTicketEmoji("");
                            }
                          }}
                        >
                          Inserir
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="ticket-composer__row">
                    <button
                      className="icon-button icon-button--light"
                      type="button"
                      onClick={() =>
                        setShowTicketEmojiPicker((value) => !value)
                      }
                      title="Emojis"
                      aria-label="Emojis"
                    >
                      <SmilePlus size={18} />
                    </button>
                    <AudioRecorderButton
                      disabled={audioUploading}
                      uploading={audioUploading}
                      onRecorded={handleRecordedTicketAudio}
                    />
                    <textarea
                      className="textarea"
                      value={messageText}
                      onChange={(event) => setMessageText(event.target.value)}
                      onKeyDown={handleTicketMessageKeyDown}
                      placeholder="Responder dentro do ticket"
                      rows={2}
                    />
                    <input
                      ref={messageFileRef}
                      accept={ACCEPTED_UPLOAD_TYPES}
                      className="hidden"
                      type="file"
                      multiple
                      onChange={(event) => selectTicketAttachments(event.target.files)}
                    />
                    <button
                      className="icon-button icon-button--light"
                      type="button"
                      onClick={() => messageFileRef.current?.click()}
                      title="Anexar arquivo"
                      aria-label="Anexar arquivo"
                    >
                      <Paperclip size={18} />
                    </button>
                    <button className="button-primary" type="submit">
                      <Send size={16} />
                      Enviar
                    </button>
                  </div>
                  {messageAttachment && (
                    <span className="text-xs font-bold text-slate-500">
                      Anexo da mensagem: {messageAttachment.name}
                      {messageExtraAttachments.length > 0 ? ` + ${messageExtraAttachments.length} arquivo(s)` : ""}
                    </span>
                  )}
                </form>
              ) : (
                <section className="ticket-rating">
                  {selectedTicket.rating_score ? (
                    <div>
                      <p className="m-0 font-extrabold text-slate-950">
                        Atendimento avaliado com {selectedTicket.rating_score}/5
                      </p>
                      {selectedTicket.rating_comment && (
                        <p className="m-0 mt-1 text-sm text-slate-500">
                          {selectedTicket.rating_comment}
                        </p>
                      )}
                    </div>
                  ) : canRateSelected ? (
                    <form className="grid gap-2" onSubmit={handleRateTicket}>
                      <label className="text-sm font-extrabold text-slate-700">
                        Avaliacao final
                      </label>
                      <select
                        className="select"
                        value={ratingScore}
                        onChange={(event) => setRatingScore(event.target.value)}
                      >
                        <option value="5">5 - Excelente</option>
                        <option value="4">4 - Bom</option>
                        <option value="3">3 - Regular</option>
                        <option value="2">2 - Ruim</option>
                        <option value="1">1 - Muito ruim</option>
                      </select>
                      <textarea
                        className="textarea"
                        value={ratingComment}
                        onChange={(event) =>
                          setRatingComment(event.target.value)
                        }
                        placeholder="Comentario opcional"
                        rows={2}
                      />
                      <button
                        className="button-primary justify-self-start"
                        type="submit"
                      >
                        <Star size={16} />
                        Avaliar ticket
                      </button>
                    </form>
                  ) : (
                    <p className="m-0 text-sm font-bold text-slate-500">
                      Ticket resolvido aguardando avaliacao do solicitante.
                    </p>
                  )}
                </section>
              )}

              {settingsOpen && (
                <div
                  className="ticket-settings-overlay"
                  role="presentation"
                  onMouseDown={() => setSettingsOpen(false)}
                >
                  <aside
                    className="ticket-settings-drawer"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Configurações do ticket"
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    <header className="ticket-settings-drawer__header">
                      <div>
                        <span>Ticket #{selectedTicket.id}</span>
                        <h3>Detalhes e configurações</h3>
                      </div>
                      <button
                        className="ticket-icon-button"
                        type="button"
                        aria-label="Fechar configurações"
                        onClick={() => setSettingsOpen(false)}
                      >
                        <X size={19} />
                      </button>
                    </header>

                    <div className="ticket-settings-drawer__content">
                      <section className="ticket-settings-section">
                        <div className="ticket-settings-section__title">
                          <strong>Informações</strong>
                          <span>Dados principais do atendimento</span>
                        </div>
                        <div className="ticket-detail__meta ticket-detail__meta--drawer">
                          <div>
                            <span>Solicitante</span>
                            <strong>
                              {selectedTicket.created_by_name || "-"}
                            </strong>
                          </div>
                          <div>
                            <span>Abertura</span>
                            <strong>
                              {formatDateTime(selectedTicket.created_at)}
                            </strong>
                          </div>
                          <div>
                            <span>Time responsável</span>
                            <strong>
                              {(selectedTicket.assigned_users || [])
                                .map((item) => item.name)
                                .join(", ") || "Não atribuído"}
                            </strong>
                          </div>
                          <div>
                            <span>Setores / departamentos</span>
                            <strong>
                              {(selectedTicket.assigned_departments || [])
                                .map((item) => item.name || item)
                                .filter(Boolean)
                                .join(", ") || selectedTicket.department || "-"}
                            </strong>
                          </div>
                          <div>
                            <span>Fechamento</span>
                            <strong>
                              {formatDateTime(selectedTicket.closed_at)}
                            </strong>
                          </div>
                        </div>
                        {selectedTicket.attachment_file_id && (
                          <button
                            className="button-secondary justify-self-start"
                            type="button"
                            onClick={() =>
                              handleDownloadFile(
                                selectedTicket.attachment_file_id,
                                selectedTicket.attachment_filename,
                              )
                            }
                          >
                            <Paperclip size={16} />
                            {selectedTicket.attachment_filename ||
                              "Baixar anexo fixo do ticket"}
                            <Download size={16} />
                          </button>
                        )}
                      </section>

                      {canManageGroupSelected && (
                        <section className="ticket-settings-section">
                          <div className="ticket-settings-section__title">
                            <strong>Pessoas e setores do ticket</strong>
                            <span>
                              Setores classificam o atendimento; acesso continua somente para usuários selecionados
                            </span>
                          </div>
                          <TicketAssignmentCards
                            users={users}
                            departments={departments}
                            selectedUserIds={groupUserIds}
                            selectedDepartments={groupDepartmentNames}
                            onToggleUser={(id) =>
                              setGroupUserIds((current) =>
                                toggleValue(current, id),
                              )
                            }
                            onToggleDepartment={(departmentName) =>
                              setGroupDepartmentNames((current) =>
                                toggleValue(current, departmentName),
                              )
                            }
                          />
                          <button
                            className="button-primary justify-self-start"
                            type="button"
                            onClick={handleSaveGroupAssignment}
                          >
                            Salvar pessoas e setores
                          </button>
                        </section>
                      )}

                      <section className="ticket-settings-section">
                        <div className="ticket-settings-section__title">
                          <strong>Repassar atendimento</strong>
                          <span>
                            Transfira a responsabilidade com uma observação
                          </span>
                        </div>
                        <div className="ticket-actions__transfer">
                          <select
                            className="select"
                            value={transferUserId}
                            onChange={(event) =>
                              setTransferUserId(event.target.value)
                            }
                          >
                            <option value="">Selecionar responsável</option>
                            {users.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.full_name || item.username}
                              </option>
                            ))}
                          </select>
                          <input
                            className="input"
                            value={transferNote}
                            onChange={(event) =>
                              setTransferNote(event.target.value)
                            }
                            placeholder="Mensagem de repasse"
                          />
                          <button
                            className="button-secondary"
                            type="button"
                            onClick={handleTransferTicket}
                          >
                            <ArrowRightLeft size={16} /> Passar ticket
                          </button>
                        </div>
                      </section>

                      {canCloseSelected && (
                        <section className="ticket-settings-section ticket-settings-section--danger">
                          <div className="ticket-settings-section__title">
                            <strong>Concluir atendimento</strong>
                            <span>Registre uma observação antes de fechar</span>
                          </div>
                          <input
                            className="input"
                            value={closeNote}
                            onChange={(event) =>
                              setCloseNote(event.target.value)
                            }
                            placeholder="Motivo obrigatório do fechamento"
                          />
                          <button
                            className="button-primary justify-self-start"
                            type="button"
                            onClick={handleCloseTicket}
                          >
                            <CheckCircle2 size={16} /> Fechar ticket
                          </button>
                        </section>
                      )}
                    </div>
                  </aside>
                </div>
              )}
            </div>
          )}
        </aside>
      </section>
    </div>
  );
};

export default Tickets;
