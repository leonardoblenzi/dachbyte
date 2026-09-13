import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import toast from "react-hot-toast";
import { API_BASE_URL } from "../config";

const AuthContext = createContext();
const REMEMBER_KEY = "voltchat:remember-session";
const ACTIVE_SESSION_KEY = "voltchat:session-active";
const isDesktopApp = () => Boolean(window.voltChatDesktop?.customTitleBar);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth deve ser usado dentro de um AuthProvider");
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const expireSession = useCallback(() => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    localStorage.removeItem(REMEMBER_KEY);
    sessionStorage.removeItem(ACTIVE_SESSION_KEY);
    if (isDesktopApp()) {
      window.voltChatDesktop?.clearSavedSession?.().catch(() => {});
    }
    setUser(null);
  }, []);

  // Restaura primeiro a sessao segura do desktop e depois valida o token na API.
  useEffect(() => {
    let cancelled = false;

    const restoreSession = async () => {
      let token = localStorage.getItem("token");
      let savedUser = localStorage.getItem("user");
      let remembered = localStorage.getItem(REMEMBER_KEY) === "true";
      const activeSession = sessionStorage.getItem(ACTIVE_SESSION_KEY) === "true";

      if (isDesktopApp() && (!token || !savedUser || (!remembered && !activeSession))) {
        const recovered = await window.voltChatDesktop?.getSavedSession?.().catch(() => null);
        if (recovered?.token && recovered?.user) {
          token = recovered.token;
          savedUser = JSON.stringify(recovered.user);
          remembered = true;
          localStorage.setItem("token", token);
          localStorage.setItem("user", savedUser);
          localStorage.setItem(REMEMBER_KEY, "true");
          sessionStorage.removeItem(ACTIVE_SESSION_KEY);
        }
      }

      if (token && savedUser && (remembered || activeSession)) {
        try {
          const cachedUser = JSON.parse(savedUser);
          if (!cancelled) setUser(cachedUser);
          fetch(`${API_BASE_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
            .then(async (response) => {
              if (!response.ok) throw new Error("Sessao expirada");
              const freshUser = await response.json();
              localStorage.setItem("user", JSON.stringify(freshUser));
              if (isDesktopApp() && remembered) {
                window.voltChatDesktop?.saveSession?.({ token, user: freshUser }).catch(() => {});
              }
              if (!cancelled) setUser(freshUser);
            })
            .catch(() => {
              // Falhas de rede nao removem a sessao; somente token invalido.
              try {
                const payload = JSON.parse(atob(token.split(".")[1] || ""));
                if (Number(payload.exp || 0) * 1000 <= Date.now()) expireSession();
              } catch {
                expireSession();
              }
            });
        } catch (error) {
          console.error("Erro ao carregar usuario:", error);
          expireSession();
        }
      } else if (!remembered && !activeSession) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
      }

      if (!cancelled) setLoading(false);
    };

    restoreSession();
    return () => { cancelled = true; };
  }, [expireSession]);

  const login = async (credentials, rememberMe = isDesktopApp()) => {
    try {
      setLoading(true);

      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...credentials, remember_me: Boolean(rememberMe) }),
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ detail: "Erro de conexão" }));
        throw new Error(errorData.detail || `Erro ${response.status}`);
      }

      const data = await response.json();

      const { access_token, user: userData } = data;

      // Salvar token e dados do usuário
      localStorage.setItem("token", access_token);
      localStorage.setItem("user", JSON.stringify(userData));
      localStorage.setItem(REMEMBER_KEY, String(Boolean(rememberMe)));
      if (rememberMe) {
        sessionStorage.removeItem(ACTIVE_SESSION_KEY);
        if (isDesktopApp()) {
          window.voltChatDesktop?.saveSession?.({ token: access_token, user: userData }).catch(() => {});
        }
      } else {
        sessionStorage.setItem(ACTIVE_SESSION_KEY, "true");
        if (isDesktopApp()) {
          window.voltChatDesktop?.clearSavedSession?.().catch(() => {});
        }
      }

      setUser(userData);

      toast.success(
        userData.must_change_password
          ? "Troca de senha obrigatoria para continuar."
          : `Bem-vindo, ${userData.full_name || userData.name}!`,
      );

      return { success: true, user: userData };
    } catch (error) {
      console.error("Erro no login:", error);

      // Verificar se é erro de conexão
      if (error.message.includes("fetch")) {
        toast.error(
          "Nao foi possivel conectar ao Volt Corp. Tente novamente em alguns instantes.",
        );
      } else {
        toast.error(error.message);
      }

      return { success: false, error: error.message };
    } finally {
      setLoading(false);
    }
  };

  const changePassword = async ({ currentPassword, newPassword }) => {
    const token = localStorage.getItem("token");
    const response = await fetch(`${API_BASE_URL}/auth/change-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || "Nao foi possivel alterar a senha.");
    }

    const data = await response.json();
    localStorage.setItem("user", JSON.stringify(data.user));
    setUser(data.user);
    toast.success("Senha alterada com sucesso.");
    return data.user;
  };

  const updateProfile = async (profile) => {
    const response = await fetch(`${API_BASE_URL}/auth/profile`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
      body: JSON.stringify(profile),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || "Nao foi possivel atualizar o perfil.");
    }
    const data = await response.json();
    localStorage.setItem("user", JSON.stringify(data.user));
    setUser(data.user);
    toast.success("Perfil atualizado.");
    return data.user;
  };

  const logout = async () => {
    try {
      const token = localStorage.getItem("token");
      if (token) {
        // Tentar fazer logout no backend
        await fetch(`${API_BASE_URL}/auth/logout`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }).catch(() => {
          // Ignora falha remota; a sessao local ainda deve ser encerrada.
        });
      }
    } catch (error) {
      console.error("Erro ao fazer logout:", error);
    } finally {
      // Limpar dados locais
      expireSession();
      toast.success("Logout realizado com sucesso");
    }
  };

  const isPlatformAdmin = () =>
    Boolean(user?.is_platform_admin || user?.access_level === "master");

  const isAdmin = () => {
    return Boolean(isPlatformAdmin() || user?.company_role === "master_admin");
  };

  const hasCompanyRole = (roles) => {
    const memberships = user?.companies || [];
    return (
      memberships.some((membership) => roles.includes(membership.role)) ||
      roles.includes(user?.company_role)
    );
  };

  const isCompanyAdmin = () => {
    return Boolean(
      isAdmin() || hasCompanyRole(["company_admin", "master_admin"]),
    );
  };

  const isCoordinator = () => {
    return Boolean(
      isAdmin() ||
      user?.access_level === "coordenador" ||
      hasCompanyRole(["company_admin", "master_admin", "coordinator"]),
    );
  };

  const value = {
    user,
    loading,
    login,
    changePassword,
    updateProfile,
    logout,
    expireSession,
    isAdmin,
    isPlatformAdmin,
    isCompanyAdmin,
    isCoordinator,
    isAuthenticated: !!user,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
