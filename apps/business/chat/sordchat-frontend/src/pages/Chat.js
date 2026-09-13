import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  BellOff,
  Bot,
  Clock3,
  Download,
  Eye,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Loader2,
  Megaphone,
  MessageCircle,
  Paperclip,
  Pencil,
  Phone,
  Plus,
  Reply,
  Search,
  Send,
  Settings,
  SmilePlus,
  Star,
  Sticker,
  Trash2,
  Users,
  Video,
  X,
} from "lucide-react";
import { useLocation } from "react-router-dom";
import toast from "react-hot-toast";
import { useAuth } from "../contexts/AuthContext";
import { useWebSocket } from "../contexts/WebSocketContext";
import { usePlatformDialog } from "../contexts/PlatformDialogContext";
import { API_BASE_URL } from "../config";
import { ACCEPTED_UPLOAD_TYPES } from "../constants/uploads";
import { downloadAuthenticatedFile } from "../utils/downloads";
import AudioRecorderButton from "../components/chat/AudioRecorderButton";
import AuthenticatedAudio from "../components/chat/AuthenticatedAudio";
import StickerMessage from "../components/chat/StickerMessage";
import StickerPicker from "../components/chat/StickerPicker";
import MessageAssistantAction from "../components/chat/MessageAssistantAction";
import BoltConfirmation from "../components/common/BoltConfirmation";
import { defaultStickerMap } from "../data/defaultStickers";
import { buildAssistantFollowUpCommand, normalizeDisplayText, polishAssistantReply } from "../utils/assistantText";
import boltAssistantImage from "../assets/bolt-assistant.jpeg";
import mittyAssistantImage from "../assets/mitty-assistant.png";

const displayContactName = (contact) =>
  normalizeDisplayText(contact?.nickname || contact?.display_name || contact?.full_name || contact?.username || 'Usuário').trim();

const assistantUsername = (contact) =>
  String(contact?.username || "").trim().toLowerCase();

const isBoltContact = (contact) =>
  assistantUsername(contact) === "bolt" ||
  String(displayContactName(contact)).trim().toLowerCase() === "bolt";

const isMittyContact = (contact) =>
  assistantUsername(contact) === "mitty" ||
  String(displayContactName(contact)).trim().toLowerCase() === "mitty";

const isAssistantContact = (contact) => isBoltContact(contact) || isMittyContact(contact);

const MESSAGE_TOKEN_PATTERN = /(https?:\/\/[^\s<>]+|@[A-Za-z0-9._-]+)/g;
const renderMessageTextWithLinks = (value) => {
  const text = String(value || "");
  return text.split(MESSAGE_TOKEN_PATTERN).map((part, index) => {
    if (/^https?:\/\//i.test(part)) {
      return (
        <a
          className="chat-message__link"
          href={part}
          key={`${part}-${index}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {part}
        </a>
      );
    }
    if (/^@[A-Za-z0-9._-]+$/.test(part)) {
      return <span className="chat-message__mention" key={`${part}-${index}`}>{part}</span>;
    }
    return <React.Fragment key={`text-${index}`}>{part}</React.Fragment>;
  });
};
const mentionTokenForContact = (contact) => String(
  contact?.nickname || contact?.display_name || contact?.full_name || contact?.username || "usuario"
)
  .trim()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/\s+/g, ".")
  .replace(/[^A-Za-z0-9._-]/g, "");

const mentionUserIdsForText = (text, members = []) => {
  const value = String(text || "");
  return Array.from(new Set(
    (Array.isArray(members) ? members : [])
      .filter((member) => {
        const token = mentionTokenForContact(member);
        return token && new RegExp(`(^|\\s)@${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$|[.,!?;:])`, "i").test(value);
      })
      .map((member) => Number(member.id))
      .filter(Number.isFinite),
  ));
};

const INLINE_MESSAGE_MAX_LENGTH = 1000;
const COLLAPSED_MESSAGE_PREVIEW_LENGTH = 260;

const ExpandableMessageText = ({ value }) => {
  const [expanded, setExpanded] = useState(false);
  const text = String(value || "");
  const lineCount = text.split(/\r?\n/).length;
  const shouldCollapse = text.length > COLLAPSED_MESSAGE_PREVIEW_LENGTH || lineCount > 5;
  const displayText = !expanded && shouldCollapse
    ? `${text.slice(0, COLLAPSED_MESSAGE_PREVIEW_LENGTH).trimEnd()}…`
    : text;

  return (
    <div className="chat-message__expandable">
      <p
        className={`chat-message__content chat-message__expandable-content ${expanded ? "chat-message__expandable-content--expanded" : "chat-message__expandable-content--collapsed"} m-0 whitespace-pre-wrap text-sm text-slate-950`}
      >
        {renderMessageTextWithLinks(displayText)}
      </p>
      {shouldCollapse && (
        <button
          className="chat-message__expand-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Ler menos" : "Ler mais"}
        </button>
      )}
    </div>
  );
};
const messageReceiptStatus = (message) =>
  message?.pending ? "sent" : message?.is_read ? "read" : "delivered";
const stickerSourceReference = (message) => {
  if (message?.sticker_key) return `default:${message.sticker_key}`;
  if (message?.sticker_id) return `sticker:${message.sticker_id}`;
  const reference = String(message?.file_path || "").trim();
  return reference.startsWith("default:") || reference.startsWith("sticker:") ? reference : "";
};

const messageDateKey = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

const messageDateLabel = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data desconhecida";
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startMessage = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDifference = Math.round((startToday - startMessage) / 86400000);
  if (dayDifference === 0) return "Hoje";
  if (dayDifference === 1) return "Ontem";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
};

const contactProfilePhoto = (contact) =>
  isBoltContact(contact)
    ? boltAssistantImage
    : isMittyContact(contact)
      ? mittyAssistantImage
      : contact?.profile_photo || null;
const fullNameCaption = (contact) => {
  const nickname = String(contact?.nickname || '').trim();
  const fullName = String(contact?.full_name || '').trim();
  return nickname && fullName && nickname.localeCompare(fullName, 'pt-BR', { sensitivity: 'accent' }) !== 0
    ? `(${fullName})`
    : '';
};

const presenceMeta = (contact, onlineUsers = []) => {
  if (isBoltContact(contact) || isMittyContact(contact)) {
    return { key: "online", label: "Online", dotClass: "status-dot--online" };
  }
  const onlineRecord = onlineUsers.find((item) => Number(item.id) === Number(contact?.id));
  if (!onlineRecord) return { key: "offline", label: "Offline", dotClass: "status-dot--meeting" };
  const status = onlineRecord.presence_status || "online";
  if (status === "busy") return { key: status, label: "Ocupado", dotClass: "status-dot--busy" };
  if (status === "meeting") return { key: status, label: "Em reunião", dotClass: "status-dot--meeting" };
  if (status === "away") return { key: status, label: "Ausente por inatividade", dotClass: "status-dot--meeting" };
  return { key: "online", label: "Online", dotClass: "status-dot--online" };
};
const emojiGroups = [
  {
    label: "Reacoes",
    emojis: [
      "\u{1F600}",
      "\u{1F601}",
      "\u{1F602}",
      "\u{1F642}",
      "\u{1F60D}",
      "\u{1F91D}",
      "\u{1F44F}",
      "\u{1F64C}",
      "\u{1F44D}",
      "\u{1F44E}",
      "\u{2705}",
      "\u{1F525}",
      "\u{1F4A1}",
      "\u{1F680}",
      "\u{1F440}",
      "\u{1F64F}",
    ],
  },
  {
    label: "Trabalho",
    emojis: [
      "\u{1F4CC}",
      "\u{1F4CE}",
      "\u{1F5C2}\u{FE0F}",
      "\u{1F4C1}",
      "\u{1F4C4}",
      "\u{1F4DD}",
      "\u{1F4CA}",
      "\u{1F4C8}",
      "\u{1F50E}",
      "\u{2699}\u{FE0F}",
      "\u{1F6E0}\u{FE0F}",
      "\u{23F1}\u{FE0F}",
      "\u{1F4C5}",
      "\u{1F3C1}",
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
      "\u{1F512}",
      "\u{1F513}",
      "\u{2B50}",
      "\u{1F4AF}",
      "\u{2728}",
      "\u{1F4E3}",
      "\u{1F4E5}",
      "\u{1F4E4}",
      "\u{1F9FE}",
      "\u{1F197}",
      "\u{274C}",
    ],
  },
  {
    label: "Pessoas",
    emojis:
      "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😍 🥰 😘 😋 😜 🤪 🤓 😎 🥳 😤 😢 😭 😱 😴 🤗 🤔 🤫 🤭 🫡 🤝 👏 🙌 👍 👎 👌 ✌️ 🤞 💪 🙏".split(
        " ",
      ),
  },
  {
    label: "Animais",
    emojis:
      "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦄 🐝 🦋 🐌 🐞 🐠 🐬 🐳 🐘 🦒 🐕 🐈".split(
        " ",
      ),
  },
  {
    label: "Comida",
    emojis:
      "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥑 🍅 🥕 🌽 🥐 🍞 🧀 🍔 🍟 🍕 🌭 🌮 🍝 🍣 🍪 🍰 ☕ 🥤".split(
        " ",
      ),
  },
  {
    label: "Viagem",
    emojis:
      "🚗 🚕 🚌 🚎 🏎️ 🚓 🚑 🚒 🚚 🚲 🛵 ✈️ 🚀 🚁 ⛵ 🚢 🗺️ 🗽 🗼 🏰 🏖️ 🏝️ ⛰️ 🏕️ 🏠 🏢 🏥 🏦 🏨 🌎".split(
        " ",
      ),
  },
  {
    label: "Objetos",
    emojis:
      "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 📷 🎥 📞 💡 🔦 📚 📌 📎 ✂️ 🔒 🔑 🔨 🧰 🧲 🧪 💊 🎁 🎈 🎉 🏆 ⚽ 🎮 🎵 ❤️".split(
        " ",
      ),
  },
  {
    label: "Simbolos",
    emojis:
      "✅ ❌ ⚠️ ℹ️ ❓ ❗ ⭕ 🚫 ♻️ ✔️ ☑️ ➕ ➖ ➡️ ⬅️ ⬆️ ⬇️ 🔄 🔔 🔕 💬 💭 💯 ⭐ ✨ 🔥 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍".split(
        " ",
      ),
  },
];

const imageExtensions = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);
const spreadsheetExtensions = new Set([".csv", ".xls", ".xlsx"]);
const archiveExtensions = new Set([".zip", ".rar", ".7z"]);
const audioExtensions = new Set([".webm", ".ogg", ".mp3", ".m4a", ".wav"]);

const getFileExtension = (filename = "") => {
  const cleanName = filename.split("?")[0];
  const dotIndex = cleanName.lastIndexOf(".");
  return dotIndex >= 0 ? cleanName.slice(dotIndex).toLowerCase() : "";
};

const getAttachmentIcon = (extension) => {
  if (imageExtensions.has(extension)) {
    return FileImage;
  }
  if (spreadsheetExtensions.has(extension)) {
    return FileSpreadsheet;
  }
  if (archiveExtensions.has(extension)) {
    return FileArchive;
  }
  if (audioExtensions.has(extension)) {
    return FileAudio;
  }
  return FileText;
};

const getAttachmentFileId = (message = {}) =>
  message.attachment_file_id || message.file_id || message.file_path || null;

const getAttachmentFilename = (message = {}) =>
  message.attachment_filename ||
  message.filename ||
  message.content ||
  "Arquivo";

const getAttachmentSize = (message = {}) =>
  message.attachment_file_size || message.file_size || null;

const formatFileSize = (bytes) => {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) {
    return "";
  }

  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(size) / Math.log(1024)),
    units.length - 1,
  );
  const value = size / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
};

const isAttachmentMessage = (message = {}) =>
  message.message_type === "file" ||
  Boolean(getAttachmentFileId(message) || message.attachment_filename);

const attachmentPreviewUrlCache = new Map();

const fetchAttachmentBlob = async (fileId) => {
  const token = localStorage.getItem("token");
  const response = await fetch(`${API_BASE_URL}/files/content/${fileId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error("Nao foi possivel carregar o anexo");
  }

  return response.blob();
};

const AttachmentPreview = ({ message, isOwn }) => {
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const filename = getAttachmentFilename(message);
  const caption = String(message.content || "").trim();
  const hasCaption = Boolean(caption && caption !== filename);
  const fileId = getAttachmentFileId(message);
  const fileSize = getAttachmentSize(message);
  const attachmentUnavailable = Boolean(message.attachment_unavailable);
  const extension = getFileExtension(filename);
  const isImage = imageExtensions.has(extension);
  const isAudio =
    audioExtensions.has(extension) ||
    String(message.attachment_content_type || "").startsWith("audio/");
  const Icon = getAttachmentIcon(extension);
  const metaItems = [
    extension ? extension.replace(".", "").toUpperCase() : "Arquivo",
    formatFileSize(fileSize),
  ].filter(Boolean);

  useEffect(() => {
    let cancelled = false;

    if (!isImage || !fileId || attachmentUnavailable) {
      return undefined;
    }

    const cacheKey = String(fileId);
    const cachedPreviewUrl = attachmentPreviewUrlCache.get(cacheKey);
    if (cachedPreviewUrl) {
      setPreviewUrl(cachedPreviewUrl);
      setLoadingPreview(false);
      setPreviewFailed(false);
      return undefined;
    }

    setLoadingPreview(true);
    setPreviewFailed(false);

    fetchAttachmentBlob(fileId)
      .then((blob) => {
        if (cancelled) {
          return;
        }

        const objectUrl = URL.createObjectURL(blob);
        attachmentPreviewUrlCache.set(cacheKey, objectUrl);
        setPreviewUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingPreview(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attachmentUnavailable, fileId, isImage]);

  useEffect(() => {
    if (!previewOpen) return undefined;

    const handleEscape = (event) => {
      if (event.key === "Escape") setPreviewOpen(false);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [previewOpen]);

  const handleDownload = async () => {
    if (!fileId || attachmentUnavailable) {
      toast.error("Este arquivo expirou e nao esta mais disponivel.");
      return;
    }

    try {
      const savedPath = await downloadAuthenticatedFile(fileId, filename);
      toast.success(
        savedPath ? `Arquivo salvo em ${savedPath}` : "Download iniciado.",
      );
    } catch (error) {
      toast.error(error.message || "Nao foi possivel baixar o arquivo.");
    }
  };

  return (
    <div className={`attachment-card ${isOwn ? "attachment-card--own" : ""}`}>
      {isAudio && !attachmentUnavailable && (
        <AuthenticatedAudio
          fileId={fileId}
          className="attachment-card__audio"
        />
      )}
      {isImage && (
        <div className="attachment-card__preview">
          {previewUrl && (
            <button
              className="attachment-card__preview-button"
              type="button"
              onClick={() => setPreviewOpen(true)}
              aria-label={"Ampliar previa de " + filename}
            >
              <img
                className="attachment-card__preview-image"
                src={previewUrl}
                alt={"Previa de " + filename}
                title="Clique para ampliar"
              />
            </button>
          )}
          {loadingPreview && (
            <span className="attachment-card__loading">
              <Loader2 size={18} />
            </span>
          )}
          {!previewUrl && !loadingPreview && (
            <span className="attachment-card__fallback">
              <Icon size={24} />
              {attachmentUnavailable ? "Arquivo expirado" : previewFailed ? "Previa indisponivel" : "Imagem"}
            </span>
          )}
        </div>
      )}

      {hasCaption && (
        <p className="attachment-card__caption">{caption}</p>
      )}

      <div className="attachment-card__body">
        <span className="attachment-card__icon">
          <Icon size={18} />
        </span>
        <div className="attachment-card__details">
          <p className="attachment-card__name">{filename}</p>
          <p className="attachment-card__meta">{metaItems.join(" - ")}</p>
        </div>
        <button
          className="attachment-card__download"
          type="button"
          onClick={handleDownload}
          disabled={attachmentUnavailable}
          title={attachmentUnavailable ? "Arquivo expirado" : "Baixar arquivo"}
        >
          <Download size={16} />
          <span>{attachmentUnavailable ? "Expirado" : "Baixar"}</span>
        </button>
      </div>
      {previewOpen && previewUrl && (
        <div
          className="attachment-preview-modal"
          role="presentation"
          onMouseDown={() => setPreviewOpen(false)}
        >
          <section
            className="attachment-preview-modal__panel"
            role="dialog"
            aria-modal="true"
            aria-label={"Previa de " + filename}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <strong>Previa do anexo</strong>
                <span>{filename}</span>
              </div>
              <button
                className="icon-button icon-button--light"
                type="button"
                onClick={() => setPreviewOpen(false)}
                aria-label="Fechar previa"
              >
                <X size={18} />
              </button>
            </header>
            <div className="attachment-preview-modal__canvas">
              <img src={previewUrl} alt={filename} />
            </div>
            <footer>
              <button className="button-secondary" type="button" onClick={handleDownload}>
                <Download size={16} /> Baixar imagem
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
};

const Chat = () => {
  const { user, isAdmin, isPlatformAdmin } = useAuth();
  const {
    connected,
    onlineUsers,
    messages,
    typingUsers,
    unreadByConversation,
    sendMessage,
    sendReaction,
    switchChatCompany,
    sendTypingIndicator,
    sendReadReceipt,
    sendAttentionRequest,
    markAsRead,
    uploadFile,
    loadMessageHistory,
    removeMessageImmediately,
    restoreMessageImmediately,
    clearConversationImmediately,
    startVoiceCall,
    startVideoCall,
    startGroupVoiceCall,
  } = useWebSocket();

  const [composerExceedsInlineLimit, setComposerExceedsInlineLimit] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionRange, setMentionRange] = useState(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [groups, setGroups] = useState([]);
  const [chatTab, setChatTab] = useState("chats");
  const [conversationStarted, setConversationStarted] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  const [contacts, setContacts] = useState([]);
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [adminCompanies, setAdminCompanies] = useState([]);
  const [selectedChatCompanyId, setSelectedChatCompanyId] = useState("");
  const [allowUserMessageEditing, setAllowUserMessageEditing] = useState(false);
  const [editingMessage, setEditingMessage] = useState(null);
  const [editingMessageValue, setEditingMessageValue] = useState("");
  const [editingMessageSaving, setEditingMessageSaving] = useState(false);
  const [editHistoryMessage, setEditHistoryMessage] = useState(null);
  const [favoriteIds, setFavoriteIds] = useState([]);
  const [mutedIds, setMutedIds] = useState([]);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [favoriteStickerReferences, setFavoriteStickerReferences] = useState([]);
  const [favoritingStickerIds, setFavoritingStickerIds] = useState([]);
  const [emojiCategory, setEmojiCategory] = useState(emojiGroups[0].label);
  const [replyingTo, setReplyingTo] = useState(null);
  const [reactionMessageId, setReactionMessageId] = useState(null);
  const [assistantActionMessage, setAssistantActionMessage] = useState(null);
  const [assistantChatPlans, setAssistantChatPlans] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem("voltchat:assistant-chat-plans") || "{}") || {};
    } catch {
      return {};
    }
  });
  const [assistantResponding, setAssistantResponding] = useState(false);
  const [assistantChatUrgencies, setAssistantChatUrgencies] = useState({});
  const [isUploading, setIsUploading] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState(null);
  const [pendingExtraAttachments, setPendingExtraAttachments] = useState([]);
  const [composerDropActive, setComposerDropActive] = useState(false);
  const [pendingAttachmentPreviewUrl, setPendingAttachmentPreviewUrl] =
    useState("");
  const [filesHistoryOpen, setFilesHistoryOpen] = useState(false);
  const [conversationFiles, setConversationFiles] = useState([]);
  const [loadingConversationFiles, setLoadingConversationFiles] =
    useState(false);
  const [deletingMessageIds, setDeletingMessageIds] = useState([]);  const [showGroupCreator, setShowGroupCreator] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState([]);
  const [groupImageData, setGroupImageData] = useState("");
  const [editingGroup, setEditingGroup] = useState(null);
  const [groupDetailsOpen, setGroupDetailsOpen] = useState(false);
  const [attentionLocks, setAttentionLocks] = useState({});
  const [attentionNow, setAttentionNow] = useState(Date.now());
  const [historyPagesByConversation, setHistoryPagesByConversation] = useState({});
  const [historyStateByConversation, setHistoryStateByConversation] = useState({});
  const historyRequestsRef = useRef(new Set());
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const nearBottomRef = useRef(true);
  const typingTimeoutRef = useRef(null);
  const typingTargetRef = useRef(null);
  const composerValueRef = useRef("");
  const mentionUpdateTimeoutRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerRef = useRef(null);
  const location = useLocation();
  const masterAdmin = isPlatformAdmin();
  const dialog = usePlatformDialog();
  const activeChatCompanyId = masterAdmin ? selectedChatCompanyId : user?.company_id;
  const setComposerValue = useCallback((value) => {
    const nextValue = String(value || "");
    composerValueRef.current = nextValue;
    if (composerRef.current && composerRef.current.value !== nextValue) {
      composerRef.current.value = nextValue;
    }
    // Mantém a digitação fora do ciclo de renderização do histórico inteiro.
    setComposerExceedsInlineLimit(nextValue.trim().length > INLINE_MESSAGE_MAX_LENGTH);
  }, []);

  useEffect(() => () => {
    if (typingTimeoutRef.current) window.clearTimeout(typingTimeoutRef.current);
    if (mentionUpdateTimeoutRef.current) window.clearTimeout(mentionUpdateTimeoutRef.current);
  }, []);

  useEffect(() => {
    sessionStorage.setItem("voltchat:assistant-chat-plans", JSON.stringify(assistantChatPlans));
  }, [assistantChatPlans]);
  useEffect(() => {
    if (!user?.id || (masterAdmin && !selectedChatCompanyId)) {
      setFavoriteStickerReferences([]);
      return undefined;
    }
    const controller = new AbortController();
    const query = activeChatCompanyId ? `?company_id=${encodeURIComponent(activeChatCompanyId)}` : "";
    fetch(`${API_BASE_URL}/stickers${query}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => []);
        if (!response.ok) throw new Error(payload.detail || "Não foi possível carregar suas figurinhas favoritas.");
        return payload;
      })
      .then((stickers) => setFavoriteStickerReferences(Array.from(new Set(
        stickers.flatMap((sticker) => [sticker.source_reference, `sticker:${sticker.id}`]).filter(Boolean),
      ))))
      .catch((error) => {
        if (error.name !== "AbortError") toast.error(error.message);
      });
    return () => controller.abort();
  }, [activeChatCompanyId, masterAdmin, selectedChatCompanyId, user?.id]);

  useEffect(() => {
    if (!user?.id || (masterAdmin && !selectedChatCompanyId)) return undefined;
    const query = activeChatCompanyId ? `?company_id=${encodeURIComponent(activeChatCompanyId)}` : "";
    const controller = new AbortController();
    fetch(`${API_BASE_URL}/chat/settings${query}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.detail || "Nao foi possivel carregar as configuracoes do chat.");
        }
        return response.json();
      })
      .then((payload) => {
        setAllowUserMessageEditing(Boolean(payload.allow_user_message_editing));
      })
      .catch((error) => {
        if (error.name !== "AbortError") toast.error(error.message);
      });
    return () => controller.abort();
  }, [activeChatCompanyId, masterAdmin, selectedChatCompanyId, user?.id]);

  useEffect(() => {
    const handleCompanySettingsUpdate = (event) => {
      const detail = event.detail || {};
      if (activeChatCompanyId && String(detail.companyId) !== String(activeChatCompanyId)) return;
      if (typeof detail.allowUserMessageEditing === "boolean") {
        setAllowUserMessageEditing(detail.allowUserMessageEditing);
      }
    };
    window.addEventListener("voltchat:company-settings-updated", handleCompanySettingsUpdate);
    return () => window.removeEventListener("voltchat:company-settings-updated", handleCompanySettingsUpdate);
  }, [activeChatCompanyId]);

  useEffect(() => {
    const handleMentionChange = (event) => {
      const groupId = Number(event.detail?.groupId);
      const delta = Number(event.detail?.delta || 0);
      if (!groupId || !delta) return;
      setGroups((current) => current.map((group) =>
        Number(group.id) === groupId
          ? { ...group, unread_mention_count: Math.max(0, Number(group.unread_mention_count || 0) + delta) }
          : group
      ));
    };
    window.addEventListener("voltchat:group-mention-changed", handleMentionChange);
    return () => window.removeEventListener("voltchat:group-mention-changed", handleMentionChange);
  }, []);

  const markDirectMessagesRead = useCallback(async (senderId) => {
    if (!senderId) return;
    if (sendReadReceipt(senderId)) return;
    try {
      await fetch(`${API_BASE_URL}/messages/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` },
        body: JSON.stringify({ sender_id: senderId, company_id: masterAdmin ? selectedChatCompanyId : undefined }),
      });
    } catch {
      // A próxima abertura ou mensagem tentará novamente sem interromper o chat.
    }
  }, [masterAdmin, selectedChatCompanyId, sendReadReceipt]);

  useEffect(() => {
    if (!user?.id) return;
    try {
      setFavoriteIds(
        JSON.parse(localStorage.getItem(`voltchat:favorites:${user.id}`)) || [],
      );
      setMutedIds(
        JSON.parse(localStorage.getItem(`voltchat:muted:${user.id}`)) || [],
      );
    } catch {
      setFavoriteIds([]);
      setMutedIds([]);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id || !masterAdmin) return;
    fetch(`${API_BASE_URL}/companies/available`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Nao foi possivel carregar as empresas.");
        return response.json();
      })
      .then((companies) => {
        setAdminCompanies(companies);
        setSelectedChatCompanyId(
          (current) => current || companies[0]?.id || "",
        );
      })
      .catch((error) => toast.error(error.message));
  }, [masterAdmin, user?.id]);

  useEffect(() => {
    if (!user?.id || (masterAdmin && !selectedChatCompanyId)) return undefined;
    if (masterAdmin && !connected) return undefined;

    const controller = new AbortController();
    const query = masterAdmin
      ? `?company_id=${encodeURIComponent(selectedChatCompanyId)}`
      : "";
    const headers = { Authorization: `Bearer ${localStorage.getItem("token")}` };
    setDirectoryLoading(true);

    Promise.all([
      fetch(`${API_BASE_URL}/chat/contacts${query}`, { headers, signal: controller.signal }),
      fetch(`${API_BASE_URL}/groups/${query}`, { headers, signal: controller.signal }),
    ])
      .then(async ([contactsResponse, groupsResponse]) => {
        if (!contactsResponse.ok) throw new Error("Não foi possível carregar os contatos.");
        if (!groupsResponse.ok) throw new Error("Não foi possível carregar os grupos.");
        return Promise.all([contactsResponse.json(), groupsResponse.json()]);
      })
      .then(([nextContacts, nextGroups]) => {
        if (controller.signal.aborted) return;
        setContacts(nextContacts);
        setGroups(nextGroups);
      })
      .catch((error) => {
        if (error.name !== "AbortError") toast.error(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDirectoryLoading(false);
      });

    return () => controller.abort();
  }, [connected, masterAdmin, selectedChatCompanyId, user?.id]);
  useEffect(() => {
    const handleGroupUpsert = (event) => {
      const group = event.detail;
      if (!group?.id) return;
      setGroups((current) =>
        current.some((item) => Number(item.id) === Number(group.id))
          ? current.map((item) => Number(item.id) === Number(group.id) ? { ...group, unread_mention_count: item.unread_mention_count || 0 } : item)
          : [...current, group].sort((left, right) => left.name.localeCompare(right.name, "pt-BR")),
      );
      setSelectedGroup((current) =>
        Number(current?.id) === Number(group.id) ? { ...group, unread_mention_count: current?.unread_mention_count || 0 } : current,
      );
    };
    const handleGroupRemoved = (event) => {
      const groupId = Number(event.detail?.groupId);
      setGroups((current) => current.filter((item) => Number(item.id) !== groupId));
      setSelectedGroup((current) => {
        if (Number(current?.id) !== groupId) return current;
        setConversationStarted(false);
        setGroupDetailsOpen(false);
        return null;
      });
    };
    window.addEventListener("voltchat:group-upsert", handleGroupUpsert);
    window.addEventListener("voltchat:group-removed", handleGroupRemoved);
    return () => {
      window.removeEventListener("voltchat:group-upsert", handleGroupUpsert);
      window.removeEventListener("voltchat:group-removed", handleGroupRemoved);
    };
  }, []);

  useEffect(() => {
    if (!masterAdmin || !selectedChatCompanyId || !connected) return;
    setSelectedUser(null);
    setSelectedGroup(null);
    setConversationStarted(false);
    setContacts([]);
    switchChatCompany(selectedChatCompanyId);
  }, [connected, masterAdmin, selectedChatCompanyId, switchChatCompany]);

  useEffect(() => {
    const startChatUser = location.state?.startChatUser;
    if (startChatUser?.id) { setSelectedUser(startChatUser); setConversationStarted(true); }
  }, [location.state]);

  useEffect(() => {
    const handleAttentionResult = (event) => {
      const detail = event.detail || {};
      const seconds = Number(detail.retry_after || detail.cooldown_seconds || 0);
      if (detail.receiver_id && seconds > 0) {
        setAttentionLocks((current) => ({
          ...current,
          [String(detail.receiver_id)]: {
            kind: detail.code === "blocked" ? "blocked" : "cooldown",
            until: Date.now() + seconds * 1000,
          },
        }));
        setAttentionNow(Date.now());
      }
    };
    window.addEventListener("voltchat:attention-result", handleAttentionResult);
    return () => window.removeEventListener("voltchat:attention-result", handleAttentionResult);
  }, []);

  useEffect(() => {
    const hasActiveLock = Object.values(attentionLocks).some(
      (lock) => lock?.until > Date.now(),
    );
    if (!hasActiveLock) return undefined;
    const intervalId = window.setInterval(() => setAttentionNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [attentionLocks]);

  const selectedAttentionLock = selectedUser?.id
    ? attentionLocks[String(selectedUser.id)]
    : null;
  const activeAttentionLock = selectedAttentionLock?.until > attentionNow
    ? selectedAttentionLock
    : null;
  const attentionRemainingSeconds = activeAttentionLock
    ? Math.max(1, Math.ceil((activeAttentionLock.until - attentionNow) / 1000))
    : 0;
  const attentionButtonTitle = activeAttentionLock?.kind === "blocked"
    ? "Bot\u00e3o bloqueado por 24h por abuso de uso da fun\u00e7\u00e3o"
    : activeAttentionLock
      ? "Disponivel novamente em "
        + Math.floor(attentionRemainingSeconds / 60)
        + ":"
        + String(attentionRemainingSeconds % 60).padStart(2, "0")
      : selectedUser
        ? "Chamar a atencao de " + displayContactName(selectedUser)
        : "Chamar atencao";

  const handleAttentionRequest = () => {
    if (!selectedUser?.id || activeAttentionLock) return;
    if (sendAttentionRequest(selectedUser.id)) {
      setAttentionLocks((current) => ({
        ...current,
        [String(selectedUser.id)]: {
          kind: "cooldown",
          until: Date.now() + 300000,
        },
      }));
      setAttentionNow(Date.now());
    }
  };




  const conversationUsers = useMemo(() => {
    const contactMap = new Map();
    contacts.forEach((contact) =>
      contactMap.set(String(contact.id), { ...contact, is_online: false }),
    );
    onlineUsers.forEach((onlineUser) => {
      const current = contactMap.get(String(onlineUser.id)) || {};
      contactMap.set(String(onlineUser.id), {
        ...current,
        ...onlineUser,
        is_online: true,
      });
    });
    messages.forEach((message) => {
      if (message.sender_id && String(message.sender_id) !== String(user?.id)) {
        const current = contactMap.get(String(message.sender_id)) || {};
        contactMap.set(String(message.sender_id), {
          ...current,
          id: message.sender_id,
          full_name: current.full_name || message.sender_full_name || message.sender_name,
          nickname: current.nickname || message.sender_nickname || null,
          department: current.department || message.sender_department,
          is_online: Boolean(current.is_online),
          last_message_at: !current.last_message_at || new Date(message.timestamp) > new Date(current.last_message_at) ? message.timestamp : current.last_message_at,
        });
      }
      if (message.receiver_id && String(message.receiver_id) !== String(user?.id)) {
        const current = contactMap.get(String(message.receiver_id)) || {};
        contactMap.set(String(message.receiver_id), {
          ...current,
          id: message.receiver_id,
          full_name: current.full_name || message.receiver_full_name || message.receiver_name,
          nickname: current.nickname || message.receiver_nickname || null,
          department: current.department || message.receiver_department,
          is_online: Boolean(current.is_online),
          last_message_at: !current.last_message_at || new Date(message.timestamp) > new Date(current.last_message_at) ? message.timestamp : current.last_message_at,
        });
      }
    });
    const term = contactSearch.trim().toLowerCase();
    return Array.from(contactMap.values())
      .filter(
        (contact) =>
          contact.id !== user?.id &&
          (!term ||
            String(contact.full_name || "")
              .toLowerCase()
              .includes(term) ||
            String(contact.username || "")
              .toLowerCase()
              .includes(term) ||
            String(contact.nickname || "")
              .toLowerCase()
              .includes(term)),
      )
      .sort(
        (left, right) =>
          Number(new Date(right.last_message_at || 0)) - Number(new Date(left.last_message_at || 0)) ||
          Number(favoriteIds.includes(String(right.id))) -
            Number(favoriteIds.includes(String(left.id))) ||
          Number(right.is_online) - Number(left.is_online) ||
          displayContactName(left).localeCompare(
            displayContactName(right),
            "pt-BR",
          ),
      );
  }, [contactSearch, contacts, favoriteIds, messages, onlineUsers, user?.id]);

  const historyConversationKey = selectedGroup
    ? `company:${activeChatCompanyId || user?.company_id || "none"}:group:${selectedGroup.id}`
    : selectedUser
      ? `company:${activeChatCompanyId || user?.company_id || "none"}:direct:${selectedUser.id}`
      : "";
  const activeHistoryState = historyStateByConversation[historyConversationKey] || {};
  const historyLoading = Boolean(activeHistoryState.loading);

  const filteredMessages = useMemo(() => {
    if (!conversationStarted) return [];
    const currentConversationMessages = selectedGroup
      ? messages.filter((message) => Number(message.group_id) === Number(selectedGroup.id))
      : selectedUser
        ? messages.filter(
            (message) =>
              (String(message.sender_id) === String(selectedUser.id) &&
                String(message.receiver_id) === String(user?.id)) ||
              (String(message.sender_id) === String(user?.id) &&
                String(message.receiver_id) === String(selectedUser.id)),
          )
        : [];
    const mergedById = new Map();
    [...(historyPagesByConversation[historyConversationKey] || []), ...currentConversationMessages].forEach((message) => {
      mergedById.set(String(message.id), message);
    });
    const byConversation = [...mergedById.values()].sort((left, right) =>
      new Date(left.timestamp) - new Date(right.timestamp) || Number(left.id) - Number(right.id),
    );
    if (!searchTerm.trim()) return byConversation;
    const term = searchTerm.toLowerCase();
    return byConversation.filter((message) => {
      const content = String(message.content || "").toLowerCase();
      const sender = String(message.sender_name || "").toLowerCase();
      return content.includes(term) || sender.includes(term);
    });
  }, [conversationStarted, historyConversationKey, historyPagesByConversation, messages, searchTerm, selectedGroup, selectedUser, user?.id]);

  const loadConversationHistoryPage = useCallback(async (mode = "initial") => {
    const conversationKey = historyConversationKey;
    if (!conversationStarted || !conversationKey || historyRequestsRef.current.has(conversationKey)) return false;
    const currentState = historyStateByConversation[conversationKey];
    if (mode === "older" && (!currentState?.hasMore || !currentState.nextCursor)) return false;

    historyRequestsRef.current.add(conversationKey);
    setHistoryStateByConversation((current) => ({
      ...current,
      [conversationKey]: { ...current[conversationKey], loading: true },
    }));
    try {
      const queryParams = new URLSearchParams();
      if (selectedGroup?.id) queryParams.set("group_id", selectedGroup.id);
      else if (selectedUser?.id) queryParams.set("receiver_id", selectedUser.id);
      if (mode === "older" && currentState?.nextCursor) queryParams.set("before_message_id", currentState.nextCursor);
      if (masterAdmin && activeChatCompanyId) queryParams.set("company_id", activeChatCompanyId);

      const response = await fetch(`${API_BASE_URL}/messages/history?${queryParams.toString()}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Nao foi possivel carregar mensagens anteriores.");
      if (historyConversationKey !== conversationKey) return false;

      const pageMessages = Array.isArray(payload.messages) ? payload.messages : [];
      setHistoryPagesByConversation((current) => {
        const existing = mode === "initial" ? [] : current[conversationKey] || [];
        const byId = new Map(existing.map((message) => [String(message.id), message]));
        pageMessages.forEach((message) => byId.set(String(message.id), message));
        return { ...current, [conversationKey]: [...byId.values()] };
      });
      setHistoryStateByConversation((current) => ({
        ...current,
        [conversationKey]: {
          nextCursor: payload.next_cursor || null,
          hasMore: Boolean(payload.has_more),
          loading: false,
        },
      }));
      return true;
    } catch (error) {
      if (historyConversationKey === conversationKey) {
        setHistoryStateByConversation((current) => ({
          ...current,
          [conversationKey]: { ...current[conversationKey], loading: false },
        }));
        toast.error(error.message || "Nao foi possivel carregar o historico da conversa.");
      }
      return false;
    } finally {
      historyRequestsRef.current.delete(conversationKey);
    }
  }, [activeChatCompanyId, conversationStarted, historyConversationKey, historyStateByConversation, masterAdmin, selectedGroup?.id, selectedUser?.id]);

  useEffect(() => {
    if (!conversationStarted || !historyConversationKey || historyStateByConversation[historyConversationKey]) return;
    loadConversationHistoryPage("initial");
  }, [conversationStarted, historyConversationKey, historyStateByConversation, loadConversationHistoryPage]);

  useEffect(() => {
    nearBottomRef.current = true;
    setShowScrollToBottom(false);
    requestAnimationFrame(() => messagesEndRef.current?.scrollIntoView({ behavior: "auto" }));
  }, [selectedGroup?.id, selectedUser?.id, conversationStarted]);

  useEffect(() => {
    if (!connected || !conversationStarted || (!selectedUser?.id && !selectedGroup?.id)) return;
    const frameId = window.requestAnimationFrame(() => composerRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [connected, conversationStarted, selectedGroup?.id, selectedUser?.id]);

  useEffect(() => {
    if (!conversationStarted || !filteredMessages.length) return;
    const lastMessage = filteredMessages[filteredMessages.length - 1];
    if (Number(lastMessage.sender_id) === Number(user?.id) || nearBottomRef.current) {
      requestAnimationFrame(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }));
      setShowScrollToBottom(false);
    } else {
      setShowScrollToBottom(true);
    }
  }, [conversationStarted, filteredMessages, user?.id]);

  const handleMessagesScroll = () => {
    const element = messagesContainerRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    nearBottomRef.current = nearBottom;
    if (nearBottom) setShowScrollToBottom(false);
    if (element.scrollTop <= 72 && activeHistoryState.hasMore && !historyLoading) {
      const previousHeight = element.scrollHeight;
      const previousTop = element.scrollTop;
      loadConversationHistoryPage("older").then((loaded) => {
        if (!loaded || messagesContainerRef.current !== element) return;
        requestAnimationFrame(() => {
          element.scrollTop = element.scrollHeight - previousHeight + previousTop;
        });
      });
    }
  };

  const scrollToLastMessage = () => {
    nearBottomRef.current = true;
    setShowScrollToBottom(false);
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const typingUser = selectedGroup
    ? typingUsers.find((item) => Number(item.group_id) === Number(selectedGroup.id))
    : selectedUser
      ? typingUsers.find(
          (item) => String(item.id) === String(selectedUser.id)
            && String(item.receiver_id) === String(user?.id),
        )
      : null;
  const selectedEmojiGroup =
    emojiGroups.find((group) => group.label === emojiCategory) ||
    emojiGroups[0];
  const selectedConversationKey = selectedGroup
    ? `group:${selectedGroup.id}`
    : selectedUser
      ? String(selectedUser.id)
      : "";
  const selectedGroupMembers = Array.isArray(selectedGroup?.member_ids)
    ? selectedGroup.member_ids
    : [];
  const selectedGroupOnlineCount = selectedGroup
    ? selectedGroupMembers.filter((memberId) => Number(memberId) === Number(user?.id) || onlineUsers.some((onlineUser) => Number(onlineUser.id) === Number(memberId))).length
    : 0;
  const selectedGroupMentionUsers = selectedGroup
    ? (Array.isArray(selectedGroup.members) && selectedGroup.members.length
        ? selectedGroup.members
        : contacts.filter((contact) => selectedGroupMembers.map(Number).includes(Number(contact.id))))
        .filter((contact) => Number(contact.id) !== Number(user?.id))
    : [];
  const mentionCandidates = mentionRange
    ? selectedGroupMentionUsers
        .filter((contact) => {
          const term = mentionQuery.trim().toLowerCase();
          if (!term) return true;
          return [contact.nickname, contact.display_name, contact.full_name, contact.username, contact.department]
            .some((value) => String(value || "").toLowerCase().includes(term));
        })
        .slice(0, 8)
    : [];
  const selectedUserPresence = presenceMeta(selectedUser, onlineUsers);
  const selectedAssistantId = selectedUser && isAssistantContact(selectedUser) ? String(selectedUser.id) : "";
  const selectedAssistantPlan = selectedAssistantId ? assistantChatPlans[selectedAssistantId] : null;
  const selectedAssistantUrgency = selectedAssistantId
    ? (assistantChatUrgencies[selectedAssistantId] || selectedAssistantPlan?.plan?.ticket_priority || "")
    : "";

  useEffect(() => {
    setMentionRange(null);
    setMentionQuery("");
    setMentionActiveIndex(0);
  }, [selectedGroup?.id, selectedUser?.id]);

  useEffect(() => {
    if (!connected || !conversationStarted || !selectedUser?.id) return;
    const hasUnread = messages.some((message) => Number(message.sender_id) === Number(selectedUser.id) && Number(message.receiver_id) === Number(user?.id) && !message.is_read);
    if (hasUnread) markDirectMessagesRead(selectedUser.id);
  }, [connected, conversationStarted, markDirectMessagesRead, messages, selectedUser?.id, user?.id]);

  useEffect(() => {
    if (!pendingAttachmentPreviewUrl) return undefined;
    return () => URL.revokeObjectURL(pendingAttachmentPreviewUrl);
  }, [pendingAttachmentPreviewUrl]);

  useEffect(() => {
    if (!window.voltChatDesktop?.onNotificationClicked) return undefined;
    return window.voltChatDesktop.onNotificationClicked((payload) => {
      if (payload?.groupId) {
        const group = groups.find(
          (item) => String(item.id) === String(payload.groupId),
        );
        if (group) {
          setSelectedGroup(group);
          setSelectedUser(null);
          setConversationStarted(true);
          return;
        }
      }

      const contact = contacts.find(
        (item) => String(item.id) === String(payload?.senderId),
      );
      if (contact) {
        setSelectedUser(contact);
        setSelectedGroup(null);
        setConversationStarted(true);
      }
    });
  }, [contacts, groups]);

  const togglePreference = (kind, key) => {
    const setter = kind === "favorites" ? setFavoriteIds : setMutedIds;
    setter((current) => {
      const next = current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key];
      localStorage.setItem(`voltchat:${kind}:${user.id}`, JSON.stringify(next));
      return next;
    });
  };

  const updateMentionState = (value, caretPosition) => {
    if (!selectedGroup) {
      setMentionRange(null);
      setMentionQuery("");
      return;
    }
    const caret = Number.isInteger(caretPosition) ? caretPosition : value.length;
    const beforeCaret = value.slice(0, caret);
    const match = beforeCaret.match(/(?:^|\s)@([A-Za-z0-9._-]*)$/);
    if (!match) {
      setMentionRange(null);
      setMentionQuery("");
      return;
    }
    const query = match[1] || "";
    const atIndex = beforeCaret.lastIndexOf("@");
    setMentionRange({ start: atIndex, end: caret });
    setMentionQuery(query);
    setMentionActiveIndex(0);
  };

  const insertMention = (contact) => {
    if (!mentionRange) return;
    const username = mentionTokenForContact(contact);
    if (!username) return;
    const mentionText = `@${username} `;
    const currentValue = composerValueRef.current;
    const nextValue = `${currentValue.slice(0, mentionRange.start)}${mentionText}${currentValue.slice(mentionRange.end)}`;
    const nextCaret = mentionRange.start + mentionText.length;
    setComposerValue(nextValue, { immediate: true });
    setMentionRange(null);
    setMentionQuery("");
    setMentionActiveIndex(0);
    window.setTimeout(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(nextCaret, nextCaret);
    }, 0);
  };

  const handleTyping = (event) => {
    const value = event.target.value;
    const caretPosition = event.target.selectionStart;
    setComposerValue(value);

    if (mentionRange || (selectedGroup && value.includes("@"))) {
      if (mentionUpdateTimeoutRef.current) {
        window.clearTimeout(mentionUpdateTimeoutRef.current);
      }
      mentionUpdateTimeoutRef.current = window.setTimeout(() => {
        updateMentionState(value, caretPosition);
        mentionUpdateTimeoutRef.current = null;
      }, 120);
    }

    const target = {
      key: selectedGroup ? `group:${selectedGroup.id}` : `user:${selectedUser?.id || ""}`,
      receiverId: selectedGroup ? null : selectedUser?.id || null,
      groupId: selectedGroup?.id || null,
    };
    const previousTarget = typingTargetRef.current;
    if (previousTarget && previousTarget.key !== target.key) {
      sendTypingIndicator(false, previousTarget.receiverId, previousTarget.groupId);
      typingTargetRef.current = null;
    }
    if (!typingTargetRef.current && (target.receiverId || target.groupId)) {
      sendTypingIndicator(true, target.receiverId, target.groupId);
      typingTargetRef.current = target;
    }

    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = window.setTimeout(() => {
      if (typingTargetRef.current?.key === target.key) {
        sendTypingIndicator(false, target.receiverId, target.groupId);
        typingTargetRef.current = null;
      }
      typingTimeoutRef.current = null;
    }, 1200);
  };

  const canCreateChatGroup = masterAdmin || ["company_admin", "master_admin", "coordinator"].includes(user?.company_role);
  const visibleGroupContacts = contacts.filter((contact) => {
    const term = groupSearch.trim().toLowerCase();
    return !term || [contact.nickname, contact.full_name, contact.username, contact.department].some((value) => String(value || "").toLowerCase().includes(term));
  });

  const handleGroupImage = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setGroupImageData(String(reader.result || ""));
    reader.readAsDataURL(file);
  };

  const openGroupConversation = (group) => {
    setSelectedGroup(group);
    setSelectedUser(null);
    setConversationStarted(true);
    setChatTab("groups");
    markAsRead(`group:${group.id}`);
    setGroups((current) => current.map((item) =>
      Number(item.id) === Number(group.id) ? { ...item, unread_mention_count: 0 } : item
    ));
    setSelectedGroup((current) => Number(current?.id) === Number(group.id) ? { ...current, unread_mention_count: 0 } : current);
    const query = masterAdmin && selectedChatCompanyId ? `?company_id=${encodeURIComponent(selectedChatCompanyId)}` : "";
    fetch(`${API_BASE_URL}/groups/${group.id}/read${query}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    }).catch(() => {});
  };

  const openGroupEditor = (group = null) => {
    setEditingGroup(group);
    setGroupName(group?.name || "");
    setGroupDescription(group?.description || "");
    setGroupMemberIds(group?.member_ids || []);
    setGroupImageData(group?.image_data || "");
    setGroupSearch("");
    setShowGroupCreator(true);
  };
  const handleCreateChatGroup = async (event) => {
    event.preventDefault();
    if (!groupName.trim()) return;
    try {
      const response = await fetch(editingGroup ? `${API_BASE_URL}/groups/${editingGroup.id}` : `${API_BASE_URL}/groups/`, {
        method: editingGroup ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` },
        body: JSON.stringify({ name: groupName, description: groupDescription, image_data: groupImageData, member_ids: groupMemberIds, company_id: masterAdmin ? selectedChatCompanyId : undefined }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.detail || "Nao foi possivel criar o grupo.");
      }
      const savedGroup = await response.json();
      setGroups((current) => editingGroup ? current.map((group) => group.id === savedGroup.id ? savedGroup : group) : [...current, savedGroup]);
      if (selectedGroup?.id === savedGroup.id) setSelectedGroup(savedGroup);
      toast.success(editingGroup ? "Grupo atualizado com sucesso." : "Grupo criado com sucesso.");
      setShowGroupCreator(false);
      setEditingGroup(null);
      setGroupName(""); setGroupDescription(""); setGroupSearch(""); setGroupMemberIds([]); setGroupImageData("");
    } catch (error) { toast.error(error.message); }
  };
  const handleDeleteGroup = async (group) => {
    if (!group?.id || !canCreateChatGroup) return;
    const confirmed = await dialog.confirm({
      title: "Excluir grupo",
      message: `Deseja excluir o grupo “${group.name}”?`,
      detail: "O grupo deixará de aparecer para todos os participantes. O histórico será preservado para auditoria.",
      confirmLabel: "Excluir grupo",
      danger: true,
    });
    if (!confirmed) return;
    try {
      const query = masterAdmin && selectedChatCompanyId
        ? `?company_id=${encodeURIComponent(selectedChatCompanyId)}`
        : "";
      const response = await fetch(`${API_BASE_URL}/groups/${group.id}${query}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.detail || "Não foi possível excluir o grupo.");
      }
      setGroups((current) => current.filter((item) => Number(item.id) !== Number(group.id)));
      if (Number(selectedGroup?.id) === Number(group.id)) {
        setSelectedGroup(null);
        setConversationStarted(false);
      }
      setShowGroupCreator(false);
      setGroupDetailsOpen(false);
      setEditingGroup(null);
      toast.success("Grupo excluído com sucesso.");
    } catch (error) {
      toast.error(error.message);
    }
  };

  const sendAssistantChatMessage = async (content, assistant, options = {}) => {
    const assistantId = String(assistant.id);
    const pending = assistantChatPlans[assistantId];
    const normalized = content.trim().toLowerCase();
    const confirms = /^(sim|confirmo|confirmar|pode|pode criar|pode abrir|ok|confirmado)[.! ]*$/.test(normalized);
    const cancels = /^(nao|não|cancelar|cancela|desistir)[.! ]*$/.test(normalized);
    let message = content;
    let execute = false;
    let confirmed = false;
    let urgency = options.urgency;

    if (pending && cancels) {
      setAssistantChatPlans((current) => {
        const next = { ...current };
        delete next[assistantId];
        return next;
      });
    } else if (pending?.requires_confirmation && confirms) {
      message = pending.command || content;
      urgency = options.urgency || pending.plan?.ticket_priority;
      execute = true;
      confirmed = true;
    } else if (pending?.needs_input || pending?.requires_confirmation) {
      message = buildAssistantFollowUpCommand({ pending, content });
    } else {
      message = buildAssistantFollowUpCommand({ pending: null, content });
    }

    setAssistantResponding(true);
    try {
      const response = await fetch(`${API_BASE_URL}/assistant/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
        body: JSON.stringify({
          assistant_username: assistantUsername(assistant),
          company_id: masterAdmin ? selectedChatCompanyId : undefined,
          message,
          display_message: content,
          urgency,
          execute,
          confirmed,
          attachment_file_id: options.attachment_file_id || pending?.attachment_file_id || undefined,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Nao foi possivel conversar com o assistente.");
      if (data.executed) {
        const successMessage = data.intent === "meeting_edit"
          ? "Agenda atualizada pela Mitty."
          : data.intent === "task_edit"
            ? "Tarefa atualizada pela Mitty."
            : data.intent === "meeting"
          ? "Reunião agendada pela Mitty."
          : data.intent === "reminder"
            ? "Compromisso agendado pela Mitty."
            : data.intent === "agenda_task"
              ? "Tarefa adicionada à agenda pela Mitty."
              : data.intent === "task"
                ? "Tarefa criada pela Mitty."
                : data.intent === "ticket"
                  ? "Ticket criado pelo Volt."
                  : "Ação concluída.";
        toast.success(successMessage);
        window.dispatchEvent(new CustomEvent("voltchat:assistant-action-executed", { detail: data }));
      }
      if (data.plan?.ticket_priority) {
        setAssistantChatUrgencies((current) => ({ ...current, [assistantId]: data.plan.ticket_priority }));
      }
      setAssistantChatPlans((current) => {
        const next = { ...current };
        if (!data.executed && (data.needs_input || data.requires_confirmation)) {
          next[assistantId] = {
            ...data,
            attachment_file_id: options.attachment_file_id || pending?.attachment_file_id || undefined,
          };
        }
        else delete next[assistantId];
        return next;
      });
      return data;
    } catch (error) {
      toast.error(error.message);
      return null;
    } finally {
      setAssistantResponding(false);
    }
  };
  const cancelSelectedAssistantPlan = () => {
    if (!selectedAssistantId) return;
    setAssistantChatPlans((current) => {
      const next = { ...current };
      delete next[selectedAssistantId];
      return next;
    });
    setAssistantChatUrgencies((current) => {
      const next = { ...current };
      delete next[selectedAssistantId];
      return next;
    });
    setPendingAttachment(null);
    setPendingAttachmentPreviewUrl("");
    toast.success("Solicitação cancelada. Escreva novamente com os ajustes desejados.");
  };

  const confirmSelectedAssistantPlan = async () => {
    if (!selectedUser || !selectedAssistantPlan?.requires_confirmation) return;
    if (selectedAssistantPlan.intent === "ticket" && !selectedAssistantUrgency) {
      toast.error("Selecione o nível de urgência.");
      return;
    }
    if (pendingAttachment && !isBoltContact(selectedUser)) {
      toast.error("Anexo fixo está disponível apenas para tickets tratados pelo Volt.");
      return;
    }
    setIsUploading(Boolean(pendingAttachment));
    try {
      const uploaded = pendingAttachment
        ? await uploadFile(pendingAttachment, masterAdmin ? selectedChatCompanyId : null)
        : null;
      const data = await sendAssistantChatMessage("Confirmo", selectedUser, {
        urgency: selectedAssistantUrgency,
        attachment_file_id: uploaded?.id || selectedAssistantPlan.attachment_file_id,
      });
      if (data?.executed) {
        setPendingAttachment(null);
        setPendingAttachmentPreviewUrl("");
      }
    } catch (error) {
      toast.error(error.message || "Não foi possível confirmar a ação.");
    } finally {
      setIsUploading(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const draftContent = composerValueRef.current.trim();

    if (!draftContent && !pendingAttachment) {
      return;
    }

    if (!selectedUser && !selectedGroup) {
      toast.error("Selecione uma conversa direta ou um grupo antes de enviar.");
      return;
    }

    if (selectedUser && !selectedGroup && isAssistantContact(selectedUser)) {
      const content = draftContent;
      if (!content) {
        toast.error("Descreva o que o assistente deve fazer antes de anexar o arquivo.");
        return;
      }
      if (pendingAttachment && !isBoltContact(selectedUser)) {
        toast.error("Anexo fixo está disponível apenas para tickets tratados pelo Volt.");
        return;
      }
      const typedConfirmation = /^(sim|confirmo|confirmar|pode|pode criar|pode abrir|ok|confirmado)[.! ]*$/i.test(content);
      if (selectedAssistantPlan?.requires_confirmation && typedConfirmation) {
        setComposerValue("", { immediate: true });
        await confirmSelectedAssistantPlan();
        return;
      }
      try {
        const data = await sendAssistantChatMessage(content, selectedUser);
        if (data) {
          setComposerValue("", { immediate: true });
          setReplyingTo(null);
          setShowEmojiPicker(false);
          sendTypingIndicator(false, selectedUser.id, null);
          typingTargetRef.current = null;
        }
      } catch (error) {
        toast.error(error.message || "Não foi possível conversar com o assistente.");
      } finally {
        setIsUploading(false);
      }
      return;
    }

    const outgoingMentionUserIds = selectedGroup
      ? mentionUserIdsForText(draftContent, selectedGroupMentionUsers)
      : [];

    if (draftContent.length > INLINE_MESSAGE_MAX_LENGTH) {
      const content = draftContent;
      const filename = `mensagem-longa-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
      const textFile = new File([content], filename, { type: "text/plain;charset=utf-8" });
      setIsUploading(true);
      try {
        const result = await uploadFile(textFile, masterAdmin ? selectedChatCompanyId : null);
        if (!sendMessage(
          `Mensagem com ${content.length.toLocaleString("pt-BR")} caracteres convertida automaticamente em arquivo TXT. O limite de texto no balão é de ${INLINE_MESSAGE_MAX_LENGTH} caracteres.`,
          selectedGroup ? null : selectedUser?.id,
          "file",
          result.id || result.file_path,
          replyingTo,
          selectedGroup?.id || null,
          outgoingMentionUserIds,
        )) {
          throw new Error("O chat esta reconectando. Tente enviar novamente.");
        }
        toast.success(`Mensagem acima de ${INLINE_MESSAGE_MAX_LENGTH} caracteres enviada como arquivo TXT.`);
        setComposerValue("", { immediate: true });
        setMentionRange(null);
        setMentionQuery("");
        setReplyingTo(null);
        setShowEmojiPicker(false);
      } catch (error) {
        toast.error(error.message || "Nao foi possivel enviar a mensagem grande.");
      } finally {
        setIsUploading(false);
      }
      return;
    }
    if (pendingAttachment) {
      const attachments = [pendingAttachment, ...pendingExtraAttachments];
      setIsUploading(true);
      try {
        for (let index = 0; index < attachments.length; index += 1) {
          const attachment = attachments[index];
          const result = await uploadFile(attachment, masterAdmin ? selectedChatCompanyId : null);
          const content = index === 0 ? draftContent || attachment.name : attachment.name;
          if (!sendMessage(
            content,
            selectedGroup ? null : selectedUser?.id,
            "file",
            result.id || result.file_path,
            index === 0 ? replyingTo : null,
            selectedGroup?.id || null,
            outgoingMentionUserIds,
          )) {
            throw new Error("O chat esta reconectando. Tente enviar novamente.");
          }
        }
        toast.success(attachments.length > 1 ? `${attachments.length} arquivos enviados.` : "Arquivo enviado.");
        setPendingAttachment(null);
        setPendingExtraAttachments([]);
        setPendingAttachmentPreviewUrl("");
        setComposerValue("", { immediate: true });
        setMentionRange(null);
        setMentionQuery("");
        setReplyingTo(null);
        setShowEmojiPicker(false);
      } catch (error) {
        toast.error(error.message || "Nao foi possivel enviar os arquivos.");
      } finally {
        setIsUploading(false);
      }
      return;
    }
    if (
      !sendMessage(
        draftContent,
        selectedGroup ? null : selectedUser?.id,
        "text",
        null,
        replyingTo,
        selectedGroup?.id || null,
        outgoingMentionUserIds,
      )
    ) {
      return;
    }
    sendTypingIndicator(false, selectedGroup ? null : selectedUser?.id, selectedGroup?.id || null);
    typingTargetRef.current = null;
    setComposerValue("", { immediate: true });
    setMentionRange(null);
    setMentionQuery("");
    setReplyingTo(null);
    setShowEmojiPicker(false);
  };

  const canEditChatMessage = (message) => {
    if (!allowUserMessageEditing || !message || message.pending || message.failed) return false;
    if (Number(message.sender_id) !== Number(user?.id) || message.message_type !== "text") return false;
    if (!Number.isInteger(Number(message.id)) || Number(message.edit_count || 0) >= 2) return false;
    const sentAt = new Date(message.timestamp).getTime();
    return Number.isFinite(sentAt) && Date.now() - sentAt <= 30 * 60 * 1000;
  };

  const openMessageEditor = (message) => {
    if (!canEditChatMessage(message)) return;
    setEditingMessage(message);
    setEditingMessageValue(String(message.content || ""));
  };

  const submitMessageEdit = async (event) => {
    event?.preventDefault?.();
    if (!editingMessage || editingMessageSaving) return;
    const content = editingMessageValue.trim();
    if (!content) {
      toast.error("A mensagem não pode ficar vazia.");
      return;
    }
    if (content.length > INLINE_MESSAGE_MAX_LENGTH) {
      toast.error(`A edição é limitada a ${INLINE_MESSAGE_MAX_LENGTH} caracteres.`);
      return;
    }
    const group = editingMessage.group_id
      ? groups.find((item) => Number(item.id) === Number(editingMessage.group_id))
      : null;
    const mentionIds = group ? mentionUserIdsForText(content, group.members || []) : [];
    setEditingMessageSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/messages/${editingMessage.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
        body: JSON.stringify({ content, mention_user_ids: mentionIds }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Não foi possível editar a mensagem.");
      setEditingMessage(null);
      setEditingMessageValue("");
      toast.success(`Mensagem editada (${payload.edit_count || 1}/2).`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setEditingMessageSaving(false);
    }
  };

  const handleFavoriteSticker = async (message) => {
    const reference = stickerSourceReference(message);
    if (!reference || favoritingStickerIds.includes(String(message.id))) return;
    if (favoriteStickerReferences.includes(reference)) {
      toast.success("Esta figurinha já está em Minhas figurinhas.");
      return;
    }

    setFavoritingStickerIds((current) => [...current, String(message.id)]);
    try {
      let imageData;
      if (reference.startsWith("default:")) {
        const sticker = defaultStickerMap[reference.split(":", 2)[1]];
        if (!sticker?.image) throw new Error("Não foi possível localizar a figurinha oficial.");
        const imageResponse = await fetch(sticker.image);
        if (!imageResponse.ok) throw new Error("Não foi possível carregar a figurinha oficial.");
        const blob = await imageResponse.blob();
        imageData = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("Não foi possível preparar a figurinha."));
          reader.readAsDataURL(blob);
        });
      }

      const response = await fetch(`${API_BASE_URL}/stickers/favorite`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
        body: JSON.stringify({
          message_id: message.id,
          company_id: activeChatCompanyId || undefined,
          image_data: imageData,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Não foi possível favoritar a figurinha.");
      setFavoriteStickerReferences((current) => Array.from(new Set([
        ...current,
        reference,
        payload.source_reference,
        payload.id ? `sticker:${payload.id}` : null,
      ].filter(Boolean))));
      window.dispatchEvent(new CustomEvent("voltchat:stickers-updated"));
      toast.success(payload.already_saved ? "Figurinha já estava salva." : "Figurinha adicionada às Minhas figurinhas.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setFavoritingStickerIds((current) => current.filter((id) => id !== String(message.id)));
    }
  };
  const handleSendSticker = (sticker) => {
    if (!sticker?.source) return;
    if (
      !sendMessage(
        sticker.name || "Figurinha",
        selectedGroup ? null : selectedUser?.id,
        "sticker",
        sticker.source,
        replyingTo,
        selectedGroup?.id || null,
      )
    ) return;
    setReplyingTo(null);
    setShowStickerPicker(false);
    setShowEmojiPicker(false);
  };
  const handleMessageKeyDown = (event) => {
    if (mentionRange && mentionCandidates.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionActiveIndex((current) => (current + 1) % mentionCandidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionActiveIndex((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        insertMention(mentionCandidates[mentionActiveIndex] || mentionCandidates[0]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionRange(null);
        setMentionQuery("");
        return;
      }
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent?.isComposing
    ) {
      event.preventDefault();
      handleSubmit(event);
    }
  };

  const selectAttachment = (file) => {
    if (!file) return;
    setPendingAttachment(file);
    setPendingAttachmentPreviewUrl("");
    if (String(file.type || "").startsWith("image/") || imageExtensions.has(getFileExtension(file.name))) {
      setPendingAttachmentPreviewUrl(URL.createObjectURL(file));
    }
  };

  const selectAttachments = (files) => {
    const selectedFiles = Array.from(files || []).filter(Boolean);
    if (!selectedFiles.length) return;
    selectAttachment(selectedFiles[0]);
    setPendingExtraAttachments(selectedFiles.slice(1));
  };

  const handleFileUpload = (event) => {
    selectAttachments(event.target.files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleComposerDrop = (event) => {
    event.preventDefault();
    setComposerDropActive(false);
    if (!selectedUser && !selectedGroup) {
      toast.error("Selecione uma conversa antes de anexar arquivos.");
      return;
    }
    selectAttachments(event.dataTransfer?.files);
  };

  const handleComposerPaste = (event) => {
    const imageFile = Array.from(event.clipboardData?.items || []).find((item) => item.type.startsWith("image/"))?.getAsFile();
    if (!imageFile) return;
    event.preventDefault();
    selectAttachments([new File([imageFile], `imagem-colada-${Date.now()}.${imageFile.type.split("/")[1] || "png"}`, { type: imageFile.type })]);
    toast.success("Imagem colada e pronta para enviar.");
  };
  const handleRecordedAudio = async (file) => {
    setIsUploading(true);
    try {
      const result = await uploadFile(
        file,
        masterAdmin ? selectedChatCompanyId : null,
      );
      if (
        !sendMessage(
          file.name,
          selectedGroup ? null : selectedUser?.id,
          "file",
          result.id || result.file_path,
          replyingTo,
          selectedGroup?.id || null,
        )
      ) {
        throw new Error(
          "O áudio foi gravado, mas o chat está reconectando. Tente novamente.",
        );
      }
      setReplyingTo(null);
      toast.success("Áudio enviado.");
    } catch (error) {
      toast.error(error.message || "Não foi possível enviar o áudio.");
      throw error;
    } finally {
      setIsUploading(false);
    }
  };

  const handleCancelPendingAttachment = () => {
    setPendingAttachment(null);
    setPendingExtraAttachments([]);
    setPendingAttachmentPreviewUrl("");
  };

  const openFilesHistory = async () => {
    setFilesHistoryOpen(true);
    setLoadingConversationFiles(true);
    try {
      const token = localStorage.getItem("token");
      const queryParams = new URLSearchParams();
      if (selectedUser?.id) queryParams.set("user_id", selectedUser.id);
      if (masterAdmin && selectedChatCompanyId)
        queryParams.set("company_id", selectedChatCompanyId);
      const query = queryParams.toString() ? `?${queryParams.toString()}` : "";
      const response = await fetch(
        `${API_BASE_URL}/files/conversation${query}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          payload.detail ||
            "Nao foi possivel carregar os arquivos da conversa.",
        );
      }
      setConversationFiles(await response.json());
    } catch (error) {
      toast.error(error.message);
      setConversationFiles([]);
    } finally {
      setLoadingConversationFiles(false);
    }
  };

  const handleConversationFileDownload = async (file) => {
    try {
      const savedPath = await downloadAuthenticatedFile(file.id, file.filename);
      toast.success(
        savedPath ? `Arquivo salvo em ${savedPath}` : "Download iniciado.",
      );
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleReaction = async (messageId, emoji) => {
    const normalizedEmoji = String(emoji || "").trim();
    if (!normalizedEmoji) return;
    try {
      await sendReaction(messageId, normalizedEmoji);
      setReactionMessageId(null);
    } catch {
      // O contexto exibe a mensagem de erro.
    }
  };

  const handleDeleteMessage = async (messageId) => {
    const confirmed = await dialog.confirm({ title: "Excluir mensagem?", message: "A mensagem será removida para todos os participantes.", confirmLabel: "Excluir mensagem", danger: true });
    if (!confirmed) return;
    const removedMessage = messages.find(
      (message) => String(message.id) === String(messageId),
    );
    setDeletingMessageIds((current) => [...current, String(messageId)]);
    removeMessageImmediately(messageId);
    try {
      const response = await fetch(`${API_BASE_URL}/messages/${messageId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      });
      if (!response.ok && response.status !== 404) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          payload.detail || "Não foi possível remover a mensagem.",
        );
      }
      toast.success("Mensagem removida.");
    } catch (error) {
      restoreMessageImmediately(removedMessage);
      toast.error(error.message);
      loadMessageHistory();
    } finally {
      setDeletingMessageIds((current) =>
        current.filter((id) => id !== String(messageId)),
      );
    }
  };

  const handleClearChatHistory = async () => {
    if (!selectedUser) return;
    const chatName = displayContactName(selectedUser);
    const confirmed = await dialog.confirm({
      title: "Limpar histórico do chat?",
      message: `Todo o histórico atual de ${chatName} será removido para os participantes.`,
      confirmLabel: "Limpar histórico",
      danger: true,
    });
    if (!confirmed) return;
    try {
      const queryParams = new URLSearchParams();
      if (selectedUser?.id) queryParams.set("receiver_id", selectedUser.id);
      if (masterAdmin && selectedChatCompanyId)
        queryParams.set("company_id", selectedChatCompanyId);
      const query = queryParams.toString() ? `?${queryParams.toString()}` : "";
      const response = await fetch(
        `${API_BASE_URL}/messages/history/clear${query}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
        },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          payload.detail || "Não foi possível limpar o histórico.",
        );
      }
      toast.success("Histórico do chat removido.");
      clearConversationImmediately(selectedUser?.id || null);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const formatTime = (timestamp) => {
    if (!timestamp) {
      return "";
    }

    return new Date(timestamp).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="chat-shell panel grid h-[calc(100vh-138px)] min-h-[620px] overflow-hidden lg:grid-cols-[320px_1fr]">
      <aside className="chat-roster flex min-h-0 flex-col border-b border-slate-200 lg:border-b-0 lg:border-r">
        <div className="chat-roster__head border-b border-slate-200 p-4">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="m-0 text-lg font-extrabold text-slate-950">
                Conversas
              </h2>
              <p className="m-0 text-sm text-slate-500">
                {connected ? "Sincronizado" : "Aguardando conexao"}
              </p>
            </div>
            <span
              className={`chat-sync ${connected ? "chat-sync--online" : ""}`}
            >
              {connected ? "Sincronizado" : "Offline"}
            </span>
          </div>

          {masterAdmin && (
            <div className="chat-admin-contact-picker">
              <label>
                <span>Empresa</span>
                <select
                  className="select"
                  value={selectedChatCompanyId}
                  onChange={(event) => {
                    setSelectedUser(null);
                    setContacts([]);
                    setSelectedChatCompanyId(event.target.value);
                  }}
                >
                  <option value="">Selecionar empresa</option>
                  {adminCompanies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Iniciar conversa com</span>
                <select
                  className="select"
                  value={selectedUser?.id || ""}
                  onChange={(event) => {
                    const contact = contacts.find(
                      (item) => String(item.id) === event.target.value,
                    );
                    if (contact) { setSelectedUser(contact); setSelectedGroup(null); setConversationStarted(true); }
                  }}
                  disabled={!selectedChatCompanyId}
                >
                  <option value="">Selecionar usuario</option>
                  {contacts.map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {displayContactName(contact)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <div className="chat-roster-tabs mb-3 grid grid-cols-2 gap-2" role="tablist" aria-label="Tipos de conversa">
            <button className={`button-secondary justify-center ${chatTab === "chats" ? "chat-roster-tab--active" : ""}`} type="button" onClick={() => setChatTab("chats")}>Chats</button>
            <button className={`button-secondary justify-center ${chatTab === "groups" ? "chat-roster-tab--active" : ""}`} type="button" onClick={() => setChatTab("groups")}>Grupos</button>
          </div>
          {canCreateChatGroup && (
            <button className="button-primary mb-3 w-full justify-center" type="button" onClick={() => openGroupEditor(null)}>
              <Plus size={17} /> Novo grupo
            </button>
          )}
          <div className="chat-contact-search">
            <Search
              className="chat-contact-search__icon"
              size={17}
              aria-hidden="true"
            />
            <input
              className="input chat-contact-search__input"
              value={contactSearch}
              onChange={(event) => setContactSearch(event.target.value)}
              placeholder="Buscar por nome ou apelido"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className={chatTab === "chats" ? "block" : "hidden"}>
          <p className="mb-2 mt-4 px-2 text-xs font-extrabold uppercase tracking-wide text-slate-400">
            Conversas diretas
          </p>

          <div className="grid gap-1">
            {directoryLoading ? (
              <div className="chat-directory-loading"><Loader2 size={18} /><span>Carregando todas as conversas...</span></div>
            ) : conversationUsers.length === 0 ? (
              <p className="chat-empty-row rounded-lg bg-slate-50 p-3 text-sm text-slate-500">
                Nenhuma conversa direta ainda.
              </p>
            ) : (
              conversationUsers.map((onlineUser) => (
                <button
                  key={onlineUser.id}
                  className={`chat-thread-item flex w-full items-center gap-3 rounded-lg border p-3 text-left transition ${unreadByConversation[String(onlineUser.id)] > 0 ? "chat-thread-item--unread " : ""}${
                    String(selectedUser?.id) === String(onlineUser.id)
                      ? "chat-thread-item--active border-teal-200 bg-teal-50"
                      : "border-transparent hover:bg-slate-50"
                  }`}
                  onClick={() => { setSelectedUser(onlineUser); setSelectedGroup(null); setConversationStarted(true); markAsRead(String(onlineUser.id)); markDirectMessagesRead(onlineUser.id); }}
                >
                  <div className="chat-thread-avatar relative grid h-10 w-10 place-items-center rounded-lg bg-slate-100 font-bold text-slate-700">
                    {contactProfilePhoto(onlineUser) ? (
                      <img
                        className="chat-contact-avatar__image"
                        src={contactProfilePhoto(onlineUser)}
                        alt=""
                      />
                    ) : (
                      (displayContactName(onlineUser) || "U")
                        .charAt(0)
                        .toUpperCase()
                    )}
                    <span
                      className={`chat-thread-avatar__status absolute -bottom-1 -right-1 h-3 w-3 rounded-full border-2 border-white ${presenceMeta(onlineUser, onlineUsers).dotClass}`}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 truncate text-sm font-extrabold text-slate-950">
                      {displayContactName(onlineUser)}
                    </p>
                    {fullNameCaption(onlineUser) && (
                      <p className="m-0 truncate text-[11px] text-slate-400">
                        {fullNameCaption(onlineUser)}
                      </p>
                    )}
                    <p className="m-0 text-xs text-slate-500">
                      {typingUsers.find((item) => String(item.id) === String(onlineUser.id) && String(item.receiver_id) === String(user?.id))
                        ? "digitando..."
                        : isBoltContact(onlineUser)
                          ? "Online · Assistente de tickets"
                          : isMittyContact(onlineUser)
                            ? "Online · Secretaria virtual"
                          : presenceMeta(onlineUser, onlineUsers).label}
                    </p>
                  </div>
                  <div className="chat-thread-item__preferences">
                    {unreadByConversation[String(onlineUser.id)] > 0 && <span className="badge badge--warning">{unreadByConversation[String(onlineUser.id)]}</span>}
                    {favoriteIds.includes(String(onlineUser.id)) && (
                      <Star
                        size={13}
                        fill="currentColor"
                        aria-label="Favorito"
                      />
                    )}
                    {mutedIds.includes(String(onlineUser.id)) && (
                      <BellOff size={13} aria-label="Silenciado" />
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
          </div>
          {chatTab === "groups" && (
            <div className="grid gap-2">
              {directoryLoading ? (<div className="chat-directory-loading"><Loader2 size={18} /><span>Carregando todos os grupos...</span></div>) : groups.length === 0 ? (
                <p className="chat-empty-row rounded-lg bg-slate-50 p-3 text-sm text-slate-500">Nenhum grupo disponível.</p>
              ) : groups.map((group) => {
                const memberIds = Array.isArray(group.member_ids) ? group.member_ids : [];
                const onlineCount = memberIds.filter((memberId) => Number(memberId) === Number(user?.id) || onlineUsers.some((onlineUser) => Number(onlineUser.id) === Number(memberId))).length;
                return <button key={group.id} className={`chat-thread-item flex w-full items-center gap-3 rounded-lg border p-3 text-left transition ${selectedGroup?.id === group.id ? "chat-thread-item--active border-teal-200 bg-teal-50" : "border-transparent hover:bg-slate-50"}`} type="button" onClick={() => openGroupConversation(group)}>
                  <div className="chat-thread-avatar grid h-10 w-10 place-items-center overflow-hidden rounded-lg bg-slate-900 font-bold text-white">{group.image_data ? <img className="h-full w-full object-cover" src={group.image_data} alt="" /> : group.name.charAt(0).toUpperCase()}</div>
                  <div className="min-w-0 flex-1"><p className="m-0 truncate text-sm font-extrabold text-slate-950">{group.name}</p><p className="m-0 text-xs text-slate-500">{onlineCount} online de {memberIds.length}</p></div>
                  <span className="chat-thread-item__badges">
                    {unreadByConversation[`group:${group.id}`] > 0 && <span className="badge badge--warning">{unreadByConversation[`group:${group.id}`]}</span>}
                    {Number(group.unread_mention_count || 0) > 0 && <span className="badge badge--mention" title={`Você foi mencionado ${group.unread_mention_count} vez(es) neste grupo`}>@</span>}
                  </span>
                  {canCreateChatGroup && <span className="icon-button icon-button--light" role="button" tabIndex={0} title="Editar grupo" onClick={(event) => { event.stopPropagation(); openGroupEditor(group); }}><Settings size={15} /></span>}
                </button>;
              })}
            </div>
          )}
        </div>
      </aside>

      <section className={`chat-window flex min-h-0 flex-col ${!conversationStarted ? "chat-window--empty" : ""}`}>
        {!conversationStarted && (
          <div className="chat-window__empty-selection">
            <span><MessageCircle size={30} /></span>
            <h2>Selecione uma conversa</h2>
            <p>Escolha um chat ou grupo à esquerda para começar.</p>
          </div>
        )}
        <header className="chat-window__head flex items-center justify-between border-b border-slate-200 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="chat-window__avatar relative grid h-11 w-11 place-items-center rounded-lg bg-slate-100 text-slate-700">
              {selectedGroup ? (
                selectedGroup.image_data ? <img className="chat-contact-avatar__image" src={selectedGroup.image_data} alt="" /> : <Users size={20} />
              ) : selectedUser ? (
                contactProfilePhoto(selectedUser) ? <img className="chat-contact-avatar__image" src={contactProfilePhoto(selectedUser)} alt="" /> : <span className="font-extrabold">{(displayContactName(selectedUser) || "U").charAt(0).toUpperCase()}</span>
              ) : <MessageCircle size={20} />}
              {selectedUser && <span className={`chat-window__avatar-status status-dot ${selectedUserPresence.dotClass}`} title={selectedUserPresence.label} />}
            </div>
            <button
              className="chat-window__conversation-title min-w-0 text-left"
              type="button"
              onClick={() => selectedGroup ? setGroupDetailsOpen(true) : selectedUser ? openFilesHistory() : undefined}
              title={selectedGroup ? "Ver participantes do grupo" : selectedUser ? "Abrir histórico de arquivos" : "Selecione uma conversa"}
            >
              <h3 className="m-0 truncate text-base font-extrabold text-slate-950">
                {selectedGroup ? selectedGroup.name : selectedUser ? displayContactName(selectedUser) : "Selecione uma conversa"}
              </h3>
              <p className="m-0 text-sm text-slate-500">
                {selectedGroup ? `${selectedGroupOnlineCount} online de ${selectedGroupMembers.length} participantes` : selectedUser ? `${fullNameCaption(selectedUser) ? `${fullNameCaption(selectedUser)} · ` : ""}${selectedUserPresence.label}` : "Escolha Chats ou Grupos à esquerda"}
              </p>
            </button>
          </div>

          <div className="flex items-center gap-2">
            {selectedUser && (
              <button
                className="chat-attention-button"
                type="button"
                onClick={handleAttentionRequest}
                disabled={Boolean(activeAttentionLock)}
                title={attentionButtonTitle}
                aria-label={attentionButtonTitle}
              >
                <Megaphone size={17} />
                <span>
                  {activeAttentionLock
                    ? activeAttentionLock.kind === "blocked"
                      ? "Bloqueado"
                      : Math.floor(attentionRemainingSeconds / 60)
                        + ":"
                        + String(attentionRemainingSeconds % 60).padStart(2, "0")
                    : "Chamar atencao"}
                </span>
              </button>
            )}
            {selectedUser && (
              <button
                className="icon-button icon-button--light"
                type="button"
                onClick={() => startVoiceCall(selectedUser)}
                title={`Ligar para ${displayContactName(selectedUser)}`}
                aria-label={`Ligar para ${displayContactName(selectedUser)}`}
              >
                <Phone size={18} />
              </button>
            )}
            {selectedUser && (
              <button className="icon-button icon-button--light" type="button" onClick={() => startVideoCall(selectedUser)} title={`Vídeo com ${displayContactName(selectedUser)}`} aria-label={`Vídeo com ${displayContactName(selectedUser)}`}>
                <Video size={18} />
              </button>
            )}
            {selectedGroup && (
              <button className="icon-button icon-button--light" type="button" onClick={() => startGroupVoiceCall(selectedGroup, contacts.filter(contact => selectedGroupMembers.map(Number).includes(Number(contact.id))))} title="Iniciar ligação de voz com o grupo" aria-label="Iniciar ligação de voz com o grupo">
                <Phone size={18} />
              </button>
            )}            <div className="chat-message-search relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                size={15}
              />
              <input
                className="input pl-9"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Buscar na conversa"
              />
            </div>
            {searchTerm && (
              <span className="badge">
                {filteredMessages.length} resultado(s)
              </span>
            )}
            {(selectedUser || selectedGroup) && <button
              className={`icon-button icon-button--light ${favoriteIds.includes(selectedConversationKey) ? "chat-preference--active" : ""}`}
              type="button"
              onClick={() =>
                togglePreference("favorites", selectedConversationKey)
              }
              title={
                favoriteIds.includes(selectedConversationKey)
                  ? "Remover dos favoritos"
                  : "Favoritar conversa"
              }
              aria-label={
                favoriteIds.includes(selectedConversationKey)
                  ? "Remover dos favoritos"
                  : "Favoritar conversa"
              }
            >
              <Star
                size={18}
                fill={
                  favoriteIds.includes(selectedConversationKey)
                    ? "currentColor"
                    : "none"
                }
              />
            </button>}
            {(selectedUser || selectedGroup) && <button
              className={`icon-button icon-button--light ${mutedIds.includes(selectedConversationKey) ? "chat-preference--muted" : ""}`}
              type="button"
              onClick={() => togglePreference("muted", selectedConversationKey)}
              title={
                mutedIds.includes(selectedConversationKey)
                  ? "Ativar notificacoes"
                  : "Silenciar conversa"
              }
              aria-label={
                mutedIds.includes(selectedConversationKey)
                  ? "Ativar notificacoes"
                  : "Silenciar conversa"
              }
            >
              <BellOff size={18} />
            </button>}
            {selectedUser && <button
              className="icon-button icon-button--light"
              type="button"
              onClick={openFilesHistory}
              title="Arquivos compartilhados"
              aria-label="Arquivos compartilhados"
            >
              <FolderOpen size={18} />
            </button>}
            {isAdmin() && selectedUser && (
              <button
                className="icon-button icon-button--light text-red-600"
                type="button"
                onClick={handleClearChatHistory}
                title="Limpar histórico deste chat"
                aria-label="Limpar histórico deste chat"
              >
                <Trash2 size={18} />
              </button>
            )}
          </div>
        </header>

        <div ref={messagesContainerRef} onScroll={handleMessagesScroll} className="chat-canvas min-h-0 flex-1 overflow-y-auto bg-slate-50 p-5">
          {historyLoading && (
            <div className="mb-3 flex items-center justify-center gap-2 text-xs text-slate-500">
              <Loader2 className="animate-spin" size={15} /> Carregando mensagens
            </div>
          )}
          {!connected && (
            <div className="empty-state min-h-[320px]">
              <div className="empty-state__icon">
                <MessageCircle size={28} />
              </div>
              <h2>Chat desconectado</h2>
              <p>Inicie o backend para ativar mensagens em tempo real.</p>
            </div>
          )}

          {connected && filteredMessages.length === 0 && !historyLoading && (
            <div className="empty-state min-h-[320px]">
              <div className="empty-state__icon">
                <MessageCircle size={28} />
              </div>
              <h2>Nenhuma mensagem</h2>
              <p>
                {searchTerm
                  ? "Tente outro termo de busca."
                  : "Comece a conversa por aqui."}
              </p>
            </div>
          )}

          <div className="grid gap-3">
            {filteredMessages.map((message, messageIndex) => {
              const isOwn = message.sender_id === user?.id;
              const isFile = isAttachmentMessage(message);
              const isSticker = message.message_type === "sticker";
              const receiptStatus = isOwn && !message.group_id
                ? messageReceiptStatus(message)
                : "";
              const showDateDivider = messageIndex === 0 ||
                messageDateKey(filteredMessages[messageIndex - 1]?.timestamp) !== messageDateKey(message.timestamp);

              return (
                <React.Fragment key={message.id}>
                  {showDateDivider && (
                    <div className="chat-date-divider"><span>{messageDateLabel(message.timestamp)}</span></div>
                  )}
                <div
                  id={"chat-message-" + message.id}
                  className={`flex ${isOwn ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`chat-message message-card max-w-[min(680px,82%)] p-3 ${
                      isSticker
                        ? "chat-message--sticker"
                        : isOwn
                          ? "chat-message--own border-teal-200 bg-teal-50 text-slate-950"
                          : "chat-message--other bg-white text-slate-900"
                    }`}
                    onDoubleClick={() => setReplyingTo(message)}
                    title="Clique duas vezes para responder"
                  >
                    {!isOwn && !selectedUser && (
                      <p className="m-0 mb-1 text-xs font-extrabold opacity-70">
                        {message.sender_name}
                      </p>
                    )}

                    {message.reply_to && (
                      <button
                        className="chat-message__reply-preview"
                        type="button"
                        onClick={() =>
                          document
                            .getElementById(
                              "chat-message-" + message.reply_to.id,
                            )
                            ?.scrollIntoView({
                              behavior: "smooth",
                              block: "center",
                            })
                        }
                      >
                        <strong>{message.reply_to.sender_name}</strong>
                        <span>
                          {message.reply_to.message_type === "file"
                            ? "Arquivo: " + normalizeDisplayText(message.reply_to.content)
                            : message.reply_to.message_type === "sticker"
                              ? "Figurinha"
                              : normalizeDisplayText(message.reply_to.content)}
                        </span>
                      </button>
                    )}

                    {isSticker ? (
                      <StickerMessage
                        message={message}
                        time={formatTime(message.timestamp)}
                        receiptStatus={receiptStatus}
                        favorite={favoriteStickerReferences.includes(stickerSourceReference(message))}
                        favoriteLoading={favoritingStickerIds.includes(String(message.id))}
                        onFavorite={() => handleFavoriteSticker(message)}
                      />
                    ) : isFile ? (
                      <AttachmentPreview message={message} isOwn={isOwn} />
                    ) : (
                      <ExpandableMessageText
                        value={
                          selectedUser && isAssistantContact(selectedUser)
                            ? polishAssistantReply(message.content)
                            : normalizeDisplayText(message.content)
                        }
                      />
                    )}

                    <div className="chat-message__footer mt-2 flex items-center gap-2 text-[11px] text-slate-500">
                      {!isSticker && <span className="chat-message__time-corner">{formatTime(message.timestamp)}</span>}
                      {message.is_edited && (
                        <button
                          className="chat-message__edited-label"
                          type="button"
                          title="Ver histórico de edições"
                          onClick={() => setEditHistoryMessage(message)}
                        >
                          Mensagem editada <Pencil size={11} />
                        </button>
                      )}
                      {Number.isInteger(Number(message.id)) && (
                        <>
                          <button
                            className="chat-message__action"
                            type="button"
                            title="Responder"
                            aria-label="Responder"
                            onClick={() => setReplyingTo(message)}
                          >
                            <Reply size={14} />
                          </button>
                          {canEditChatMessage(message) && (
                            <button
                              className="chat-message__action"
                              type="button"
                              title={`Editar mensagem (${Number(message.edit_count || 0)}/2)`}
                              aria-label="Editar mensagem"
                              onClick={() => openMessageEditor(message)}
                            >
                              <Pencil size={14} />
                            </button>
                          )}
                          <button
                            className="chat-message__action"
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
                          <button
                            className="chat-message__action chat-message__action--ai"
                            type="button"
                            title="Criar ação com IA"
                            aria-label="Criar ticket, task ou agenda a partir desta mensagem"
                            onClick={() => setAssistantActionMessage(message)}
                          >
                            <Bot size={14} />
                          </button>
                        </>
                      )}
                      {!isSticker && receiptStatus && (
                        <span className={`chat-message__receipt chat-message__receipt--${receiptStatus}`} title={receiptStatus === "read" ? "Visualizada" : receiptStatus === "delivered" ? "Entregue" : "Enviando"} aria-label={receiptStatus === "read" ? "Mensagem visualizada" : receiptStatus === "delivered" ? "Mensagem entregue" : "Mensagem enviada, aguardando entrega"}>
                          <span className="chat-message__receipt-glyph" aria-hidden="true">
                            {receiptStatus === "read" ? <Eye size={14} /> : receiptStatus === "sent" ? <Clock3 size={12} /> : "✓"}
                          </span>
                        </span>
                      )}
                      {isAdmin() && Number.isInteger(Number(message.id)) && (
                        <button
                          className="chat-message__delete"
                          type="button"
                          title="Excluir mensagem"
                          disabled={deletingMessageIds.includes(
                            String(message.id),
                          )}
                          onClick={() => handleDeleteMessage(message.id)}
                        >
                          {deletingMessageIds.includes(String(message.id)) ? (
                            <Loader2 className="animate-spin" size={13} />
                          ) : (
                            <Trash2 size={13} />
                          )}
                        </button>
                      )}
                    </div>
                    {isOwn && message.group_id && (
                      <span className="chat-message__group-readers" title={(message.readers || []).length ? `Visualizada por: ${(message.readers || []).map((reader) => reader.name || reader.full_name).join(", ")}` : "Ainda não visualizada por outros participantes"}>
                        <Eye size={15} />
                      </span>
                    )}                    {(message.reactions || []).length > 0 && (
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
                              handleReaction(message.id, reaction.emoji)
                            }
                          >
                            <span>{reaction.emoji}</span>
                            <strong>{reaction.count}</strong>
                          </button>
                        ))}
                      </div>
                    )}
                    {reactionMessageId === message.id && (
                      <div className="chat-reaction-picker">
                        <div className="emoji-picker__tabs">
                          {emojiGroups.map((group) => (
                            <button
                              key={group.label}
                              className={
                                emojiCategory === group.label ? "active" : ""
                              }
                              type="button"
                              onClick={() => setEmojiCategory(group.label)}
                            >
                              {group.label}
                            </button>
                          ))}
                        </div>
                        <div className="emoji-picker__grid">
                          {selectedEmojiGroup.emojis.map((emoji) => (
                            <button
                              className="emoji-button"
                              key={emoji}
                              type="button"
                              onClick={() => handleReaction(message.id, emoji)}
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                </React.Fragment>
              );
            })}
          </div>

          {assistantResponding && selectedUser && isAssistantContact(selectedUser) && (
            <p className="chat-typing-indicator mt-3 text-sm font-semibold text-slate-500">
              <span /><span /><span />
              {displayContactName(selectedUser)} esta preparando a resposta...
            </p>
          )}

          {typingUser && (
            <p className="chat-typing-indicator mt-3 text-sm font-semibold text-slate-500">
              <span />
              <span />
              <span />
              {displayContactName(typingUser)} esta digitando...
            </p>
          )}

          <div ref={messagesEndRef} />
        </div>

        {showScrollToBottom && <button type="button" className="chat-scroll-to-bottom" onClick={scrollToLastMessage} title="Rolar até a última mensagem"><ArrowDown size={18}/><span>Nova mensagem</span></button>}

        <footer className="chat-composer border-t border-slate-200 bg-white p-4">
          {replyingTo && (
            <div className="chat-composer__replying">
              <Reply size={17} />
              <div>
                <strong>
                  Respondendo a {replyingTo.sender_name || "mensagem"}
                </strong>
                <span>
                  {replyingTo.message_type === "file"
                    ? "Arquivo: " + replyingTo.content
                    : replyingTo.message_type === "sticker"
                      ? "Figurinha"
                      : replyingTo.content}
                </span>
              </div>
              <button
                className="icon-button icon-button--light"
                type="button"
                onClick={() => setReplyingTo(null)}
                aria-label="Cancelar resposta"
              >
                <X size={15} />
              </button>
            </div>
          )}
          {showStickerPicker && (
            <StickerPicker
              companyId={activeChatCompanyId}
              onSend={handleSendSticker}
              onClose={() => setShowStickerPicker(false)}
            />
          )}
          {showEmojiPicker && (
            <div className="emoji-picker mb-3">
              <div
                className="emoji-picker__tabs"
                role="tablist"
                aria-label="Categorias de emoji"
              >
                {emojiGroups.map((group) => (
                  <button
                    key={group.label}
                    className={emojiCategory === group.label ? "active" : ""}
                    type="button"
                    onClick={() => setEmojiCategory(group.label)}
                  >
                    {group.label}
                  </button>
                ))}
              </div>
              <div className="emoji-picker__grid">
                {selectedEmojiGroup.emojis.map((emoji) => (
                  <button
                    key={emoji}
                    className="emoji-button"
                    type="button"
                    onClick={() => setComposerValue(`${composerValueRef.current}${emoji}`, { immediate: true })}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          )}

          {selectedAssistantPlan?.requires_confirmation && selectedUser && isAssistantContact(selectedUser) && (
            <div className="chat-assistant-confirmation mb-3">
              <BoltConfirmation
                result={selectedAssistantPlan}
                urgency={selectedAssistantUrgency}
                setUrgency={(value) => setAssistantChatUrgencies((current) => ({
                  ...current,
                  [selectedAssistantId]: value,
                }))}
                onConfirm={confirmSelectedAssistantPlan}
                onCancel={cancelSelectedAssistantPlan}
                loading={assistantResponding || isUploading}
              />
              {selectedAssistantPlan.intent === "ticket" && (
                <p className="m-0 mt-2 text-xs font-semibold text-slate-500">
                  {pendingAttachment
                    ? `Anexo fixo preparado: ${pendingAttachment.name}. Ele será salvo após a confirmação.`
                    : "Você pode anexar um arquivo fixo antes de confirmar o ticket."}
                </p>
              )}
            </div>
          )}

          {pendingAttachment && (
            <div className="chat-composer__attachment-preview mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  {pendingAttachmentPreviewUrl ? (
                    <img
                      className="h-14 w-14 rounded-md object-cover"
                      src={pendingAttachmentPreviewUrl}
                      alt={pendingAttachment.name}
                    />
                  ) : (
                    <span className="inline-flex h-14 w-14 items-center justify-center rounded-md bg-slate-200 text-slate-600">
                      <FileText size={20} />
                    </span>
                  )}
                  <div>
                    <p className="m-0 font-semibold text-slate-900">
                      {pendingAttachment.name}
                    </p>
                    <p className="m-0 text-sm text-slate-500">
                      {formatFileSize(pendingAttachment.size)}
                    </p>
                    {pendingExtraAttachments.length > 0 && (
                      <p className="m-0 text-xs font-semibold text-slate-500">+ {pendingExtraAttachments.length} arquivo(s) selecionado(s)</p>
                    )}
                  </div>
                </div>
                <button
                  className="button-secondary"
                  type="button"
                  onClick={handleCancelPendingAttachment}
                >
                  <X size={16} /> Remover anexo
                </button>
              </div>
            </div>
          )}

          {selectedGroup && mentionRange && (
            <div className="chat-mention-picker" role="listbox" aria-label="Mencionar participante do grupo">
              <div className="chat-mention-picker__header">
                <strong>Mencionar no grupo</strong>
                <span>Digite @ novamente para marcar mais pessoas</span>
              </div>
              {mentionCandidates.length ? (
                <div className="chat-mention-picker__list">
                  {mentionCandidates.map((contact, index) => (
                    <button
                      className={`chat-mention-picker__item ${index === mentionActiveIndex ? "is-active" : ""}`}
                      key={contact.id}
                      type="button"
                      role="option"
                      aria-selected={index === mentionActiveIndex}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertMention(contact)}
                    >
                      <span className="chat-mention-picker__avatar">
                        {displayContactName(contact).slice(0, 1).toUpperCase()}
                      </span>
                      <span className="chat-mention-picker__person">
                        <strong>{displayContactName(contact)}</strong>
                        <small>@{mentionTokenForContact(contact)}</small>
                      </span>
                      {contact.department && <span className="chat-mention-picker__department">{contact.department}</span>}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="chat-mention-picker__empty">Nenhum participante encontrado.</p>
              )}
            </div>
          )}

          <form
            className={`chat-composer__form flex items-center gap-2 ${composerDropActive ? "chat-composer__form--dragging" : ""}`}
            onSubmit={handleSubmit}
            onDragOver={(event) => { event.preventDefault(); setComposerDropActive(true); }}
            onDragLeave={() => setComposerDropActive(false)}
            onDrop={handleComposerDrop}
          >
            <button
              className="icon-button icon-button--light"
              type="button"
              onClick={() => {
                setShowEmojiPicker((value) => !value);
                setShowStickerPicker(false);
              }}
              title="Emojis"
              aria-label="Emojis"
            >
              <SmilePlus size={18} />
            </button>

            <button
              className="icon-button icon-button--light"
              type="button"
              onClick={() => {
                setShowStickerPicker((value) => !value);
                setShowEmojiPicker(false);
              }}
              title="Figurinhas"
              aria-label="Figurinhas"
            >
              <Sticker size={18} />
            </button>

            <input
              ref={fileInputRef}
              accept={ACCEPTED_UPLOAD_TYPES}
              className="hidden"
              type="file"
              multiple
              onChange={handleFileUpload}
            />
            <button
              className="icon-button icon-button--light"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!connected || isUploading}
              title="Anexar arquivo"
              aria-label="Anexar arquivo"
            >
              {isUploading ? (
                <span className="spinner h-4 w-4" />
              ) : (
                <Paperclip size={18} />
              )}
            </button>

            <AudioRecorderButton
              disabled={!connected}
              uploading={isUploading}
              onRecorded={handleRecordedAudio}
            />

            <textarea
              ref={composerRef}
              className="textarea min-h-[44px] min-w-0 flex-1 resize-none py-2"
              defaultValue=""
              onChange={handleTyping}
              onKeyDown={handleMessageKeyDown}
              onPaste={handleComposerPaste}
              disabled={!connected || assistantResponding}
              rows={1}
              placeholder={
                selectedGroup
                  ? `Mensagem para ${selectedGroup.name} · use @ para mencionar`
                  : selectedUser
                    ? `Mensagem para ${displayContactName(selectedUser)}`
                    : "Escreva uma mensagem"
              }
            />

            <button
              className="button-primary"
              type="submit"
              disabled={
                !connected ||
                assistantResponding ||
                isUploading
              }
            >
              <Send size={17} />
              Enviar
            </button>
          </form>
          <div className="chat-composer__limits">
            <span>Até {INLINE_MESSAGE_MAX_LENGTH} caracteres no balão.</span>
            {selectedGroup && <span>Use @ para mencionar participantes.</span>}
            {composerExceedsInlineLimit && (
              <strong>Esta mensagem será convertida automaticamente em arquivo TXT ao enviar.</strong>
            )}
          </div>
        </footer>
      </section>

      {editingMessage && (
        <div className="profile-modal" role="presentation" onMouseDown={() => !editingMessageSaving && setEditingMessage(null)}>
          <section className="profile-modal__panel chat-edit-modal" role="dialog" aria-modal="true" aria-label="Editar mensagem" onMouseDown={(event) => event.stopPropagation()}>
            <header className="profile-modal__header">
              <div><span>Chat</span><h2>Editar mensagem</h2></div>
              <button className="icon-button icon-button--light" type="button" disabled={editingMessageSaving} onClick={() => setEditingMessage(null)}><X size={18} /></button>
            </header>
            <form className="profile-modal__form" onSubmit={submitMessageEdit}>
              <label>
                Mensagem
                <textarea className="input min-h-32 resize-y" maxLength={INLINE_MESSAGE_MAX_LENGTH} value={editingMessageValue} onChange={(event) => setEditingMessageValue(event.target.value)} autoFocus />
              </label>
              <div className="chat-edit-modal__meta">
                <span>{editingMessageValue.trim().length}/{INLINE_MESSAGE_MAX_LENGTH} caracteres</span>
                <span>{Number(editingMessage.edit_count || 0)}/2 edições utilizadas</span>
              </div>
              <p className="m-0 text-xs leading-5 text-slate-500">A edição é permitida somente até 30 minutos após o envio. As versões anteriores continuarão visíveis no histórico.</p>
              <div className="flex justify-end gap-2">
                <button className="button-secondary" type="button" disabled={editingMessageSaving} onClick={() => setEditingMessage(null)}>Cancelar</button>
                <button className="button-primary" type="submit" disabled={editingMessageSaving || !editingMessageValue.trim()}>
                  {editingMessageSaving ? <Loader2 className="animate-spin" size={16} /> : <Pencil size={16} />} Salvar edição
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {editHistoryMessage && (
        <div className="profile-modal" role="presentation" onMouseDown={() => setEditHistoryMessage(null)}>
          <section className="profile-modal__panel chat-edit-history" role="dialog" aria-modal="true" aria-label="Histórico de edições" onMouseDown={(event) => event.stopPropagation()}>
            <header className="profile-modal__header">
              <div><span>Chat</span><h2>Histórico de edições</h2></div>
              <button className="icon-button icon-button--light" type="button" onClick={() => setEditHistoryMessage(null)}><X size={18} /></button>
            </header>
            <div className="profile-modal__form">
              {(editHistoryMessage.edit_history || []).map((edit, index) => (
                <article className="chat-edit-history__version" key={edit.id || `${edit.edited_at}-${index}`}>
                  <div><strong>Versão {index + 1}</strong><span>{edit.edited_at ? new Date(edit.edited_at).toLocaleString("pt-BR") : ""}</span></div>
                  <p>{normalizeDisplayText(edit.previous_content)}</p>
                </article>
              ))}
              <article className="chat-edit-history__version chat-edit-history__version--current">
                <div><strong>Versão atual</strong><span>{editHistoryMessage.edited_at ? new Date(editHistoryMessage.edited_at).toLocaleString("pt-BR") : ""}</span></div>
                <p>{normalizeDisplayText(editHistoryMessage.content)}</p>
              </article>
            </div>
          </section>
        </div>
      )}

      {groupDetailsOpen && selectedGroup && (
        <div className="profile-modal" role="presentation" onMouseDown={() => setGroupDetailsOpen(false)}>
          <section className="profile-modal__panel" role="dialog" aria-modal="true" aria-label={`Participantes de ${selectedGroup.name}`} onMouseDown={(event) => event.stopPropagation()}>
            <header className="profile-modal__header">
              <div><span>Grupo</span><h2>{selectedGroup.name}</h2></div>
              <button className="icon-button icon-button--light" type="button" onClick={() => setGroupDetailsOpen(false)} aria-label="Fechar"><X size={18} /></button>
            </header>
            <div className="profile-modal__form">
              {selectedGroup.description && <p className="m-0 text-sm text-slate-600">{selectedGroup.description}</p>}
              <div className="flex items-center justify-between">
                <strong>{selectedGroup.members?.length || 0} participantes</strong>
                <span className="badge">{selectedGroupOnlineCount} online</span>
              </div>
              <div className="max-h-80 space-y-2 overflow-y-auto">
                {(selectedGroup.members || []).map((member) => {
                  const memberPresence = Number(member.id) === Number(user?.id)
                    ? { label: "Você", dotClass: "status-dot--online" }
                    : presenceMeta(member, onlineUsers);
                  return (
                    <article className="flex items-center gap-3 rounded-xl border border-slate-200 p-3" key={member.id}>
                      <div className="relative h-11 w-11 shrink-0">
                        {contactProfilePhoto(member)
                          ? <img className="h-11 w-11 rounded-full object-cover" src={contactProfilePhoto(member)} alt="" />
                          : <span className="grid h-11 w-11 place-items-center rounded-full bg-slate-100 font-extrabold text-slate-700">{displayContactName(member).charAt(0).toUpperCase()}</span>}
                        <span className={`absolute bottom-0 right-0 status-dot ${memberPresence.dotClass}`} title={memberPresence.label} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <strong className="block truncate">{displayContactName(member)}</strong>
                        {fullNameCaption(member) && <small className="block truncate text-slate-500">{fullNameCaption(member)}</small>}
                        <small className="block truncate text-slate-500">{member.department || "Sem setor"} · {memberPresence.label}</small>
                      </div>
                    </article>
                  );
                })}
              </div>
              {canCreateChatGroup && (
                <div className="flex flex-wrap justify-end gap-2">
                  <button className="button-danger" type="button" onClick={() => handleDeleteGroup(selectedGroup)}><Trash2 size={17} /> Excluir grupo</button>
                  <button className="button-primary" type="button" onClick={() => { setGroupDetailsOpen(false); openGroupEditor(selectedGroup); }}><Settings size={17} /> Editar grupo</button>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {showGroupCreator && (
        <div className="profile-modal" role="presentation" onMouseDown={() => setShowGroupCreator(false)}>
          <section className="profile-modal__panel" role="dialog" aria-modal="true" aria-label="Novo grupo" onMouseDown={(event) => event.stopPropagation()}>
            <header className="profile-modal__header"><div><span>Chat</span><h2>{editingGroup ? "Editar grupo" : "Novo grupo"}</h2></div><button className="icon-button icon-button--light" type="button" onClick={() => setShowGroupCreator(false)}><X size={18} /></button></header>
            <form className="profile-modal__form" onSubmit={handleCreateChatGroup}>
              <label>Imagem do grupo<input className="input" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleGroupImage} /></label>
              {groupImageData && <img className="h-16 w-16 rounded-lg object-cover" src={groupImageData} alt="Prévia do grupo" />}
              <label>Nome<input className="input" value={groupName} onChange={(event) => setGroupName(event.target.value)} required maxLength={120} /></label>
              <label>Descrição<textarea className="textarea" value={groupDescription} onChange={(event) => setGroupDescription(event.target.value)} maxLength={500} /></label>
              <label>Buscar usuários por nome ou setor<input className="input" value={groupSearch} onChange={(event) => setGroupSearch(event.target.value)} placeholder="Nome, apelido ou setor" /></label>
              <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 p-2">
                {visibleGroupContacts.map((contact) => { const selected = groupMemberIds.includes(contact.id); return <button className={`mb-1 flex w-full items-center justify-between rounded-md p-2 text-left ${selected ? "bg-teal-50" : "hover:bg-slate-50"}`} key={contact.id} type="button" onClick={() => setGroupMemberIds((ids) => selected ? ids.filter((id) => id !== contact.id) : [...ids, contact.id])}><span><strong>{displayContactName(contact)}</strong><small className="ml-2 text-slate-500">{contact.department || "Sem setor"}</small></span><span>{selected ? "✓" : "+"}</span></button>; })}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                {editingGroup && canCreateChatGroup && (
                  <button className="button-danger" type="button" onClick={() => handleDeleteGroup(editingGroup)}><Trash2 size={17} /> Excluir grupo</button>
                )}
                <button className="button-primary" type="submit"><Plus size={17} /> {editingGroup ? "Salvar alterações" : "Criar grupo"}</button>
              </div>
            </form>
          </section>
        </div>
      )}
      {assistantActionMessage && (
        <MessageAssistantAction
          message={assistantActionMessage}
          onClose={() => setAssistantActionMessage(null)}
        />
      )}
      {filesHistoryOpen && (
        <aside
          className="chat-files-history"
          aria-label="Histórico de arquivos compartilhados"
        >
          <div className="chat-files-history__header">
            <div>
              <h3>Arquivos compartilhados</h3>
              <p>
                {selectedUser
                  ? `Conversa com ${displayContactName(selectedUser)}`
                  : selectedGroup?.name || "Conversa"}{" "}
                · disponíveis por 15 dias
              </p>
            </div>
            <button
              className="icon-button icon-button--light"
              type="button"
              onClick={() => setFilesHistoryOpen(false)}
              aria-label="Fechar histórico"
            >
              <X size={18} />
            </button>
          </div>
          <div className="chat-files-history__list">
            {loadingConversationFiles ? (
              <div className="ticket-thread__empty">
                <span className="spinner h-5 w-5" /> Carregando arquivos
              </div>
            ) : conversationFiles.length === 0 ? (
              <div className="ticket-thread__empty">
                Nenhum arquivo compartilhado nesta conversa nos últimos 15
                dias.
              </div>
            ) : (
              conversationFiles.map((file) => {
                const Icon = getAttachmentIcon(getFileExtension(file.filename));
                return (
                  <article className="chat-files-history__item" key={file.id}>
                    <Icon size={19} />
                    <div>
                      <strong>{file.filename}</strong>
                      <small>
                        {formatFileSize(file.file_size)} •{" "}
                        {file.uploaded_by_name || "Usuário"} •{" "}
                        {file.shared_at ? formatTime(file.shared_at) : ""}
                      </small>
                    </div>
                    <button
                      className="icon-button icon-button--light"
                      type="button"
                      title="Baixar arquivo"
                      onClick={() => handleConversationFileDownload(file)}
                    >
                      <Download size={17} />
                    </button>
                  </article>
                );
              })
            )}
          </div>
        </aside>
      )}
    </div>
  );
};

export default Chat;
