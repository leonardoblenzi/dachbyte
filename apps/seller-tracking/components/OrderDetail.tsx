import React, { useEffect, useState } from "react";
import { Order, OrderStatus } from "../types";
import {
  X,
  MapPin,
  Calendar,
  Truck,
  User,
  CreditCard,
  Pencil,
  Check,
  Loader2,
} from "lucide-react";
import { clsx } from "clsx";
import {
  normalizeCarrierName,
  normalizeTrackingHistory,
  formatDateOrDash,
  formatCarrierForecast,
} from "../utils";
import { fetchWithAuth } from "../utils/authFetch";

const STATUS_TRANSLATIONS: Record<string, string> = {
  PENDING: "Aguardando envio",
  CREATED: "Pedido criado",
  SHIPPED: "Em transito",
  DELIVERY_ATTEMPT: "Saiu para entrega",
  DELIVERED: "Entregue",
  FAILURE: "Falha na entrega",
  RETURNED: "Devolvido",
  CANCELED: "Cancelado",
  CHANNEL_LOGISTICS: "Logistica do canal",
  NEW: "Novo",
  IN_TRANSIT: "Em transito",
  TO_BE_DELIVERED: "Saiu para entrega",
  CLARIFY_DELIVERY_FAIL: "Falha na entrega",
  DELIVERY_DELAY: "Atraso",
  PAYMENT_CONFIRMED: "Pagamento confirmado",
  INVOICED: "Faturado",
  READY_FOR_SHIPPING: "Pronto para envio",
};

const formatDocument = (value: string) => {
  if (!value) return "";
  const cleaned = value.replace(/\D/g, "");
  if (cleaned.length === 11) {
    return cleaned.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  }
  if (cleaned.length === 14) {
    return cleaned.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  }
  return value;
};

const formatPhone = (value: string) => {
  if (!value) return "";
  const cleaned = value.replace(/\D/g, "");
  if (cleaned.length === 11) {
    return cleaned.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3");
  }
  if (cleaned.length === 10) {
    return cleaned.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
  }
  return value;
};

const formatCurrency = (value: number | null | undefined) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }

  return `R$ ${value.toFixed(2)}`;
};

const getFreightDifference = (order: Order) => {
  if (
    order.freightValue === null ||
    order.freightValue === undefined ||
    order.recalculatedFreightValue === null ||
    order.recalculatedFreightValue === undefined
  ) {
    return null;
  }

  return order.freightValue - order.recalculatedFreightValue;
};

const formatMatchLabel = (value: boolean | null | undefined) => {
  if (value === null || value === undefined) return "-";
  return value ? "Sim" : "Nao";
};

const formatDateTime = (value: Date | string | null | undefined) => {
  if (!value) return "-";
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "-" : parsed.toLocaleString("pt-BR");
};

const inferTrackingSourceLabel = (order: Order) => {
  if (order.trackingSourceLabel) {
    return order.trackingSourceLabel;
  }

  const trackingUrl = String(order.trackingUrl || "");
  const normalizedInvoice = String(order.invoiceNumber || "").replace(/\D/g, "");
  const normalizedTrackingCode = String(order.trackingCode || "").replace(/\D/g, "");
  const normalizedTrackingKey = String(order.trackingCode || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  const looksLikeCorreiosObjectCode = /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(
    normalizedTrackingKey,
  );

  if (/ssw\.inf\.br/i.test(trackingUrl)) {
    if (!normalizedInvoice && normalizedTrackingKey.length >= 44) {
      return "SSW com Codigo XML";
    }

    if (!normalizedInvoice && normalizedTrackingCode) {
      return "SSW com codigo envio/NF";
    }

    return "SSW com NF";
  }

  if (/ondeestameupedido\.com|intelipost/i.test(trackingUrl)) {
    return "Intelipost";
  }

  if (
    looksLikeCorreiosObjectCode &&
    /rastreamento\.correios\.com\.br|correios/i.test(trackingUrl)
  ) {
    return "Correios";
  }

  return "-";
};

const createManualDataDraft = (order: Order) => ({
  customerName: order.customerName || "",
  corporateName: order.corporateName || "",
  cpf: order.cpf || "",
  cnpj: order.cnpj || "",
  phone: order.phone || "",
  mobile: order.mobile || "",
  recipient: order.recipient || "",
  address: order.address || "",
  number: order.number || "",
  complement: order.complement || "",
  neighborhood: order.neighborhood || "",
  city: order.city || "",
  state: order.state || "",
  zipCode: order.zipCode || "",
  invoiceNumber: order.invoiceNumber || "",
  trackingCode: order.trackingCode || "",
  trackingUrl: order.trackingUrl || "",
  manualCustomStatus: order.manualCustomStatus || "",
  observation: order.observation || "",
});

interface OrderDetailProps {
  order: Order;
  onClose: () => void;
  onOrderUpdated?: (order: Order) => void;
}

export const OrderDetail: React.FC<OrderDetailProps> = ({
  order: initialOrder,
  onClose,
  onOrderUpdated,
}) => {
  const [resolvedOrder, setResolvedOrder] = useState<Order>(initialOrder);
  const [isEditingFreightType, setIsEditingFreightType] = useState(false);
  const [freightTypeDraft, setFreightTypeDraft] = useState(
    initialOrder.freightType || "",
  );
  const [isSavingFreightType, setIsSavingFreightType] = useState(false);
  const [freightTypeError, setFreightTypeError] = useState("");
  const [isEditingManualData, setIsEditingManualData] = useState(false);
  const [manualDataDraft, setManualDataDraft] = useState(
    createManualDataDraft(initialOrder),
  );
  const [isSavingManualData, setIsSavingManualData] = useState(false);
  const [manualDataError, setManualDataError] = useState("");
  const [customStatusOptions, setCustomStatusOptions] = useState<string[]>([]);
  const [saveStatusForOtherOrders, setSaveStatusForOtherOrders] = useState(false);
  const order = resolvedOrder;
  const trackingHistory = normalizeTrackingHistory(order.trackingHistory);
  const sortedHistory = [...trackingHistory].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  useEffect(() => {
    let isMounted = true;
    setResolvedOrder(initialOrder);
    setSaveStatusForOtherOrders(false);

    fetchWithAuth(`/api/orders/${initialOrder.id}`)
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok || !data) {
          throw new Error("Nao foi possivel carregar os detalhes do pedido.");
        }

        if (isMounted) {
          setResolvedOrder(data as Order);
          setManualDataDraft(createManualDataDraft(data as Order));
        }
      })
      .catch(() => {
        if (isMounted) {
          setResolvedOrder(initialOrder);
          setManualDataDraft(createManualDataDraft(initialOrder));
        }
      });

    fetchWithAuth("/api/orders/custom-statuses")
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok || !data) {
          throw new Error("Nao foi possivel carregar os status personalizados.");
        }

        if (isMounted) {
          const labels = Array.isArray(data.statuses)
            ? data.statuses
                .map((item: any) => String(item?.label || "").trim())
                .filter(Boolean)
            : [];
          setCustomStatusOptions(Array.from(new Set(labels)));
        }
      })
      .catch(() => {
        if (isMounted) {
          setCustomStatusOptions([]);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [initialOrder.id]);

  const handleStartFreightEdit = () => {
    setFreightTypeDraft(order.freightType || "");
    setFreightTypeError("");
    setIsEditingFreightType(true);
  };

  const handleCancelFreightEdit = () => {
    setFreightTypeDraft(order.freightType || "");
    setFreightTypeError("");
    setIsEditingFreightType(false);
  };

  const handleSaveFreightType = async () => {
    const normalizedFreightType = freightTypeDraft.trim();

    if (!normalizedFreightType) {
      setFreightTypeError("Informe o nome da transportadora.");
      return;
    }

    setIsSavingFreightType(true);
    setFreightTypeError("");

    try {
      const response = await fetchWithAuth(`/api/orders/${order.id}/freight-type`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ freightType: normalizedFreightType }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data?.order) {
        throw new Error(
          data?.error || "Nao foi possivel atualizar a transportadora.",
        );
      }

      setResolvedOrder(data.order as Order);
      setManualDataDraft(createManualDataDraft(data.order as Order));
      onOrderUpdated?.(data.order as Order);
      setIsEditingFreightType(false);
    } catch (error) {
      setFreightTypeError(
        error instanceof Error
          ? error.message
          : "Nao foi possivel atualizar a transportadora.",
      );
    } finally {
      setIsSavingFreightType(false);
    }
  };

  const handleStartManualEdit = () => {
    setManualDataDraft(createManualDataDraft(order));
    setManualDataError("");
    setSaveStatusForOtherOrders(false);
    setIsEditingManualData(true);
  };

  const handleCancelManualEdit = () => {
    setManualDataDraft(createManualDataDraft(order));
    setManualDataError("");
    setSaveStatusForOtherOrders(false);
    setIsEditingManualData(false);
  };

  const handleManualFieldChange = (
    field: keyof ReturnType<typeof createManualDataDraft>,
    value: string,
  ) => {
    setManualDataDraft((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleSaveManualData = async () => {
    if (!manualDataDraft.customerName.trim()) {
      setManualDataError("Informe o nome do cliente.");
      return;
    }

    setIsSavingManualData(true);
    setManualDataError("");

    try {
      const response = await fetchWithAuth(`/api/orders/${order.id}/manual-data`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manualDataDraft),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data?.order) {
        throw new Error(
          data?.error || "Nao foi possivel atualizar os dados do pedido.",
        );
      }

      setResolvedOrder(data.order as Order);
      setManualDataDraft(createManualDataDraft(data.order as Order));
      onOrderUpdated?.(data.order as Order);
      setIsEditingManualData(false);

      const normalizedCustomStatus = manualDataDraft.manualCustomStatus.trim();
      if (saveStatusForOtherOrders && normalizedCustomStatus) {
        const statusResponse = await fetchWithAuth("/api/orders/custom-statuses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: normalizedCustomStatus }),
        });

        if (statusResponse.ok) {
          setCustomStatusOptions((current) =>
            Array.from(new Set([normalizedCustomStatus, ...current])),
          );
        } else {
          console.error("Falha ao salvar status personalizado para reutilizacao.");
        }
      }
    } catch (error) {
      setManualDataError(
        error instanceof Error
          ? error.message
          : "Nao foi possivel atualizar os dados do pedido.",
      );
    } finally {
      setIsSavingManualData(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-dark-card w-full max-w-5xl max-h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 border border-slate-200 dark:border-white/10">
        <div className="flex items-center justify-between p-6 border-b border-slate-100 dark:border-white/10 bg-slate-50/50 dark:bg-black/20">
          <div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-white flex flex-wrap items-center gap-2">
              <span>Pedido #{order.orderNumber}</span>
              {!isEditingManualData && (
                <>
                  <span className="text-slate-400 dark:text-slate-500">&gt;</span>
                  <button
                    type="button"
                    onClick={handleStartManualEdit}
                    className="inline-flex items-center gap-1 rounded-lg bg-gradient-to-r from-orange-500 to-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-transform hover:scale-[1.02] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Editar Dados
                  </button>
                </>
              )}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Detalhes completos, frete e rastreamento
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-200 dark:hover:bg-white/10 rounded-full transition-colors text-slate-500 dark:text-slate-400"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/30 dark:bg-white/5">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2 text-slate-800 dark:text-white font-semibold text-sm">
                      <User className="w-4 h-4 text-accent" /> Cliente
                    </div>
                  </div>
                  <p className="font-medium text-slate-700 dark:text-slate-200">
                    {order.customerName}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Destinatario: {order.recipient || "-"}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Documento: {formatDocument(order.cpf || order.cnpj || "") || "-"}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Telefone: {formatPhone(order.mobile || order.phone || "") || "-"}
                  </p>
                </div>

                <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/30 dark:bg-white/5">
                  <div className="flex items-center gap-2 mb-2 text-slate-800 dark:text-white font-semibold text-sm">
                    <MapPin className="w-4 h-4 text-accent" /> Entrega
                  </div>
                  <p className="text-sm text-slate-700 dark:text-slate-200">
                    {order.address}, {order.number}
                  </p>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {order.neighborhood || "-"}
                  </p>
                  <p className="text-sm font-medium mt-1 text-slate-700 dark:text-slate-200">
                    {order.city} - {order.state}
                  </p>
                  <p className="text-xs text-slate-400">{order.zipCode}</p>
                </div>

                <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/30 dark:bg-white/5 md:col-span-2">
                  <div className="flex items-center gap-2 mb-3 text-slate-800 dark:text-white font-semibold text-sm">
                    <Truck className="w-4 h-4 text-accent" /> Analise de frete
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white/70 dark:bg-black/10 p-3">
                      <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
                        Frete pago
                      </p>
                      <p className="text-lg font-semibold text-slate-800 dark:text-white">
                        {formatCurrency(order.freightValue)}
                      </p>
                      <div className="mt-2 space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            Transportadora real: {normalizeCarrierName(order.freightType)}
                          </p>
                          {!isEditingFreightType && (
                            <button
                              type="button"
                              onClick={handleStartFreightEdit}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5 dark:hover:text-white"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              Editar
                            </button>
                          )}
                        </div>

                        {isEditingFreightType && (
                          <div className="space-y-2">
                            <input
                              type="text"
                              value={freightTypeDraft}
                              onChange={(event) => setFreightTypeDraft(event.target.value)}
                              placeholder="Digite a transportadora real"
                              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                            />
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={handleSaveFreightType}
                                disabled={isSavingFreightType}
                                className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
                              >
                                {isSavingFreightType ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Check className="h-3.5 w-3.5" />
                                )}
                                Salvar transportadora
                              </button>
                              <button
                                type="button"
                                onClick={handleCancelFreightEdit}
                                disabled={isSavingFreightType}
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5"
                              >
                                Cancelar
                              </button>
                            </div>
                            {freightTypeError && (
                              <p className="text-xs text-red-600 dark:text-red-300">
                                {freightTypeError}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>


                    <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white/70 dark:bg-black/10 p-3">
                      <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
                        Frete recalculado atual
                      </p>
                      <p className="text-lg font-semibold text-slate-800 dark:text-white">
                        {formatCurrency(order.recalculatedFreightValue)}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 break-all">
                        Transportadora: {order.recalculatedQuotedCarrierName || "-"}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Diferenca frete: {formatCurrency(getFreightDifference(order))}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Recalculado em: {formatDateTime(order.recalculatedFreightDate)}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400 break-all">
                        Id da cotacao intelipost: {order.originalQuotedFreightQuotationId || "-"}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Carrier coincide: {formatMatchLabel(order.freightCarrierMatchesRecalculatedQuote)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-slate-700 dark:text-slate-200">
                    <p>
                      <span className="text-slate-500 dark:text-slate-400">Rastreio:</span>{" "}
                      {inferTrackingSourceLabel(order)}
                    </p>
                    <p>
                      <span className="text-slate-500 dark:text-slate-400">Canal:</span>{" "}
                      {order.salesChannel}
                    </p>
                    <p>
                      <span className="text-slate-500 dark:text-slate-400">NF:</span>{" "}
                      <span className="break-all whitespace-normal">{order.invoiceNumber || "-"}</span>
                    </p>
                    <p>
                      <span className="text-slate-500 dark:text-slate-400">Chave NF:</span>{" "}
                      <span className="break-all whitespace-normal">
                        {order.invoiceAccessKey || "-"}
                      </span>
                    </p>
                    <p>
                      <span className="text-slate-500 dark:text-slate-400">Codigo de envio:</span>{" "}
                      <span className="break-all whitespace-normal">{order.trackingCode || "-"}</span>
                    </p>
                    <p>
                      <span className="text-slate-500 dark:text-slate-400">
                        Status personalizado:
                      </span>{" "}
                      <span className="break-all whitespace-normal">
                        {order.manualCustomStatus || "-"}
                      </span>
                    </p>
                    <p className="md:col-span-2">
                      <span className="text-slate-500 dark:text-slate-400">Observacao:</span>{" "}
                      <span className="break-all whitespace-normal">
                        {order.observation || "-"}
                      </span>
                    </p>
                    <p className="md:col-span-2">
                      <span className="text-slate-500 dark:text-slate-400">Link de rastreio:</span>{" "}
                      {order.trackingUrl ? (
                        <a
                          href={order.trackingUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all whitespace-normal text-blue-600 hover:underline dark:text-blue-300"
                        >
                          {order.trackingUrl}
                        </a>
                      ) : (
                        "-"
                      )}
                    </p>
                  </div>
                </div>

                <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/30 dark:bg-white/5">
                  <div className="flex items-center gap-2 mb-2 text-slate-800 dark:text-white font-semibold text-sm">
                    <Calendar className="w-4 h-4 text-accent" /> Prazos
                  </div>
                  <p className="text-sm text-slate-700 dark:text-slate-200">
                    <span className="text-slate-500 dark:text-slate-400">Emissao:</span>{" "}
                    {formatDateOrDash(order.platformCreatedAt || order.shippingDate)}
                  </p>
                  <p className="text-sm text-slate-700 dark:text-slate-200">
                    <span className="text-slate-500 dark:text-slate-400">Data de envio do pedido:</span>{" "}
                    {formatDateOrDash(order.maxShippingDeadline || order.shippingDate)}
                  </p>
                  <p
                    className={clsx(
                      "text-sm font-medium",
                      order.isDelayed
                        ? "text-red-600 dark:text-red-400"
                        : "text-green-600 dark:text-green-400",
                    )}
                  >
                    <span className="text-slate-500 dark:text-slate-400 font-normal">
                      Previsto:
                    </span>{" "}
                    {formatDateOrDash(order.estimatedDeliveryDate)}
                  </p>
                  <p className="text-sm text-slate-700 dark:text-slate-200">
                    <span className="text-slate-500 dark:text-slate-400">Previsao transportadora:</span>{" "}
                    {formatCarrierForecast(order.carrierEstimatedDeliveryDate)}
                  </p>
                </div>
              </div>

              {order.isDelayed && order.status !== OrderStatus.DELIVERED && (
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/30 p-4 rounded-lg flex items-start gap-3">
                  <div className="p-2 bg-red-100 dark:bg-red-900/50 rounded-full text-red-600 dark:text-red-300">
                    <CreditCard className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="font-bold text-red-700 dark:text-red-400 text-sm">
                      Atraso pela transportadora detectado
                    </h4>
                    <p className="text-xs text-red-600 dark:text-red-300 mt-1">
                      A data atual excede o prazo da transportadora e o pedido ainda nao consta como entregue.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="border-l border-slate-200 dark:border-white/10 pl-8 relative">
              <h3 className="font-bold text-slate-800 dark:text-white mb-6">
                Historico de rastreamento
              </h3>

              <div className="space-y-8">
                {sortedHistory.length > 0 ? (
                  sortedHistory.map((event, idx) => (
                    <div key={idx} className="relative group">
                      {idx !== sortedHistory.length - 1 && (
                        <div className="absolute top-2 left-[-33px] w-0.5 h-full bg-slate-200 dark:bg-white/10 group-last:hidden"></div>
                      )}

                      <div
                        className={clsx(
                          "absolute top-1.5 left-[-37px] w-2.5 h-2.5 rounded-full border-2",
                          idx === 0
                            ? "bg-accent border-accent shadow-[0_0_0_4px_rgba(59,130,246,0.2)]"
                            : "bg-white dark:bg-slate-700 border-slate-300 dark:border-slate-600",
                        )}
                      ></div>

                      <div>
                        <p className="font-semibold text-slate-800 dark:text-white text-sm">
                          {STATUS_TRANSLATIONS[event.status] || event.status}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                          {event.description}
                        </p>
                        <div className="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
                          <span>{new Date(event.date).toLocaleString()}</span>
                          {event.city && (
                            <span>
                              - {event.city}
                              {event.state ? `/${event.state}` : ""}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-slate-400 text-sm italic">
                    Aguardando primeira atualizacao de rastreamento...
                  </div>
                )}

                <div className="relative">
                  <div className="absolute top-1.5 left-[-37px] w-2.5 h-2.5 rounded-full border-2 bg-slate-200 dark:bg-slate-700 border-slate-300 dark:border-slate-600"></div>
                  <div>
                    <p className="font-semibold text-slate-600 dark:text-slate-300 text-sm">
                      IMPORTADO
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Pedido importado para o sistema
                    </p>
                    <div className="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500 mt-1">
                      <span>{new Date(order.shippingDate).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {isEditingManualData && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
          onClick={handleCancelManualEdit}
        >
          <div
            className="w-full max-w-4xl max-h-[88vh] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-dark-card"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-black/20">
              <div className="flex items-center gap-2 text-slate-800 dark:text-white font-semibold text-sm">
                <Pencil className="w-4 h-4 text-accent" />
                Edicao manual do pedido #{order.orderNumber}
              </div>
              <button
                type="button"
                onClick={handleCancelManualEdit}
                className="rounded-full p-2 text-slate-500 transition-colors hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-white/10"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="max-h-[calc(88vh-140px)] overflow-auto p-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input
                  type="text"
                  value={manualDataDraft.customerName}
                  onChange={(event) =>
                    handleManualFieldChange("customerName", event.target.value)
                  }
                  placeholder="Nome do cliente"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
                <input
                  type="text"
                  value={manualDataDraft.recipient}
                  onChange={(event) =>
                    handleManualFieldChange("recipient", event.target.value)
                  }
                  placeholder="Destinatario"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
                <div className="md:col-span-2 rounded-lg border border-slate-200 bg-white/80 p-3 dark:border-white/10 dark:bg-white/5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Adicionar status personalizado
                  </p>
                  <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                    <select
                      value={
                        customStatusOptions.includes(manualDataDraft.manualCustomStatus)
                          ? manualDataDraft.manualCustomStatus
                          : ""
                      }
                      onChange={(event) =>
                        handleManualFieldChange(
                          "manualCustomStatus",
                          event.target.value,
                        )
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                    >
                      <option value="">Selecionar status salvo</option>
                      {customStatusOptions.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={manualDataDraft.manualCustomStatus}
                      onChange={(event) =>
                        handleManualFieldChange("manualCustomStatus", event.target.value)
                      }
                      placeholder="Digite o status personalizado"
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                    />
                  </div>
                  <label className="mt-2 inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={saveStatusForOtherOrders}
                      onChange={(event) =>
                        setSaveStatusForOtherOrders(event.target.checked)
                      }
                      className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600"
                    />
                    Salvar status personalizado para usar em outros pedidos
                  </label>
                </div>
                <input
                  type="text"
                  value={manualDataDraft.cpf}
                  onChange={(event) => handleManualFieldChange("cpf", event.target.value)}
                  placeholder="CPF"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
                <input
                  type="text"
                  value={manualDataDraft.cnpj}
                  onChange={(event) => handleManualFieldChange("cnpj", event.target.value)}
                  placeholder="CNPJ"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
                <input
                  type="text"
                  value={manualDataDraft.phone}
                  onChange={(event) => handleManualFieldChange("phone", event.target.value)}
                  placeholder="Telefone"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
                <input
                  type="text"
                  value={manualDataDraft.mobile}
                  onChange={(event) => handleManualFieldChange("mobile", event.target.value)}
                  placeholder="Celular"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
                <input
                  type="text"
                  value={manualDataDraft.address}
                  onChange={(event) => handleManualFieldChange("address", event.target.value)}
                  placeholder="Endereco"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white md:col-span-2"
                />
                <input
                  type="text"
                  value={manualDataDraft.number}
                  onChange={(event) => handleManualFieldChange("number", event.target.value)}
                  placeholder="Numero"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
                <input
                  type="text"
                  value={manualDataDraft.complement}
                  onChange={(event) =>
                    handleManualFieldChange("complement", event.target.value)
                  }
                  placeholder="Complemento"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
                <input
                  type="text"
                  value={manualDataDraft.neighborhood}
                  onChange={(event) =>
                    handleManualFieldChange("neighborhood", event.target.value)
                  }
                  placeholder="Bairro"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
                <input
                  type="text"
                  value={manualDataDraft.zipCode}
                  onChange={(event) =>
                    handleManualFieldChange("zipCode", event.target.value)
                  }
                  placeholder="CEP"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
                <input
                  type="text"
                  value={manualDataDraft.city}
                  onChange={(event) => handleManualFieldChange("city", event.target.value)}
                  placeholder="Cidade"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
                <input
                  type="text"
                  value={manualDataDraft.state}
                  onChange={(event) => handleManualFieldChange("state", event.target.value)}
                  placeholder="UF"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
                <input
                  type="text"
                  value={manualDataDraft.invoiceNumber}
                  onChange={(event) =>
                    handleManualFieldChange("invoiceNumber", event.target.value)
                  }
                  placeholder="Nota fiscal"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
                <input
                  type="text"
                  value={manualDataDraft.trackingCode}
                  onChange={(event) =>
                    handleManualFieldChange("trackingCode", event.target.value)
                  }
                  placeholder="Codigo de envio"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
                <input
                  type="text"
                  value={manualDataDraft.trackingUrl}
                  onChange={(event) =>
                    handleManualFieldChange("trackingUrl", event.target.value)
                  }
                  placeholder="Link de rastreio"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white md:col-span-2"
                />
                <textarea
                  value={manualDataDraft.observation}
                  onChange={(event) =>
                    handleManualFieldChange("observation", event.target.value)
                  }
                  placeholder="Observacao interna do pedido"
                  rows={3}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white md:col-span-2"
                />
              </div>
            </div>

            <div className="border-t border-slate-100 p-4 dark:border-white/10">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleSaveManualData}
                  disabled={isSavingManualData}
                  className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
                >
                  {isSavingManualData ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  Salvar dados
                </button>
                <button
                  type="button"
                  onClick={handleCancelManualEdit}
                  disabled={isSavingManualData}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5"
                >
                  Cancelar
                </button>
              </div>
              {manualDataError && (
                <p className="mt-3 text-xs text-red-600 dark:text-red-300">
                  {manualDataError}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

