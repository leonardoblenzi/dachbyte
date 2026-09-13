import React, { useState } from 'react';
import { Truck, TrendingDown, TrendingUp, Loader2, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';

interface FreightComparisonProps {
  orderId: string;
  orderNumber: string;
  freightPaid: number;
  quotedFreightValue?: number | null;
  quotedFreightDate?: string | null;
  onQuote: () => Promise<void>;
}

export const FreightComparison: React.FC<FreightComparisonProps> = ({
  orderId,
  orderNumber,
  freightPaid,
  quotedFreightValue,
  quotedFreightDate,
  onQuote
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleQuote = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      await onQuote();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao cotar frete');
    } finally {
      setIsLoading(false);
    }
  };

  // Calcular diferença e percentual
  const difference = quotedFreightValue !== null && quotedFreightValue !== undefined
    ? freightPaid - quotedFreightValue
    : null;

  const percentDifference = difference !== null && freightPaid > 0
    ? ((difference / freightPaid) * 100).toFixed(1)
    : null;

  const hasQuotation = quotedFreightValue !== null && quotedFreightValue !== undefined;
  const isSaving = difference !== null && difference > 0;
  const isExpensive = difference !== null && difference < 0;

  return (
    <div className="border border-slate-200 dark:border-white/10 rounded-xl p-5 bg-white dark:bg-dark-card shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
            <Truck className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h3 className="font-bold text-slate-800 dark:text-white text-sm">Análise de Frete</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">Compare o frete pago com cotação em tempo real</p>
          </div>
        </div>
        
        <button
          onClick={handleQuote}
          disabled={isLoading}
          className={clsx(
            "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all",
            isLoading 
              ? "bg-slate-300 dark:bg-slate-700 text-slate-500 dark:text-slate-400 cursor-not-allowed"
              : "bg-accent text-white hover:bg-blue-700 shadow-sm hover:shadow-md"
          )}
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Cotando...
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4" />
              {hasQuotation ? 'Atualizar' : 'Cotar Frete'}
            </>
          )}
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/30 rounded-lg">
          <p className="text-sm font-medium text-red-700 dark:text-red-400">{error}</p>
          {error.includes('não autorizada') && (
            <p className="text-xs text-red-600 dark:text-red-300 mt-1">
              ⏳ Aguardando aprovacao do app pela Integradora. Entre em contato com o suporte.
            </p>
          )}
        </div>
      )}

      {/* Content Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {/* Frete Pago */}
        <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/5">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1 uppercase tracking-wide">Frete Pago</p>
          <p className="text-2xl font-bold text-slate-900 dark:text-white">
            R$ {freightPaid.toFixed(2)}
          </p>
        </div>

        {/* Frete Cotado */}
        <div className={clsx(
          "p-4 rounded-xl border transition-all",
          hasQuotation 
            ? isSaving 
              ? 'bg-green-50/50 dark:bg-green-900/10 border-green-200 dark:border-green-900/30'
              : 'bg-orange-50/50 dark:bg-orange-900/10 border-orange-200 dark:border-orange-900/30'
            : 'bg-slate-100 dark:bg-slate-800/50 border-slate-200 dark:border-white/10'
        )}>
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1 uppercase tracking-wide">Frete Cotado</p>
          {hasQuotation ? (
            <p className={clsx(
              "text-2xl font-bold",
              isSaving ? 'text-green-700 dark:text-green-400' : 'text-orange-700 dark:text-orange-400'
            )}>
              R$ {quotedFreightValue!.toFixed(2)}
            </p>
          ) : (
            <p className="text-lg text-slate-400 dark:text-slate-500 italic">
              Não cotado
            </p>
          )}
        </div>
      </div>

      {/* Comparison Result */}
      {hasQuotation && difference !== null && (
        <div className={clsx(
          "p-4 rounded-xl border-2 transition-all",
          isSaving 
            ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-900/40' 
            : 'bg-orange-50 dark:bg-orange-900/20 border-orange-300 dark:border-orange-900/40'
        )}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={clsx(
                "p-2 rounded-lg",
                isSaving ? 'bg-green-100 dark:bg-green-900/40' : 'bg-orange-100 dark:bg-orange-900/40'
              )}>
                {isSaving ? (
                  <TrendingDown className="w-5 h-5 text-green-600 dark:text-green-400" />
                ) : (
                  <TrendingUp className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                )}
              </div>
              <span className={clsx(
                "font-bold text-sm",
                isSaving ? 'text-green-900 dark:text-green-300' : 'text-orange-900 dark:text-orange-300'
              )}>
                {isSaving ? '💰 Economia' : '⚠️ Acréscimo'}
              </span>
            </div>
            
            <div className="text-right">
              <p className={clsx(
                "text-2xl font-bold",
                isSaving ? 'text-green-700 dark:text-green-400' : 'text-orange-700 dark:text-orange-400'
              )}>
                R$ {Math.abs(difference).toFixed(2)}
              </p>
              <p className={clsx(
                "text-xs font-medium",
                isSaving ? 'text-green-600 dark:text-green-500' : 'text-orange-600 dark:text-orange-500'
              )}>
                {percentDifference}% {isSaving ? 'menor' : 'maior'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Última Cotação */}
      {quotedFreightDate && (
        <div className="mt-3 pt-3 border-t border-slate-200 dark:border-white/10">
          <p className="text-xs text-slate-500 dark:text-slate-400 text-center">
            Última cotação: {new Date(quotedFreightDate).toLocaleString('pt-BR')}
          </p>
        </div>
      )}
    </div>
  );
};
