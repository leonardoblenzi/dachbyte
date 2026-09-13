import { API_BASE_URL } from '../config';

// Função auxiliar para fazer requisições
const apiRequest = async (endpoint, options = {}) => {
  const token = localStorage.getItem('token');

  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...options,
  };

  const response = await fetch(`${API_BASE_URL}${endpoint}`, config);

  if (!response.ok) {
    throw new Error(`Erro ${response.status}: ${response.statusText}`);
  }

  return response.json();
};

// Serviços de dashboard
export const dashboardService = {
  getOverview: async () => {
    return apiRequest('/dashboard/overview');
  },
};

// Serviço de verificação de saúde
export const healthService = {
  getInfo: async () => {
    return apiRequest('/');
  },
};
