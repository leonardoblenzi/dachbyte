import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import toast from 'react-hot-toast';
import { useAuth } from './AuthContext';

const WebSocketContext = createContext();

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket deve ser usado dentro de um WebSocketProvider');
  }
  return context;
};

export const WebSocketProvider = ({ children }) => {
  const { user, isAuthenticated } = useAuth();
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [notifications, setNotifications] = useState([]);

  // Conectar ao WebSocket
  const connect = useCallback(() => {
    if (!isAuthenticated || !user) return;

    const token = localStorage.getItem('token');
    if (!token) return;

    try {
      const wsUrl = `ws://127.0.0.1:8001/messages/ws/${token}`;
      const newSocket = new WebSocket(wsUrl);

      newSocket.onopen = () => {
        console.log('✅ WebSocket conectado');
        setConnected(true);
        toast.success('Conectado ao chat em tempo real! 🔄');
      };

      newSocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleWebSocketMessage(data);
        } catch (error) {
          console.error('Erro ao processar mensagem WebSocket:', error);
        }
      };

      newSocket.onclose = (event) => {
        console.log('🔌 WebSocket desconectado:', event.code);
        setConnected(false);

        if (event.code !== 1000) { // Não foi fechamento normal
          toast.error('Conexão perdida. Tentando reconectar...');

          // Tentar reconectar após 3 segundos
          setTimeout(() => {
            if (isAuthenticated) {
              connect();
            }
          }, 3000);
        }
      };

      newSocket.onerror = (error) => {
        console.error('❌ Erro no WebSocket:', error);
        toast.error('Erro na conexão em tempo real');
      };

      setSocket(newSocket);
    } catch (error) {
      console.error('Erro ao conectar WebSocket:', error);
    }
  }, [isAuthenticated, user]);

  // Desconectar WebSocket
  const disconnect = useCallback(() => {
    if (socket) {
      socket.close(1000); // Fechamento normal
      setSocket(null);
      setConnected(false);
    }
  }, [socket]);

  // Processar mensagens recebidas
  const handleWebSocketMessage = (data) => {
    console.log('📥 Mensagem WebSocket recebida:', data);

    switch (data.type) {
      case 'connection':
        toast.success(data.message);
        break;

      case 'new_message':
        setMessages(prev => [...prev, data.message]);

        // Notificação de nova mensagem se não for do próprio usuário
        if (data.message.sender_id !== user?.id) {
          toast.success(`💬 Nova mensagem de ${data.message.sender_name}`);
        }
        break;

      case 'notification':
        setNotifications(prev => [data.notification, ...prev]);

        // Mostrar toast da notificação
        const { notification } = data;
        const icon = getNotificationIcon(notification.type);
        toast.success(`${icon} ${notification.title}: ${notification.message}`);
        break;

      case 'user_status':
        // Atualizar status online dos usuários
        if (data.is_online) {
          setOnlineUsers(prev => [...prev.filter(id => id !== data.user_id), data.user_id]);
        } else {
          setOnlineUsers(prev => prev.filter(id => id !== data.user_id));
        }
        break;

      case 'typing':
        // Implementar indicador de digitação
        console.log(`${data.username} está ${data.is_typing ? 'digitando' : 'parou de digitar'}`);
        break;

      case 'pong':
        console.log('🏓 Pong recebido do servidor');
        break;

      default:
        console.log('Tipo de mensagem não reconhecido:', data.type);
    }
  };

  // Ícones para diferentes tipos de notificação
  const getNotificationIcon = (type) => {
    switch (type) {
      case 'success': return '✅';
      case 'warning': return '⚠️';
      case 'error': return '❌';
      case 'info':
      default: return 'ℹ️';
    }
  };

  // Enviar mensagem
  const sendMessage = useCallback((content, receiverId = null) => {
    if (!socket || !connected) {
      toast.error('Não conectado ao chat');
      return;
    }

    const message = {
      type: 'chat_message',
      content,
      receiver_id: receiverId,
      message_type: 'text'
    };

    socket.send(JSON.stringify(message));
  }, [socket, connected]);

  // Enviar indicador de digitação
  const sendTypingIndicator = useCallback((isTyping, receiverId = null) => {
    if (!socket || !connected) return;

    const message = {
      type: 'typing',
      is_typing: isTyping,
      receiver_id: receiverId
    };

    socket.send(JSON.stringify(message));
  }, [socket, connected]);

  // Enviar ping para manter conexão viva
  const sendPing = useCallback(() => {
    if (!socket || !connected) return;

    const message = { type: 'ping' };
    socket.send(JSON.stringify(message));
  }, [socket, connected]);

  // Conectar quando autenticado
  useEffect(() => {
    if (isAuthenticated && user) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [isAuthenticated, user, connect, disconnect]);

  // Ping periódico para manter conexão
  useEffect(() => {
    if (!connected) return;

    const pingInterval = setInterval(() => {
      sendPing();
    }, 30000); // Ping a cada 30 segundos

    return () => clearInterval(pingInterval);
  }, [connected, sendPing]);

  const value = {
    socket,
    connected,
    onlineUsers,
    messages,
    notifications,
    sendMessage,
    sendTypingIndicator,
    connect,
    disconnect,
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
};