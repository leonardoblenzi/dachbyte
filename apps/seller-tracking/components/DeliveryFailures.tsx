import React, { useState, useMemo } from "react";
import { Order, OrderStatus } from "../types";
import { OrderDetail } from "./OrderDetail";
import { AlertTriangle, CheckCircle, Download, Search } from "lucide-react";
import {
  formatCarrierForecast,
  formatDateOrDash,
  getLatestDeliveryFailureEvent,
  isPendingDeliveryFailureOrder,
  normalizeCarrierName,
  normalizeTrackingHistory,
  toText,
} from "../utils";
import { showToast } from "../utils/toast";

interface DeliveryFailuresProps {
  orders: Order[];
}

export const DeliveryFailures: React.FC<DeliveryFailuresProps> = ({
  orders,
}) => {
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [searchText, setSearchText] = useState("");

  // Filter only orders with delivery failures
  const failureOrders = useMemo(() => {
    return orders
      .filter((o) => {
        if (!isPendingDeliveryFailureOrder(o)) {
          return false;
        }

        if (searchText) {
          const lower = searchText.toLowerCase();
          return (
            toText(o.orderNumber).toLowerCase().includes(lower) ||
            toText((o as any).invoiceNumber).toLowerCase().includes(lower) ||
            toText(o.customerName).toLowerCase().includes(lower) ||
            toText(o.trackingCode).toLowerCase().includes(lower)
          );
        }

        return true;
      })
      .sort(
        (a, b) =>
          new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime(),
      );
  }, [orders, searchText]);

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

  const getLatestMovementLabel = (order: Order) => {
    const trackingHistory = normalizeTrackingHistory(order.trackingHistory);
    if (trackingHistory.length === 0) {
      return formatDateOrDash(order.lastUpdate);
    }

    const latestEvent = trackingHistory[trackingHistory.length - 1];
    const eventDate = latestEvent.date
      ? new Date(latestEvent.date)
      : order.lastUpdate
        ? new Date(order.lastUpdate)
        : null;

    const eventDateLabel =
      eventDate && !Number.isNaN(eventDate.getTime())
        ? `${eventDate.toLocaleDateString("pt-BR")} ${eventDate.toLocaleTimeString(
            "pt-BR",
            { hour: "2-digit", minute: "2-digit" },
          )}`
        : "-";

    return [eventDateLabel, toText(latestEvent.status), toText(latestEvent.description)]
      .filter(Boolean)
      .join(" - ");
  };

  const statusLabelMap: Record<string, string> = {
    [OrderStatus.PENDING]: "Pendente",
    [OrderStatus.CREATED]: "Criado",
    [OrderStatus.SHIPPED]: "Em Transito",
    [OrderStatus.DELIVERY_ATTEMPT]: "Saiu para Entrega",
    [OrderStatus.DELIVERED]: "Entregue",
    [OrderStatus.FAILURE]: "Falha",
    [OrderStatus.RETURNED]: "Devolvido",
    [OrderStatus.CANCELED]: "Cancelado",
    [OrderStatus.CHANNEL_LOGISTICS]: "Logistica do Canal",
  };

  const getOrderStatusLabel = (order: Order) =>
    statusLabelMap[order.status] || toText(order.status);

  const handleExportCsvReport = () => {
    if (failureOrders.length === 0) {
      showToast({
        tone: "warning",
        title: "Nada para exportar",
        message: "Nao ha pedidos com falha para exportar.",
      });
      return;
    }

    const escapeCsvValue = (value: unknown) =>
      `"${toText(value).replace(/"/g, '""')}"`;

    const headers = [
      "ID / Pedido",
      "Nota Fiscal",
      "Codigo de envio",
      "Marketplace",
      "Transportadora",
      "Frete Pago",
      "Frete Recalculado",
      "Carrier Recalculado",
      "Diferenca Frete",
      "Prev. Entrega",
      "Previsao Transportadora",
      "Ultima Movimentacao",
      "Motivo da Falha",
      "Status",
      "Observacao",
      "Abrir rastreio",
    ];

    const rows = failureOrders.map((order) => {
      const failEvent = getLatestDeliveryFailureEvent(order);
      return [
        order.orderNumber,
        order.invoiceNumber || "-",
        order.trackingCode || "-",
        order.salesChannel,
        normalizeCarrierName(order.freightType),
        formatCurrency(order.freightValue),
        formatCurrency(order.recalculatedFreightValue),
        order.recalculatedQuotedCarrierName || "Sem cotacao no pedido",
        formatCurrency(getFreightDifference(order)),
        formatDateOrDash(order.estimatedDeliveryDate),
        formatCarrierForecast(order.carrierEstimatedDeliveryDate),
        getLatestMovementLabel(order),
        failEvent?.description || "Falha na entrega",
        getOrderStatusLabel(order),
        order.observation || "-",
        order.trackingUrl || "#",
      ];
    });

    const csvContent = [
      headers.map(escapeCsvValue).join(";"),
      ...rows.map((row) => row.map(escapeCsvValue).join(";")),
    ].join("\n");

    const blob = new Blob([`\uFEFF${csvContent}`], {
      type: "text/csv;charset=utf-8;",
    });
    const fileUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const today = new Date().toISOString().slice(0, 10);

    link.href = fileUrl;
    link.download = `relatorio-falhas-entrega-${today}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(fileUrl);
  };

  return (
    <div className="space-y-6 h-full flex flex-col">
      {/* Header & Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 shrink-0">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/30 p-6 rounded-xl flex items-center justify-between">
          <div>
            <p className="text-red-600 dark:text-red-400 font-medium text-sm">
              Total de Falhas
            </p>
            <h3 className="text-3xl font-bold text-red-800 dark:text-white">
              {failureOrders.length}
            </h3>
            <p className="text-xs text-red-500 mt-1">
              Pedidos aguardando tratativa
            </p>
          </div>
          <AlertTriangle className="w-8 h-8 text-red-300 dark:text-red-500" />
        </div>

        <div className="bg-white dark:bg-dark-card border border-slate-200 dark:border-white/10 p-6 rounded-xl flex items-center gap-4">
          <div className="flex-1">
            <label className="text-sm font-medium text-slate-600 dark:text-slate-300 block mb-2">
              Buscar Pedido
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="Número, cliente, rastreio..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="w-full bg-slate-50 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm focus:border-accent outline-none"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={handleExportCsvReport}
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-slate-200 bg-white px-3.5 text-sm font-semibold tracking-tight text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
          >
            <Download className="h-3.5 w-3.5" />
            Baixar CSV
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-hidden bg-white dark:bg-dark-card rounded-xl border border-slate-200 dark:border-white/10 shadow-sm relative">
        <div className="absolute inset-0 overflow-auto">
          {failureOrders.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 dark:text-slate-500">
              <CheckCircle className="w-12 h-12 mb-2 text-green-400" />
              <p className="font-medium text-lg text-slate-600 dark:text-slate-300">
                Tudo certo!
              </p>
              <p>Nenhuma falha de entrega pendente.</p>
            </div>
          ) : (
            <table className="w-full text-sm text-left border-collapse">
              <thead className="text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase bg-slate-50 dark:bg-dark-card sticky top-0 z-10 shadow-sm backdrop-blur-md">
                <tr>
                  <th className="px-4 py-3 bg-slate-50 dark:bg-[#11131f]">
                    Pedido
                  </th>
                  <th className="px-4 py-3 bg-slate-50 dark:bg-[#11131f]">
                    Cliente
                  </th>
                  <th className="px-4 py-3 bg-slate-50 dark:bg-[#11131f]">
                    Transportadora
                  </th>
                  <th className="px-4 py-3 bg-slate-50 dark:bg-[#11131f]">
                    Última Atualização
                  </th>
                  <th className="px-4 py-3 bg-slate-50 dark:bg-[#11131f]">
                    Motivo da Falha
                  </th>
                  <th className="px-4 py-3 bg-slate-50 dark:bg-[#11131f]">
                    Ação
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                {failureOrders.map((order) => {
                  const failEvent = getLatestDeliveryFailureEvent(order);
                  return (
                    <tr
                      key={order.id}
                      className="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors group"
                    >
                      <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">
                        {order.orderNumber}
                        <div className="text-[10px] text-slate-400">
                          {order.trackingCode || "Sem rastreio"}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        {order.customerName}
                        <div className="text-[10px] text-slate-400">
                          {order.city} - {order.state}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-white/10 text-slate-600 dark:text-slate-300">
                          {normalizeCarrierName(order.freightType)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        {new Date(order.lastUpdate).toLocaleDateString()}
                        <div className="text-[10px] text-slate-400">
                          {new Date(order.lastUpdate).toLocaleTimeString()}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div
                          className="text-red-600 dark:text-red-400 font-medium text-xs max-w-[200px] truncate"
                          title={failEvent?.description}
                        >
                          {failEvent?.description || "Falha na entrega"}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setSelectedOrder(order)}
                          className="px-3 py-1.5 bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 rounded-lg hover:bg-accent hover:text-white hover:border-accent transition-colors text-xs font-medium"
                        >
                          Detalhes
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {selectedOrder && (
        <OrderDetail
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
        />
      )}
    </div>
  );
};
