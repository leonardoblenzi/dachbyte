import React, { useEffect, useState } from "react";
import { Calendar, Loader2, Mail, Sparkles, Wrench } from "lucide-react";
import { ReleaseNoteDetail, ReleaseNoteSummary } from "../types";
import { fetchWithAuth } from "../utils/authFetch";

export const LatestUpdates: React.FC = () => {
  const [items, setItems] = useState<ReleaseNoteSummary[]>([]);
  const [selectedItem, setSelectedItem] = useState<ReleaseNoteDetail | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const loadItems = async () => {
      setLoading(true);
      setError("");

      try {
        const response = await fetchWithAuth("/api/release-notes");
        const data = await response.json().catch(() => []);

        if (!response.ok) {
          throw new Error(data.error || "Nao foi possivel carregar as atualizacoes.");
        }

        setItems(Array.isArray(data) ? data : []);

        if (Array.isArray(data) && data.length > 0) {
          void handleSelect(data[0].id);
        } else {
          setSelectedItem(null);
        }
      } catch (err: any) {
        setError(err.message || "Erro ao carregar atualizacoes.");
      } finally {
        setLoading(false);
      }
    };

    void loadItems();
  }, []);

  const handleSelect = async (id: string) => {
    setLoadingDetail(true);

    try {
      const response = await fetchWithAuth(`/api/release-notes/${id}`);
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Nao foi possivel carregar a atualizacao.");
      }

      setSelectedItem(data);
    } catch (err: any) {
      setError(err.message || "Erro ao carregar a atualizacao.");
    } finally {
      setLoadingDetail(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="w-8 h-8 animate-spin text-accent dark:text-neon-blue" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[380px_minmax(0,1fr)] gap-6">
      <div className="glass-card rounded-xl border border-slate-200 dark:border-white/10 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5">
          <h2 className="text-lg font-bold text-slate-800 dark:text-white">
            Últimas Atualizações
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Histórico dos release notes disparados para a plataforma.
          </p>
        </div>

        <div className="max-h-[75vh] overflow-auto divide-y divide-slate-100 dark:divide-white/5">
          {items.length === 0 ? (
            <div className="p-6 text-sm text-slate-500 dark:text-slate-400">
              Nenhuma atualização publicada ainda.
            </div>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                onClick={() => void handleSelect(item.id)}
                className={`w-full text-left p-4 transition-colors ${
                  selectedItem?.id === item.id
                    ? "bg-blue-50 dark:bg-blue-900/10"
                    : "hover:bg-slate-50 dark:hover:bg-white/5"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-blue-600 dark:text-blue-300 font-bold">
                      Versão {item.version}
                    </p>
                    <h3 className="mt-1 font-semibold text-slate-800 dark:text-white">
                      {item.title}
                    </h3>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 line-clamp-3">
                      {item.summary}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-slate-400">
                    {new Date(item.createdAt).toLocaleDateString("pt-BR")}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 px-2 py-2">
                    <div className="flex items-center justify-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                      <Sparkles className="w-3 h-3" />
                      Novidades
                    </div>
                    <p className="mt-1 font-bold text-slate-800 dark:text-white">
                      {item.featureCount}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 px-2 py-2">
                    <div className="flex items-center justify-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                      <Wrench className="w-3 h-3" />
                      Ajustes
                    </div>
                    <p className="mt-1 font-bold text-slate-800 dark:text-white">
                      {item.adjustmentCount}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 px-2 py-2">
                    <div className="flex items-center justify-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                      <Mail className="w-3 h-3" />
                      Envios
                    </div>
                    <p className="mt-1 font-bold text-slate-800 dark:text-white">
                      {item.recipientCount}
                    </p>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="glass-card rounded-xl border border-slate-200 dark:border-white/10 overflow-hidden min-h-[75vh]">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5">
          {selectedItem ? (
            <>
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-blue-600 dark:text-blue-300 font-bold">
                <Calendar className="w-3 h-3" />
                {new Date(selectedItem.createdAt).toLocaleString("pt-BR")}
              </div>
              <h2 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">
                {selectedItem.title}
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Versão {selectedItem.version}
              </p>
            </>
          ) : (
            <h2 className="text-lg font-bold text-slate-800 dark:text-white">
              Prévia da atualização
            </h2>
          )}
        </div>

        <div className="h-[70vh] bg-slate-100 dark:bg-slate-900">
          {loadingDetail ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="w-8 h-8 animate-spin text-accent dark:text-neon-blue" />
            </div>
          ) : selectedItem ? (
            <iframe
              title={selectedItem.title}
              className="w-full h-full bg-white"
              srcDoc={selectedItem.htmlContent}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-slate-400">
              Selecione uma atualização para visualizar o template enviado.
            </div>
          )}
        </div>

        {error && (
          <div className="px-5 py-3 border-t border-slate-200 dark:border-white/10 text-sm text-red-600 dark:text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  );
};
