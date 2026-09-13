import axios from 'axios';
import toast from 'react-hot-toast';

// Configuração base da API
const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://127.0.0.1:8001';

// Criar instância do axios
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Interceptor para adicionar token de autenticação
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Interceptor para tratar respostas e erros
api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    const { response } = error;

    if (response?.status === 401) {
      // Token expirado ou inválido
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
      toast.error('Sessão expirada. Faça login novamente.');
    } else if (response?.status === 403) {
      toast.error('Acesso negado. Você não tem permissão para esta ação.');
    } else if (response?.status === 404) {
      toast.error('Recurso não encontrado.');
    } else if (response?.status >= 500) {
      toast.error('Erro interno do servidor. Tente novamente mais tarde.');
    } else if (error.code === 'ECONNABORTED') {
      toast.error('Tempo limite da requisição excedido.');
    } else if (!response) {
      toast.error('Erro de conexão. Verifique sua internet.');
    }

    return Promise.reject(error);
  }
);

// Serviços de autenticação
export const authService = {
  login: async (credentials) => {
    const response = await api.post('/auth/login', credentials);
    return response.data;
  },

  logout: async () => {
    const response = await api.post('/auth/logout');
    return response.data;
  },

  getProfile: async () => {
    const response = await api.get('/auth/me');
    return response.data;
  },

  getPermissions: async () => {
    const response = await api.get('/auth/permissions');
    return response.data;
  },
};

// Serviços de usuários
export const userService = {
  getUsers: async (params = {}) => {
    const response = await api.get('/users/', { params });
    return response.data;
  },

  getMyProfile: async () => {
    const response = await api.get('/users/me');
    return response.data;
  },
};

// Serviços de tickets
export const ticketService = {
  getTickets: async (params = {}) => {
    const response = await api.get('/tickets/', { params });
    return response.data;
  },

  getTicketStats: async () => {
    const response = await api.get('/tickets/stats');
    return response.data;
  },
};

// Serviços de tasks
export const taskService = {
  getTasks: async (params = {}) => {
    const response = await api.get('/tasks/', { params });
    return response.data;
  },

  getTaskStats: async () => {
    const response = await api.get('/tasks/stats');
    return response.data;
  },
};

// Serviços de mensagens
export const messageService = {
  getMessages: async (params = {}) => {
    const response = await api.get('/messages/', { params });
    return response.data;
  },

  getOnlineUsers: async () => {
    const response = await api.get('/messages/online-users');
    return response.data;
  },
};

// Serviços de arquivos
export const fileService = {
  uploadFile: async (file, category = 'documents', description = '') => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('category', category);
    formData.append('description', description);

    const response = await api.post('/files/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  getFiles: async (params = {}) => {
    const response = await api.get('/files/', { params });
    return response.data;
  },

  downloadFile: async (fileId) => {
    const response = await api.get(`/files/${fileId}`, {
      responseType: 'blob',
    });
    return response;
  },

  deleteFile: async (fileId) => {
    const response = await api.delete(`/files/${fileId}`);
    return response.data;
  },

  getFileStats: async () => {
    const response = await api.get('/files/stats/overview');
    return response.data;
  },
};

// Serviços de notificações
export const notificationService = {
  getNotifications: async (params = {}) => {
    const response = await api.get('/notifications/', { params });
    return response.data;
  },

  markAsRead: async (notificationId) => {
    const response = await api.post(`/notifications/${notificationId}/read`);
    return response.data;
  },

  markAllAsRead: async () => {
    const response = await api.post('/notifications/mark-all-read');
    return response.data;
  },

  getUnreadCount: async () => {
    const response = await api.get('/notifications/unread-count');
    return response.data;
  },

  createTestNotification: async () => {
    const response = await api.post('/notifications/test');
    return response.data;
  },

  getStats: async () => {
    const response = await api.get('/notifications/stats');
    return response.data;
  },
};

// Serviços de dashboard
export const dashboardService = {
  getOverview: async () => {
    const response = await api.get('/dashboard/overview');
    return response.data;
  },

  getTicketChart: async () => {
    const response = await api.get('/dashboard/charts/tickets-by-priority');
    return response.data;
  },

  getPerformanceMetrics: async () => {
    const response = await api.get('/dashboard/performance');
    return response.data;
  },
};

// Serviço de verificação de saúde
export const healthService = {
  check: async () => {
    const response = await api.get('/health');
    return response.data;
  },

  getInfo: async () => {
    const response = await api.get('/');
    return response.data;
  },
};

export default api;