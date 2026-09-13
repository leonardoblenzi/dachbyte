import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  CalendarClock,
  Check,
  Clock3,
  Info,
  Plane,
  Truck,
  TriangleAlert,
  X,
} from "lucide-react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { Order, OrderStatus } from "../types";
import { fetchWithAuth } from "../utils/authFetch";
import {
  isCarrierDelayedOrder,
  isPlatformDelayedOrder,
  parseOptionalDate,
} from "../utils";

interface MonitoringPanelProps {
  orders: Order[];
  onFilterRequest?: (filters: any) => void;
}

interface WebhookLogItem {
  id: string;
  type: string;
  title: string;
  message: string;
  createdAt: string;
  payload?: Record<string, any>;
}

type MonitoringAlertItem = {
  id: string;
  icon: React.ComponentType<any>;
  tone: string;
  toneClass: string;
  title: string;
  subtitle: string;
  time: string;
  occurredAt: Date | null;
  emphasis?: "delivery-failure-new";
  orderNumber?: string;
  orderId?: string;
  canAcknowledge?: boolean;
};

type MonitoringActivityItem = {
  id: string;
  icon: React.ComponentType<any>;
  iconClass: string;
  iconBg: string;
  title: string;
  subtitle: string;
  time: string;
  occurredAt: Date | null;
};

type MonitoringKey =
  | "sendToday"
  | "sendTomorrow"
  | "sendIn2Days"
  | "sendDelayed"
  | "deliverToday"
  | "deliverTomorrow"
  | "deliverIn2Days"
  | "deliverDelayed";

const SHIPPING_PENDING_STATUSES = new Set<OrderStatus>([
  OrderStatus.PENDING,
  OrderStatus.CREATED,
]);

const DELIVERY_ACTIVE_STATUSES = new Set<OrderStatus>([
  OrderStatus.PENDING,
  OrderStatus.CREATED,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERY_ATTEMPT,
]);

const startOfDay = (value: Date) => {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
};

const dayDiffFromToday = (value: Date, today: Date) =>
  Math.round(
    (startOfDay(value).getTime() - startOfDay(today).getTime()) / 86400000,
  );

type TrendPoint = { name: string; value: number };

const TREND_DAYS = 12;

const formatRelativeTime = (value: Date | string | null | undefined, now: Date) => {
  if (!value) return "Agora";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Agora";
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const mins = Math.floor(diffMs / 60000);
  if (mins <= 0) return "Agora";
  if (mins < 60) return `${mins} min atras`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h atras`;
  const days = Math.floor(hours / 24);
  return `${days} d atras`;
};

const isDateInCurrentDay = (value: Date | null | undefined, now: Date) => {
  if (!value || Number.isNaN(value.getTime())) return false;
  const dayStart = startOfDay(now).getTime();
  const dayEnd = dayStart + 86400000;
  const time = value.getTime();
  return time >= dayStart && time < dayEnd;
};

const getWebhookFailureReason = (payload: Record<string, any> | undefined) => {
  const candidates = [
    payload?.statusDescription,
    payload?.trackingDescription,
    payload?.eventDescription,
    payload?.message,
    payload?.statusDetail,
  ];

  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (text) return text;
  }

  return "falha reportada pela transportadora";
};

const buildWebhookLatestEventActivity = (
  payload: Record<string, any>,
  orderNumber: string,
) => {
  const latestEvent =
    payload?.latestEvent && typeof payload.latestEvent === "object"
      ? payload.latestEvent
      : null;
  if (!latestEvent) return null;

  const rawStatus = String(latestEvent.status || "").trim();
  const rawDescription = String(latestEvent.description || "").trim();
  const city = String(latestEvent.city || "").trim();
  const state = String(latestEvent.state || "").trim();
  const location =
    city && state ? `${city}/${state}` : city || state ? city || state : "";
  const statusText = `${rawStatus} ${rawDescription}`.toUpperCase();

  const hasAny = (...tokens: string[]) =>
    tokens.some((token) => statusText.includes(token));

  if (hasAny("ENTREGUE", "DELIVERED", "MERCADORIA ENTREGUE")) {
    return {
      icon: Truck,
      iconClass: "text-emerald-600",
      iconBg: "bg-emerald-50",
      title: "Entrega concluida",
      subtitle: `Pedido #${orderNumber} foi entregue${location ? ` em ${location}` : ""}`,
    };
  }

  if (hasAny("FALHA", "AUSENTE", "SINISTR", "ROUBO", "AVARIA")) {
    return {
      icon: AlertTriangle,
      iconClass: "text-red-600",
      iconBg: "bg-red-50",
      title: "Falha na entrega",
      subtitle: `Pedido #${orderNumber} registrou falha${location ? ` em ${location}` : ""}`,
    };
  }

  if (hasAny("SAIDA PARA ENTREGA", "TO_BE_DELIVERED", "OUT FOR DELIVERY")) {
    return {
      icon: Plane,
      iconClass: "text-blue-600",
      iconBg: "bg-blue-50",
      title: "Saiu para entrega",
      subtitle: `Pedido #${orderNumber} saiu para entrega${location ? ` em ${location}` : ""}`,
    };
  }

  if (
    hasAny(
      "SAIDA DE UNIDADE",
      "DESPACHADO",
      "SHIPPED",
      "DISPATCH",
      "EM TRANSITO",
      "TRANSITO",
    )
  ) {
    return {
      icon: Plane,
      iconClass: "text-blue-600",
      iconBg: "bg-blue-50",
      title: "Pedido despachado",
      subtitle: `Pedido #${orderNumber} foi despachado${location ? ` em ${location}` : ""}`,
    };
  }

  if (hasAny("CHEGADA EM UNIDADE", "CHEGOU NA UNIDADE", "UNIDADE")) {
    return {
      icon: CalendarClock,
      iconClass: "text-amber-600",
      iconBg: "bg-amber-50",
      title: "Chegada em unidade",
      subtitle: `Pedido #${orderNumber} chegou na unidade${location ? ` ${location}` : ""}`,
    };
  }

  if (rawDescription) {
    return {
      icon: Info,
      iconClass: "text-slate-600",
      iconBg: "bg-slate-100",
      title: "Rastreio atualizado",
      subtitle: `Pedido #${orderNumber}: ${rawDescription}`,
    };
  }

  return null;
};

type MonitoringSnapshot = Record<MonitoringKey, number> & {
  totalMonitorable: number;
};

type FailureAckItem = {
  id: string;
  orderId: string;
  orderNumber: string | null;
  acknowledgedAt: string | null;
  acknowledgedByUserId: string | null;
  acknowledgedByEmail: string | null;
};

const calculateMonitoringSnapshot = (
  monitorableOrders: Order[],
  referenceDate: Date,
): MonitoringSnapshot => {
  const referenceDay = startOfDay(referenceDate);

  const sendingOrders = monitorableOrders.filter((order) =>
    SHIPPING_PENDING_STATUSES.has(order.status),
  );
  const deliveryOrders = monitorableOrders.filter((order) =>
    DELIVERY_ACTIVE_STATUSES.has(order.status),
  );

  let sendToday = 0;
  let sendTomorrow = 0;
  let sendIn2Days = 0;
  let sendDelayed = 0;
  let deliverToday = 0;
  let deliverTomorrow = 0;
  let deliverIn2Days = 0;
  let deliverDelayed = 0;

  for (const order of sendingOrders) {
    const sendDate = parseOptionalDate(order.maxShippingDeadline || order.shippingDate);
    if (!sendDate) continue;

    const diff = dayDiffFromToday(sendDate, referenceDay);
    if (diff === 0) sendToday += 1;
    else if (diff === 1) sendTomorrow += 1;
    else if (diff === 2) sendIn2Days += 1;
    else if (diff < 0) sendDelayed += 1;
  }

  for (const order of deliveryOrders) {
    const deliveryDate = parseOptionalDate(
      order.carrierEstimatedDeliveryDate || order.estimatedDeliveryDate,
    );
    if (deliveryDate) {
      const diff = dayDiffFromToday(deliveryDate, referenceDay);
      if (diff === 0) deliverToday += 1;
      else if (diff === 1) deliverTomorrow += 1;
      else if (diff === 2) deliverIn2Days += 1;
    }

    // Mantem o card "Entrega atrasada" alinhado ao mesmo criterio do filtro
    // de atraso da transportadora usado na lista de pedidos.
    if (isCarrierDelayedOrder(order)) {
      deliverDelayed += 1;
    }
  }

  return {
    sendToday,
    sendTomorrow,
    sendIn2Days,
    sendDelayed,
    deliverToday,
    deliverTomorrow,
    deliverIn2Days,
    deliverDelayed,
    totalMonitorable: monitorableOrders.length,
  };
};

export const MonitoringPanel: React.FC<MonitoringPanelProps> = ({
  orders,
  onFilterRequest,
}) => {
  const [now, setNow] = useState(() => new Date());
  const [webhookLogs, setWebhookLogs] = useState<WebhookLogItem[]>([]);
  const [failureAcks, setFailureAcks] = useState<FailureAckItem[]>([]);
  const [acknowledgingOrderId, setAcknowledgingOrderId] = useState<string | null>(null);
  const [isWebhookLive, setIsWebhookLive] = useState(false);
  const [expandedPanel, setExpandedPanel] = useState<"alerts" | "activities" | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let canceled = false;

    const loadWebhookLogs = async () => {
      try {
        const [logsResponse, acksResponse] = await Promise.all([
          fetchWithAuth("/api/webhooks/intelipost/logs?limit=500"),
          fetchWithAuth("/api/webhooks/monitoring/failure-acks?limit=500"),
        ]);

        if (logsResponse.ok) {
          const data = await logsResponse.json().catch(() => ({}));
          if (!canceled) {
            const rows = Array.isArray(data?.logs) ? data.logs : [];
            setWebhookLogs(rows);
            setIsWebhookLive(true);
          }
        } else if (!canceled) {
          setIsWebhookLive(false);
        }

        if (acksResponse.ok) {
          const data = await acksResponse.json().catch(() => ({}));
          if (!canceled) {
            const rows = Array.isArray(data?.acks) ? data.acks : [];
            setFailureAcks(rows);
          }
        }
      } catch {
        if (!canceled) {
          setIsWebhookLive(false);
        }
      }
    };

    void loadWebhookLogs();
    const interval = window.setInterval(() => {
      void loadWebhookLogs();
    }, 30000);

    return () => {
      canceled = true;
      window.clearInterval(interval);
    };
  }, []);

  const failureAckByOrderId = useMemo(() => {
    const map = new Map<string, Date>();
    for (const ack of failureAcks) {
      const orderId = String(ack.orderId || "").trim();
      if (!orderId) continue;
      const acknowledgedAt = parseOptionalDate(ack.acknowledgedAt);
      if (!acknowledgedAt) continue;
      const current = map.get(orderId);
      if (!current || acknowledgedAt.getTime() > current.getTime()) {
        map.set(orderId, acknowledgedAt);
      }
    }
    return map;
  }, [failureAcks]);

  const lastWebhookStatusByOrderNumber = useMemo(() => {
    const map = new Map<string, Date>();
    for (const item of webhookLogs) {
      if (String(item.type || "") !== "INTELIPOST_WEBHOOK_PROCESSED") continue;
      const orderNumber = String(item.payload?.orderNumber || "").trim();
      const status = String(item.payload?.status || "").trim();
      if (!orderNumber || !status) continue;
      const occurredAt = parseOptionalDate(item.createdAt);
      if (!occurredAt) continue;
      const current = map.get(orderNumber);
      if (!current || occurredAt.getTime() > current.getTime()) {
        map.set(orderNumber, occurredAt);
      }
    }
    return map;
  }, [webhookLogs]);

  const isFailureAlertSuppressed = (order: Order) => {
    const acknowledgedAt = failureAckByOrderId.get(order.id);
    if (!acknowledgedAt) return false;

    const orderNumber = String(order.orderNumber || "").trim();
    const lastWebhookAt = orderNumber
      ? lastWebhookStatusByOrderNumber.get(orderNumber) || null
      : null;
    const referenceDate =
      lastWebhookAt && lastWebhookAt.getTime() > acknowledgedAt.getTime()
        ? lastWebhookAt
        : acknowledgedAt;

    return now.getTime() - referenceDate.getTime() < 48 * 60 * 60 * 1000;
  };

  const acknowledgeFailureAlert = async (alert: MonitoringAlertItem) => {
    const orderId = String(alert.orderId || "").trim();
    if (!orderId || acknowledgingOrderId) return;

    try {
      setAcknowledgingOrderId(orderId);
      const response = await fetchWithAuth("/api/webhooks/monitoring/failure-acks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          orderNumber: String(alert.orderNumber || "").trim() || null,
        }),
      });

      if (!response.ok) return;

      const acknowledgedAt = new Date().toISOString();
      setFailureAcks((previous) => {
        const remaining = previous.filter((item) => item.orderId !== orderId);
        return [
          {
            id: `local-${orderId}-${acknowledgedAt}`,
            orderId,
            orderNumber: String(alert.orderNumber || "").trim() || null,
            acknowledgedAt,
            acknowledgedByUserId: null,
            acknowledgedByEmail: null,
          },
          ...remaining,
        ];
      });
      setNow(new Date());
    } catch {
      // sem ruido visual no painel
    } finally {
      setAcknowledgingOrderId(null);
    }
  };

  const monitorableOrders = useMemo(
    () =>
      orders.filter(
        (order) =>
          order.status !== OrderStatus.CANCELED &&
          order.status !== OrderStatus.CHANNEL_LOGISTICS,
      ),
    [orders],
  );

  const metrics = useMemo(() => {
    const currentSnapshot = calculateMonitoringSnapshot(monitorableOrders, now);
    const yesterdayReference = new Date(startOfDay(now).getTime() - 86400000);
    const yesterdaySnapshot = calculateMonitoringSnapshot(
      monitorableOrders,
      yesterdayReference,
    );

    return {
      ...currentSnapshot,
      yesterday: yesterdaySnapshot,
      lastRead: now.toLocaleTimeString("pt-BR"),
    };
  }, [monitorableOrders, now]);

  const cardModels: Array<{
    key: MonitoringKey;
    title: string;
    value: number;
    icon: React.ComponentType<any>;
    iconTone: string;
    iconBg: string;
    lineColor: string;
    filter?: any;
  }> = [
    {
      key: "sendToday",
      title: "Enviar hoje",
      value: metrics.sendToday,
      icon: Plane,
      iconTone: "text-blue-600",
      iconBg: "bg-blue-50",
      lineColor: "#2563eb",
      filter: { shippingDueWindow: "today" },
    },
    {
      key: "sendTomorrow",
      title: "Enviar Amanha",
      value: metrics.sendTomorrow,
      icon: Calendar,
      iconTone: "text-sky-600",
      iconBg: "bg-sky-50",
      lineColor: "#0ea5e9",
      filter: { shippingDueWindow: "tomorrow" },
    },
    {
      key: "sendIn2Days",
      title: "Enviar em 2 dias",
      value: metrics.sendIn2Days,
      icon: CalendarClock,
      iconTone: "text-violet-600",
      iconBg: "bg-violet-50",
      lineColor: "#a855f7",
      filter: { shippingDueWindow: "in2days" },
    },
    {
      key: "sendDelayed",
      title: "Envio atrasado",
      value: metrics.sendDelayed,
      icon: AlertTriangle,
      iconTone: "text-red-500",
      iconBg: "bg-red-50",
      lineColor: "#ef4444",
      filter: { onlyShippingDelayed: true },
    },
    {
      key: "deliverToday",
      title: "Entregar hoje",
      value: metrics.deliverToday,
      icon: Truck,
      iconTone: "text-emerald-600",
      iconBg: "bg-emerald-50",
      lineColor: "#16a34a",
      filter: { dueToday: true },
    },
    {
      key: "deliverTomorrow",
      title: "Entregar Amanha",
      value: metrics.deliverTomorrow,
      icon: Calendar,
      iconTone: "text-teal-600",
      iconBg: "bg-teal-50",
      lineColor: "#14b8a6",
      filter: { deliveryDueWindow: "tomorrow" },
    },
    {
      key: "deliverIn2Days",
      title: "Entregar em 2 dias",
      value: metrics.deliverIn2Days,
      icon: CalendarClock,
      iconTone: "text-amber-500",
      iconBg: "bg-amber-50",
      lineColor: "#eab308",
      filter: { deliveryDueWindow: "in2days" },
    },
    {
      key: "deliverDelayed",
      title: "Entrega atrasada",
      value: metrics.deliverDelayed,
      icon: TriangleAlert,
      iconTone: "text-red-500",
      iconBg: "bg-red-50",
      lineColor: "#ef4444",
      filter: { onlyDelayed: true },
    },
  ];

  const cards = useMemo(
    () =>
      cardModels.map((model) => {
        const trend: TrendPoint[] = Array.from({ length: TREND_DAYS }, (_, index) => {
          const dayOffset = TREND_DAYS - 1 - index;
          const reference = new Date(startOfDay(now).getTime() - dayOffset * 86400000);
          const snapshot = calculateMonitoringSnapshot(monitorableOrders, reference);
          return {
            name: String(index),
            value: Number(snapshot[model.key] || 0),
          };
        });

        const yesterdayValue = Number(metrics.yesterday[model.key] || 0);
        const deltaRaw = model.value - yesterdayValue;
        const deltaPercent =
          yesterdayValue > 0
            ? Math.round((Math.abs(deltaRaw) / yesterdayValue) * 100)
            : model.value > 0
              ? 100
              : 0;
        return {
          ...model,
          trend,
          deltaRaw,
          deltaPercent,
          isUp: deltaRaw >= 0,
        };
      }),
    [
      now,
      monitorableOrders,
      metrics.yesterday,
      metrics.sendToday,
      metrics.sendTomorrow,
      metrics.sendIn2Days,
      metrics.sendDelayed,
      metrics.deliverToday,
      metrics.deliverTomorrow,
      metrics.deliverIn2Days,
      metrics.deliverDelayed,
    ],
  );

  const delayedOrders = useMemo(
    () =>
      monitorableOrders.filter(
        (order) => isCarrierDelayedOrder(order) || isPlatformDelayedOrder(order),
      ),
    [monitorableOrders],
  );

  const liveAlerts = useMemo<MonitoringAlertItem[]>(() => {
    const orderByOrderNumber = new Map<string, Order>();
    for (const order of monitorableOrders) {
      const normalizedOrderNumber = String(order.orderNumber || "").trim();
      if (normalizedOrderNumber) {
        orderByOrderNumber.set(normalizedOrderNumber, order);
      }
    }

    const unresolvedFailureOrders = monitorableOrders
      .filter((order) => order.status === OrderStatus.FAILURE)
      .filter((order) => !isFailureAlertSuppressed(order))
      .sort(
        (a, b) =>
          new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime(),
      );

    const unresolvedFailureAlerts = unresolvedFailureOrders.slice(0, 8).map((order) => ({
      id: `failure-open-${order.id}`,
      icon: AlertTriangle,
      tone: "nova falha",
      toneClass: "bg-red-600 text-white",
      title: `Falha na entrega pendente - Pedido #${order.orderNumber}`,
      subtitle: "pedido com falha ainda sem entrega confirmada",
      time: formatRelativeTime(order.lastUpdate, now),
      occurredAt: parseOptionalDate(order.lastUpdate),
      emphasis: "delivery-failure-new" as const,
      orderNumber: String(order.orderNumber || "").trim(),
      orderId: order.id,
      canAcknowledge: true,
    }));

    const processedLogs = webhookLogs.filter(
      (item) => String(item.type || "") === "INTELIPOST_WEBHOOK_PROCESSED",
    );

    if (processedLogs.length > 0) {
      const last2h = now.getTime() - 2 * 60 * 60 * 1000;
      const recentWebhookLogs = processedLogs.filter((item) => {
        const eventTime = new Date(item.createdAt).getTime();
        return Number.isFinite(eventTime) && eventTime >= last2h;
      });

      const deliveredCount = recentWebhookLogs.filter(
        (item) => String(item.payload?.status || "") === OrderStatus.DELIVERED,
      ).length;
      const failureWebhookLogs = recentWebhookLogs.filter((item) => {
        if (String(item.payload?.status || "") !== OrderStatus.FAILURE) {
          return false;
        }
        const webhookOrderNumber = String(item.payload?.orderNumber || "").trim();
        if (!webhookOrderNumber) return true;
        const localOrder = monitorableOrders.find(
          (order) => String(order.orderNumber || "").trim() === webhookOrderNumber,
        );
        return localOrder ? localOrder.status !== OrderStatus.DELIVERED : true;
      });
      const failureCount = failureWebhookLogs.length;
      const dispatchCount = recentWebhookLogs.filter((item) => {
        const status = String(item.payload?.status || "");
        return status === OrderStatus.SHIPPED || status === OrderStatus.DELIVERY_ATTEMPT;
      }).length;
      const delayedCount = recentWebhookLogs.filter((item) =>
        Boolean(item.payload?.isDelayed),
      ).length;

      const findLatestWebhookDate = (matcher: (item: WebhookLogItem) => boolean) =>
        recentWebhookLogs
          .filter(matcher)
          .map((item) => parseOptionalDate(item.createdAt))
          .filter((value): value is Date => Boolean(value))
          .sort((a, b) => b.getTime() - a.getTime())[0] || null;

      const findLatestWebhookTime = (matcher: (item: WebhookLogItem) => boolean) => {
        const matched = recentWebhookLogs
          .filter(matcher)
          .map((item) => parseOptionalDate(item.createdAt))
          .filter((value): value is Date => Boolean(value))
          .sort((a, b) => b.getTime() - a.getTime())[0];

        return formatRelativeTime(matched, now);
      };

      const failureOrderAlerts = failureWebhookLogs
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        .slice(0, 3)
        .map((item, index) => {
          const orderNumber = String(item.payload?.orderNumber || "-").trim() || "-";
          const failureReason = getWebhookFailureReason(item.payload);
          const occurredAt = parseOptionalDate(item.createdAt);
          const localOrder = orderByOrderNumber.get(orderNumber);

          return {
            id: `webhook-failure-order-${orderNumber}-${index}`,
            icon: AlertTriangle,
            tone: "nova falha",
            toneClass: "bg-red-600 text-white",
            title: `Nova falha na entrega - Pedido #${orderNumber}`,
            subtitle: failureReason,
            time: formatRelativeTime(item.createdAt, now),
            occurredAt,
            emphasis: "delivery-failure-new" as const,
            orderNumber,
            orderId: localOrder?.id,
            canAcknowledge: Boolean(localOrder && localOrder.status === OrderStatus.FAILURE),
          };
        });

      const webhookAlerts = [
        ...failureOrderAlerts,
        failureCount > 0
          ? {
              id: "webhook-failure",
              icon: AlertTriangle,
              tone: "critico",
              toneClass: "bg-red-100 text-red-600",
              title: `Falha na entrega: ${failureCount} webhook(s)`,
              subtitle: "eventos recebidos nas ultimas 2 horas",
              time: findLatestWebhookTime((item) =>
                failureWebhookLogs.some((failureItem) => failureItem.id === item.id),
              ),
              occurredAt: findLatestWebhookDate((item) =>
                failureWebhookLogs.some((failureItem) => failureItem.id === item.id),
              ),
            }
          : null,
        dispatchCount > 0
          ? {
              id: "webhook-dispatch",
              icon: Plane,
              tone: "info",
              toneClass: "bg-blue-100 text-blue-700",
              title: `Despachos atualizados: ${dispatchCount}`,
              subtitle: "webhooks de envio em transito/saida para entrega",
              time: findLatestWebhookTime((item) => {
                const status = String(item.payload?.status || "");
                return (
                  status === OrderStatus.SHIPPED ||
                  status === OrderStatus.DELIVERY_ATTEMPT
                );
              }),
              occurredAt: findLatestWebhookDate((item) => {
                const status = String(item.payload?.status || "");
                return (
                  status === OrderStatus.SHIPPED ||
                  status === OrderStatus.DELIVERY_ATTEMPT
                );
              }),
            }
          : null,
        deliveredCount > 0
          ? {
              id: "webhook-delivered",
              icon: Truck,
              tone: "atencao",
              toneClass: "bg-emerald-100 text-emerald-700",
              title: `Entregas confirmadas: ${deliveredCount}`,
              subtitle: "confirmacoes recebidas via webhook",
              time: findLatestWebhookTime(
                (item) => String(item.payload?.status || "") === OrderStatus.DELIVERED,
              ),
              occurredAt: findLatestWebhookDate(
                (item) => String(item.payload?.status || "") === OrderStatus.DELIVERED,
              ),
            }
          : null,
        delayedCount > 0
          ? {
              id: "webhook-deadline",
              icon: Clock3,
              tone: "alerta",
              toneClass: "bg-amber-100 text-amber-700",
              title: `Atualizacao de prazo/atraso: ${delayedCount}`,
              subtitle: "pedidos marcados em atraso pelos eventos recentes",
              time: findLatestWebhookTime((item) => Boolean(item.payload?.isDelayed)),
              occurredAt: findLatestWebhookDate((item) => Boolean(item.payload?.isDelayed)),
            }
          : null,
      ].filter(Boolean) as MonitoringAlertItem[];

      if (webhookAlerts.length > 0 || unresolvedFailureAlerts.length > 0) {
        const merged = [...unresolvedFailureAlerts, ...webhookAlerts];
        const seenFailureOrder = new Set<string>();
        const deduped = merged.filter((alert) => {
          const normalizedOrder = String(alert.orderNumber || "").trim();
          if (!normalizedOrder) return true;
          if (seenFailureOrder.has(normalizedOrder)) {
            return false;
          }
          seenFailureOrder.add(normalizedOrder);
          return true;
        });
        return deduped;
      }
    }

    const delayedStates = Array.from(
      new Set(
        delayedOrders
          .map((order) => String(order.state || "").trim())
          .filter((state) => state.length > 0),
      ),
    )
      .slice(0, 3)
      .join(", ");

    const latestOrderUpdate = monitorableOrders
      .map((order) => parseOptionalDate(order.lastUpdate))
      .filter((value): value is Date => Boolean(value))
      .sort((a, b) => b.getTime() - a.getTime())[0];

    const topAlerts = [
      ...unresolvedFailureAlerts,
      metrics.deliverDelayed > 0
        ? {
            id: "delivery-delayed",
            icon: AlertTriangle,
            tone: "critico",
            toneClass: "bg-red-100 text-red-600",
            title: `Entrega atrasada: ${metrics.deliverDelayed} pedidos`,
            subtitle: delayedStates ? `regioes: ${delayedStates}` : "requer acompanhamento imediato",
            time: formatRelativeTime(latestOrderUpdate, now),
            occurredAt: latestOrderUpdate || null,
          }
        : null,
      metrics.sendDelayed > 0
        ? {
            id: "shipping-delayed",
            icon: TriangleAlert,
            tone: "alerta",
            toneClass: "bg-amber-100 text-amber-700",
            title: `Envios atrasados: ${metrics.sendDelayed} pedidos`,
            subtitle: "pedidos com prazo de envio vencido",
            time: formatRelativeTime(latestOrderUpdate, now),
            occurredAt: latestOrderUpdate || null,
          }
        : null,
      metrics.deliverToday > 0
        ? {
            id: "high-volume",
            icon: Clock3,
            tone: "atencao",
            toneClass: "bg-yellow-100 text-yellow-700",
            title: "Alto volume de entregas hoje",
            subtitle: `${metrics.deliverToday} entregas previstas`,
            time: formatRelativeTime(latestOrderUpdate, now),
            occurredAt: latestOrderUpdate || null,
          }
        : null,
      metrics.sendToday > 0
        ? {
            id: "send-today",
            icon: Info,
            tone: "info",
            toneClass: "bg-blue-100 text-blue-700",
            title: "Pedidos para envio hoje",
            subtitle: `${metrics.sendToday} pedidos com envio previsto para hoje`,
            time: formatRelativeTime(latestOrderUpdate, now),
            occurredAt: latestOrderUpdate || null,
          }
        : null,
    ].filter(Boolean) as MonitoringAlertItem[];

    return topAlerts;
  }, [
    webhookLogs,
    now,
    delayedOrders,
    metrics.deliverDelayed,
    metrics.sendDelayed,
    metrics.deliverToday,
    monitorableOrders,
    failureAckByOrderId,
    lastWebhookStatusByOrderNumber,
  ]);

  const recentActivities = useMemo<MonitoringActivityItem[]>(() => {
    const processedLogs = webhookLogs.filter(
      (item) => String(item.type || "") === "INTELIPOST_WEBHOOK_PROCESSED",
    );

    if (processedLogs.length > 0) {
      return processedLogs.map((item) => {
        const payload = item.payload || {};
        const status = String(payload.status || "");
        const orderNumber = String(payload.orderNumber || "-");
        const wasDelayed = Boolean(payload.isDelayed);
        const occurredAt = parseOptionalDate(item.createdAt);
        const latestEventActivity = buildWebhookLatestEventActivity(
          payload,
          orderNumber,
        );

        if (latestEventActivity) {
          return {
            id: item.id,
            icon: latestEventActivity.icon,
            iconClass: latestEventActivity.iconClass,
            iconBg: latestEventActivity.iconBg,
            title: latestEventActivity.title,
            subtitle: latestEventActivity.subtitle,
            time: formatRelativeTime(item.createdAt, now),
            occurredAt,
          };
        }

        if (status === OrderStatus.DELIVERED) {
          return {
            id: item.id,
            icon: Truck,
            iconClass: "text-emerald-600",
            iconBg: "bg-emerald-50",
            title: "Entrega concluida",
            subtitle: `Pedido #${orderNumber} entregue (webhook)`,
            time: formatRelativeTime(item.createdAt, now),
            occurredAt,
          };
        }

        if (status === OrderStatus.FAILURE) {
          return {
            id: item.id,
            icon: AlertTriangle,
            iconClass: "text-red-600",
            iconBg: "bg-red-50",
            title: "Falha na entrega",
            subtitle: `Pedido #${orderNumber} com ocorrencia de entrega (webhook)`,
            time: formatRelativeTime(item.createdAt, now),
            occurredAt,
          };
        }

        if (status === OrderStatus.SHIPPED || status === OrderStatus.DELIVERY_ATTEMPT) {
          return {
            id: item.id,
            icon: Plane,
            iconClass: "text-blue-600",
            iconBg: "bg-blue-50",
            title: "Despacho atualizado",
            subtitle: `Pedido #${orderNumber} atualizado em rota (webhook)`,
            time: formatRelativeTime(item.createdAt, now),
            occurredAt,
          };
        }

        if (wasDelayed) {
          return {
            id: item.id,
            icon: CalendarClock,
            iconClass: "text-amber-600",
            iconBg: "bg-amber-50",
            title: "Prazo atualizado",
            subtitle: `Pedido #${orderNumber} com atualizacao de prazo/atraso (webhook)`,
            time: formatRelativeTime(item.createdAt, now),
            occurredAt,
          };
        }

        return {
          id: item.id,
          icon: Info,
          iconClass: "text-slate-600",
          iconBg: "bg-slate-100",
          title: "Rastreio atualizado",
          subtitle: `Pedido #${orderNumber} atualizado via webhook`,
          time: formatRelativeTime(item.createdAt, now),
          occurredAt,
        };
      });
    }

    const recent = [...monitorableOrders]
      .sort((a, b) => {
        const ta = new Date(a.lastUpdate).getTime();
        const tb = new Date(b.lastUpdate).getTime();
        return tb - ta;
      })
      .map((order) => {
        const isDelivered = order.status === OrderStatus.DELIVERED;
        const isDelayed = isCarrierDelayedOrder(order) || isPlatformDelayedOrder(order);
        const isShipping =
          order.status === OrderStatus.SHIPPED || order.status === OrderStatus.DELIVERY_ATTEMPT;

        if (isDelivered) {
          return {
            id: order.id,
            icon: Truck,
            iconClass: "text-emerald-600",
            iconBg: "bg-emerald-50",
            title: "Entrega concluida",
            subtitle: `Pedido #${order.orderNumber} entregue com sucesso`,
            time: formatRelativeTime(order.lastUpdate, now),
            occurredAt: parseOptionalDate(order.lastUpdate),
          };
        }

        if (isShipping) {
          return {
            id: order.id,
            icon: Plane,
            iconClass: "text-blue-600",
            iconBg: "bg-blue-50",
            title: "Envio realizado",
            subtitle: `Pedido #${order.orderNumber} em transito`,
            time: formatRelativeTime(order.lastUpdate, now),
            occurredAt: parseOptionalDate(order.lastUpdate),
          };
        }

        if (isDelayed) {
          return {
            id: order.id,
            icon: AlertTriangle,
            iconClass: "text-red-600",
            iconBg: "bg-red-50",
            title: "Atraso identificado",
            subtitle: `Pedido #${order.orderNumber} com risco de atraso`,
            time: formatRelativeTime(order.lastUpdate, now),
            occurredAt: parseOptionalDate(order.lastUpdate),
          };
        }

        return {
          id: order.id,
          icon: CalendarClock,
          iconClass: "text-amber-600",
          iconBg: "bg-amber-50",
          title: "Prazo atualizado",
          subtitle: `Pedido #${order.orderNumber} teve atualizacao de prazo`,
          time: formatRelativeTime(order.lastUpdate, now),
          occurredAt: parseOptionalDate(order.lastUpdate),
        };
      });

    return recent;
  }, [monitorableOrders, now, webhookLogs]);

  const previewLiveAlerts = useMemo(() => liveAlerts.slice(0, 4), [liveAlerts]);
  const previewRecentActivities = useMemo(
    () => recentActivities.slice(0, 4),
    [recentActivities],
  );

  const todayAlertItems = useMemo(
    () =>
      liveAlerts
        .filter((item) => isDateInCurrentDay(item.occurredAt, now))
        .sort(
          (a, b) =>
            (b.occurredAt?.getTime() || 0) - (a.occurredAt?.getTime() || 0),
        ),
    [liveAlerts, now],
  );

  const todayActivityItems = useMemo(
    () =>
      recentActivities
        .filter((item) => isDateInCurrentDay(item.occurredAt, now))
        .sort(
          (a, b) =>
            (b.occurredAt?.getTime() || 0) - (a.occurredAt?.getTime() || 0),
        ),
    [recentActivities, now],
  );

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Painel de Monitoramento
            </p>
            <h2 className="mt-1 text-lg font-bold text-slate-900">
              Acompanhamento de prazos em tempo real
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600"
            >
              <CalendarClock className="h-3.5 w-3.5" />
              Filtrar
            </button>
            <div className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">
              Todas as operacoes
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <span>Total monitorado: {metrics.totalMonitorable}</span>
          <span>Ultima leitura: {metrics.lastRead}</span>
          <span>
            Webhook:{" "}
            <span className={isWebhookLive ? "text-emerald-600" : "text-amber-600"}>
              {isWebhookLive ? "ao vivo" : "indisponivel"}
            </span>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => {
          const Icon = card.icon;
          const deltaColor = card.isUp ? "text-emerald-600" : "text-red-500";

          return (
            <button
              key={card.key}
              type="button"
              onClick={() => card.filter && onFilterRequest?.(card.filter)}
              className="rounded-xl border border-slate-200 bg-white p-4 text-left transition-colors hover:border-slate-300"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[13px] font-semibold text-slate-700">
                    {card.title}
                  </p>
                  <p className="mt-1 text-[42px] font-bold leading-none text-slate-900">
                    {card.value}
                  </p>
                  <p className={`mt-2 text-xs font-semibold ${deltaColor}`}>
                    {card.isUp ? "↑" : "↓"} {card.deltaPercent}%{" "}
                    <span className="font-medium text-slate-500">vs ontem</span>
                  </p>
                </div>
                <div className={`rounded-xl p-2.5 ${card.iconBg}`}>
                  <Icon className={`h-5 w-5 ${card.iconTone}`} />
                </div>
              </div>
              <div className="mt-3 h-10 min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={card.trend}>
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke={card.lineColor}
                      strokeWidth={2.2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-slate-800">Alertas ao vivo</p>
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">
                {previewLiveAlerts.length}
              </span>
            </div>
          </div>
          <div className="divide-y divide-slate-100">
            {previewLiveAlerts.length === 0 ? (
              <div className="px-4 py-4 text-sm text-slate-500">
                Nenhum alerta critico neste momento.
              </div>
            ) : (
              previewLiveAlerts.map((alert) => {
                const Icon = alert.icon;
                const isFailureHighlight = alert.emphasis === "delivery-failure-new";
                return (
                  <div
                    key={alert.id}
                    className={`flex items-start justify-between gap-3 px-4 py-3 ${
                      isFailureHighlight
                        ? "monitoring-alert-failure-live border-l-4 border-red-700"
                        : ""
                    }`}
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <div
                        className={`rounded-lg p-1.5 ${
                          isFailureHighlight
                            ? "monitoring-alert-failure-icon-wrap"
                            : "bg-red-50"
                        }`}
                      >
                        <Icon
                          className={`h-4 w-4 ${
                            isFailureHighlight
                              ? "monitoring-alert-failure-icon"
                              : "text-red-500"
                          }`}
                        />
                      </div>
                      <div className="min-w-0">
                        <p
                          className={`truncate text-sm font-semibold ${
                            isFailureHighlight
                              ? "monitoring-alert-failure-title"
                              : "text-slate-800"
                          }`}
                        >
                          {alert.title}
                        </p>
                        <p
                          className={`truncate text-xs ${
                            isFailureHighlight
                              ? "monitoring-alert-failure-subtitle"
                              : "text-slate-500"
                          }`}
                        >
                          {alert.subtitle}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {alert.canAcknowledge && alert.orderId ? (
                        <button
                          type="button"
                          onClick={() => void acknowledgeFailureAlert(alert)}
                          disabled={acknowledgingOrderId === alert.orderId}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-emerald-300 bg-emerald-50 text-emerald-700 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                          title="Marcar pedido atendido"
                          aria-label="Marcar pedido atendido"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                      <span
                        className={`text-[11px] ${
                          isFailureHighlight
                            ? "monitoring-alert-failure-time"
                            : "text-slate-500"
                        }`}
                      >
                        {alert.time}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${alert.toneClass}`}>
                        {alert.tone}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <button
            type="button"
            onClick={() => setExpandedPanel("alerts")}
            className="w-full border-t border-slate-100 px-4 py-3 text-left text-sm font-semibold text-blue-600"
          >
            Ver todos os alertas
          </button>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold text-slate-800">Atividades recentes</p>
          </div>
          <div className="divide-y divide-slate-100">
            {previewRecentActivities.length === 0 ? (
              <div className="px-4 py-4 text-sm text-slate-500">
                Sem atividades recentes.
              </div>
            ) : (
              previewRecentActivities.map((activity) => {
                const Icon = activity.icon;
                return (
                  <div key={activity.id} className="flex items-start justify-between gap-3 px-4 py-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className={`rounded-lg p-1.5 ${activity.iconBg}`}>
                        <Icon className={`h-4 w-4 ${activity.iconClass}`} />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-800">{activity.title}</p>
                        <p className="truncate text-xs text-slate-500">{activity.subtitle}</p>
                      </div>
                    </div>
                    <span className="shrink-0 text-[11px] text-slate-500">{activity.time}</span>
                  </div>
                );
              })
            )}
          </div>
          <button
            type="button"
            onClick={() => setExpandedPanel("activities")}
            className="w-full border-t border-slate-100 px-4 py-3 text-left text-sm font-semibold text-blue-600"
          >
            Ver todas as atividades
          </button>
        </div>
      </div>

      {expandedPanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-4">
          <div className="w-full max-w-4xl rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  {expandedPanel === "alerts" ? "Alertas" : "Atividades"}
                </p>
                <h3 className="mt-1 text-base font-bold text-slate-900">
                  {expandedPanel === "alerts"
                    ? "Todos os alertas recentes de hoje"
                    : "Todas as atividades recentes de hoje"}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setExpandedPanel(null)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                aria-label="Fechar"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[72vh] overflow-y-auto p-4">
              {expandedPanel === "alerts" ? (
                todayAlertItems.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
                    Nenhum alerta registrado no dia atual.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {todayAlertItems.map((alert) => {
                      const Icon = alert.icon;
                      const isFailureHighlight =
                        alert.emphasis === "delivery-failure-new";
                      return (
                        <div
                          key={alert.id}
                          className={`rounded-xl border px-4 py-3 ${
                            isFailureHighlight
                              ? "monitoring-alert-failure-live border-red-700"
                              : "border-slate-200 bg-slate-50"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex min-w-0 items-start gap-3">
                              <div
                                className={`rounded-lg p-1.5 ${
                                  isFailureHighlight
                                    ? "monitoring-alert-failure-icon-wrap"
                                    : "bg-red-50"
                                }`}
                              >
                                <Icon
                                  className={`h-4 w-4 ${
                                    isFailureHighlight
                                      ? "monitoring-alert-failure-icon"
                                      : "text-red-500"
                                  }`}
                                />
                              </div>
                              <div className="min-w-0">
                                <p
                                  className={`truncate text-sm font-semibold ${
                                    isFailureHighlight
                                      ? "monitoring-alert-failure-title"
                                      : "text-slate-800"
                                  }`}
                                >
                                  {alert.title}
                                </p>
                                <p
                                  className={`truncate text-xs ${
                                    isFailureHighlight
                                      ? "monitoring-alert-failure-subtitle"
                                      : "text-slate-500"
                                  }`}
                                >
                                  {alert.subtitle}
                                </p>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              {alert.canAcknowledge && alert.orderId ? (
                                <button
                                  type="button"
                                  onClick={() => void acknowledgeFailureAlert(alert)}
                                  disabled={acknowledgingOrderId === alert.orderId}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-emerald-300 bg-emerald-50 text-emerald-700 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                                  title="Marcar pedido atendido"
                                  aria-label="Marcar pedido atendido"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                              ) : null}
                              <span
                                className={`text-[11px] ${
                                  isFailureHighlight
                                    ? "monitoring-alert-failure-time"
                                    : "text-slate-500"
                                }`}
                              >
                                {alert.time}
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${alert.toneClass}`}
                              >
                                {alert.tone}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : todayActivityItems.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
                  Nenhuma atividade registrada no dia atual.
                </div>
              ) : (
                <div className="space-y-2">
                  {todayActivityItems.map((activity) => {
                    const Icon = activity.icon;
                    return (
                      <div
                        key={activity.id}
                        className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-3">
                            <div className={`rounded-lg p-1.5 ${activity.iconBg}`}>
                              <Icon className={`h-4 w-4 ${activity.iconClass}`} />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-slate-800">
                                {activity.title}
                              </p>
                              <p className="truncate text-xs text-slate-500">
                                {activity.subtitle}
                              </p>
                            </div>
                          </div>
                          <span className="shrink-0 text-[11px] text-slate-500">
                            {activity.time}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
