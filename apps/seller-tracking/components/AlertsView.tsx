import React, { useEffect, useMemo, useState } from "react";
import { Order, OrderStatus } from "../types";
import { OrderDetail } from "./OrderDetail";
import {
  AlertTriangle,
  Clock,
  CalendarX,
  Eye,
  AlertOctagon,
  CheckCircle,
} from "lucide-react";
import { clsx } from "clsx";
import {
  isCarrierDelayedOrder,
  normalizeCarrierName,
  parseOptionalDate,
  formatDateOrDash,
  isChannelManagedOrder,
} from "../utils";

interface AlertsViewProps {
  orders: Order[];
  initialFilters?: any;
}

type AlertTab = "critical" | "risk";

const DAY_MS = 1000 * 60 * 60 * 24;

const isClosedOrder = (order: Order) =>
  order.status === OrderStatus.DELIVERED ||
  order.status === OrderStatus.FAILURE ||
  order.status === OrderStatus.RETURNED ||
  order.status === OrderStatus.CANCELED;

export const AlertsView: React.FC<AlertsViewProps> = ({
  orders,
  initialFilters,
}) => {
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [minDaysDelayed, setMinDaysDelayed] = useState<number>(0);
  const [activeTab, setActiveTab] = useState<AlertTab>(
    initialFilters?.alertTab === "risk" ? "risk" : "critical",
  );

  useEffect(() => {
    if (initialFilters?.alertTab === "risk") {
      setActiveTab("risk");
      return;
    }

    if (initialFilters?.alertTab === "critical") {
      setActiveTab("critical");
    }
  }, [initialFilters?.alertTab]);

  const getDelayDays = (order: Order) => {
    if (!isCarrierDelayedOrder(order)) return 0;
    const targetDate = parseOptionalDate(order.carrierEstimatedDeliveryDate);
    if (!targetDate) return 0;
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - targetDate.getTime());
    return Math.ceil(diffTime / DAY_MS);
  };

  const getRemainingDays = (order: Order) => {
    const targetDate = parseOptionalDate(order.estimatedDeliveryDate);
    if (!targetDate) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    targetDate.setHours(0, 0, 0, 0);

    return Math.ceil((targetDate.getTime() - today.getTime()) / DAY_MS);
  };

  const eligibleOrders = useMemo(
    () =>
      orders.filter((order) => {
        if (order.status === OrderStatus.CANCELED) return false;
        if (isChannelManagedOrder(order)) return false;
        return true;
      }),
    [orders],
  );

  const criticalAlerts = useMemo(() => {
    return eligibleOrders
      .filter((order) => {
        const hasDelay = isCarrierDelayedOrder(order);
        const hasFailure =
          order.status === OrderStatus.FAILURE || order.status === OrderStatus.RETURNED;

        if (!hasDelay && !hasFailure) return false;

        return getDelayDays(order) >= minDaysDelayed;
      })
      .sort((left, right) => getDelayDays(right) - getDelayDays(left));
  }, [eligibleOrders, minDaysDelayed]);

  const riskAlerts = useMemo(() => {
    return eligibleOrders
      .filter((order) => {
        if (isClosedOrder(order)) return false;
        const remainingDays = getRemainingDays(order);
        return remainingDays === 1 || remainingDays === 2;
      })
      .sort((left, right) => {
        const leftDays = getRemainingDays(left) ?? 99;
        const rightDays = getRemainingDays(right) ?? 99;
        return leftDays - rightDays;
      });
  }, [eligibleOrders]);

  const displayedOrders = activeTab === "risk" ? riskAlerts : criticalAlerts;

  return (
    <div className="space-y-6 h-full flex flex-col">
      <div className="flex flex-wrap gap-3 shrink-0">
        <button
          onClick={() => setActiveTab("critical")}
          className={clsx(
            "inline-flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition-colors",
            activeTab === "critical"
              ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/30 dark:bg-red-900/20 dark:text-red-300"
              : "border-slate-200 bg-white text-slate-600 dark:border-white/10 dark:bg-dark-card dark:text-slate-300",
          )}
        >
          <AlertTriangle className="h-4 w-4" />
          Alertas Ativos
          <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs dark:bg-black/20">
            {criticalAlerts.length}
          </span>
        </button>
        <button
          onClick={() => setActiveTab("risk")}
          className={clsx(
            "inline-flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition-colors",
            activeTab === "risk"
              ? "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/30 dark:bg-orange-900/20 dark:text-orange-300"
              : "border-slate-200 bg-white text-slate-600 dark:border-white/10 dark:bg-dark-card dark:text-slate-300",
          )}
        >
          <Clock className="h-4 w-4" />
          Risco de atraso
          <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs dark:bg-black/20">
            {riskAlerts.length}
          </span>
        </button>
      </div>

      {activeTab === "critical" ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 shrink-0">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/30 p-6 rounded-xl flex items-center justify-between">
            <div>
              <p className="text-red-600 dark:text-red-400 font-medium text-sm">
                Total de Alertas
              </p>
              <h3 className="text-3xl font-bold text-red-800 dark:text-white">
                {criticalAlerts.length}
              </h3>
            </div>
            <AlertTriangle className="w-8 h-8 text-red-300 dark:text-red-500" />
          </div>

          <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-100 dark:border-orange-900/30 p-6 rounded-xl flex items-center justify-between">
            <div>
              <p className="text-orange-600 dark:text-orange-400 font-medium text-sm">
                Atraso Crítico (+5 dias)
              </p>
              <h3 className="text-3xl font-bold text-orange-800 dark:text-white">
                {criticalAlerts.filter((order) => getDelayDays(order) > 5).length}
              </h3>
            </div>
            <AlertOctagon className="w-8 h-8 text-orange-300 dark:text-orange-500" />
          </div>

          <div className="bg-white dark:bg-dark-card border border-slate-200 dark:border-white/10 p-6 rounded-xl flex items-center gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium text-slate-600 dark:text-slate-300 block mb-2">
                Filtrar por dias de atraso
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="0"
                  max="30"
                  value={minDaysDelayed}
                  onChange={(e) => setMinDaysDelayed(parseInt(e.target.value))}
                  className="w-full h-2 bg-slate-200 dark:bg-white/10 rounded-lg appearance-none cursor-pointer accent-red-500"
                />
                <span className="w-8 text-sm font-bold text-slate-700 dark:text-white">
                  {minDaysDelayed}+
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 shrink-0">
          <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-100 dark:border-orange-900/30 p-6 rounded-xl flex items-center justify-between">
            <div>
              <p className="text-orange-600 dark:text-orange-400 font-medium text-sm">
                Pedidos em risco
              </p>
              <h3 className="text-3xl font-bold text-orange-800 dark:text-white">
                {riskAlerts.length}
              </h3>
            </div>
            <Clock className="w-8 h-8 text-orange-300 dark:text-orange-500" />
          </div>

          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-900/30 p-6 rounded-xl flex items-center justify-between">
            <div>
              <p className="text-amber-600 dark:text-amber-400 font-medium text-sm">
                Vencem em 1 dia
              </p>
              <h3 className="text-3xl font-bold text-amber-800 dark:text-white">
                {riskAlerts.filter((order) => getRemainingDays(order) === 1).length}
              </h3>
            </div>
            <CalendarX className="w-8 h-8 text-amber-300 dark:text-amber-500" />
          </div>

          <div className="bg-white dark:bg-dark-card border border-slate-200 dark:border-white/10 p-6 rounded-xl flex items-center justify-between">
            <div>
              <p className="text-slate-600 dark:text-slate-300 font-medium text-sm">
                Vencem em 2 dias
              </p>
              <h3 className="text-3xl font-bold text-slate-800 dark:text-white">
                {riskAlerts.filter((order) => getRemainingDays(order) === 2).length}
              </h3>
            </div>
            <Clock className="w-8 h-8 text-slate-300 dark:text-slate-500" />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-hidden bg-white dark:bg-dark-card rounded-xl border border-slate-200 dark:border-white/10 shadow-sm relative">
        <div className="absolute inset-0 overflow-auto">
          {displayedOrders.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 dark:text-slate-500">
              <CheckCircle className="w-12 h-12 mb-2 text-green-400" />
              <p className="font-medium text-lg text-slate-600 dark:text-slate-300">
                Tudo certo!
              </p>
              <p>
                {activeTab === "risk"
                  ? "Nenhum pedido a 1 ou 2 dias do prazo de entrega."
                  : "Nenhum pedido com alerta crítico encontrado."}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-white/5">
              {displayedOrders.map((order) => {
                const delayDays = getDelayDays(order);
                const remainingDays = getRemainingDays(order);
                const isRiskTab = activeTab === "risk";

                return (
                  <div
                    key={order.id}
                    className="p-4 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors flex flex-col md:flex-row items-start md:items-center justify-between gap-4"
                  >
                    <div className="flex items-start gap-4">
                      <div
                        className={clsx(
                          "p-3 rounded-lg mt-1",
                          isRiskTab
                            ? "bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400"
                            : "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400",
                        )}
                      >
                        {isRiskTab ? (
                          <Clock className="w-5 h-5" />
                        ) : (
                          <AlertTriangle className="w-5 h-5" />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-bold text-slate-800 dark:text-white">
                            Pedido #{order.orderNumber}
                          </h4>
                          <span className="text-xs bg-slate-100 dark:bg-white/10 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded border border-slate-200 dark:border-white/5">
                            {normalizeCarrierName(order.freightType)}
                          </span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-400 text-sm mt-0.5">
                          {order.customerName}
                        </p>
                        <div className="flex items-center gap-3 mt-1 text-xs text-slate-500 dark:text-slate-500">
                          <span className="flex items-center gap-1">
                            <CalendarX className="w-3 h-3" /> Previsto:{" "}
                            {formatDateOrDash(order.carrierEstimatedDeliveryDate)}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 w-full md:w-auto justify-between md:justify-end">
                      <div className="text-right">
                        <p className="text-xs text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wider">
                          {isRiskTab ? "Dias restantes" : "Tempo de atraso"}
                        </p>
                        <p
                          className={clsx(
                            "text-xl font-bold",
                            isRiskTab
                              ? "text-orange-600 dark:text-orange-400"
                              : "text-red-600 dark:text-red-400",
                          )}
                        >
                          {isRiskTab ? `${remainingDays} dias` : `${delayDays} dias`}
                        </p>
                      </div>
                      <button
                        onClick={() => setSelectedOrder(order)}
                        className="px-4 py-2 bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-700 dark:text-white font-medium rounded-lg hover:bg-slate-50 dark:hover:bg-white/10 hover:border-slate-300 transition-colors flex items-center gap-2"
                      >
                        <Eye className="w-4 h-4" /> Detalhes
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
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
