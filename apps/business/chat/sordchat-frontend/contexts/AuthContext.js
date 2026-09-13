import React, { createContext, useContext, useState, useEffect } from 'react';
import { authService } from '../services/api';
import toast from 'react-hot-toast';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth deve ser usado dentro de um AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [permissions, setPermissions] = useState([]);

  // Verificar se há token salvo ao carregar a aplicação
  useEffect(() => {
    const initAuth = async () => {
      const token = localStorage.getItem('token');
      const savedUser = localStorage.getItem('user');

      if (token && savedUser) {
        try {
          setUser(JSON.parse(savedUser));

          // Verificar se o token ainda é válido
          const profile = await authService.getProfile();
          const userPermissions = await authService.getPermissions();

          setUser(profile);
          setPermissions(userPermissions.permissions || []);
        } catch (error) {
          console.error('Erro ao verificar autenticação:', error);
          logout();
        }
      }

      setLoading(false);
    };

    initAuth();
  }, []);

  const login = async (credentials) => {
    try {
      setLoading(true);
      const response = await authService.login(credentials);

      const { access_token, user: userData } = response;

      // Salvar token e dados do usuário
      localStorage.setItem('token', access_token);
      localStorage.setItem('user', JSON.stringify(userData));

      setUser(userData);

      // Obter permissões
      const userPermissions = await authService.getPermissions();
      setPermissions(userPermissions.permissions || []);

      toast.success(`Bem-vindo, ${userData.full_name}! 🎉`);

      return { success: true, user: userData };
    } catch (error) {
      console.error('Erro no login:', error);
      const message = error.response?.data?.detail || 'Erro ao fazer login';
      toast.error(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    try {
      await authService.logout();
    } catch (error) {
      console.error('Erro ao fazer logout:', error);
    } finally {
      // Limpar dados locais
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      setUser(null);
      setPermissions([]);
      toast.success('Logout realizado com sucesso');
    }
  };

  const hasPermission = (permission) => {
    return permissions.includes(permission) || user?.access_level === 'master';
  };

  const isAdmin = () => {
    return user?.access_level === 'master';
  };

  const isCoordinator = () => {
    return user?.access_level === 'coordenador' || user?.access_level === 'master';
  };

  const value = {
    user,
    loading,
    permissions,
    login,
    logout,
    hasPermission,
    isAdmin,
    isCoordinator,
    isAuthenticated: !!user,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};