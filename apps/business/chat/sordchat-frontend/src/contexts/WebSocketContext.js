import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { useAuth } from "./AuthContext";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import { API_BASE_URL, WS_BASE_URL } from "../config";
import {
  applyLocalChatHistoryReset,
  clearLocalChatHistory,
  loadLocalChatHistory,
  removeLocalChatMessage,
  saveLocalChatHistory,
} from "../utils/chatHistoryCache";
import { normalizeDisplayText } from "../utils/assistantText";

const WebSocketContext = createContext();

const DESKTOP_ARCHIVE_FLUSH_MS = 15_000;

const getWebSocketClientId = () => {
  const storageKey = "voltchat:websocket-client-id";
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const generated =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `client-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    window.sessionStorage.setItem(storageKey, generated);
    return generated;
  } catch (_error) {
    return `client-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }
};

const isJwtExpired = (token) => {
  try {
    const encodedPayload = token.split(".")[1];
    if (!encodedPayload) return true;
    const normalizedPayload = encodedPayload
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(encodedPayload.length / 4) * 4, "=");
    const payload = JSON.parse(window.atob(normalizedPayload));
    return Number(payload.exp || 0) * 1000 <= Date.now();
  } catch (_error) {
    return true;
  }
};

const showSystemMessageNotification = (message) => {
  const senderName = String(message.sender_name || "VoltChat").trim() || "VoltChat";
  const isGroupMessage = Boolean(message.group_id);
  const groupName = String(message.group_name || "Grupo").trim() || "Grupo";
  const messageBody =
    message.message_type === "file"
      ? `Arquivo: ${message.content}`
      : message.message_type === "sticker"
        ? `Figurinha: ${message.content || "Figurinha"}`
        : String(message.content || "");
  const payload = {
    title: isGroupMessage
      ? `Nova mensagem no grupo ${groupName}`
      : `Nova mensagem de ${senderName}`,
    body: isGroupMessage
      ? `${senderName.toLocaleUpperCase("pt-BR")}: ${messageBody}`
      : messageBody,
    icon: message.sender_profile_photo || undefined,
    senderId: message.sender_id,
    groupId: message.group_id || null,
    messageId: message.id,
  };
  if (window.voltChatDesktop?.showNotification) {
    window.voltChatDesktop.showNotification(payload).catch(() => {});
    return;
  }
  if (
    document.hidden &&
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    const notification = new Notification(payload.title, {
      body: payload.body,
      icon:
        payload.icon ||
        `${process.env.PUBLIC_URL || ""}/brand/voltchat-favicon.png`,
      tag: `voltchat-message-${message.id}`,
    });
    notification.onclick = () => window.focus();
  }
};

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error(
      "useWebSocket deve ser usado dentro de um WebSocketProvider",
    );
  }
  return context;
};

export const WebSocketProvider = ({ children }) => {
  const { isAuthenticated, user, expireSession } = useAuth();
  const navigate = useNavigate();

  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [typingUsers, setTypingUsers] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadByConversation, setUnreadByConversation] = useState({});
  const [voiceSignal, setVoiceSignal] = useState(null);

  const socketRef = useRef(null);
  const connectedRef = useRef(false);
  const pingIntervalRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const desiredPresenceRef = useRef("online");
  const idlePresenceRef = useRef(false);
  const voiceCallControllerRef = useRef(null);
  const hasOpenedConnectionRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectNoticeRef = useRef(false);
  const manualDisconnectRef = useRef(false);
  const lastPongAtRef = useRef(0);
  const connectionGenerationRef = useRef(0);
  const connectInProgressRef = useRef(false);
  const connectRef = useRef(null);
  const handleWebSocketMessageRef = useRef(null);
  const authStateRef = useRef({ isAuthenticated: false, userId: null });
  const expireSessionRef = useRef(expireSession);
  const desktopArchiveQueueRef = useRef(new Map());
  const desktopArchiveTimerRef = useRef(null);
  const desktopArchiveInFlightRef = useRef(false);
  const desktopArchiveFlushRef = useRef(null);

  const flushDesktopArchive = useCallback(async () => {
    desktopArchiveTimerRef.current = null;
    if (desktopArchiveInFlightRef.current) return;
    const desktop = window.voltChatDesktop;
    const userId = user?.id;
    if (!desktop?.archiveChatHistory || !userId) return;

    const pending = [...desktopArchiveQueueRef.current.values()];
    if (!pending.length) return;
    desktopArchiveQueueRef.current.clear();
    desktopArchiveInFlightRef.current = true;
    try {
      await desktop.archiveChatHistory({ userId, messages: pending });
    } catch (error) {
      // Keep the delta queued for the next safe flush instead of losing it.
      pending.forEach((message) => {
        const key = `${message.company_id}:${message.id}:${message.timestamp || message.created_at || ""}`;
        desktopArchiveQueueRef.current.set(key, message);
      });
      console.error("Falha ao atualizar o cofre local do chat:", error);
    } finally {
      desktopArchiveInFlightRef.current = false;
      if (desktopArchiveQueueRef.current.size && !desktopArchiveTimerRef.current) {
        desktopArchiveTimerRef.current = window.setTimeout(
          () => void desktopArchiveFlushRef.current?.(),
          DESKTOP_ARCHIVE_FLUSH_MS,
        );
      }
    }
  }, [user?.id]);

  desktopArchiveFlushRef.current = flushDesktopArchive;

  const queueDesktopArchiveMessages = useCallback((items) => {
    if (!window.voltChatDesktop?.archiveChatHistory || !user?.id || !Array.isArray(items)) return;
    for (const message of items) {
      if (!message?.id || !message.company_id || message.pending) continue;
      const key = `${message.company_id}:${message.id}:${message.timestamp || message.created_at || ""}`;
      desktopArchiveQueueRef.current.set(key, message);
    }
    if (!desktopArchiveQueueRef.current.size || desktopArchiveTimerRef.current) return;
    desktopArchiveTimerRef.current = window.setTimeout(
      () => void desktopArchiveFlushRef.current?.(),
      DESKTOP_ARCHIVE_FLUSH_MS,
    );
  }, [user?.id]);

  useEffect(() => () => {
    if (desktopArchiveTimerRef.current) window.clearTimeout(desktopArchiveTimerRef.current);
    desktopArchiveTimerRef.current = null;
    desktopArchiveQueueRef.current.clear();
  }, [user?.id]);
  authStateRef.current = {
    isAuthenticated: Boolean(isAuthenticated),
    userId: user?.id || null,
  };
  expireSessionRef.current = expireSession;

  const removeMessageImmediately = useCallback(
    (messageId) => {
      setMessages((current) =>
        current.filter((message) => String(message.id) !== String(messageId)),
      );
      removeLocalChatMessage(user?.id, messageId);
    },
    [user?.id],
  );

  const restoreMessageImmediately = useCallback((message) => {
    if (!message) return;
    setMessages((current) => {
      if (current.some((item) => String(item.id) === String(message.id))) return current;
      return [...current, message].sort(
        (left, right) => new Date(left.timestamp) - new Date(right.timestamp),
      );
    });
    queueDesktopArchiveMessages([message]);
  }, [queueDesktopArchiveMessages]);
  const clearConversationImmediately = useCallback(
    (receiverId = null) => {
      setMessages((current) =>
        current.filter((message) => {
          if (receiverId) {
            return !(
              (String(message.sender_id) === String(user?.id) &&
                String(message.receiver_id) === String(receiverId)) ||
              (String(message.sender_id) === String(receiverId) &&
                String(message.receiver_id) === String(user?.id))
            );
          }
          return (
            message.receiver_id !== null && message.receiver_id !== undefined
          );
        }),
      );
      clearLocalChatHistory(user?.id, receiverId);
    },
    [user?.id],
  );

  // Processar mensagens do WebSocket
  const handleWebSocketMessage = useCallback(
    (data) => {
      switch (data.type) {
        case "connection":
          break;

        case "message_history":
          queueDesktopArchiveMessages(data.messages);
          applyLocalChatHistoryReset(user?.id, data.company_id, data.history_cleared_at).then(
            (historyWasReset) => {
              setMessages((prev) => {
                const baseMessages = historyWasReset ? [] : prev;
                const byId = new Map(
                  baseMessages.map((message) => [String(message.id), message]),
                );
                data.messages.forEach((message) =>
                  byId.set(String(message.id), message),
                );
                return [...byId.values()].sort(
                  (left, right) =>
                    new Date(left.timestamp) - new Date(right.timestamp),
                );
              });
            },
          );
          break;

        case "new_message":
          queueDesktopArchiveMessages([data.message]);
          setMessages((prev) => {
            if (data.message.client_id) {
              const optimisticIndex = prev.findIndex(
                (msg) => msg.client_id === data.message.client_id,
              );
              if (optimisticIndex >= 0) {
                return prev.map((msg, index) =>
                  index === optimisticIndex
                    ? { ...data.message, pending: false }
                    : msg,
                );
              }
            }

            if (prev.some((msg) => msg.id === data.message.id)) {
              return prev;
            }

            return [...prev, data.message];
          });

          if (
            data.message.group_id &&
            Array.isArray(data.message.mention_user_ids) &&
            data.message.mention_user_ids.some((id) => Number(id) === Number(user?.id)) &&
            Number(data.message.sender_id) !== Number(user?.id)
          ) {
            window.dispatchEvent(new CustomEvent("voltchat:group-mention-changed", {
              detail: { groupId: Number(data.message.group_id), delta: 1 },
            }));
          }

          // Incrementar contador de não lidas se não for do usuário atual
          if (data.message.sender_id !== user?.id) {
            try {
              const mutedIds =
                JSON.parse(
                  localStorage.getItem(`voltchat:muted:${user?.id}`),
                ) || [];
              const conversationKey = data.message.group_id
                ? `group:${data.message.group_id}`
                : data.message.receiver_id
                  ? String(data.message.sender_id)
                  : "general";
              if (mutedIds.includes(conversationKey)) break;
            } catch {
              // Preferencias invalidas nao devem interromper o recebimento.
            }
            const conversationKey = data.message.group_id
              ? `group:${data.message.group_id}`
              : data.message.receiver_id
                ? String(data.message.sender_id)
                : "general";
            setUnreadCount((prev) => prev + 1);
            setUnreadByConversation((prev) => ({
              ...prev,
              [conversationKey]: (prev[conversationKey] || 0) + 1,
            }));

            // Notificação
            toast.success(`Nova mensagem de ${data.message.sender_name}`);
            showSystemMessageNotification(data.message);
          }
          break;

        case "message_updated": {
          setMessages((prev) => prev.map((message) =>
            String(message.id) === String(data.message?.id) ? data.message : message
          ));
          queueDesktopArchiveMessages([data.message]);
          if (data.message?.group_id) {
            const newlyMentioned = (data.newly_mentioned_user_ids || []).some((id) => Number(id) === Number(user?.id));
            const removedMention = (data.removed_mention_user_ids || []).some((id) => Number(id) === Number(user?.id));
            const delta = newlyMentioned ? 1 : removedMention ? -1 : 0;
            if (delta) {
              window.dispatchEvent(new CustomEvent("voltchat:group-mention-changed", {
                detail: { groupId: Number(data.message.group_id), delta },
              }));
            }
          }
          break;
        }

        case "company_settings_updated":
          window.dispatchEvent(new CustomEvent("voltchat:company-settings-updated", {
            detail: {
              companyId: data.company_id,
              allowUserMessageEditing: data.allow_user_message_editing,
              allowUserStickerCreation: data.allow_user_sticker_creation,
            },
          }));
          break;

        case "message_read": {
          const readIds = new Set((data.message_ids || []).map(String));
          setMessages((prev) => prev.map((message) =>
            readIds.has(String(message.id)) ? { ...message, is_read: true } : message
          ));
          break;
        }

        case "group_messages_read":
          setMessages((prev) =>
            prev.map((message) => {
              if (!data.message_ids?.includes(message.id)) return message;
              const readers = message.readers || [];
              return readers.some((reader) => reader.id === data.reader?.id)
                ? message
                : { ...message, readers: [...readers, data.reader] };
            }),
          );
          break;

        case "group_upsert":
          window.dispatchEvent(
            new CustomEvent("voltchat:group-upsert", { detail: data.group }),
          );
          break;

        case "group_removed":
          window.dispatchEvent(
            new CustomEvent("voltchat:group-removed", {
              detail: { groupId: data.group_id },
            }),
          );
          break;

        case "chat_settings_updated":
          window.dispatchEvent(
            new CustomEvent("voltchat:chat-settings-updated", {
              detail: {
                companyId: data.company_id,
                generalChatName: data.general_chat_name,
              },
            }),
          );
          break;
        case "history_restored":
          toast.success(`${data.restored || 0} mensagens restauradas pelo Admin Master.`);
          if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ type: "get_history" }));
          }
          break;

        case "message_deleted":
          removeMessageImmediately(data.message_id);
          break;

        case "history_cleared":
          clearConversationImmediately(data.receiver_id);
          break;
        case "company_history_cleared":
          applyLocalChatHistoryReset(user?.id, data.company_id, data.cleared_at).then(() => {
            setMessages([]);
            toast.success("O histórico desta empresa foi apagado pelo Admin Master.");
          });
          break;

        case "user_status":
          if (data.is_online) {
            setOnlineUsers((prev) => {
              const nextUser = {
                id: data.user_id,
                username: data.username,
                full_name: data.full_name,
                nickname: data.nickname,
                presence_status: data.presence_status || "online",
                is_online: true,
              };
              return prev.some((item) => Number(item.id) === Number(data.user_id))
                ? prev.map((item) => Number(item.id) === Number(data.user_id) ? { ...item, ...nextUser } : item)
                : [...prev, nextUser];
            });
          } else {
            setOnlineUsers((prev) => prev.filter((u) => u.id !== data.user_id));
          }
          break;

        case "online_users":
          setOnlineUsers(data.users.filter((u) => u.id !== user?.id));
          break;

        case "typing": {
          if (data.user_id === user?.id) break;
          const receiverId =
            data.receiver_id == null ? null : Number(data.receiver_id);
          const groupId = data.group_id == null ? null : Number(data.group_id);
          const typingKey = `${data.user_id}:${groupId != null ? `group:${groupId}` : receiverId == null ? "general" : receiverId}`;
          if (data.is_typing) {
            setTypingUsers((prev) => {
              const nextUser = {
                id: data.user_id,
                username: data.username,
                full_name: data.full_name,
                nickname: data.nickname,
                receiver_id: receiverId,
                group_id: groupId,
                key: typingKey,
              };
              const existingIndex = prev.findIndex(
                (item) => item.key === typingKey,
              );
              if (existingIndex < 0) return [...prev, nextUser];
              return prev.map((item, index) =>
                index === existingIndex ? nextUser : item,
              );
            });
          } else {
            setTypingUsers((prev) =>
              prev.filter((item) => item.key !== typingKey),
            );
          }
          break;
        }

        case "attention_request": {
          const sender = data.from_user;
          if (!sender?.id) break;
          const senderName = sender.nickname || sender.full_name || sender.username;
          toast.success(senderName + " chamou sua atencao.", {
            duration: 6000,
            icon: "\u{1F4E3}",
          });
          if (window.voltChatDesktop?.showNotification) {
            window.voltChatDesktop.showNotification({
              title: "Chamaram sua atencao no VoltChat",
              body: senderName + " quer falar com voce.",
              senderId: sender.id,
            }).catch(() => {});
          }
          navigate("/chat", {
            state: {
              startChatUser: sender,
              attentionRequestId: data.request_id || Date.now(),
            },
          });
          window.dispatchEvent(new CustomEvent("voltchat:attention-request", { detail: data }));
          break;
        }

        case "attention_result":
          window.dispatchEvent(new CustomEvent("voltchat:attention-result", { detail: data }));
          if (data.success) toast.success(data.message || "Atencao solicitada.");
          else toast.error(data.message || "Nao foi possivel chamar a atencao.");
          break;
        case "reaction_update":
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === data.message_id
                ? { ...msg, reactions: data.reactions }
                : msg,
            ),
          );

          // Notificação de reação
          if (data.action === "added" && data.user_name !== user?.full_name) {
            toast.success(`${data.user_name} reagiu com ${data.emoji}`);
          }
          break;

        case "voice_signal":
          setVoiceSignal({ ...data, receivedAt: Date.now() });
          break;
        case "meeting_deleted":
          window.dispatchEvent(
            new CustomEvent("voltchat:meeting-deleted", { detail: data }),
          );
          break;
        case "notification": {
          const rawNotification = data.notification;
          if (!rawNotification) {
            break;
          }
          const notification = {
            ...rawNotification,
            title: normalizeDisplayText(rawNotification.title),
            description: normalizeDisplayText(rawNotification.description),
            message: normalizeDisplayText(rawNotification.message),
            body: normalizeDisplayText(rawNotification.body),
          };

          try {
            const stored =
              JSON.parse(localStorage.getItem("voltcorp:notifications")) || [];
            const nextNotifications = [
              notification,
              ...stored.filter((item) => item.id !== notification.id),
            ].slice(0, 100);
            localStorage.setItem(
              "voltcorp:notifications",
              JSON.stringify(nextNotifications),
            );
            window.dispatchEvent(
              new CustomEvent("voltcorp:notifications-updated", {
                detail: nextNotifications,
              }),
            );
          } catch (error) {
            console.error("Erro ao salvar notificacao:", error);
          }
          toast.success(notification.title || "Nova notificacao");
          if (window.voltChatDesktop?.showNotification) {
            window.voltChatDesktop
              .showNotification({
                title: notification.title || "VoltChat",
                body:
                  notification.message ||
                  notification.body ||
                  notification.description ||
                  "",
                icon:
                  notification.icon ||
                  notification.sender_profile_photo ||
                  undefined,
              })
              .catch(() => {});
          }
          break;
        }

        case "force_update_check":
          window.dispatchEvent(new CustomEvent("voltchat:force-update-check", { detail: data }));
          break;

        case "pong":
          lastPongAtRef.current = Date.now();
          break;

        case "error":
          toast.error(data.detail || "Nao foi possivel concluir a acao no chat.", {
            id: "voltchat-websocket-action-error",
          });
          break;

        default:
          console.debug("Mensagem WebSocket nao reconhecida:", data);
      }
    },
    [clearConversationImmediately, navigate, queueDesktopArchiveMessages, removeMessageImmediately, user],
  );

  handleWebSocketMessageRef.current = handleWebSocketMessage;

  // Conectar ao WebSocket. A rotina e deliberadamente estavel e possui uma
  // trava de geracao para impedir sockets/timers antigos de criarem conexoes
  // paralelas depois de um ECONNRESET, deploy ou troca de rede.
  const connect = useCallback(() => {
    const authState = authStateRef.current;
    if (!authState.isAuthenticated || !authState.userId) {
      return;
    }
    // Uma chamada explicita a connect() apos login/rede restaurada reabre o
    // canal. O flag manual continua bloqueando apenas timers antigos.
    manualDisconnectRef.current = false;

    const existingSocket = socketRef.current;
    if (
      existingSocket &&
      (existingSocket.readyState === WebSocket.OPEN ||
        existingSocket.readyState === WebSocket.CONNECTING ||
        existingSocket.readyState === WebSocket.CLOSING)
    ) {
      return;
    }
    if (existingSocket?.readyState === WebSocket.CLOSED) {
      socketRef.current = null;
    }
    if (connectInProgressRef.current) return;

    const token = localStorage.getItem("token");
    if (!token) return;
    if (isJwtExpired(token)) {
      expireSessionRef.current?.();
      toast.error("Sua sessao expirou. Faca login novamente.", {
        id: "voltchat-session-expired",
      });
      return;
    }

    connectInProgressRef.current = true;
    const generation = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = generation;

    const scheduleReconnect = (event = {}) => {
      if (manualDisconnectRef.current || !authStateRef.current.isAuthenticated) return;
      if (reconnectTimeoutRef.current) return;

      const currentToken = localStorage.getItem("token");
      const sessionExpired = !currentToken || isJwtExpired(currentToken);
      if (event.code === 4001 || sessionExpired) {
        expireSessionRef.current?.();
        toast.error("Sua sessao expirou. Faca login novamente.", {
          id: "voltchat-session-expired",
        });
        return;
      }

      const attempt = reconnectAttemptRef.current;
      const baseDelay = Math.min(15000, 1000 * (2 ** Math.min(attempt, 4)));
      const retryDelay = baseDelay + Math.floor(Math.random() * 900);
      reconnectAttemptRef.current = Math.min(attempt + 1, 5);

      if (!reconnectNoticeRef.current) {
        reconnectNoticeRef.current = true;
        const reason = String(event.reason || "").trim();
        toast.error(
          event.code === 1008 && reason
            ? `Chat em tempo real: ${reason}. Tentando reconectar...`
            : "Conexao perdida. Reconectando automaticamente...",
          { id: "voltchat-connection" },
        );
      }

      reconnectTimeoutRef.current = window.setTimeout(() => {
        reconnectTimeoutRef.current = null;
        if (
          authStateRef.current.isAuthenticated &&
          !manualDisconnectRef.current &&
          (!socketRef.current || socketRef.current.readyState === WebSocket.CLOSED)
        ) {
          connectRef.current?.();
        }
      }, retryDelay);
    };

    try {
      const wsClientId = getWebSocketClientId();
      const wsUrl = `${WS_BASE_URL}/messages/ws/${token}?client_id=${encodeURIComponent(wsClientId)}`;
      manualDisconnectRef.current = false;
      const newSocket = new WebSocket(wsUrl);
      socketRef.current = newSocket;
      setSocket(newSocket);
      connectInProgressRef.current = false;

      newSocket.onopen = () => {
        if (
          connectionGenerationRef.current !== generation ||
          socketRef.current !== newSocket
        ) return;

        if (reconnectTimeoutRef.current) {
          window.clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        if (pingIntervalRef.current) {
          window.clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        const reconnectedAfterInterruption = hasOpenedConnectionRef.current;
        const recoveredConnection = reconnectAttemptRef.current > 0;
        hasOpenedConnectionRef.current = true;
        reconnectAttemptRef.current = 0;
        reconnectNoticeRef.current = false;
        setConnected(true);
        connectedRef.current = true;
        toast.success(
          recoveredConnection
            ? "Conexao em tempo real restabelecida."
            : "Conectado ao chat em tempo real.",
          { id: "voltchat-connection" },
        );

        if (reconnectedAfterInterruption) {
          window.dispatchEvent(new Event("voltchat:reconnected"));
        }

        lastPongAtRef.current = Date.now();
        pingIntervalRef.current = window.setInterval(() => {
          if (
            connectionGenerationRef.current !== generation ||
            socketRef.current !== newSocket ||
            newSocket.readyState !== WebSocket.OPEN
          ) return;

          const silentFor = Date.now() - lastPongAtRef.current;
          if (silentFor > 90000) {
            console.warn("[VoltChat WS] heartbeat sem resposta; encerrando somente o socket atual", {
              generation,
              silentFor,
            });
            try {
              newSocket.close(4000, "Heartbeat timeout");
            } catch (_error) {
              // onclose/onerror cuidam da reconexao.
            }
            return;
          }

          try {
            newSocket.send(JSON.stringify({ type: "ping" }));
          } catch (error) {
            console.warn("[VoltChat WS] falha ao enviar heartbeat", error);
          }
        }, 25000);
      };

      newSocket.onmessage = (event) => {
        if (
          connectionGenerationRef.current !== generation ||
          socketRef.current !== newSocket
        ) return;
        try {
          const data = JSON.parse(event.data);
          if (data?.type === "pong") lastPongAtRef.current = Date.now();
          handleWebSocketMessageRef.current?.(data);
        } catch (error) {
          console.error("Erro ao processar mensagem WebSocket:", error);
        }
      };

      newSocket.onclose = (event) => {
        // Eventos atrasados de um socket antigo nao podem derrubar uma conexao
        // nova nem criar outro timer de reconnect.
        if (connectionGenerationRef.current !== generation) return;
        if (socketRef.current !== newSocket) return;

        if (pingIntervalRef.current) {
          window.clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        socketRef.current = null;
        setSocket(null);
        setConnected(false);
        connectedRef.current = false;

        console.warn("[VoltChat WS] conexao encerrada", {
          generation,
          code: event.code,
          reason: event.reason || "",
          wasClean: event.wasClean,
          manual: manualDisconnectRef.current,
        });

        if (!manualDisconnectRef.current) scheduleReconnect(event);
      };

      newSocket.onerror = (error) => {
        if (
          connectionGenerationRef.current !== generation ||
          socketRef.current !== newSocket
        ) return;
        // O evento close e o unico responsavel por agendar a reconexao.
        // Isso evita onerror + onclose criarem dois timers concorrentes.
        console.warn("[VoltChat WS] erro no socket atual", { generation, error });
      };
    } catch (error) {
      connectInProgressRef.current = false;
      socketRef.current = null;
      setSocket(null);
      setConnected(false);
      connectedRef.current = false;
      console.error("Erro ao conectar WebSocket:", error);
      scheduleReconnect({ code: 1006, reason: "Falha ao criar WebSocket" });
    }
  }, []);

  connectRef.current = connect;

  // Desconectar do WebSocket
  const disconnect = useCallback(() => {
    manualDisconnectRef.current = true;
    connectionGenerationRef.current += 1;
    connectInProgressRef.current = false;

    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (pingIntervalRef.current) {
      window.clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }

    const currentSocket = socketRef.current;
    socketRef.current = null;
    if (currentSocket && currentSocket.readyState !== WebSocket.CLOSED) {
      try {
        currentSocket.close(1000, "Desconexao manual");
      } catch (_error) {
        // O estado local ja foi limpo.
      }
    }

    setSocket(null);
    setConnected(false);
    connectedRef.current = false;
    setOnlineUsers([]);
    setTypingUsers([]);
  }, []);

  // Enviar mensagem
  const sendVoiceSignal = useCallback(
    (receiverId, signalType, signal = {}) => {
      if (
        !receiverId ||
        !socketRef.current ||
        socketRef.current.readyState !== WebSocket.OPEN
      ) {
        toast.error("Não conectado ao chat para iniciar a ligação.");
        connect();
        return false;
      }
      try {
        socketRef.current.send(
          JSON.stringify({
            type: "voice_signal",
            receiver_id: receiverId,
            signal_type: signalType,
            signal,
          }),
        );
        return true;
      } catch (error) {
        console.error("Erro na sinalização de voz:", error);
        toast.error("Não foi possível sinalizar a ligação.");
        return false;
      }
    },
    [connect],
  );

  const registerVoiceCallController = useCallback((controller) => {
    voiceCallControllerRef.current = controller;
    return () => {
      if (voiceCallControllerRef.current === controller)
        voiceCallControllerRef.current = null;
    };
  }, []);

  const runCallController = useCallback((method, ...args) => {
    if (!voiceCallControllerRef.current?.[method]) {
      toast.error("O controlador de chamadas ainda não está pronto.");
      return false;
    }
    return voiceCallControllerRef.current[method](...args);
  }, []);
  const startVoiceCall = useCallback((contact) => runCallController("start", contact), [runCallController]);
  const startVideoCall = useCallback((contact) => runCallController("startVideo", contact), [runCallController]);
  const startGroupVoiceCall = useCallback((group, participants) => runCallController("startGroup", group, participants), [runCallController]);
  const startMeetingVideo = useCallback((meeting, participants, options = {}) => runCallController("startMeetingVideo", meeting, participants, options), [runCallController]);
  const sendMessage = useCallback(
    (
      content,
      receiverId = null,
      messageType = "text",
      filePath = null,
      replyTo = null,
      groupId = null,
      mentionUserIds = [],
    ) => {
      if (
        !socketRef.current ||
        socketRef.current.readyState !== WebSocket.OPEN
      ) {
        toast.error("Não conectado ao chat");
        connect();
        return false;
      }

      const clientId =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `local-${Date.now()}`;
      const messageData = {
        type: "chat_message",
        client_id: clientId,
        content,
        receiver_id: receiverId,
        group_id: groupId,
        message_type: messageType,
        file_path: filePath,
        reply_to_id: replyTo?.id || null,
        mention_user_ids: Array.isArray(mentionUserIds) ? mentionUserIds : [],
      };

      try {
        setMessages((prev) => [
          ...prev,
          {
            id: clientId,
            client_id: clientId,
            content,
            sender_id: user?.id,
            sender_name: user?.full_name || user?.username || "Voce",
            receiver_id: receiverId,
            group_id: groupId,
            message_type: messageType,
            timestamp: new Date().toISOString(),
            file_path: filePath,
            reply_to_id: replyTo?.id || null,
            reply_to: replyTo
              ? {
                  id: replyTo.id,
                  content: replyTo.content,
                  sender_id: replyTo.sender_id,
                  sender_name: replyTo.sender_name,
                  message_type: replyTo.message_type,
                }
              : null,
            reactions: [],
            mention_user_ids: Array.isArray(mentionUserIds) ? mentionUserIds : [],
            pending: true,
          },
        ]);
        socketRef.current.send(JSON.stringify(messageData));
        return true;
      } catch (error) {
        console.error("Erro ao enviar mensagem:", error);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.client_id === clientId
              ? { ...msg, pending: false, failed: true }
              : msg,
          ),
        );
        toast.error("Erro ao enviar mensagem");
      }
      return false;
    },
    [connect, user],
  );

  // Enviar indicador de digitação
  const switchChatCompany = useCallback((companyId) => {
    if (
      !companyId ||
      !socketRef.current ||
      socketRef.current.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    setMessages([]);
    setOnlineUsers([]);
    setTypingUsers([]);
    socketRef.current.send(
      JSON.stringify({ type: "switch_company", company_id: companyId }),
    );
    return true;
  }, []);

  const sendReadReceipt = useCallback((senderId) => {
    if (!senderId || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return false;
    socketRef.current.send(JSON.stringify({ type: "mark_read", sender_id: Number(senderId) }));
    return true;
  }, []);

  const sendTypingIndicator = useCallback((isTyping, receiverId = null, groupId = null) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    const typingData = {
      type: "typing",
      is_typing: isTyping,
      receiver_id: receiverId,
      group_id: groupId,
    };

    try {
      socketRef.current.send(JSON.stringify(typingData));
    } catch (error) {
      console.error("Erro ao enviar indicador de digitação:", error);
    }
  }, []);

  const sendPresenceStatus = useCallback((status) => {
    desiredPresenceRef.current = status || "online";
    idlePresenceRef.current = false;
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      return false;
    }
    socketRef.current.send(JSON.stringify({ type: "presence", status: desiredPresenceRef.current }));
    return true;
  }, []);

  const sendAttentionRequest = useCallback((receiverId) => {
    if (!receiverId || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      toast.error("Nao conectado ao chat");
      return false;
    }
    socketRef.current.send(JSON.stringify({
      type: "attention_request",
      receiver_id: Number(receiverId),
    }));
    return true;
  }, []);
  // Upload de arquivo
  const uploadFile = useCallback(async (file, companyId = null) => {
    try {
      const formData = new FormData();
      formData.append("file", file);

      const token = localStorage.getItem("token");
      const companyQuery = companyId
        ? `?company_id=${encodeURIComponent(companyId)}`
        : "";
      const response = await fetch(
        `${API_BASE_URL}/files/upload${companyQuery}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: formData,
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || "Erro no upload");
      }

      const result = await response.json();
      return result;
    } catch (error) {
      console.error("Erro no upload:", error);
      throw error;
    }
  }, []);

  // Enviar reação
  const sendReaction = useCallback(async (messageId, emoji) => {
    try {
      const token = localStorage.getItem("token");
      const response = await fetch(
        `${API_BASE_URL}/messages/${messageId}/reactions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ emoji }),
        },
      );

      if (!response.ok) {
        throw new Error("Erro ao enviar reação");
      }

      const result = await response.json();
      return result;
    } catch (error) {
      console.error("Erro ao enviar reação:", error);
      toast.error("Erro ao reagir à mensagem");
      throw error;
    }
  }, []);

  // Marcar mensagens como lidas
  const markAsRead = useCallback((conversationKey = null) => {
    if (!conversationKey) {
      setUnreadCount(0);
      setUnreadByConversation({});
      return;
    }
    setUnreadByConversation((prev) => {
      const count = prev[conversationKey] || 0;
      setUnreadCount((total) => Math.max(0, total - count));
      const next = { ...prev };
      delete next[conversationKey];
      return next;
    });
  }, []);

  // Carregar histórico de mensagens
  const loadMessageHistory = useCallback(() => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "get_history" }));
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !user?.id) return undefined;
    let idleTimer = null;
    const markAway = () => {
      idlePresenceRef.current = true;
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "presence", status: "away" }));
      }
    };
    const registerActivity = () => {
      if (idlePresenceRef.current) {
        idlePresenceRef.current = false;
        if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) connect();
        else socketRef.current.send(JSON.stringify({ type: "presence", status: desiredPresenceRef.current || "online" }));
      }
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(markAway, 60 * 60 * 1000);
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"];
    events.forEach((eventName) => window.addEventListener(eventName, registerActivity, { passive: true }));
    registerActivity();
    return () => {
      window.clearTimeout(idleTimer);
      events.forEach((eventName) => window.removeEventListener(eventName, registerActivity));
    };
  }, [connect, isAuthenticated, user?.id]);

  // Mudancas reais de rede podem deixar um WebSocket meio-aberto. Quando o
  // navegador volta a ficar online, tentamos UMA conexao somente se nao houver
  // socket OPEN/CONNECTING. O evento offline apenas atualiza o indicador; o
  // onclose continua sendo o responsavel por programar reconnect.
  useEffect(() => {
    const handleOnline = () => {
      if (!authStateRef.current.isAuthenticated || manualDisconnectRef.current) return;
      const current = socketRef.current;
      if (
        !current ||
        current.readyState === WebSocket.CLOSED
      ) {
        connect();
      }
    };
    const handleOffline = () => {
      setConnected(false);
      connectedRef.current = false;
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [connect]);

  // Efeitos
  useEffect(() => {
    let active = true;
    if (isAuthenticated && user?.id) {
      loadLocalChatHistory(user.id).then((history) => {
        if (active && history.length) setMessages(history);
      });
    }
    return () => {
      active = false;
    };
  }, [isAuthenticated, user?.id]);

  useEffect(() => {
    if (!isAuthenticated || !user?.id) return undefined;
    // IndexedDB is shared with the browser. Debouncing avoids serializing the
    // entire renderer history for transient read receipts and reactions.
    const timeoutId = window.setTimeout(() => {
      saveLocalChatHistory(user.id, messages);
    }, 1000);
    return () => window.clearTimeout(timeoutId);
  }, [isAuthenticated, messages, user?.id]);

  useEffect(() => {
    if (isAuthenticated && user?.id) {
      connect();
    } else {
      disconnect();
    }
  }, [isAuthenticated, user?.id, connect, disconnect]);

  // Cleanup ao desmontar
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  const value = {
    socket,
    connected,
    onlineUsers,
    messages,
    typingUsers,
    unreadCount,
    unreadByConversation,
    sendMessage,
    switchChatCompany,
    sendTypingIndicator,
    sendReadReceipt,
    sendPresenceStatus,
    sendAttentionRequest,
    uploadFile,
    markAsRead,
    loadMessageHistory,
    connect,
    disconnect,
    sendReaction,
    removeMessageImmediately,
    restoreMessageImmediately,
    clearConversationImmediately,
    voiceSignal,
    sendVoiceSignal,
    registerVoiceCallController,
    startVoiceCall,
    startVideoCall,
    startGroupVoiceCall,
    startMeetingVideo,
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
};
