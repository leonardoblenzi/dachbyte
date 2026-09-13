import React, { useMemo, useState } from "react";
import { Order, OrderStatus, PageView } from "../types";
import {
  FileText,
  CheckCircle,
  Package,
  Truck,
  MapPin,
  AlertTriangle,
  Calendar,
  HelpCircle,
  Timer,
  TrendingUp,
  Bell,
  Search,
  Filter,
  ChevronDown,
  ChevronUp,
  ArrowUpRight,
  ArrowDownRight,
  PieChart as PieChartIcon,
  WifiOff,
  ChevronRight,
} from "lucide-react";
import { clsx } from "clsx";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip as RechartsTooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  isCarrierDelayedOrder,
  normalizeCarrierName,
  isOrderOnRoute,
  isPlatformDelayedOrder,
  toText,
  parseOptionalDate,
  isChannelManagedOrder,
  isPendingDeliveryFailureOrder,
  resolvePlatformCreatedDate,
} from "../utils";

interface DashboardProps {
  orders: Order[];
  onChangeView: (view: PageView) => void;
  onFilterRequest?: (filters: any) => void;
}

const STATUS_LABELS: Record<string, string> = {
  [OrderStatus.PENDING]: "Pendente",
  [OrderStatus.CREATED]: "Criado",
  [OrderStatus.SHIPPED]: "Em Trânsito",
  [OrderStatus.DELIVERY_ATTEMPT]: "Saiu para Entrega",
  [OrderStatus.DELIVERED]: "Entregue",
  [OrderStatus.FAILURE]: "Falha",
  [OrderStatus.RETURNED]: "Devolvido",
  [OrderStatus.CANCELED]: "Cancelado",
  [OrderStatus.CHANNEL_LOGISTICS]: "Logística do Canal",
};

const CHART_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#6366f1",
  "#14b8a6",
];

const DAY_IN_MS = 86400000;

const isDateInRange = (value: unknown, start: Date, endExclusive: Date) => {
  const parsed = parseOptionalDate(value);
  if (!parsed) return false;

  return parsed >= start && parsed < endExclusive;
};

const isActiveCarrierDelayedOrder = (order: Order) =>
  isCarrierDelayedOrder(order);

const isActivePlatformDelayedOrder = (order: Order) =>
  isPlatformDelayedOrder(order);

const isQualityMeasurableOrder = (order: Order) =>
  order.status === OrderStatus.DELIVERED || isActiveCarrierDelayedOrder(order);

const isOrderDeliveredOnTrayTime = (order: Order) => {
  if (order.status !== OrderStatus.DELIVERED) return false;

  const estimated = parseOptionalDate(order.estimatedDeliveryDate);
  if (!estimated) return false;
  estimated.setHours(23, 59, 59, 999);

  return new Date(order.lastUpdate) <= estimated;
};

const isCarrierQualityMeasurableOrder = (order: Order) => {
  const carrierDate = parseOptionalDate(order.carrierEstimatedDeliveryDate);
  if (!carrierDate) return false;

  if (order.status === OrderStatus.DELIVERED) return true;

  if (
    order.status === OrderStatus.FAILURE ||
    order.status === OrderStatus.RETURNED ||
    order.status === OrderStatus.CANCELED
  ) {
    return false;
  }

  carrierDate.setHours(23, 59, 59, 999);
  return Date.now() > carrierDate.getTime();
};

const isOrderDeliveredOnCarrierTime = (order: Order) => {
  if (order.status !== OrderStatus.DELIVERED) return false;

  const carrierDate = parseOptionalDate(order.carrierEstimatedDeliveryDate);
  if (!carrierDate) return false;
  carrierDate.setHours(23, 59, 59, 999);

  return new Date(order.lastUpdate) <= carrierDate;
};

const isOrderOutsideCarrierDeadline = (order: Order) => {
  const carrierDate = parseOptionalDate(order.carrierEstimatedDeliveryDate);
  if (!carrierDate) return false;
  carrierDate.setHours(23, 59, 59, 999);

  if (order.status === OrderStatus.DELIVERED) {
    return new Date(order.lastUpdate) > carrierDate;
  }

  return (
    order.status !== OrderStatus.FAILURE &&
    order.status !== OrderStatus.RETURNED &&
    order.status !== OrderStatus.CANCELED &&
    Date.now() > carrierDate.getTime()
  );
};

const isOrderOutsideTrayDeadline = (order: Order) => {
  const trayDate = parseOptionalDate(order.estimatedDeliveryDate);
  if (!trayDate) return false;
  trayDate.setHours(23, 59, 59, 999);

  if (order.status === OrderStatus.DELIVERED) {
    return new Date(order.lastUpdate) > trayDate;
  }

  return (
    order.status !== OrderStatus.FAILURE &&
    order.status !== OrderStatus.RETURNED &&
    order.status !== OrderStatus.CANCELED &&
    Date.now() > trayDate.getTime()
  );
};

const isOrderWithShippingDelay = (order: Order) => {
  if (
    order.status !== OrderStatus.PENDING &&
    order.status !== OrderStatus.CREATED
  ) {
    return false;
  }

  const shippingDeadline = parseOptionalDate(
    order.maxShippingDeadline || order.shippingDate,
  );
  if (!shippingDeadline) return false;

  shippingDeadline.setHours(23, 59, 59, 999);
  return Date.now() > shippingDeadline.getTime();
};

const normalizeTrackingEventText = (value: unknown) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();

const trackingEventDateToTime = (value: unknown) => {
  const parsed = parseOptionalDate(value);
  return parsed ? parsed.getTime() : null;
};

const isTransportDocumentIssuedEvent = (
  event: Order["trackingHistory"][number],
) => {
  const status = normalizeTrackingEventText(event.status);
  const description = normalizeTrackingEventText(event.description);
  const combined = `${status} ${description}`.trim();

  return (
    combined.includes("DOCUMENTO DE TRANSPORTE EMITIDO") ||
    combined.includes("DOCUMENTO TRANSPORTE EMITIDO") ||
    combined.includes("DOCUMENTO DE TRANSPORTE FOI EMITIDO") ||
    combined.includes("CT-E AUTORIZADO") ||
    combined.includes("CTE AUTORIZADO") ||
    combined.includes("CTE EMITIDO") ||
    combined.includes("CT-E EMITIDO")
  );
};

const isDeliveredTrackingEvent = (event: Order["trackingHistory"][number]) => {
  const status = normalizeTrackingEventText(event.status);
  const description = normalizeTrackingEventText(event.description);
  const combined = `${status} ${description}`.trim();

  if (status === OrderStatus.DELIVERED || status.includes("DELIVERED")) {
    return true;
  }

  if (
    combined.includes("NAO ENTREGUE") ||
    combined.includes("TENTATIVA DE ENTREGA") ||
    combined.includes("ENTREGA NAO REALIZADA")
  ) {
    return false;
  }

  return (
    combined.includes("ENTREGUE") ||
    combined.includes("ENTREGA REALIZADA") ||
    combined.includes("ENTREGA CONCLUIDA")
  );
};

const getTransportDocumentIssuedDate = (order: Order) => {
  const trackingHistory = Array.isArray(order.trackingHistory)
    ? order.trackingHistory
    : [];

  const matchingEvent = trackingHistory
    .filter(isTransportDocumentIssuedEvent)
    .sort(
      (left, right) =>
        (trackingEventDateToTime(left.date) || 0) -
        (trackingEventDateToTime(right.date) || 0),
    )[0];

  return matchingEvent ? trackingEventDateToTime(matchingEvent.date) : null;
};

const getDeliveredDate = (order: Order) => {
  const trackingHistory = Array.isArray(order.trackingHistory)
    ? order.trackingHistory
    : [];

  const deliveredEvent = trackingHistory
    .filter(isDeliveredTrackingEvent)
    .sort(
      (left, right) =>
        (trackingEventDateToTime(left.date) || 0) -
        (trackingEventDateToTime(right.date) || 0),
    )[0];

  return (
    (deliveredEvent ? trackingEventDateToTime(deliveredEvent.date) : null) ??
    trackingEventDateToTime(order.lastUpdate)
  );
};

const getDeliveredElapsedDaysFromTransportDocument = (order: Order) => {
  if (order.status !== OrderStatus.DELIVERED) {
    return null;
  }

  const start = getTransportDocumentIssuedDate(order);
  if (start === null) {
    return null;
  }

  const deliveredAt = getDeliveredDate(order);
  if (deliveredAt === null) {
    return null;
  }

  return (deliveredAt - start) / DAY_IN_MS;
};

const getOrderMonthReferenceDate = (order: Order) => {
  if (order.status === OrderStatus.DELIVERED) {
    const deliveredAt = getDeliveredDate(order);
    if (deliveredAt !== null) {
      return new Date(deliveredAt);
    }
  }

  return resolvePlatformCreatedDate(order);
};

const isEarlyDelivery = (order: Order) => {
  if (order.status !== OrderStatus.DELIVERED) return false;

  const deliveryDate = new Date(order.lastUpdate);
  const promisedDate = parseOptionalDate(
    order.carrierEstimatedDeliveryDate || order.estimatedDeliveryDate,
  );
  if (!promisedDate) return false;
  promisedDate.setHours(23, 59, 59, 999);

  return promisedDate.getTime() - deliveryDate.getTime() > DAY_IN_MS * 2;
};

export const Dashboard: React.FC<DashboardProps> = ({
  orders,
  onChangeView,
  onFilterRequest,
}) => {
  // --- Local Filter State ---
  const [showFilters, setShowFilters] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [carrierFilter, setCarrierFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [marketplaceFilter, setMarketplaceFilter] = useState("ALL");
  const [dateType, setDateType] = useState<"shipping" | "delivery">("shipping");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  // --- UI State ---
  const [isRankingExpanded, setIsRankingExpanded] = useState(false);

  const currentMonthDateFilters = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    return {
      dateRangeStart: start.toISOString().slice(0, 10),
      dateRangeEnd: end.toISOString().slice(0, 10),
    };
  }, []);

  // --- Helpers ---
  const uniqueCarriers = useMemo(
    () =>
      Array.from(
        new Set(
          orders
            .map((o) => normalizeCarrierName(o.freightType)),
        ),
      ).sort(),
    [orders],
  );
  const uniqueMarketplaces = useMemo(
    () =>
      Array.from(
        new Set(
          orders.map((o) => o.salesChannel),
        ),
      ).sort(),
    [orders],
  );

  // --- Filtering Logic ---
  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (o.status === OrderStatus.CANCELED) return false;
      if (isChannelManagedOrder(o)) return false;

      // Text Search
      const textMatch =
        !searchText ||
        toText(o.orderNumber)
          .toLowerCase()
          .includes(searchText.toLowerCase()) ||
        toText((o as any).invoiceNumber)
          .toLowerCase()
          .includes(searchText.toLowerCase()) ||
        toText(o.customerName).toLowerCase().includes(searchText.toLowerCase());

      // Dropdowns
      const carrierMatch =
        carrierFilter === "ALL" ||
        normalizeCarrierName(o.freightType) === carrierFilter;
      const statusMatch = statusFilter === "ALL" || o.status === statusFilter;
      const marketMatch =
        marketplaceFilter === "ALL" || o.salesChannel === marketplaceFilter;

      // Dates
      let dateMatch = true;
      if (startDate || endDate) {
        const targetDate =
          dateType === "shipping"
            ? resolvePlatformCreatedDate(o)
            : parseOptionalDate(o.estimatedDeliveryDate);
        if (!targetDate) return false;
        if (startDate)
          dateMatch = dateMatch && targetDate >= new Date(startDate);
        if (endDate) dateMatch = dateMatch && targetDate <= new Date(endDate);
      }

      return (
        textMatch && carrierMatch && statusMatch && marketMatch && dateMatch
      );
    });
  }, [
    orders,
    searchText,
    carrierFilter,
    statusFilter,
    marketplaceFilter,
    startDate,
    endDate,
    dateType,
  ]);

  // --- KPI Calculation ---
  const stats = useMemo(() => {
    const total = filteredOrders.length;
    const delivered = filteredOrders.filter(
      (o) => o.status === OrderStatus.DELIVERED,
    ).length;

    // Status Breakdowns
    const waiting = filteredOrders.filter(
      (o) =>
        o.status === OrderStatus.PENDING || o.status === OrderStatus.CREATED,
    ).length;
    const inTransit = filteredOrders.filter(
      (o) => o.status === OrderStatus.SHIPPED,
    ).length;
    const onRoute = filteredOrders.filter((o) => isOrderOnRoute(o)).length;
    const activeDelayed = filteredOrders.filter(
      isActiveCarrierDelayedOrder,
    ).length;
    const platformDelayed = filteredOrders.filter(
      isActivePlatformDelayedOrder,
    ).length;
    const shippingDelayed = filteredOrders.filter(
      isOrderWithShippingDelay,
    ).length;

    // No Sync: Count orders that have never been synced
    const noSync = filteredOrders.filter((o) => !o.lastApiSync).length;

    // Time Logic
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dueToday = filteredOrders.filter((o) => {
      if (
        o.status === OrderStatus.DELIVERED ||
        o.status === OrderStatus.FAILURE ||
        o.status === OrderStatus.RETURNED ||
        o.status === OrderStatus.CANCELED ||
        o.status === OrderStatus.CHANNEL_LOGISTICS
      ) {
        return false;
      }

      const d = parseOptionalDate(
        o.carrierEstimatedDeliveryDate || o.estimatedDeliveryDate,
      );
      if (!d) return false;
      d.setHours(0, 0, 0, 0);
      return d.getTime() === today.getTime();
    }).length;

    const noForecast = filteredOrders.filter(
      (o) => !o.estimatedDeliveryDate,
    ).length;

    // Risk of Delay (1, 2, 3 days remaining)
    const riskOfDelay = filteredOrders.filter((o) => {
      if (
        !o.estimatedDeliveryDate ||
        o.status === OrderStatus.DELIVERED ||
        o.status === OrderStatus.FAILURE ||
        o.status === OrderStatus.RETURNED ||
        o.status === OrderStatus.CANCELED
      )
        return false;

      const est = parseOptionalDate(o.estimatedDeliveryDate);
      if (!est) return false;
      est.setHours(0, 0, 0, 0);

      const diffTime = est.getTime() - today.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      return diffDays >= 1 && diffDays <= 2;
    }).length;

    // Delivery Failures
    const deliveryFailures = filteredOrders.filter((o) =>
      isPendingDeliveryFailureOrder(o),
    ).length;

    // Average Time (Documento de Transporte Emitido -> Entregue)
    let totalDays = 0;
    let measurableCount = 0;

    // On Time Calculation Logic
    let deliveredOnTime = 0;
    let carrierMeasurableCount = 0;
    filteredOrders.forEach((o) => {
      if (!isQualityMeasurableOrder(o)) return;

      const diff = getDeliveredElapsedDaysFromTransportDocument(o);
      if (diff !== null && diff >= 0) {
        totalDays += diff;
        measurableCount++;
      }

      if (isCarrierQualityMeasurableOrder(o)) {
        carrierMeasurableCount++;
      }

      if (
        o.status === OrderStatus.DELIVERED &&
        isOrderDeliveredOnCarrierTime(o)
      ) {
        deliveredOnTime++;
      }
    });

    const avgDays =
      measurableCount > 0 ? (totalDays / measurableCount).toFixed(1) : "0.0";

    const onTimePct =
      carrierMeasurableCount > 0
        ? ((deliveredOnTime / carrierMeasurableCount) * 100).toFixed(1)
        : "0.0";

    return {
      total,
      delivered,
      waiting,
      inTransit,
      onRoute,
      delayed: activeDelayed,
      shippingDelayed,
      platformDelayed,
      dueToday,
      noForecast,
      avgDays,
      onTimePct,
      noSync,
      riskOfDelay,
      deliveryFailures,
    };
  }, [filteredOrders]);

  // --- Month Summary Logic ---
  const monthSummary = useMemo(() => {
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const previousMonthStart = new Date(
      now.getFullYear(),
      now.getMonth() - 1,
      1,
    );

    const monthEligibleOrders = orders.filter((order) => {
      if (order.status === OrderStatus.CANCELED) return false;
      if (isChannelManagedOrder(order)) return false;
      return true;
    });

    const currentMonthOrders = monthEligibleOrders.filter((order) =>
      isDateInRange(
        getOrderMonthReferenceDate(order),
        currentMonthStart,
        nextMonthStart,
      ),
    );
    const previousMonthOrders = monthEligibleOrders.filter((order) =>
      isDateInRange(
        getOrderMonthReferenceDate(order),
        previousMonthStart,
        currentMonthStart,
      ),
    );

    const calcGrowth = (curr: number, prev: number) => {
      if (prev === 0) return curr > 0 ? 100 : 0;
      return ((curr - prev) / prev) * 100;
    };

    const currentMonthDeliveredOrders = currentMonthOrders.filter(
      (order) => order.status === OrderStatus.DELIVERED,
    );
    const previousMonthDeliveredOrders = previousMonthOrders.filter(
      (order) => order.status === OrderStatus.DELIVERED,
    );

    const totalGrowth = calcGrowth(
      currentMonthDeliveredOrders.length,
      previousMonthDeliveredOrders.length,
    );

    const currentMonthCarrierDelayed = currentMonthOrders.filter(
      isActiveCarrierDelayedOrder,
    ).length;
    const currentMonthPlatformDelayed = currentMonthOrders.filter(
      isActivePlatformDelayedOrder,
    ).length;
    const currentMonthActiveDelayed = currentMonthOrders.filter(
      (order) =>
        isActiveCarrierDelayedOrder(order) ||
        isActivePlatformDelayedOrder(order),
    ).length;

    const currentMonthCarrierMeasurableCount = currentMonthOrders.filter(
      isCarrierQualityMeasurableOrder,
    ).length;
    const previousMonthCarrierMeasurableCount = previousMonthOrders.filter(
      isCarrierQualityMeasurableOrder,
    ).length;
    const currDeliveredOnTime = currentMonthOrders.filter(
      (order) =>
        order.status === OrderStatus.DELIVERED &&
        isOrderDeliveredOnCarrierTime(order),
    ).length;
    const prevDeliveredOnTime = previousMonthOrders.filter(
      (order) =>
        order.status === OrderStatus.DELIVERED &&
        isOrderDeliveredOnCarrierTime(order),
    ).length;

    const currOnTimePct =
      currentMonthCarrierMeasurableCount > 0
        ? (currDeliveredOnTime / currentMonthCarrierMeasurableCount) * 100
        : 0;

    const prevOnTimePct =
      previousMonthCarrierMeasurableCount > 0
        ? (prevDeliveredOnTime / previousMonthCarrierMeasurableCount) * 100
        : 0;

    const onTimeGrowth = calcGrowth(currOnTimePct, prevOnTimePct);

    return {
      totalDelivered: currentMonthDeliveredOrders.length,
      totalGrowth,
      onTimePct: currOnTimePct.toFixed(1),
      onTimeGrowth,
      activeDelayed: currentMonthActiveDelayed,
      carrierDelayed: currentMonthCarrierDelayed,
      platformDelayed: currentMonthPlatformDelayed,
    };
  }, [orders]);

  // --- Carrier Ranking Logic ---
  const carrierRanking = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string;
        volume: number;
        onTime: number;
        lateCarrier: number;
        lateTray: number;
        early: number;
        totalTime: number;
        measurableCount: number;
        averageTimeCount: number;
      }
    >();

    filteredOrders.forEach((o) => {
      if (!isQualityMeasurableOrder(o)) return;

      const name = normalizeCarrierName(o.freightType) || "Desconhecida";
      const current = map.get(name) || {
        name,
        volume: 0,
        onTime: 0,
        lateCarrier: 0,
        lateTray: 0,
        early: 0,
        totalTime: 0,
        measurableCount: 0,
        averageTimeCount: 0,
      };

      if (
        !isCarrierQualityMeasurableOrder(o) &&
        !isOrderOutsideTrayDeadline(o)
      ) {
        map.set(name, current);
        return;
      }

      const days = getDeliveredElapsedDaysFromTransportDocument(o);
      if (isCarrierQualityMeasurableOrder(o)) {
        current.measurableCount++;
        current.volume = current.measurableCount;
      }

      if (days !== null && days >= 0) {
        current.totalTime += days;
        current.averageTimeCount++;
      }

      if (
        o.status === OrderStatus.DELIVERED &&
        isOrderDeliveredOnCarrierTime(o)
      ) {
        current.onTime++;
        if (isEarlyDelivery(o)) {
          current.early++;
        }
      } else if (isOrderOutsideCarrierDeadline(o)) {
        current.lateCarrier++;
      }

      if (isOrderOutsideTrayDeadline(o)) {
        current.lateTray++;
      }

      map.set(name, current);
    });

    return Array.from(map.values())
      .filter((carrier) => carrier.measurableCount > 0 || carrier.lateTray > 0)
      .sort((a, b) => b.volume - a.volume || b.lateTray - a.lateTray);
    // Removed .slice(0, 5) to allow expansion
  }, [filteredOrders]);

  // --- Status Chart Data ---
  const statusChartData = useMemo(() => {
    const counts: Record<string, number> = {};
    filteredOrders.forEach((o) => {
      const label = STATUS_LABELS[o.status] || o.status;
      counts[label] = (counts[label] || 0) + 1;
    });
    return Object.keys(counts)
      .map((key) => ({ name: key, value: counts[key] }))
      .sort((a, b) => b.value - a.value);
  }, [filteredOrders]);

  const RADIAN = Math.PI / 180;
  const renderCustomizedLabel = ({
    cx,
    cy,
    midAngle,
    innerRadius,
    outerRadius,
    percent,
    index,
  }: any) => {
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    return (
      <text
        x={x}
        y={y}
        fill="white"
        textAnchor={x > cx ? "start" : "end"}
        dominantBaseline="central"
        fontSize={10}
        fontWeight="bold"
      >
        {`${(percent * 100).toFixed(0)}%`}
      </text>
    );
  };

  // --- Components ---
  const KpiCard = ({
    title,
    value,
    icon: Icon,
    color,
    subtext,
    onClick,
  }: any) => (
    <div
      className={clsx(
        "glass-card p-4 rounded-xl border border-slate-200 dark:border-white/5 relative overflow-hidden group",
        onClick &&
          "cursor-pointer hover:shadow-lg transition-shadow hover:border-accent/30",
      )}
      onClick={onClick}
    >
      <div
        className={clsx(
          "absolute right-0 top-0 p-3 rounded-bl-xl opacity-10 group-hover:opacity-20 transition-opacity",
          color,
        )}
      >
        <Icon className="w-8 h-8" />
      </div>
      <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
        {title}
      </p>
      <h3 className="text-2xl font-bold text-slate-800 dark:text-white mb-1">
        {value}
      </h3>
      {subtext && <p className="text-[10px] text-slate-400">{subtext}</p>}
    </div>
  );

  // --- Navigation Handler ---
  const handleCardClick = (filterType: string, value?: string) => {
    if (filterType === "risk_of_delay") {
      onFilterRequest?.({ alertTab: "risk" });
      onChangeView("alerts");
      return;
    }

    if (filterType === "delivery-failures") {
      onChangeView("delivery-failures");
      return;
    }

    if (onFilterRequest) {
      // Map card types to filter criteria
      const filters: any = {};

      switch (filterType) {
        case "delivered":
          filters.status = OrderStatus.DELIVERED;
          break;
        case "in_progress":
          filters.customStatus = [
            "PENDING",
            "CREATED",
            "SHIPPED",
            "DELIVERY_ATTEMPT",
            "CHANNEL_LOGISTICS",
          ];
          break;
        case "waiting":
          filters.customStatus = ["PENDING", "CREATED"];
          break;
        case "in_transit":
          filters.status = OrderStatus.SHIPPED;
          break;
        case "on_route":
          filters.status = OrderStatus.DELIVERY_ATTEMPT;
          break;
        case "delayed":
          filters.onlyDelayed = true;
          break;
        case "platform_delayed":
          filters.onlyPlatformDelayed = true;
          break;
        case "shipping_delayed":
          filters.onlyShippingDelayed = true;
          break;
        case "due_today":
          filters.dueToday = true;
          break;
        case "no_sync":
          filters.noSync = true;
          break;
        case "no_forecast":
          filters.noForecast = true;
          break;
        default:
          break;
      }

      onFilterRequest(filters);
      onChangeView("orders");
    }
  };

  const displayedRanking = isRankingExpanded
    ? carrierRanking
    : carrierRanking.slice(0, 5);

  return (
    <div className="space-y-6 pb-20">
      {/* ================= 1. KPI GRID ================= */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 xl:grid-cols-7 gap-3">
        <KpiCard
          title="Total de NFs"
          value={stats.total}
          icon={FileText}
          color="bg-blue-500"
          onClick={() => handleCardClick("all")}
        />
        <KpiCard
          title="Entregues"
          value={stats.delivered}
          icon={CheckCircle}
          color="bg-emerald-500"
          onClick={() => handleCardClick("delivered")}
        />
        <KpiCard
          title="Aguardando Envio"
          value={stats.waiting}
          icon={Package}
          color="bg-slate-500"
          onClick={() => handleCardClick("waiting")}
        />
        <KpiCard
          title="Envio atrasado"
          value={stats.shippingDelayed}
          icon={Package}
          color="bg-rose-600"
          onClick={() => handleCardClick("shipping_delayed")}
        />
        <KpiCard
          title="Em Trânsito"
          value={stats.inTransit}
          icon={Truck}
          color="bg-indigo-500"
          onClick={() => handleCardClick("in_transit")}
        />
        <KpiCard
          title="Em Rota"
          value={stats.onRoute}
          icon={MapPin}
          color="bg-cyan-500"
          onClick={() => handleCardClick("on_route")}
        />

        <KpiCard
          title="Atraso Transportadora"
          value={stats.delayed}
          icon={AlertTriangle}
          color="bg-red-500"
          onClick={() => handleCardClick("delayed")}
        />
        <KpiCard
          title="Risco de Atraso"
          value={stats.riskOfDelay}
          icon={AlertTriangle}
          color="bg-orange-600"
          subtext="1-2 dias"
          onClick={() => handleCardClick("risk_of_delay")}
        />
        <KpiCard
          title="Vence Hoje"
          value={stats.dueToday}
          icon={Calendar}
          color="bg-pink-500"
          onClick={() => handleCardClick("due_today")}
        />
        <KpiCard
          title="Sem Sync"
          value={stats.noSync}
          icon={WifiOff}
          color="bg-gray-700"
          subtext="Sem rastreio"
          onClick={() => handleCardClick("no_sync")}
        />
        <KpiCard
          title="Falhas na Entrega"
          value={stats.deliveryFailures}
          icon={AlertTriangle}
          color="bg-red-700"
          subtext="Ação Necessária"
          onClick={() => handleCardClick("delivery-failures")}
        />
        <KpiCard
          title="Média Dias"
          value={stats.avgDays}
          icon={Timer}
          color="bg-purple-500"
          subtext="p/ entrega"
        />
        <KpiCard
          title="No Prazo"
          value={`${stats.onTimePct}%`}
          icon={TrendingUp}
          color="bg-green-500"
        />
        <KpiCard
          title="Atraso Plataforma"
          value={stats.platformDelayed}
          icon={Bell}
          color="bg-orange-500"
          onClick={() => handleCardClick("platform_delayed")}
        />
      </div>

      {/* ================= 2. FILTERS BAR ================= */}
      <div className="glass-card rounded-xl border border-slate-200 dark:border-white/10 p-4">
        <div
          className="flex items-center justify-between mb-4 cursor-pointer"
          onClick={() => setShowFilters(!showFilters)}
        >
          <h3 className="font-bold text-slate-800 dark:text-white flex items-center gap-2">
            <Filter className="w-4 h-4 text-accent" /> Filtros
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setSearchText("");
                setCarrierFilter("ALL");
                setStatusFilter("ALL");
                setMarketplaceFilter("ALL");
                setStartDate("");
                setEndDate("");
              }}
              className="text-xs text-red-400 hover:text-red-300 font-medium mr-2"
            >
              Limpar
            </button>
            {showFilters ? (
              <ChevronUp className="w-4 h-4 text-slate-500" />
            ) : (
              <ChevronDown className="w-4 h-4 text-slate-500" />
            )}
          </div>
        </div>

        {showFilters && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-3 animate-in slide-in-from-top-2">
            {/* Search */}
            <div className="lg:col-span-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="NF, pedido, cliente..."
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm focus:border-accent outline-none"
                />
              </div>
            </div>

            {/* Carrier */}
            <select
              value={carrierFilter}
              onChange={(e) => setCarrierFilter(e.target.value)}
              className="bg-slate-50 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm focus:border-accent outline-none"
            >
              <option value="ALL">Transportadora (todas)</option>
              {uniqueCarriers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            {/* Status - TRANSLATED */}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="bg-slate-50 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm focus:border-accent outline-none"
            >
              <option value="ALL">Status (todos)</option>
              {Object.values(OrderStatus).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s] || s}
                </option>
              ))}
            </select>

            {/* Marketplace */}
            <select
              value={marketplaceFilter}
              onChange={(e) => setMarketplaceFilter(e.target.value)}
              className="bg-slate-50 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm focus:border-accent outline-none"
            >
              <option value="ALL">Marketplace (todos)</option>
              {uniqueMarketplaces.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>

            {/* Date Type Toggle */}
            <div className="flex bg-slate-100 dark:bg-white/5 rounded-lg p-1">
              <button
                onClick={() => setDateType("shipping")}
                className={clsx(
                  "flex-1 text-xs font-medium rounded py-1",
                  dateType === "shipping"
                    ? "bg-white dark:bg-slate-700 shadow-sm"
                    : "text-slate-500",
                )}
              >
                Emissão
              </button>
              <button
                onClick={() => setDateType("delivery")}
                className={clsx(
                  "flex-1 text-xs font-medium rounded py-1",
                  dateType === "delivery"
                    ? "bg-white dark:bg-slate-700 shadow-sm"
                    : "text-slate-500",
                )}
              >
                Entrega
              </button>
            </div>

            {/* Date Inputs */}
            <div className="lg:col-span-2 xl:col-span-6 flex gap-2">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="flex-1 bg-slate-50 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none"
              />
              <span className="self-center text-slate-400">até</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="flex-1 bg-slate-50 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none"
              />
              <button
                className="bg-accent hover:bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-medium transition-colors"
                onClick={() => {}}
              >
                Filtrar
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ================= 3. CHARTS & LISTS AREA ================= */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 min-w-0">
        {/* Left Column: Month Summary & Chart */}
        <div className="flex flex-col gap-6 min-w-0">
          {/* Month Summary */}
          <div className="glass-card rounded-xl border border-slate-200 dark:border-white/10 overflow-hidden flex flex-col">
            <div className="p-4 border-b border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5">
              <h3 className="font-bold text-slate-800 dark:text-white">
                Resumo do Mês
              </h3>
              <p className="text-xs text-slate-500">
                Mês atual vs mês anterior
              </p>
            </div>
            <div className="p-6 flex-1 flex flex-col gap-6">
              {/* Delay Summary Box */}
              <div className="bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 rounded-xl p-4">
                <div className="flex justify-between items-center mb-4">
                  <div className="flex items-center gap-2 text-red-700 dark:text-red-400 font-bold">
                    <AlertTriangle className="w-5 h-5" /> Atrasos Ativos
                  </div>
                  <span className="text-2xl font-bold text-red-700 dark:text-white">
                    {monthSummary.activeDelayed}
                  </span>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between text-red-600 dark:text-red-300/80">
                    <span>Atraso transportadora</span>
                    <span className="font-bold">
                      {monthSummary.carrierDelayed}
                    </span>
                  </div>
                  <div className="flex justify-between text-red-600 dark:text-red-300/80">
                    <span>Atraso plataforma</span>
                    <span className="font-bold">
                      {monthSummary.platformDelayed}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => {
                    onFilterRequest?.({
                      onlyPlatformDelayed: true,
                      ...currentMonthDateFilters,
                    });
                    onChangeView("orders");
                  }}
                  className="text-xs text-red-500 hover:text-red-400 mt-4 underline decoration-red-500/30 underline-offset-4"
                >
                  Ver pedidos em atraso plataforma (
                  {monthSummary.platformDelayed})
                </button>
              </div>

              {/* Comparison Stats */}
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-slate-50 dark:bg-black/20 rounded-xl border border-slate-100 dark:border-white/5">
                  <p className="text-xs text-slate-500 uppercase">
                    Total Entregas
                  </p>
                  <h4 className="text-3xl font-bold text-slate-800 dark:text-white mt-1">
                    {monthSummary.totalDelivered}
                  </h4>
                  <div
                    className={clsx(
                      "flex items-center gap-1 text-xs mt-1 font-bold",
                      monthSummary.totalGrowth >= 0
                        ? "text-emerald-500"
                        : "text-red-500",
                    )}
                  >
                    {monthSummary.totalGrowth >= 0 ? (
                      <ArrowUpRight className="w-3 h-3" />
                    ) : (
                      <ArrowDownRight className="w-3 h-3" />
                    )}
                    {Math.abs(monthSummary.totalGrowth).toFixed(0)}% vs mês ant.
                  </div>
                </div>

                <div className="p-4 bg-slate-50 dark:bg-black/20 rounded-xl border border-slate-100 dark:border-white/5">
                  <p className="text-xs text-slate-500 uppercase">No Prazo</p>
                  <h4 className="text-3xl font-bold text-slate-800 dark:text-white mt-1">
                    {monthSummary.onTimePct}%
                  </h4>
                  <div
                    className={clsx(
                      "flex items-center gap-1 text-xs mt-1 font-bold",
                      monthSummary.onTimeGrowth >= 0
                        ? "text-emerald-500"
                        : "text-red-500",
                    )}
                  >
                    {monthSummary.onTimeGrowth >= 0 ? (
                      <ArrowUpRight className="w-3 h-3" />
                    ) : (
                      <ArrowDownRight className="w-3 h-3" />
                    )}
                    {Math.abs(monthSummary.onTimeGrowth).toFixed(0)}% vs mês
                    ant.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Status Chart Card */}
          <div className="glass-card rounded-xl border border-slate-200 dark:border-white/10 p-5 flex flex-col flex-1 min-w-0">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-slate-800 dark:text-white flex items-center gap-2">
                <PieChartIcon className="w-4 h-4 text-accent" />
                Distribuição
              </h3>
            </div>
            <div className="h-[250px] w-full min-w-0 min-h-[250px]">
              <ResponsiveContainer width="99%" height="100%" minWidth={0}>
                <PieChart>
                  <Pie
                    data={statusChartData}
                    innerRadius={55}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                    stroke="none"
                    label={renderCustomizedLabel}
                    labelLine={false}
                  >
                    {statusChartData.map((_, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={CHART_COLORS[index % CHART_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <RechartsTooltip
                    contentStyle={{
                      backgroundColor: "#1e293b",
                      borderColor: "#334155",
                      color: "#fff",
                      borderRadius: "8px",
                    }}
                    itemStyle={{ color: "#fff" }}
                  />
                  <Legend
                    verticalAlign="bottom"
                    height={36}
                    iconType="circle"
                    formatter={(value) => (
                      <span className="text-xs text-slate-500 dark:text-slate-300 ml-1">
                        {value}
                      </span>
                    )}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Right: Detailed Ranking List */}
        <div className="lg:col-span-2 glass-card rounded-xl border border-slate-200 dark:border-white/10 overflow-hidden flex flex-col min-w-0">
          <div className="p-4 border-b border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 flex justify-between items-center">
            <h3 className="font-bold text-slate-800 dark:text-white">
              Ranking de Transportadoras
            </h3>
            <span className="text-xs text-slate-500 bg-slate-100 dark:bg-white/5 px-2 py-1 rounded-full">
              {carrierRanking.length} parceiros listados
            </span>
          </div>
          <div className="flex-1 overflow-auto p-4 space-y-3">
            {carrierRanking.length === 0 ? (
              <div className="text-center text-slate-400 py-10">
                Sem dados para ranking.
              </div>
            ) : (
              displayedRanking.map((carrier, index) => (
                <div
                  key={carrier.name}
                  className="p-4 rounded-lg bg-slate-50 dark:bg-black/20 border border-slate-100 dark:border-white/5 hover:border-accent/30 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-sm font-bold text-accent">
                      #{index + 1}
                    </span>
                    <h4 className="font-bold text-slate-800 dark:text-white text-sm">
                      {carrier.name}
                    </h4>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase">
                        Volume
                      </p>
                      <p className="font-bold text-slate-800 dark:text-white">
                        {carrier.volume}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase">
                        No Prazo
                      </p>
                      <p className="font-bold text-emerald-500">
                        {carrier.onTime}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase">
                        Fora Prazo Transportadora
                      </p>
                      <p className="font-bold text-red-500">
                        {carrier.lateCarrier}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase">
                        Fora Prazo Integradora
                      </p>
                      <p className="font-bold text-rose-500">
                        {carrier.lateTray}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase">
                        Adiantado
                      </p>
                      <p className="font-bold text-blue-500">{carrier.early}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase">
                        Tempo Méd.
                      </p>
                      <p className="font-bold text-slate-800 dark:text-white">
                        {carrier.averageTimeCount > 0
                          ? (
                              carrier.totalTime / carrier.averageTimeCount
                            ).toFixed(1)
                          : "-"}{" "}
                        d
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 w-full bg-slate-200 dark:bg-white/10 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-500"
                      style={{
                        width: `${(carrier.onTime / (carrier.measurableCount || 1)) * 100}%`,
                      }}
                    ></div>
                  </div>
                  <div className="flex justify-between text-[10px] text-slate-400 mt-1">
                    <span>
                      qualidade:{" "}
                      {(
                        (carrier.onTime / (carrier.measurableCount || 1)) *
                        100
                      ).toFixed(0)}
                      % bom
                    </span>
                    <span>
                      {(
                        (carrier.lateCarrier / (carrier.measurableCount || 1)) *
                        100
                      ).toFixed(0)}
                      % fora transportadora
                    </span>
                  </div>
                </div>
              ))
            )}
            {carrierRanking.length > 5 && (
              <div className="text-center pt-2 pb-2">
                <button
                  onClick={() => setIsRankingExpanded(!isRankingExpanded)}
                  className="px-4 py-2 bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg text-xs font-medium hover:bg-slate-50 dark:hover:bg-white/10 transition-colors flex items-center gap-1 mx-auto"
                >
                  {isRankingExpanded ? (
                    <>
                      Ver menos <ChevronUp className="w-3 h-3" />
                    </>
                  ) : (
                    <>
                      Ver todas ({carrierRanking.length}){" "}
                      <ChevronDown className="w-3 h-3" />
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
