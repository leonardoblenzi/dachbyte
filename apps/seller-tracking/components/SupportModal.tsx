import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BookOpenText,
  ExternalLink,
  LifeBuoy,
  Mail,
  Phone,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import { useAuth } from "../contexts/AuthContext";
import { fetchWithAuth } from "../utils/authFetch";
import { showToast } from "../utils/toast";
import { PageView, TrayIntegrationStatus } from "../types";
import manualHtml from "../manual_avantracking_usuario_completo.html?raw";
import { LOGO_URL } from "../constants";

interface SupportModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentView: PageView;
  trayIntegrationStatus: TrayIntegrationStatus | null;
}

interface CurrentCompanyInfo {
  id: string;
  name: string;
  cnpj?: string | null;
}

type SupportSubject =
  | "Duvidas"
  | "Passo a passo"
  | "Erro"
  | "Melhoria"
  | "Outro";

const VIEW_LABELS: Record<PageView, string> = {
  dashboard: "Dashboard Executivo",
  "monitoring-panel": "Painel de Monitoramento",
  orders: "Gerenciamento de Pedidos",
  "monitored-orders": "Monitorados",
  upload: "Importacao de Dados",
  alerts: "Monitoramento de Riscos",
  "delivery-failures": "Falhas na Entrega",
  admin: "Administracao / Integracao",
  "no-movement": "Pedidos Sem Movimentacao",
  "latest-updates": "Ultimas Atualizacoes",
};

const INITIAL_FORM = {
  subject: "Duvidas" as SupportSubject,
  responsePreference: "email" as "email" | "phone",
  phone: "",
  message: "",
};

type SupportMode = "menu" | "contact" | "manual";

export const SupportModal: React.FC<SupportModalProps> = ({
  isOpen,
  onClose,
  currentView,
  trayIntegrationStatus,
}) => {
  const { user } = useAuth();
  const [mode, setMode] = useState<SupportMode>("menu");
  const [form, setForm] = useState(INITIAL_FORM);
  const [currentCompany, setCurrentCompany] = useState<CurrentCompanyInfo | null>(
    null,
  );
  const [isLoadingCompany, setIsLoadingCompany] = useState(false);
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    setIsLoadingCompany(true);
    fetchWithAuth("/api/companies/current")
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || "Nao foi possivel carregar a empresa.");
        }
        setCurrentCompany(data);
      })
      .catch(() => {
        setCurrentCompany(null);
      })
      .finally(() => {
        setIsLoadingCompany(false);
      });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setForm(INITIAL_FORM);
      setMode("menu");
    }
  }, [isOpen]);

  const contextItems = useMemo(
    () => [
      { label: "Email do login", value: user?.email || "-" },
      { label: "Nome", value: user?.name || "-" },
      { label: "Conta ativa", value: currentCompany?.name || "-" },
      {
        label: "Loja ativa",
        value:
          trayIntegrationStatus?.storeName ||
          trayIntegrationStatus?.storeId ||
          "Sem loja da Integradora vinculada",
      },
      { label: "Tela atual", value: VIEW_LABELS[currentView] || currentView },
    ],
    [currentView, currentCompany?.name, trayIntegrationStatus?.storeId, trayIntegrationStatus?.storeName, user?.email, user?.name],
  );

  const manualContent = useMemo(
    () => manualHtml.replace(/__APP_LOGO_URL__/g, LOGO_URL),
    [],
  );

  const handleChange = (
    field: keyof typeof form,
    value: string | "email" | "phone",
  ) => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!form.message.trim()) {
      showToast({
        tone: "warning",
        title: "Mensagem obrigatoria",
        message: "Descreva sua solicitacao antes de enviar.",
      });
      return;
    }

    if (form.responsePreference === "phone" && !form.phone.trim()) {
      showToast({
        tone: "warning",
        title: "Celular obrigatorio",
        message: "Informe um celular para retorno.",
      });
      return;
    }

    setIsSending(true);

    try {
      const response = await fetchWithAuth("/api/support/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: form.subject,
          responsePreference: form.responsePreference,
          phone: form.phone.trim() || null,
          message: form.message.trim(),
          currentView,
          currentViewLabel: VIEW_LABELS[currentView] || currentView,
          companyName: currentCompany?.name || null,
          companyId: currentCompany?.id || user?.companyId || null,
          companyCnpj: currentCompany?.cnpj || null,
          trayStoreName: trayIntegrationStatus?.storeName || null,
          trayStoreId: trayIntegrationStatus?.storeId || null,
          userName: user?.name || null,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Nao foi possivel enviar a solicitacao.");
      }

      showToast({
        tone: "success",
        title: "Suporte acionado",
        message: data.message || "Solicitacao enviada com sucesso.",
      });
      onClose();
    } catch (error) {
      showToast({
        tone: "error",
        title: "Falha no envio",
        message:
          error instanceof Error
            ? error.message
            : "Nao foi possivel enviar a solicitacao.",
      });
    } finally {
      setIsSending(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  const renderModeHeader = () => (
    <div className="border-b border-slate-200 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="inline-flex items-center rounded-full border border-[#f8b5a1] bg-[#fff1eb] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-[#f05a3d]">
            Ajuda e contato
          </div>
          <h3 className="mt-3 text-lg font-bold text-slate-800">
            Como voce deseja continuar?
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            Escolha entre abrir um atendimento com o time ou consultar o manual completo.
          </p>
        </div>
      </div>
    </div>
  );

  const renderModeMenu = () => (
    <div className="grid gap-4 bg-[#f7f2ef] p-3 md:grid-cols-2 md:p-4">
      <button
        type="button"
        onClick={() => setMode("contact")}
        className="rounded-[24px] border border-[#f1d8cf] bg-white p-6 text-left shadow-sm transition-colors hover:border-[#ffcfbf] hover:bg-[#fff9f6]"
      >
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#fff1eb] text-[#f05a3d]">
          <LifeBuoy className="h-6 w-6" />
        </div>
        <h4 className="mt-4 text-xl font-bold text-slate-800">Entrar em contato</h4>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Abra uma solicitacao de suporte com o contexto da sua conta preenchido
          automaticamente para agilizar o atendimento.
        </p>
      </button>

      <button
        type="button"
        onClick={() => setMode("manual")}
        className="rounded-[24px] border border-[#d8e3ff] bg-white p-6 text-left shadow-sm transition-colors hover:border-[#b8ccff] hover:bg-[#f7faff]"
      >
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eef4ff] text-[#3b6ef3]">
          <BookOpenText className="h-6 w-6" />
        </div>
        <h4 className="mt-4 text-xl font-bold text-slate-800">
          Acessar manual de usuario
        </h4>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Consulte o manual completo da plataforma com funcoes e passo a passo de uso
          operacional.
        </p>
      </button>
    </div>
  );

  const renderManual = () => (
    <div className="grid gap-4 bg-[#f7f2ef] p-3 md:p-4">
      <div className="rounded-[24px] border border-[#d8e3ff] bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <div className="inline-flex items-center rounded-full border border-[#bdd0ff] bg-[#eef4ff] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-[#2e59d9]">
              Manual do usuario
            </div>
            <h3 className="mt-3 text-lg font-bold text-slate-800">
              Manual completo da Avantracking
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Guia funcional com foco em uso pratico da plataforma.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              const popup = window.open("", "_blank", "noopener,noreferrer");
              if (!popup) return;
              popup.document.open();
              popup.document.write(manualContent);
              popup.document.close();
            }}
            className="inline-flex items-center gap-2 rounded-xl border border-[#c8d7ff] bg-[#f4f8ff] px-4 py-2 text-sm font-semibold text-[#2e59d9] transition-colors hover:bg-[#e9f0ff]"
          >
            <ExternalLink className="h-4 w-4" />
            Abrir em nova guia
          </button>
        </div>

        <div className="h-[70vh] overflow-hidden rounded-b-[24px] bg-slate-100">
          <iframe
            title="Manual de usuario Avantracking"
            className="h-full w-full border-0 bg-white"
            srcDoc={manualContent}
          />
        </div>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-slate-950/60 backdrop-blur-sm p-4">
      <div className="mx-auto max-w-7xl">
        <div className="overflow-hidden rounded-[30px] border border-white/60 bg-white shadow-[0_30px_120px_rgba(15,23,42,0.22)]">
          <div className="bg-gradient-to-r from-[#ff5a36] via-[#ff6b3d] to-[#ff944d] px-6 py-6 text-white md:px-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="inline-flex items-center rounded-full border border-white/35 bg-white/15 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em]">
                  Ajuda e Contato
                </div>
                <h2 className="mt-4 text-3xl font-bold tracking-tight">
                  {mode === "menu"
                    ? "Como podemos te ajudar?"
                    : mode === "manual"
                      ? "Manual da plataforma"
                      : "Fala com a gente"}
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-7 text-white/90">
                  {mode === "menu"
                    ? "Escolha a melhor opcao para o seu momento: abrir atendimento com o time ou consultar o manual completo da Avantracking."
                    : mode === "manual"
                      ? "Consulte o manual completo sem sair da plataforma, com orientacoes detalhadas de uso."
                      : "Se voce ficou com alguma duvida, encontrou um problema ou quer sugerir algo novo, envie sua mensagem por aqui. A equipe recebe o contexto da sua conta automaticamente."}
                </p>
              </div>

              <div className="flex items-start gap-2">
                {mode !== "menu" && (
                  <button
                    type="button"
                    onClick={() => setMode("menu")}
                    className="inline-flex h-10 items-center gap-2 rounded-full border border-white/30 bg-white/10 px-4 text-sm font-semibold text-white transition-colors hover:bg-white/20"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Voltar
                  </button>
                )}
                <div className="hidden flex-wrap justify-end gap-2 md:flex">
                  {mode === "contact" && (
                    <>
                      <span className="rounded-full border border-white/30 bg-white/12 px-3 py-1 text-[11px] font-bold uppercase tracking-wide">
                        Resposta organizada no suporte
                      </span>
                      <span className="rounded-full border border-white/30 bg-white/12 px-3 py-1 text-[11px] font-bold uppercase tracking-wide">
                        Email de login como referencia
                      </span>
                      <span className="rounded-full border border-white/30 bg-white/12 px-3 py-1 text-[11px] font-bold uppercase tracking-wide">
                        Conta ativa enviada no contexto
                      </span>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/30 bg-white/10 text-white transition-colors hover:bg-white/20"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
          </div>

          {mode === "menu" && (
            <>
              {renderModeHeader()}
              {renderModeMenu()}
            </>
          )}

          {mode === "manual" && renderManual()}

          {mode === "contact" && (
            <div className="grid gap-4 bg-[#f7f2ef] p-3 md:grid-cols-[minmax(0,1.55fr)_380px] md:p-4">
            <form
              onSubmit={handleSubmit}
              className="rounded-[24px] border border-[#f1d8cf] bg-white shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="inline-flex items-center rounded-full border border-[#f8b5a1] bg-[#fff1eb] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-[#f05a3d]">
                    Envio automatico
                  </div>
                  <h3 className="mt-3 text-lg font-bold text-slate-800">
                    Conte o que aconteceu
                  </h3>
                </div>
                <div className="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-bold text-slate-600">
                  Conta: {currentCompany?.id || user?.companyId || "-"}
                </div>
              </div>

              <div className="space-y-5 px-5 py-5">
                <div>
                  <label className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">
                    Assunto
                  </label>
                  <select
                    value={form.subject}
                    onChange={(event) =>
                      handleChange("subject", event.target.value as SupportSubject)
                    }
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none transition-colors focus:border-[#ff7a45]"
                  >
                    <option value="Duvidas">Duvidas</option>
                    <option value="Passo a passo">Passo a passo</option>
                    <option value="Erro">Erro</option>
                    <option value="Melhoria">Melhoria</option>
                    <option value="Outro">Outro</option>
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">
                    Como voce prefere nossa resposta
                  </label>
                  <div className="grid gap-3 md:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => handleChange("responsePreference", "email")}
                      className={clsx(
                        "rounded-2xl border px-4 py-4 text-left transition-colors",
                        form.responsePreference === "email"
                          ? "border-[#ffb39a] bg-[#fff3ee]"
                          : "border-slate-200 bg-white hover:border-[#ffd1c1]",
                      )}
                    >
                      <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
                        <Mail className="h-4 w-4 text-[#f05a3d]" />
                        Email
                      </div>
                      <p className="mt-2 text-xs leading-6 text-slate-500">
                        Vamos responder no email do seu login.
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleChange("responsePreference", "phone")}
                      className={clsx(
                        "rounded-2xl border px-4 py-4 text-left transition-colors",
                        form.responsePreference === "phone"
                          ? "border-[#ffb39a] bg-[#fff3ee]"
                          : "border-slate-200 bg-white hover:border-[#ffd1c1]",
                      )}
                    >
                      <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
                        <Phone className="h-4 w-4 text-[#f05a3d]" />
                        Celular
                      </div>
                      <p className="mt-2 text-xs leading-6 text-slate-500">
                        Informe um numero para retorno como referencia.
                      </p>
                    </button>
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">
                    Celular para retorno
                  </label>
                  <input
                    type="text"
                    value={form.phone}
                    onChange={(event) => handleChange("phone", event.target.value)}
                    placeholder="(11) 99999-9999"
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none transition-colors focus:border-[#ff7a45]"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">
                    Mensagem
                  </label>
                  <textarea
                    value={form.message}
                    onChange={(event) => handleChange("message", event.target.value)}
                    placeholder="Descreva sua duvida, contexto ou sugestao com o maximo de clareza possivel."
                    rows={7}
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none transition-colors focus:border-[#ff7a45]"
                  />
                </div>

                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <button
                    type="submit"
                    disabled={isSending}
                    className="inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#6c63ff] to-[#4f8cff] px-5 py-3 text-sm font-bold text-white shadow-lg shadow-blue-500/20 transition-transform hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Send className="h-4 w-4" />
                    {isSending ? "Enviando..." : "Enviar mensagem"}
                  </button>
                  <p className="text-sm text-slate-500">
                    A mensagem sera enviada automaticamente com o contexto da conta
                    ja preenchido.
                  </p>
                </div>
              </div>
            </form>

            <div className="space-y-4">
              <div className="rounded-[24px] border border-[#f1d8cf] bg-white shadow-sm">
                <div className="border-b border-slate-200 px-5 py-4">
                  <div className="inline-flex items-center rounded-full border border-[#f8b5a1] bg-[#fff1eb] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-[#f05a3d]">
                    Seu contexto
                  </div>
                  <h3 className="mt-3 text-lg font-bold text-slate-800">
                    A gente ja preenche parte do caminho
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    Para evitar retrabalho, usamos seu login e a conta ativa como
                    referencia no atendimento.
                  </p>
                </div>

                <div className="space-y-3 px-4 py-4">
                  {contextItems.map((item) => (
                    <div
                      key={item.label}
                      className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                    >
                      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                        {item.label}
                      </p>
                      <p className="mt-1 text-sm font-semibold text-slate-800">
                        {isLoadingCompany && item.label === "Conta ativa"
                          ? "Carregando..."
                          : item.value}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-[24px] border border-[#f1d8cf] bg-white shadow-sm">
                <div className="border-b border-slate-200 px-5 py-4">
                  <div className="inline-flex items-center rounded-full border border-[#f8b5a1] bg-[#fff1eb] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-[#f05a3d]">
                    Ajuda rapida
                  </div>
                  <h3 className="mt-3 text-lg font-bold text-slate-800">
                    O que ajuda muito no retorno
                  </h3>
                </div>

                <div className="space-y-3 px-4 py-4">
                  {[
                    "Explique em qual tela voce estava e o que tentou fazer.",
                    "Descreva o impacto: se bloqueia a operacao, vendas ou apenas incomoda a rotina.",
                    "Seja direto: se for duvida, diga se quer passo a passo ou explicacao da funcionalidade.",
                  ].map((tip) => (
                    <div
                      key={tip}
                      className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600"
                    >
                      <div className="flex items-start gap-3">
                        <Sparkles className="mt-0.5 h-4 w-4 text-[#f05a3d]" />
                        <span>{tip}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          )}
        </div>
      </div>
    </div>
  );
};
