import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { fetchWithAuth } from "../utils/authFetch";
import { showToast } from "../utils/toast";
import { Building2, Check, ChevronDown } from "lucide-react";

interface Company {
  id: string;
  name: string;
}

export const CompanySwitcher: React.FC = () => {
  const { user, setUser } = useAuth();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const isAdmin = user?.role === "ADMIN";

  useEffect(() => {
    const loadCompanies = async () => {
      setIsLoading(true);
      try {
        const response = await fetchWithAuth("/api/companies");
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        setCompanies(Array.isArray(data) ? data : []);
      } catch (error) {
        console.error("Erro ao carregar empresas:", error);
        setCompanies([]);
      } finally {
        setIsLoading(false);
      }
    };

    if (isAdmin) {
      loadCompanies();
    } else {
      setCompanies([]);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleSwitchCompany = async (companyId: string) => {
    if (!user?.id || companyId === user.companyId) {
      setIsOpen(false);
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetchWithAuth("/api/users/switch-company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          companyId,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (data.user && data.token) {
        setUser(
          {
            id: data.user.id,
            email: data.user.email,
            name: data.user.name,
            role: data.user.role,
            companyId: data.user.companyId,
            module: "avantracking",
            isSuperAdmin: Boolean(data.user.isSuperAdmin),
          },
          data.token,
        );
        showToast({
          tone: "success",
          title: "Empresa alterada",
          message: "Os dados da empresa selecionada foram atualizados.",
        });
      }
    } catch (error) {
      console.error("Erro ao trocar empresa:", error);
      showToast({
        tone: "error",
        title: "Troca de empresa",
        message: "Erro ao trocar empresa.",
      });
    } finally {
      setIsLoading(false);
      setIsOpen(false);
    }
  };

  if (!isAdmin) {
    return null;
  }

  const currentCompany = companies.find((company) => company.id === user?.companyId);

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        disabled={isLoading}
        className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 min-w-[220px]"
      >
        <Building2 className="w-4 h-4 flex-shrink-0" />
        <span className="truncate flex-1 text-left">
          {isLoading
            ? "Carregando empresas..."
            : currentCompany?.name || "Selecionar empresa"}
        </span>
        <ChevronDown
          className={`w-4 h-4 transition-transform flex-shrink-0 ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-1 w-72 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-50">
          <div className="p-2">
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 px-2 py-1 mb-1 uppercase tracking-wide">
              Empresas cadastradas
            </p>

            {companies.length === 0 ? (
              <div className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
                Nenhuma empresa disponível.
              </div>
            ) : (
              companies.map((company) => {
                const isSelected = company.id === user?.companyId;

                return (
                  <button
                    key={company.id}
                    onClick={() => handleSwitchCompany(company.id)}
                    className={`w-full flex items-center justify-between gap-3 text-left px-3 py-2 rounded text-sm transition-colors ${
                      isSelected
                        ? "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-semibold"
                        : "hover:bg-slate-100 dark:hover:bg-slate-700"
                    }`}
                  >
                    <span className="truncate">{company.name}</span>
                    {isSelected && <Check className="w-4 h-4 flex-shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
