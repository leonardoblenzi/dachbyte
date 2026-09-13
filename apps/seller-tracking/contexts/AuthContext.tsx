import React, { createContext, useContext, useState, useEffect } from "react";
import { resolveAppUrl } from "../utils/authFetch";

export type Role = "ADMIN" | "USER" | "ADMIN_SUPER";
export type AuthModule = "avantracking";

interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  companyId?: string | null;
  module?: AuthModule;
  isSuperAdmin?: boolean;
  phone?: string | null;
  birthDate?: string | null;
  profileImageData?: string | null;
  receivePlatformEmails?: boolean;
  birthdayCelebrationPending?: boolean;
  birthdayCelebrationMessage?: string | null;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  login: () => Promise<boolean>;
  logout: () => void;
  isLoading: boolean;
  token: string | null;
  setUser: (user: User | null, token?: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Removed MOCK DB as we are now using real backend API

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const hydrateSession = async () => {
      clearSessionStorage();

      try {
        const response = await fetch(resolveAppUrl("/api/users/session"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.token) {
          throw new Error(data.error || "Sessao global indisponivel.");
        }

        const sessionUser = {
          id: data.id,
          email: data.email,
          name: data.name,
          role: data.role as Role,
          companyId: data.companyId,
          module: "avantracking" as AuthModule,
          isSuperAdmin: Boolean(data.isSuperAdmin),
          phone: data.phone || null,
          birthDate: data.birthDate || null,
          profileImageData: data.profileImageData || null,
          receivePlatformEmails: data.receivePlatformEmails !== false,
          birthdayCelebrationPending: Boolean(data?.birthdayCelebration?.show),
          birthdayCelebrationMessage:
            data?.birthdayCelebration?.message || null,
        };

        if (!cancelled) {
          setUser(sessionUser);
          setToken(data.token);
          persistSession(sessionUser, data.token, sessionStorage);
        }
      } catch (_error) {
        if (!cancelled) {
          setUser(null);
          setToken(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void hydrateSession();

    return () => {
      cancelled = true;
    };
  }, []);

  const clearSessionStorage = () => {
    localStorage.removeItem("session_user");
    localStorage.removeItem("session_token");
    sessionStorage.removeItem("session_user");
    sessionStorage.removeItem("session_token");
  };

  const resolvePrimaryStorage = () => {
    if (localStorage.getItem("session_token")) return localStorage;
    if (sessionStorage.getItem("session_token")) return sessionStorage;
    if (localStorage.getItem("session_user")) return localStorage;
    if (sessionStorage.getItem("session_user")) return sessionStorage;
    return localStorage;
  };

  const persistSession = (
    sessionUser: User | null,
    sessionToken: string | null,
    preferredStorage?: Storage,
  ) => {
    const primaryStorage = preferredStorage || resolvePrimaryStorage();
    const secondaryStorage =
      primaryStorage === localStorage ? sessionStorage : localStorage;

    secondaryStorage.removeItem("session_user");
    secondaryStorage.removeItem("session_token");

    if (!sessionUser || !sessionToken) {
      primaryStorage.removeItem("session_user");
      primaryStorage.removeItem("session_token");
      return;
    }

    primaryStorage.setItem("session_user", JSON.stringify(sessionUser));
    primaryStorage.setItem("session_token", sessionToken);
  };

  useEffect(() => {
    const handleExpiredSession = () => {
      setUser(null);
      setToken(null);
      localStorage.removeItem("session_user");
      localStorage.removeItem("session_token");
      sessionStorage.removeItem("session_user");
      sessionStorage.removeItem("session_token");
    };

    window.addEventListener("auth:expired", handleExpiredSession);

    return () => {
      window.removeEventListener("auth:expired", handleExpiredSession);
    };
  }, []);

  const login = async (): Promise<boolean> => false;

  const logout = () => {
    setUser(null);
    setToken(null);
    clearSessionStorage();
    window.location.assign("/selecao-plataforma");
  };

  const handleSetUser = (newUser: User | null, newToken?: string) => {
    setUser(newUser);
    const resolvedToken = newToken ?? token;

    if (newToken !== undefined) {
      setToken(newToken || null);
    }

    if (!newUser || !resolvedToken) {
      persistSession(null, null);
      return;
    }

    persistSession(newUser, resolvedToken);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        login,
        logout,
        isLoading,
        token,
        setUser: handleSetUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
