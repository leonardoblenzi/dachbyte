import React, {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
} from "react";
import {
  Order,
  OrderStatus,
  SyncJobStatus,
  TraySyncFilters,
  TrayIntegrationStatus,
  IntegrationOrderStatusOption,
} from "../types";
import { OrderDetail } from "./OrderDetail";
import {
  Download,
  Search,
  Filter,
  Globe,
  ChevronDown,
  ChevronUp,
  X,
  Calendar,
  Truck,
  ShoppingBag,
  Eye,
  ExternalLink,
  Loader2,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Star,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import { clsx } from "clsx";
import {
  normalizeCarrierName,
  isCarrierDelayedOrder,
  isOrderOnRoute,
  isPlatformDelayedOrder,
  toText,
  normalizeTrackingHistory,
  parseOptionalDate,
  formatDateOrDash,
  formatCarrierForecast,
} from "../utils";
import { fetchWithAuth } from "../utils/authFetch";
import { showToast } from "../utils/toast";
import { LOGO_URL } from "../constants";

const DELAYED_STATUS_FILTER = "DELAYED";
const ORDER_TABLE_COLUMN_STORAGE_KEY =
  "avantracking:order-list-visible-columns";

type SortDirection = "asc" | "desc";
type DueWindow = "today" | "tomorrow" | "in2days" | null;
type SortKey =
  | "orderNumber"
  | "invoiceNumber"
  | "shippingDate"
  | "salesChannel"
  | "freightType"
  | "freightValue"
  | "recalculatedFreightValue"
  | "freightDifference"
  | "estimatedDeliveryDate"
  | "carrierEstimatedDeliveryDate"
  | "lastUpdate"
  | "status";

type VisibleColumnKey =
  | "orderNumber"
  | "invoiceNumber"
  | "shippingDate"
  | "salesChannel"
  | "freightType"
  | "freightValue"
  | "recalculatedFreightValue"
  | "freightDifference"
  | "estimatedDeliveryDate"
  | "carrierEstimatedDeliveryDate"
  | "lastUpdate"
  | "status";

interface OrderTableColumn {
  key: VisibleColumnKey;
  label: string;
  sortKey: SortKey;
}

const ORDER_TABLE_COLUMNS: OrderTableColumn[] = [
  { key: "orderNumber", label: "ID / Pedido", sortKey: "orderNumber" },
  { key: "invoiceNumber", label: "Nota Fiscal", sortKey: "invoiceNumber" },
  { key: "shippingDate", label: "Data de envio", sortKey: "shippingDate" },
  { key: "salesChannel", label: "Marketplace", sortKey: "salesChannel" },
  { key: "freightType", label: "Transportadora", sortKey: "freightType" },
  { key: "freightValue", label: "Frete Pago", sortKey: "freightValue" },
  {
    key: "recalculatedFreightValue",
    label: "Frete Recalculado",
    sortKey: "recalculatedFreightValue",
  },
  {
    key: "freightDifference",
    label: "Diferenca Frete",
    sortKey: "freightDifference",
  },
  {
    key: "estimatedDeliveryDate",
    label: "Prev. Entrega",
    sortKey: "estimatedDeliveryDate",
  },
  {
    key: "carrierEstimatedDeliveryDate",
    label: "Previsao Transportadora",
    sortKey: "carrierEstimatedDeliveryDate",
  },
  {
    key: "lastUpdate",
    label: "Ultima Movimentacao",
    sortKey: "lastUpdate",
  },
  {
    key: "status",
    label: "Status",
    sortKey: "status",
  },
];

const DEFAULT_VISIBLE_COLUMNS = ORDER_TABLE_COLUMNS.map((column) => column.key);
const ORDER_LIST_PAGE_SIZE_OPTIONS = [50, 100, 200] as const;
const DEFAULT_ORDER_LIST_PAGE_SIZE = 100;

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

const TRAY_DAY_OPTIONS: TraySyncFilters["days"][] = [90, 60, 30, 15, 7];

// Integradoras que suportam sincronização de pedidos
const INTEGRATIONS_WITH_SYNC = ["tray", "anymarket", "magazord", "jet"] as const;

interface IntegrationStatusOptionsResponse {
  success: boolean;
  integration:
    | "tray"
    | "anymarket"
    | "magazord"
    | "jet"
    | "bling"
    | "sysemp"
    | null;
  integrationLabel: string;
  statuses: IntegrationOrderStatusOption[];
  manualStatuses?: IntegrationOrderStatusOption[];
  manualStatusesSource?: "configured" | "integration_fallback";
  cancelStatusValues: string[];
}

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

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const buildTrackingLoadingHtml = () => `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Carregando rastreio...</title>
  </head>
  <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at top,#1d4ed8 0%,#0f172a 58%);font-family:'Segoe UI',Arial,sans-serif;color:#ffffff;">
    <div style="width:min(420px,calc(100vw - 32px));border:1px solid rgba(191,219,254,0.28);border-radius:24px;padding:32px 28px;background:rgba(15,23,42,0.82);box-shadow:0 24px 80px rgba(15,23,42,0.35);text-align:center;">
      <img src="${LOGO_URL}" alt="Avantracking" style="width:112px;max-width:112px;height:auto;display:block;margin:0 auto 20px;" />
      <div style="width:44px;height:44px;margin:0 auto 18px;border-radius:999px;border:3px solid rgba(255,255,255,0.22);border-top-color:#60a5fa;animation:spin 1s linear infinite;"></div>
      <h1 style="margin:0;font-size:22px;line-height:1.2;">Carregando rastreio...</h1>
      <p style="margin:12px 0 0;font-size:14px;line-height:1.7;color:#dbeafe;">
        Estamos buscando a URL correta do rastreio deste pedido.
      </p>
    </div>
    <style>
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    </style>
  </body>
</html>`;

const buildTrackingErrorHtml = (message: string) => `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Falha ao abrir rastreio</title>
  </head>
  <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;color:#ffffff;">
    <div style="width:min(420px,calc(100vw - 32px));border:1px solid rgba(248,113,113,0.32);border-radius:24px;padding:32px 28px;background:rgba(15,23,42,0.92);box-shadow:0 24px 80px rgba(15,23,42,0.35);text-align:center;">
      <img src="${LOGO_URL}" alt="Avantracking" style="width:112px;max-width:112px;height:auto;display:block;margin:0 auto 20px;" />
      <h1 style="margin:0;font-size:22px;line-height:1.2;">Nao foi possivel abrir o rastreio</h1>
      <p style="margin:12px 0 0;font-size:14px;line-height:1.7;color:#fecaca;">
        ${escapeHtml(message)}
      </p>
    </div>
  </body>
</html>`;

const isDelayedOrder = (
  order: Pick<Order, "status" | "carrierEstimatedDeliveryDate">,
) => isCarrierDelayedOrder(order);

const compareText = (left: unknown, right: unknown) =>
  toText(left).localeCompare(toText(right), "pt-BR", {
    sensitivity: "base",
    numeric: true,
  });

const compareNumber = (
  left: number | null | undefined,
  right: number | null | undefined,
) => (left ?? Number.NEGATIVE_INFINITY) - (right ?? Number.NEGATIVE_INFINITY);

const getDateSortValue = (value: string | Date | null | undefined) => {
  if (value instanceof Date) {
    return value.getTime();
  }

  return parseOptionalDate(value)?.getTime() ?? Number.NEGATIVE_INFINITY;
};

const compareDate = (
  left: string | Date | null | undefined,
  right: string | Date | null | undefined,
) => getDateSortValue(left) - getDateSortValue(right);

const getDisplayStatusLabel = (
  order: Pick<Order, "status" | "carrierEstimatedDeliveryDate">,
) => {
  if (isDelayedOrder(order)) {
    return "Atrasado";
  }

  return STATUS_LABELS[order.status] || order.status;
};

const normalizeDay = (value: Date) => {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
};

const isShippingPendingOrder = (order: Pick<Order, "status">) =>
  order.status === OrderStatus.PENDING || order.status === OrderStatus.CREATED;

const isDeliveryOpenOrder = (order: Pick<Order, "status">) =>
  [
    OrderStatus.PENDING,
    OrderStatus.CREATED,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERY_ATTEMPT,
  ].includes(order.status);

const resolveDayDiffFromToday = (value: unknown) => {
  const parsed = parseOptionalDate(value);
  if (!parsed) return null;

  const today = normalizeDay(new Date());
  const target = normalizeDay(parsed);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
};

const getStoredVisibleColumns = (): VisibleColumnKey[] => {
  if (typeof window === "undefined") {
    return DEFAULT_VISIBLE_COLUMNS;
  }

  try {
    const rawValue = window.localStorage.getItem(
      ORDER_TABLE_COLUMN_STORAGE_KEY,
    );

    if (!rawValue) {
      return DEFAULT_VISIBLE_COLUMNS;
    }

    const parsedValue = JSON.parse(rawValue);

    if (!Array.isArray(parsedValue)) {
      return DEFAULT_VISIBLE_COLUMNS;
    }

    const validColumns = parsedValue.filter(
      (column): column is VisibleColumnKey =>
        ORDER_TABLE_COLUMNS.some((item) => item.key === column),
    );

    return validColumns.length > 0 ? validColumns : DEFAULT_VISIBLE_COLUMNS;
  } catch {
    return DEFAULT_VISIBLE_COLUMNS;
  }
};

interface OrderListProps {
  orders: Order[];
  initialFilters?: any;
  onFetchSingle?: (orderId: string) => Promise<void>;
  onOrderUpdated?: (order: Order) => void;
  isNoMovementView?: boolean;
  onStartSync?: () => Promise<void> | void;
  onCancelSync?: () => Promise<void> | void;
  onStartTraySync?: (filters: TraySyncFilters) => Promise<void>;
  onCancelTraySync?: () => Promise<void> | void;
  syncJob?: SyncJobStatus | null;
  traySyncJob?: SyncJobStatus | null;
  trayIntegrationStatus?: TrayIntegrationStatus | null;
  monitoredOrderIds?: string[];
  onToggleMonitoredOrder?: (order: Order) => Promise<void> | void;
  enableArchiveControls?: boolean;
}

export const OrderList: React.FC<OrderListProps> = ({
  orders,
  initialFilters,
  onFetchSingle,
  onOrderUpdated,
  isNoMovementView = false,
  onStartSync,
  onCancelSync,
  onStartTraySync,
  onCancelTraySync,
  syncJob,
  traySyncJob,
  trayIntegrationStatus,
  monitoredOrderIds = [],
  onToggleMonitoredOrder,
  enableArchiveControls = false,
}) => {
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [isFetchingSingle, setIsFetchingSingle] = useState(false);
  const [showFilters, setShowFilters] = useState(true);
  const [showTopPanel, setShowTopPanel] = useState(true);
  const [isColumnMenuOpen, setIsColumnMenuOpen] = useState(false);
  const [activeFilterMenu, setActiveFilterMenu] = useState<
    "carrier" | "marketplace" | "status" | null
  >(null);
  const [visibleColumns, setVisibleColumns] = useState<VisibleColumnKey[]>(
    getStoredVisibleColumns,
  );
  const [isTraySyncModalOpen, setIsTraySyncModalOpen] = useState(false);
  const [isTraySyncing, setIsTraySyncing] = useState(false);
  const [traySyncDays, setTraySyncDays] = useState<TraySyncFilters["days"]>(90);
  const [selectedTrayStatuses, setSelectedTrayStatuses] = useState<string[]>(
    [],
  );
  const [integrationStatusOptions, setIntegrationStatusOptions] = useState<
    IntegrationOrderStatusOption[]
  >([]);
  const [hasConfiguredManualStatuses, setHasConfiguredManualStatuses] =
    useState(false);
  const [isUsingIntegrationFallbackStatuses, setIsUsingIntegrationFallbackStatuses] =
    useState(false);
  const [integrationLabel, setIntegrationLabel] = useState("Integradora");
  const [activeIntegration, setActiveIntegration] = useState<string | null>(
    null,
  );
  const [isLoadingIntegrationStatuses, setIsLoadingIntegrationStatuses] =
    useState(false);
  const [monitoringOrderIds, setMonitoringOrderIds] = useState<string[]>([]);
  const [syncingTrackingOrderIds, setSyncingTrackingOrderIds] = useState<
    string[]
  >([]);
  const [markingDeliveredOrderIds, setMarkingDeliveredOrderIds] = useState<
    string[]
  >([]);
  const [updatingArchiveOrderIds, setUpdatingArchiveOrderIds] = useState<
    string[]
  >([]);
  const [showArchivedOrders, setShowArchivedOrders] = useState(false);
  const [archivedOrders, setArchivedOrders] = useState<Order[]>([]);
  const [isLoadingArchivedOrders, setIsLoadingArchivedOrders] = useState(false);
  const hasSyncableIntegration = Boolean(
    activeIntegration &&
    INTEGRATIONS_WITH_SYNC.includes(
      activeIntegration as (typeof INTEGRATIONS_WITH_SYNC)[number],
    ),
  );
  const canShowIntegratorSyncButton = Boolean(
    onStartTraySync && !isNoMovementView && !showArchivedOrders,
  );
  const [isSyncing, setIsSyncing] = useState(false); // ✅ Novo state

  // No Movement View State
  const [noMovementDays, setNoMovementDays] = useState(5);

  // Search Modal State
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [apiSearchInput, setApiSearchInput] = useState("");

  // Filters State
  const [searchText, setSearchText] = useState("");
  const [selectedStatusFilters, setSelectedStatusFilters] = useState<string[]>(
    initialFilters?.status && initialFilters.status !== "ALL"
      ? [initialFilters.status]
      : [],
  );
  const [selectedCarrierFilters, setSelectedCarrierFilters] = useState<
    string[]
  >([]);
  const [selectedMarketplaceFilters, setSelectedMarketplaceFilters] = useState<
    string[]
  >([]);
  const [dateRangeStart, setDateRangeStart] = useState(
    initialFilters?.dateRangeStart || "",
  );
  const [dateRangeEnd, setDateRangeEnd] = useState(
    initialFilters?.dateRangeEnd || "",
  );
  const [sortConfig, setSortConfig] = useState<{
    key: SortKey;
    direction: SortDirection;
  } | null>(null);
  const [rowsPerPage, setRowsPerPage] = useState<number>(
    DEFAULT_ORDER_LIST_PAGE_SIZE,
  );
  const [currentPage, setCurrentPage] = useState(1);
  const columnMenuRef = useRef<HTMLDivElement | null>(null);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);

  // Custom Filter Logic from Dashboard
  const [customStatusFilter, setCustomStatusFilter] = useState<string[] | null>(
    initialFilters?.customStatus || null,
  );
  const [onlyDelayed, setOnlyDelayed] = useState<boolean>(
    initialFilters?.onlyDelayed || false,
  );
  const [onlyShippingDelayed, setOnlyShippingDelayed] = useState<boolean>(
    initialFilters?.onlyShippingDelayed || false,
  );
  const [onlyPlatformDelayed, setOnlyPlatformDelayed] = useState<boolean>(
    initialFilters?.onlyPlatformDelayed || false,
  );
  const [dueToday, setDueToday] = useState<boolean>(
    initialFilters?.dueToday || false,
  );
  const [shippingDueWindow, setShippingDueWindow] = useState<DueWindow>(
    initialFilters?.shippingDueWindow || null,
  );
  const [deliveryDueWindow, setDeliveryDueWindow] = useState<DueWindow>(
    initialFilters?.deliveryDueWindow || null,
  );
  const [noSync, setNoSync] = useState<boolean>(
    initialFilters?.noSync || false,
  );
  const [noForecast, setNoForecast] = useState<boolean>(
    initialFilters?.noForecast || false,
  );

  // Update filters if props change (re-navigation)
  React.useEffect(() => {
    if (initialFilters) {
      setSelectedStatusFilters(
        initialFilters.status && initialFilters.status !== "ALL"
          ? [initialFilters.status]
          : [],
      );
      if (initialFilters.customStatus)
        setCustomStatusFilter(initialFilters.customStatus);
      setOnlyDelayed(!!initialFilters.onlyDelayed);
      setOnlyShippingDelayed(!!initialFilters.onlyShippingDelayed);
      setOnlyPlatformDelayed(!!initialFilters.onlyPlatformDelayed);
      setDueToday(!!initialFilters.dueToday);
      setShippingDueWindow(initialFilters.shippingDueWindow || null);
      setDeliveryDueWindow(initialFilters.deliveryDueWindow || null);
      setNoSync(!!initialFilters.noSync);
      setNoForecast(!!initialFilters.noForecast);
      setDateRangeStart(initialFilters.dateRangeStart || "");
      setDateRangeEnd(initialFilters.dateRangeEnd || "");
    }
  }, [initialFilters]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      ORDER_TABLE_COLUMN_STORAGE_KEY,
      JSON.stringify(visibleColumns),
    );
  }, [visibleColumns]);

  useEffect(() => {
    if (!isColumnMenuOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (
        columnMenuRef.current &&
        !columnMenuRef.current.contains(event.target as Node)
      ) {
        setIsColumnMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isColumnMenuOpen]);

  useEffect(() => {
    if (!activeFilterMenu) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (
        filterMenuRef.current &&
        !filterMenuRef.current.contains(event.target as Node)
      ) {
        setActiveFilterMenu(null);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [activeFilterMenu]);

  const visibleColumnSet = useMemo(
    () => new Set<VisibleColumnKey>(visibleColumns),
    [visibleColumns],
  );
  const monitoredOrderIdSet = useMemo(
    () => new Set<string>(monitoredOrderIds),
    [monitoredOrderIds],
  );

  const activeColumns = useMemo(
    () =>
      ORDER_TABLE_COLUMNS.filter((column) => visibleColumnSet.has(column.key)),
    [visibleColumnSet],
  );

  const tableMinWidth = useMemo(() => {
    const actionColumnWidth = enableArchiveControls ? 480 : 380;
    const baseColumnWidth = 155;

    return `${activeColumns.length * baseColumnWidth + actionColumnWidth}px`;
  }, [activeColumns.length, enableArchiveControls]);

  const handleMonitorToggle = async (order: Order) => {
    if (!onToggleMonitoredOrder) return;

    setMonitoringOrderIds((current) =>
      current.includes(order.id) ? current : [...current, order.id],
    );

    try {
      await onToggleMonitoredOrder(order);
    } catch (error) {
      showToast({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Erro ao atualizar pedido monitorado.",
      });
    } finally {
      setMonitoringOrderIds((current) =>
        current.filter((item) => item !== order.id),
      );
    }
  };

  const loadArchivedOrders = useCallback(async () => {
    if (!enableArchiveControls) {
      return;
    }

    setIsLoadingArchivedOrders(true);
    try {
      const response = await fetchWithAuth("/api/orders?archived=only");
      const data = await response.json().catch(() => []);

      if (!response.ok || !Array.isArray(data)) {
        throw new Error("Nao foi possivel carregar os pedidos arquivados.");
      }

      setArchivedOrders(data as Order[]);
    } catch (error) {
      showToast({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Erro ao carregar os pedidos arquivados.",
      });
    } finally {
      setIsLoadingArchivedOrders(false);
    }
  }, [enableArchiveControls]);

  const handleArchiveToggle = async (order: Order, shouldArchive: boolean) => {
    if (!enableArchiveControls) {
      return;
    }

    setUpdatingArchiveOrderIds((current) =>
      current.includes(order.id) ? current : [...current, order.id],
    );

    try {
      const response = await fetchWithAuth(
        `/api/orders/${order.id}/${shouldArchive ? "archive" : "unarchive"}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
        },
      );
      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data?.order) {
        throw new Error(
          data?.error ||
            (shouldArchive
              ? "Nao foi possivel arquivar o pedido."
              : "Nao foi possivel retirar o pedido do arquivo."),
        );
      }

      const updatedOrder = data.order as Order;
      onOrderUpdated?.(updatedOrder);

      if (shouldArchive) {
        setArchivedOrders((current) => {
          const next = current.filter((item) => item.id !== updatedOrder.id);
          return [updatedOrder, ...next];
        });
      } else {
        setArchivedOrders((current) =>
          current.filter((item) => item.id !== updatedOrder.id),
        );
      }

      showToast({
        tone: "success",
        message: shouldArchive
          ? `Pedido ${order.orderNumber} arquivado com sucesso.`
          : `Pedido ${order.orderNumber} removido do arquivo.`,
      });
    } catch (error) {
      showToast({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : shouldArchive
              ? "Erro ao arquivar pedido."
              : "Erro ao remover pedido do arquivo.",
      });
    } finally {
      setUpdatingArchiveOrderIds((current) =>
        current.filter((item) => item !== order.id),
      );
    }
  };

  const handleSyncOrderTracking = async (order: Order) => {
    if (syncingTrackingOrderIds.includes(order.id)) {
      return;
    }

    setSyncingTrackingOrderIds((current) =>
      current.includes(order.id) ? current : [...current, order.id],
    );

    try {
      const response = await fetchWithAuth(`/api/orders/${order.id}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message =
          data?.message ||
          data?.error ||
          "Nao foi possivel atualizar o rastreio deste pedido.";

        showToast({
          tone: "warning",
          title: "Rastreio nao atualizado",
          message,
        });
        return;
      }

      if (data?.order) {
        onOrderUpdated?.(data.order as Order);
      }

      showToast({
        tone: "success",
        title: "Rastreio atualizado",
        message:
          data?.message ||
          `Pedido ${order.orderNumber} sincronizado com sucesso.`,
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "Erro ao sincronizar rastreio",
        message:
          error instanceof Error
            ? error.message
            : "Nao foi possivel atualizar o rastreio deste pedido.",
      });
    } finally {
      setSyncingTrackingOrderIds((current) =>
        current.filter((item) => item !== order.id),
      );
    }
  };

  const handleMarkOrderDelivered = async (order: Order) => {
    if (markingDeliveredOrderIds.includes(order.id)) {
      return;
    }

    if (
      !confirm(
        `Marcar o pedido ${order.orderNumber} como entregue manualmente?`,
      )
    ) {
      return;
    }

    setMarkingDeliveredOrderIds((current) =>
      current.includes(order.id) ? current : [...current, order.id],
    );

    try {
      const response = await fetchWithAuth(`/api/orders/${order.id}/mark-delivered`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data?.error || data?.message || "Nao foi possivel marcar o pedido como entregue.",
        );
      }

      if (data?.order) {
        onOrderUpdated?.(data.order as Order);
      }

      showToast({
        tone: "success",
        title: "Pedido atualizado",
        message: data?.message || `Pedido ${order.orderNumber} marcado como entregue.`,
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "Falha ao marcar entregue",
        message:
          error instanceof Error
            ? error.message
            : "Nao foi possivel marcar o pedido como entregue.",
      });
    } finally {
      setMarkingDeliveredOrderIds((current) =>
        current.filter((item) => item !== order.id),
      );
    }
  };

  useEffect(() => {
    if (!enableArchiveControls) {
      return;
    }

    if (showArchivedOrders || archivedOrders.length === 0) {
      loadArchivedOrders();
    }
  }, [
    archivedOrders.length,
    enableArchiveControls,
    loadArchivedOrders,
    showArchivedOrders,
  ]);

  // Extract Lists (excluding Canceled)
  const sourceOrders = useMemo(
    () => (showArchivedOrders ? archivedOrders : orders),
    [archivedOrders, orders, showArchivedOrders],
  );

  const validOrders = useMemo(
    () =>
      showArchivedOrders
        ? sourceOrders
        : sourceOrders.filter((o) => o.status !== OrderStatus.CANCELED),
    [showArchivedOrders, sourceOrders],
  );

  const carriers = useMemo(
    () =>
      Array.from(
        new Set(validOrders.map((o) => normalizeCarrierName(o.freightType))),
      ).sort(),
    [validOrders],
  );
  const marketplaces = useMemo(
    () => Array.from(new Set(validOrders.map((o) => o.salesChannel))).sort(),
    [validOrders],
  );

  const getMultiSelectButtonLabel = (
    baseLabel: string,
    selectedValues: string[],
  ) => {
    if (selectedValues.length === 0) {
      return baseLabel;
    }

    return `${baseLabel} (${selectedValues.length})`;
  };

  const toggleStatusFilter = (status: string) => {
    setSelectedStatusFilters((current) =>
      current.includes(status)
        ? current.filter((item) => item !== status)
        : [...current, status],
    );
  };

  const toggleCarrierFilter = (carrier: string) => {
    setSelectedCarrierFilters((current) =>
      current.includes(carrier)
        ? current.filter((item) => item !== carrier)
        : [...current, carrier],
    );
  };

  const toggleMarketplaceFilter = (marketplace: string) => {
    setSelectedMarketplaceFilters((current) =>
      current.includes(marketplace)
        ? current.filter((item) => item !== marketplace)
        : [...current, marketplace],
    );
  };

  const filteredOrders = useMemo(() => {
    const hasTextFilter = searchText.trim().length > 0;
    const hasStatusFilter =
      selectedStatusFilters.length > 0 ||
      (Array.isArray(customStatusFilter) && customStatusFilter.length > 0);
    const hasCarrierFilter = selectedCarrierFilters.length > 0;
    const hasMarketplaceFilter = selectedMarketplaceFilters.length > 0;
    const hasDateFilter = Boolean(dateRangeStart) || Boolean(dateRangeEnd);
    const hasMovementFilter =
      onlyDelayed ||
      onlyShippingDelayed ||
      onlyPlatformDelayed ||
      dueToday ||
      Boolean(shippingDueWindow) ||
      Boolean(deliveryDueWindow) ||
      noSync ||
      noForecast ||
      isNoMovementView;

    const hasAnyFilter =
      hasTextFilter ||
      hasStatusFilter ||
      hasCarrierFilter ||
      hasMarketplaceFilter ||
      hasDateFilter ||
      hasMovementFilter;

    if (!hasAnyFilter) {
      return validOrders;
    }

    const normalizedSearch = searchText.trim().toLowerCase();
    const normalizedSearchAlphaNumeric = searchText
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase()
      .trim();

    return validOrders.filter((o) => {
      // 1. Text
      const matchText =
        toText(o.orderNumber)
          .toLowerCase()
          .includes(normalizedSearch) ||
        toText((o as any).invoiceNumber)
          .toLowerCase()
          .includes(normalizedSearch) ||
        (Boolean(normalizedSearchAlphaNumeric) &&
          toText((o as any).invoiceAccessKey)
            .replace(/[^A-Za-z0-9]/g, "")
            .toUpperCase()
            .includes(normalizedSearchAlphaNumeric)) ||
        toText(o.customerName)
          .toLowerCase()
          .includes(normalizedSearch) ||
        toText(o.cpf).includes(searchText);

      // 2. Dropdowns
      const matchStatus =
        (selectedStatusFilters.length === 0 ||
          selectedStatusFilters.some(
            (statusFilter) =>
              (statusFilter === DELAYED_STATUS_FILTER && isDelayedOrder(o)) ||
              o.status === statusFilter ||
              (statusFilter === OrderStatus.DELIVERY_ATTEMPT &&
                isOrderOnRoute(o)),
          )) &&
        (!customStatusFilter || customStatusFilter.includes(o.status));

      const matchCarrier =
        selectedCarrierFilters.length === 0 ||
        selectedCarrierFilters.includes(normalizeCarrierName(o.freightType));
      const matchMkt =
        selectedMarketplaceFilters.length === 0 ||
        selectedMarketplaceFilters.includes(o.salesChannel);

      // 3. Special Filters
      if (onlyDelayed && !isDelayedOrder(o)) return false;
      if (onlyShippingDelayed) {
        if (!isShippingPendingOrder(o)) return false;
        const diff = resolveDayDiffFromToday(
          o.maxShippingDeadline || o.shippingDate,
        );
        if (diff === null || diff >= 0) return false;
      }
      if (onlyPlatformDelayed && !isPlatformDelayedOrder(o)) return false;

      if (dueToday) {
        if (!isDeliveryOpenOrder(o)) return false;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const d = parseOptionalDate(
          o.carrierEstimatedDeliveryDate || o.estimatedDeliveryDate,
        );
        if (!d) return false;
        d.setHours(0, 0, 0, 0);
        if (d.getTime() !== today.getTime()) return false;
      }

      if (shippingDueWindow) {
        if (!isShippingPendingOrder(o)) return false;
        const diff = resolveDayDiffFromToday(
          o.maxShippingDeadline || o.shippingDate,
        );
        if (diff === null) return false;
        if (shippingDueWindow === "today" && diff !== 0) return false;
        if (shippingDueWindow === "tomorrow" && diff !== 1) return false;
        if (shippingDueWindow === "in2days" && diff !== 2) return false;
      }

      if (deliveryDueWindow) {
        if (!isDeliveryOpenOrder(o)) return false;
        const diff = resolveDayDiffFromToday(
          o.carrierEstimatedDeliveryDate || o.estimatedDeliveryDate,
        );
        if (diff === null) return false;
        if (deliveryDueWindow === "today" && diff !== 0) return false;
        if (deliveryDueWindow === "tomorrow" && diff !== 1) return false;
        if (deliveryDueWindow === "in2days" && diff !== 2) return false;
      }

      if (noSync && o.lastApiSync) return false;
      if (noForecast && o.estimatedDeliveryDate) return false;

      // 4. Date Range (Estimated Delivery)
      let matchDate = true;
      if (dateRangeStart) {
        const estimatedDate = parseOptionalDate(o.estimatedDeliveryDate);
        if (!estimatedDate) {
          matchDate = false;
        } else {
          matchDate = matchDate && estimatedDate >= new Date(dateRangeStart);
        }
      }
      if (dateRangeEnd) {
        const estimatedDate = parseOptionalDate(o.estimatedDeliveryDate);
        if (!estimatedDate) {
          matchDate = false;
        } else {
          matchDate = matchDate && estimatedDate <= new Date(dateRangeEnd);
        }
      }

      // 5. No Movement Filter
      if (isNoMovementView) {
        // Exclude finalized orders
        if (
          [
            OrderStatus.DELIVERED,
            OrderStatus.CANCELED,
            OrderStatus.RETURNED,
            OrderStatus.FAILURE,
          ].includes(o.status)
        ) {
          return false;
        }

        const lastUpdate = new Date(o.lastUpdate);
        const now = new Date();
        const diffTime = Math.abs(now.getTime() - lastUpdate.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays < noMovementDays) return false;
      }

      return matchText && matchStatus && matchCarrier && matchMkt && matchDate;
    });
  }, [
    validOrders,
    searchText,
    selectedStatusFilters,
    selectedCarrierFilters,
    selectedMarketplaceFilters,
    dateRangeStart,
    dateRangeEnd,
    isNoMovementView,
    noMovementDays,
    onlyDelayed,
    onlyShippingDelayed,
    onlyPlatformDelayed,
    dueToday,
    shippingDueWindow,
    deliveryDueWindow,
    noSync,
    noForecast,
    customStatusFilter,
  ]);

  const sortedOrders = useMemo(() => {
    if (!sortConfig) {
      return filteredOrders;
    }

    const sorted = [...filteredOrders].sort((left, right) => {
      switch (sortConfig.key) {
        case "orderNumber":
          return compareText(left.orderNumber, right.orderNumber);
        case "invoiceNumber":
          return compareText(left.invoiceNumber, right.invoiceNumber);
        case "shippingDate":
          return compareDate(left.shippingDate, right.shippingDate);
        case "salesChannel":
          return compareText(left.salesChannel, right.salesChannel);
        case "freightType":
          return compareText(
            normalizeCarrierName(left.freightType),
            normalizeCarrierName(right.freightType),
          );
        case "freightValue":
          return compareNumber(left.freightValue, right.freightValue);
        case "recalculatedFreightValue":
          return compareNumber(
            left.recalculatedFreightValue,
            right.recalculatedFreightValue,
          );
        case "freightDifference":
          return compareNumber(
            getFreightDifference(left),
            getFreightDifference(right),
          );
        case "estimatedDeliveryDate":
          return compareDate(
            left.estimatedDeliveryDate,
            right.estimatedDeliveryDate,
          );
        case "carrierEstimatedDeliveryDate":
          return compareDate(
            left.carrierEstimatedDeliveryDate,
            right.carrierEstimatedDeliveryDate,
          );
        case "lastUpdate":
          return compareDate(left.lastUpdate, right.lastUpdate);
        case "status":
          return compareText(
            getDisplayStatusLabel(left),
            getDisplayStatusLabel(right),
          );
        default:
          return 0;
      }
    });

    return sortConfig.direction === "asc" ? sorted : sorted.reverse();
  }, [filteredOrders, sortConfig]);

  const totalPages = Math.max(1, Math.ceil(sortedOrders.length / rowsPerPage));

  const paginatedOrders = useMemo(() => {
    const startIndex = (currentPage - 1) * rowsPerPage;
    return sortedOrders.slice(startIndex, startIndex + rowsPerPage);
  }, [currentPage, rowsPerPage, sortedOrders]);

  const pageStartIndex =
    sortedOrders.length === 0 ? 0 : (currentPage - 1) * rowsPerPage + 1;
  const pageEndIndex = Math.min(currentPage * rowsPerPage, sortedOrders.length);

  useEffect(() => {
    setCurrentPage(1);
  }, [rowsPerPage, sortedOrders.length, showArchivedOrders]);

  useEffect(() => {
    setCurrentPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const getDefaultSortDirection = (key: SortKey): SortDirection =>
    [
      "shippingDate",
      "freightValue",
      "recalculatedFreightValue",
      "freightDifference",
      "estimatedDeliveryDate",
      "carrierEstimatedDeliveryDate",
      "lastUpdate",
    ].includes(key)
      ? "desc"
      : "asc";

  const handleSort = (key: SortKey) => {
    setSortConfig((current) => {
      if (current?.key === key) {
        return {
          key,
          direction: current.direction === "asc" ? "desc" : "asc",
        };
      }

      return {
        key,
        direction: getDefaultSortDirection(key),
      };
    });
  };

  const handleExternalSearchClick = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsSearchModalOpen(true);
  };

  const executeApiSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onFetchSingle || !apiSearchInput.trim()) return;

    setIsFetchingSingle(true);
    try {
      await onFetchSingle(apiSearchInput);
      setSearchText(apiSearchInput); // Filter list to show the new item
      setIsSearchModalOpen(false);
      setApiSearchInput("");
    } catch (e) {
      // Alert handled in parent usually
    } finally {
      setIsFetchingSingle(false);
    }
  };

  const clearFilters = () => {
    setSearchText("");
    setSelectedStatusFilters([]);
    setSelectedCarrierFilters([]);
    setSelectedMarketplaceFilters([]);
    setDateRangeStart("");
    setDateRangeEnd("");
    setCustomStatusFilter(null);
    setOnlyDelayed(false);
    setOnlyShippingDelayed(false);
    setOnlyPlatformDelayed(false);
    setDueToday(false);
    setShippingDueWindow(null);
    setDeliveryDueWindow(null);
    setNoSync(false);
    setNoForecast(false);
    setActiveFilterMenu(null);
  };

  // ✅ Função de sincronização
  const toggleVisibleColumn = (columnKey: VisibleColumnKey) => {
    if (visibleColumns.length === 1 && visibleColumns.includes(columnKey)) {
      showToast({
        tone: "warning",
        title: "Uma coluna minima",
        message: "Mantenha ao menos uma coluna visivel na tabela.",
      });
      return;
    }

    setVisibleColumns((current) => {
      if (current.includes(columnKey)) {
        return current.filter((item) => item !== columnKey);
      }

      return ORDER_TABLE_COLUMNS.filter(
        (column) => current.includes(column.key) || column.key === columnKey,
      ).map((column) => column.key);
    });
  };

  const showAllColumns = () => {
    setVisibleColumns([...DEFAULT_VISIBLE_COLUMNS]);
  };

  const handleSyncAll = async () => {
    if (onStartSync) {
      if (
        !confirm(
          "Sincronizar todos os pedidos ativos? Isso pode demorar alguns minutos.",
        )
      ) {
        return;
      }
      onStartSync();
      return;
    }

    if (
      !confirm(
        "Sincronizar todos os pedidos ativos? Isso pode demorar alguns minutos.",
      )
    ) {
      return;
    }

    setIsSyncing(true);
    try {
      const response = await fetchWithAuth("/api/orders/sync-all/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const result = await response.json();

      if (result.success) {
        showToast({
          tone: "success",
          title: "Sincronizacao iniciada",
          message:
            result.message ||
            "Sincronizacao iniciada. O relatorio sera enviado ao final do processo.",
        });
      } else {
        showToast({
          tone: "error",
          title: "Falha no sync",
          message: "Nao foi possivel iniciar a sincronizacao.",
        });
      }
    } catch (error) {
      console.error("Erro ao sincronizar:", error);
      showToast({
        tone: "error",
        title: "Falha no sync",
        message: "Erro ao sincronizar pedidos.",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const toggleTrayStatus = (status: string) => {
    setSelectedTrayStatuses((current) =>
      current.includes(status)
        ? current.filter((item) => item !== status)
        : [...current, status],
    );
  };

  useEffect(() => {
    if (!isTraySyncModalOpen || !onStartTraySync) {
      return;
    }

    let cancelled = false;

    const loadIntegrationStatuses = async () => {
      setIsLoadingIntegrationStatuses(true);

      try {
        const response = await fetchWithAuth(
          "/api/integrations/order-status-options",
        );
        const data = (await response
          .json()
          .catch(() => ({}))) as Partial<IntegrationStatusOptionsResponse>;

        if (!response.ok) {
          throw new Error(
            typeof (data as any)?.error === "string"
              ? (data as any).error
              : `HTTP ${response.status}`,
          );
        }

        if (cancelled) {
          return;
        }

        const manualOptions = Array.isArray(data.manualStatuses)
          ? data.manualStatuses
          : [];
        const nextOptions = manualOptions;
        setIntegrationLabel(data.integrationLabel || "Integradora");
        setActiveIntegration((data as any).integration || null);
        setIntegrationStatusOptions(nextOptions);
        const usingConfiguredStatuses =
          data.manualStatusesSource === "configured";
        setHasConfiguredManualStatuses(usingConfiguredStatuses);
        setIsUsingIntegrationFallbackStatuses(
          data.manualStatusesSource === "integration_fallback" &&
            manualOptions.length > 0,
        );
      } catch (error) {
        if (cancelled) {
          return;
        }

        console.error("Erro ao carregar status da integradora ativa:", error);
        setIntegrationLabel("Integradora");
        setActiveIntegration(null);
        setIntegrationStatusOptions([]);
        setHasConfiguredManualStatuses(false);
        setIsUsingIntegrationFallbackStatuses(false);
      } finally {
        if (!cancelled) {
          setIsLoadingIntegrationStatuses(false);
        }
      }
    };

    void loadIntegrationStatuses();

    return () => {
      cancelled = true;
    };
  }, [isTraySyncModalOpen, onStartTraySync, trayIntegrationStatus]);

  // Carregar a integradora ativa ao montar o componente ou quando deps mudam
  useEffect(() => {
    let cancelled = false;

    const loadActiveIntegration = async () => {
      try {
        const response = await fetchWithAuth(
          "/api/integrations/order-status-options",
        );
        const data = (await response
          .json()
          .catch(() => ({}))) as Partial<IntegrationStatusOptionsResponse>;

        if (!cancelled) {
          if (response.ok) {
            setActiveIntegration((data as any).integration || null);
          } else {
            setActiveIntegration(null);
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Erro ao carregar integradora ativa:", error);
          setActiveIntegration(null);
        }
      }
    };

    // Carregar sempre que temos onStartTraySync disponível ou quando a empresa muda
    if (onStartTraySync) {
      void loadActiveIntegration();
    }

    return () => {
      cancelled = true;
    };
  }, [onStartTraySync, trayIntegrationStatus]);

  useEffect(() => {
    if (integrationStatusOptions.length === 0) {
      return;
    }

    const validStatuses = new Set(
      integrationStatusOptions.map((status) => String(status.value || "")),
    );

    setSelectedTrayStatuses((current) =>
      current.filter((status) => validStatuses.has(status)),
    );
  }, [integrationStatusOptions]);

  // Carregar activeIntegration na montagem e quando empresa muda
  useEffect(() => {
    let cancelled = false;

    const loadActiveIntegrationOnMount = async () => {
      try {
        const response = await fetchWithAuth(
          "/api/integrations/order-status-options",
        );
        const data = (await response
          .json()
          .catch(() => ({}))) as Partial<IntegrationStatusOptionsResponse>;

        if (!cancelled && response.ok) {
          setActiveIntegration((data as any).integration || null);
        }
      } catch (error) {
        if (!cancelled) {
          console.error(
            "Erro ao carregar integradora ativa na montagem:",
            error,
          );
        }
      }
    };

    // Carregar quando temos onStartTraySync, independente de outras condições
    if (onStartTraySync) {
      void loadActiveIntegrationOnMount();
    }

    return () => {
      cancelled = true;
    };
  }, [onStartTraySync, trayIntegrationStatus]);

  const handleTraySync = async () => {
    if (!onStartTraySync) return;

    if (!hasSyncableIntegration) {
      showToast({
        tone: "warning",
        title: "Sync da Integradora",
        message: activeIntegration
          ? `A integradora ativa ${integrationLabel} ainda nao possui sync manual disponivel nesta tela.`
          : "Nenhuma integradora ativa foi identificada para esta empresa.",
      });
      return;
    }

    if (selectedTrayStatuses.length === 0) {
      showToast({
        tone: "warning",
        title: "Filtros da Integradora",
        message:
          "Selecione ao menos um status da Integradora para buscar os pedidos.",
      });
      return;
    }

    setIsTraySyncing(true);
    try {
      await onStartTraySync({
        days: traySyncDays,
        statusMode: "selected",
        statuses: selectedTrayStatuses,
      });
    } finally {
      setIsTraySyncing(false);
    }
  };

  const getOrderStatusLabel = (order: Order) => {
    if (order.manualCustomStatus && order.manualCustomStatus.trim()) {
      return order.manualCustomStatus.trim();
    }

    return getDisplayStatusLabel(order);
  };

  const getLatestMovementLabel = (order: Order) => {
    const trackingHistory = normalizeTrackingHistory(order.trackingHistory);

    if (trackingHistory.length === 0) {
      if (!order.lastUpdate) {
        return "-";
      }

      return `${new Date(order.lastUpdate).toLocaleDateString("pt-BR")} ${new Date(
        order.lastUpdate,
      ).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
      })}`;
    }

    const latestEvent = [...trackingHistory].sort(
      (left, right) =>
        new Date(right.date).getTime() - new Date(left.date).getTime(),
    )[0];

    const eventDate = parseOptionalDate(latestEvent.date);
    const eventDateLabel = eventDate
      ? `${eventDate.toLocaleDateString("pt-BR")} ${eventDate.toLocaleTimeString(
          "pt-BR",
          {
            hour: "2-digit",
            minute: "2-digit",
          },
        )}`
      : "-";

    return [
      eventDateLabel,
      toText(latestEvent.status),
      toText(latestEvent.description),
    ]
      .filter(Boolean)
      .join(" - ");
  };

  const getExportRows = () =>
    sortedOrders.map((order) => ({
      orderNumber: order.orderNumber,
      invoiceNumber: order.invoiceNumber || "-",
      trackingCode: order.trackingCode || "-",
      salesChannel: order.salesChannel,
      freightType: normalizeCarrierName(order.freightType),
      freightValue: formatCurrency(order.freightValue),
      recalculatedFreightValue: formatCurrency(order.recalculatedFreightValue),
      recalculatedQuotedCarrierName:
        order.recalculatedQuotedCarrierName || "Sem cotacao no pedido",
      freightDifference: formatCurrency(getFreightDifference(order)),
      estimatedDeliveryDate: formatDateOrDash(order.estimatedDeliveryDate),
      carrierEstimatedDeliveryDate: formatCarrierForecast(
        order.carrierEstimatedDeliveryDate,
      ),
      latestMovement: getLatestMovementLabel(order),
      status: getOrderStatusLabel(order),
      manualCustomStatus: order.manualCustomStatus || "-",
      observation: order.observation || "-",
      trackingUrl: order.trackingUrl || "#",
    }));

  const handleExportHtmlReport = () => {
    if (sortedOrders.length === 0) {
      showToast({
        tone: "warning",
        title: "Nada para exportar",
        message: "Nao ha pedidos para exportar com os filtros atuais.",
      });
      return;
    }

    const escapeHtml = (value: unknown) =>
      toText(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    const reportGeneratedAt = new Date();
    const rows = getExportRows()
      .map((order) => {
        return `
          <tr>
            <td>${escapeHtml(order.orderNumber)}</td>
            <td>${escapeHtml(order.invoiceNumber)}</td>
            <td>${escapeHtml(order.trackingCode)}</td>
            <td>${escapeHtml(order.salesChannel)}</td>
            <td>${escapeHtml(order.freightType)}</td>
            <td>${escapeHtml(order.freightValue)}</td>
            <td>${escapeHtml(order.recalculatedFreightValue)}</td>
            <td>${escapeHtml(order.recalculatedQuotedCarrierName)}</td>
            <td>${escapeHtml(order.freightDifference)}</td>
            <td>${escapeHtml(order.estimatedDeliveryDate)}</td>
            <td>${escapeHtml(order.carrierEstimatedDeliveryDate)}</td>
            <td>${escapeHtml(order.latestMovement)}</td>
            <td>${escapeHtml(order.manualCustomStatus)}</td>
            <td>${escapeHtml(order.observation)}</td>
            <td><span class="status-chip">${escapeHtml(order.status)}</span></td>
            <td><a href="${escapeHtml(
              order.trackingUrl,
            )}" target="_blank" rel="noopener noreferrer">Abrir rastreio</a></td>
          </tr>
        `;
      })
      .join("");

    const htmlContent = `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Relatorio de Pedidos - Avantracking</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3f6fb;
        --card: #ffffff;
        --text: #172033;
        --muted: #64748b;
        --line: #d7dfeb;
        --line-soft: #e8edf5;
        --brand: #0f766e;
        --brand-soft: #dff6f1;
        --header: #eef4fb;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Segoe UI", Arial, sans-serif;
        background: linear-gradient(180deg, #eef3f9 0%, #f8fafc 100%);
        color: var(--text);
      }

      .page {
        padding: 32px;
      }

      .report-card {
        max-width: 1600px;
        margin: 0 auto;
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 22px;
        box-shadow: 0 18px 60px rgba(15, 23, 42, 0.08);
        overflow: hidden;
      }

      .report-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 24px;
        padding: 28px 32px 24px;
        border-bottom: 1px solid var(--line-soft);
        background: linear-gradient(135deg, #ffffff 0%, #f4f9ff 100%);
      }

      .brand {
        display: flex;
        align-items: flex-start;
        gap: 18px;
        min-width: 0;
      }

      .brand img {
        width: 168px;
        height: auto;
        object-fit: contain;
        flex-shrink: 0;
      }

      .brand-copy {
        min-width: 0;
        padding-top: 6px;
      }

      h1 {
        margin: 0 0 6px;
        font-size: 28px;
        line-height: 1.15;
      }

      .subtitle,
      .generated-at {
        margin: 0;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.5;
      }

      .summary {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: #fff;
        white-space: nowrap;
      }

      .summary strong {
        display: block;
        font-size: 24px;
      }

      .summary span {
        display: block;
        color: var(--muted);
        font-size: 13px;
      }

      .table-wrap {
        padding: 0 24px 24px;
      }

      table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        font-size: 13px;
      }

      thead th {
        position: sticky;
        top: 0;
        padding: 14px 12px;
        text-align: left;
        background: var(--header);
        color: #334155;
        border-bottom: 1px solid var(--line);
        border-top: 1px solid var(--line);
      }

      thead th:first-child {
        border-left: 1px solid var(--line);
        border-top-left-radius: 14px;
      }

      thead th:last-child {
        border-right: 1px solid var(--line);
        border-top-right-radius: 14px;
      }

      tbody td {
        padding: 12px;
        border-bottom: 1px solid var(--line-soft);
        vertical-align: top;
        color: #1e293b;
      }

      tbody tr:nth-child(even) td {
        background: #fbfdff;
      }

      tbody tr td:first-child {
        border-left: 1px solid var(--line-soft);
      }

      tbody tr td:last-child {
        border-right: 1px solid var(--line-soft);
      }

      .status-chip {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--brand-soft);
        color: var(--brand);
        font-weight: 600;
      }

      a {
        color: #0f62fe;
        text-decoration: none;
        font-weight: 600;
      }

      a:hover {
        text-decoration: underline;
      }

      @media (max-width: 960px) {
        .page {
          padding: 16px;
        }

        .report-header {
          flex-direction: column;
          align-items: stretch;
        }

        .brand {
          flex-direction: column;
        }

        .brand img {
          width: 148px;
        }

        .table-wrap {
          overflow-x: auto;
        }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="report-card">
        <div class="report-header">
          <div class="brand">
            <img src="${escapeHtml(LOGO_URL)}" alt="Avantracking" />
            <div class="brand-copy">
              <h1>Relatorio de Pedidos</h1>
              <p class="subtitle">Exportacao formatada da aba de pedidos com status, previsoes e link direto de rastreio.</p>
              <p class="generated-at">Gerado em ${escapeHtml(
                reportGeneratedAt.toLocaleString("pt-BR"),
              )}</p>
            </div>
          </div>
          <div class="summary">
            <div>
              <strong>${escapeHtml(sortedOrders.length)}</strong>
              <span>Pedidos exportados</span>
            </div>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID / Pedido</th>
                <th>Nota Fiscal</th>
                <th>Codigo de envio</th>
                <th>Marketplace</th>
                <th>Transportadora</th>
                <th>Frete Pago</th>
                <th>Frete Recalculado</th>
                <th>Carrier Recalculado</th>
                <th>Diferenca Frete</th>
                <th>Prev. Entrega</th>
                <th>Previsao Transportadora</th>
                <th>Ultima Movimentacao</th>
                <th>Status Personalizado</th>
                <th>Observacao</th>
                <th>Status</th>
                <th>Abrir rastreio</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>
  </body>
</html>`;

    const blob = new Blob([htmlContent], {
      type: "text/html;charset=utf-8;",
    });
    const fileUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const today = new Date().toISOString().slice(0, 10);

    link.href = fileUrl;
    link.download = `relatorio-pedidos-${today}.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(fileUrl);
  };

  const handleExportCsvReport = () => {
    if (sortedOrders.length === 0) {
      showToast({
        tone: "warning",
        title: "Nada para exportar",
        message: "Nao ha pedidos para exportar com os filtros atuais.",
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
      "Status Personalizado",
      "Observacao",
      "Status",
      "Abrir rastreio",
    ];

    const rows = getExportRows().map((order) => [
      order.orderNumber,
      order.invoiceNumber,
      order.trackingCode,
      order.salesChannel,
      order.freightType,
      order.freightValue,
      order.recalculatedFreightValue,
      order.recalculatedQuotedCarrierName,
      order.freightDifference,
      order.estimatedDeliveryDate,
      order.carrierEstimatedDeliveryDate,
      order.latestMovement,
      order.manualCustomStatus,
      order.observation,
      order.status,
      order.trackingUrl,
    ]);

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
    link.download = `relatorio-pedidos-${today}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(fileUrl);
  };

  const openTrackingLink = async (order: Order) => {
    const popup = window.open("", "_blank");

    if (popup) {
      popup.opener = null;
      popup.document.open();
      popup.document.write(buildTrackingLoadingHtml());
      popup.document.close();
    }

    try {
      const response = await fetchWithAuth(
        `/api/orders/${order.id}/open-tracking?resolve=1`,
        {
          headers: {
            Accept: "application/json",
          },
        },
      );
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.trackingUrl) {
        throw new Error(
          data?.error || "Nenhum link de rastreio disponivel para este pedido.",
        );
      }

      if (popup) {
        popup.location.href = data.trackingUrl;
      } else {
        window.open(data.trackingUrl, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Nao foi possivel abrir o rastreio deste pedido.";

      if (popup) {
        popup.document.open();
        popup.document.write(buildTrackingErrorHtml(message));
        popup.document.close();
      }

      showToast({
        tone: "error",
        title: "Rastreio indisponivel",
        message,
      });
    }
  };

  const isSyncRunning = isSyncing || syncJob?.status === "running";
  const isTrayJobRunning = traySyncJob?.status === "running";
  const hasTrayJob = Boolean(traySyncJob);
  const trayLogs = traySyncJob?.logs || [];
  const trayStatusLabel =
    traySyncJob?.status === "running"
      ? "Em andamento"
      : traySyncJob?.status === "completed"
        ? "Concluido"
        : traySyncJob?.status === "canceled"
          ? "Cancelado"
        : traySyncJob?.status === "failed"
          ? "Falhou"
          : "Pronto";
  const trayStatusClass =
    traySyncJob?.status === "running"
      ? "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800/40"
      : traySyncJob?.status === "completed"
        ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800/40"
        : traySyncJob?.status === "canceled"
          ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800/40"
        : traySyncJob?.status === "failed"
          ? "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800/40"
          : "bg-slate-100 text-slate-700 border-slate-200 dark:bg-white/10 dark:text-slate-300 dark:border-white/10";

  // Modern Status Badge
  const StatusBadge = ({
    status,
    delayed,
    customStatus,
  }: {
    status: OrderStatus;
    delayed: boolean;
    customStatus?: string | null;
  }) => {
    const baseClass =
      "inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wider border";

    if (customStatus && customStatus.trim()) {
      return (
        <span
          className={clsx(
            baseClass,
            "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/20 dark:text-indigo-300 dark:border-indigo-900/30",
          )}
        >
          {customStatus}
        </span>
      );
    }

    if (delayed) {
      return (
        <span
          className={clsx(
            baseClass,
            "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-900/30",
          )}
        >
          Atrasado
        </span>
      );
    }

    switch (status) {
      case OrderStatus.DELIVERED:
        return (
          <span
            className={clsx(
              baseClass,
              "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-900/30",
            )}
          >
            Entregue
          </span>
        );
      case OrderStatus.SHIPPED:
        return (
          <span
            className={clsx(
              baseClass,
              "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-900/30",
            )}
          >
            Trânsito
          </span>
        );
      case OrderStatus.DELIVERY_ATTEMPT:
        return (
          <span
            className={clsx(
              baseClass,
              "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-900/30",
            )}
          >
            Saiu para Entrega
          </span>
        );
      case OrderStatus.FAILURE:
      case OrderStatus.RETURNED:
      case OrderStatus.CANCELED:
        return (
          <span
            className={clsx(
              baseClass,
              "bg-slate-100 text-slate-700 border-slate-200 dark:bg-white/10 dark:text-slate-300 dark:border-white/5",
            )}
          >
            Falha
          </span>
        );
      case OrderStatus.CHANNEL_LOGISTICS:
        return (
          <span
            className={clsx(
              baseClass,
              "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/20 dark:text-purple-400 dark:border-purple-900/30",
            )}
          >
            Logística do Canal
          </span>
        );
      default:
        return (
          <span
            className={clsx(
              baseClass,
              "bg-gray-50 text-gray-600 border-gray-200 dark:bg-white/5 dark:text-gray-400 dark:border-white/5",
            )}
          >
            Pendente
          </span>
        );
    }
  };

  const renderSortIcon = (key: SortKey) => {
    const isActive = sortConfig?.key === key;
    const iconClass = clsx(
      "h-3 w-3 transition-colors",
      isActive
        ? "text-blue-600 dark:text-blue-400"
        : "text-slate-300 dark:text-slate-600",
    );

    return (
      <span className="ml-1.5 inline-flex flex-col items-center justify-center leading-none">
        <ChevronUp
          className={clsx(
            iconClass,
            isActive && sortConfig?.direction === "asc" ? "" : "opacity-70",
          )}
        />
        <ChevronDown
          className={clsx(
            iconClass,
            "-mt-1",
            isActive && sortConfig?.direction === "desc" ? "" : "opacity-70",
          )}
        />
      </span>
    );
  };

  const getColumnVisibilityClass = (columnKey: VisibleColumnKey) =>
    visibleColumnSet.has(columnKey) ? "" : "hidden";

  return (
    <div className="space-y-4 relative lg:h-full lg:min-h-0 lg:flex lg:flex-col">
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2">
          {enableArchiveControls && (
            <button
              type="button"
              onClick={() => {
                setShowArchivedOrders((current) => !current);
              }}
              disabled={isLoadingArchivedOrders}
              className={clsx(
                "inline-flex items-center gap-2 rounded-full border bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] shadow-sm transition-colors dark:border-white/10 dark:bg-dark-card",
                showArchivedOrders
                  ? "border-amber-300 text-amber-700 hover:border-amber-400 dark:text-amber-300"
                  : "border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-900 dark:text-slate-300 dark:hover:border-white/20 dark:hover:text-white",
              )}
            >
              {isLoadingArchivedOrders ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : showArchivedOrders ? (
                <ArchiveRestore className="h-3.5 w-3.5" />
              ) : (
                <Archive className="h-3.5 w-3.5" />
              )}
              {showArchivedOrders ? "Pedidos Ativos" : "Arquivados"}
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600 dark:bg-white/10 dark:text-slate-200">
                {archivedOrders.length}
              </span>
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowTopPanel((current) => !current)}
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-600 shadow-sm transition-colors hover:border-slate-300 hover:text-slate-900 dark:border-white/10 dark:bg-dark-card dark:text-slate-300 dark:hover:border-white/20 dark:hover:text-white"
        >
          {showTopPanel ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" />
              Recolher painel superior
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" />
              Expandir painel superior
            </>
          )}
        </button>
      </div>
      <div className={clsx("space-y-4 shrink-0", !showTopPanel && "hidden")}>
        {/* 1. Filter Control Bar (Collapsible) */}
        <div
          className={clsx(
            "glass-card rounded-xl border border-slate-200 dark:border-dark-border shadow-sm shrink-0 transition-all duration-300",
            showFilters ? "overflow-visible relative z-20" : "overflow-hidden",
          )}
        >
          <div
            className="flex items-center justify-between p-4 bg-slate-50 dark:bg-dark-card border-b border-slate-100 dark:border-white/5 cursor-pointer"
            onClick={() => setShowFilters(!showFilters)}
          >
            <div className="flex items-center gap-2 font-semibold text-slate-700 dark:text-white">
              <Filter className="w-4 h-4 text-accent dark:text-neon-blue" />
              Filtros Avançados
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">
                {filteredOrders.length} resultados
              </span>
              {showFilters ? (
                <ChevronUp className="w-4 h-4 text-slate-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              )}
            </div>
          </div>

          {showFilters && (
            <div
              ref={filterMenuRef}
              className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 animate-in slide-in-from-top-2 duration-200 bg-white dark:bg-dark-card"
            >
              {/* Search */}
              <div className="col-span-1 lg:col-span-4 flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Buscar por Pedido, Numero da Nota ou Cliente..."
                    className="w-full pl-10 pr-4 py-2 bg-slate-50 dark:bg-dark-card border border-slate-200 dark:border-white/10 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent dark:focus:border-neon-blue dark:text-white transition-colors"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                  />
                </div>
              </div>

              {/* Dropdowns */}
              <div className="space-y-1 relative">
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1">
                  <Truck className="w-3 h-3" /> Transportadora
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setActiveFilterMenu((current) =>
                      current === "carrier" ? null : "carrier",
                    )
                  }
                  className="w-full flex items-center justify-between gap-3 p-2 border border-slate-200 dark:border-white/10 rounded-lg text-sm bg-white dark:bg-dark-card dark:text-white focus:border-accent outline-none"
                >
                  <span className="truncate">
                    {getMultiSelectButtonLabel(
                      "Transportadora",
                      selectedCarrierFilters,
                    )}
                  </span>
                  <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                </button>
                {activeFilterMenu === "carrier" && (
                  <div className="absolute z-30 mt-2 w-full min-w-[240px] rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-dark-card shadow-xl p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-500 uppercase">
                        Transportadoras
                      </span>
                      {selectedCarrierFilters.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSelectedCarrierFilters([])}
                          className="text-[11px] font-medium text-blue-600 hover:underline"
                        >
                          Limpar
                        </button>
                      )}
                    </div>
                    <div className="max-h-56 overflow-auto space-y-2 pr-1">
                      {carriers.map((carrier) => (
                        <label
                          key={carrier}
                          className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
                        >
                          <input
                            type="checkbox"
                            checked={selectedCarrierFilters.includes(carrier)}
                            onChange={() => toggleCarrierFilter(carrier)}
                            className="rounded border-slate-300 text-accent focus:ring-accent"
                          />
                          <span className="truncate">{carrier}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-1 relative">
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1">
                  <ShoppingBag className="w-3 h-3" /> Marketplace
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setActiveFilterMenu((current) =>
                      current === "marketplace" ? null : "marketplace",
                    )
                  }
                  className="w-full flex items-center justify-between gap-3 p-2 border border-slate-200 dark:border-white/10 rounded-lg text-sm bg-white dark:bg-dark-card dark:text-white focus:border-accent outline-none"
                >
                  <span className="truncate">
                    {getMultiSelectButtonLabel(
                      "Marketplace",
                      selectedMarketplaceFilters,
                    )}
                  </span>
                  <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                </button>
                {activeFilterMenu === "marketplace" && (
                  <div className="absolute z-30 mt-2 w-full min-w-[240px] rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-dark-card shadow-xl p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-500 uppercase">
                        Marketplaces
                      </span>
                      {selectedMarketplaceFilters.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSelectedMarketplaceFilters([])}
                          className="text-[11px] font-medium text-blue-600 hover:underline"
                        >
                          Limpar
                        </button>
                      )}
                    </div>
                    <div className="max-h-56 overflow-auto space-y-2 pr-1">
                      {marketplaces.map((marketplace) => (
                        <label
                          key={marketplace}
                          className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
                        >
                          <input
                            type="checkbox"
                            checked={selectedMarketplaceFilters.includes(
                              marketplace,
                            )}
                            onChange={() =>
                              toggleMarketplaceFilter(marketplace)
                            }
                            className="rounded border-slate-300 text-accent focus:ring-accent"
                          />
                          <span className="truncate">{marketplace}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-1 relative">
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1">
                  <Filter className="w-3 h-3" /> Status
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setActiveFilterMenu((current) =>
                      current === "status" ? null : "status",
                    )
                  }
                  className="w-full flex items-center justify-between gap-3 p-2 border border-slate-200 dark:border-white/10 rounded-lg text-sm bg-white dark:bg-dark-card dark:text-white focus:border-accent outline-none"
                >
                  <span className="truncate">
                    {getMultiSelectButtonLabel("Status", selectedStatusFilters)}
                  </span>
                  <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                </button>
                {activeFilterMenu === "status" && (
                  <div className="absolute z-30 mt-2 w-full min-w-[240px] rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-dark-card shadow-xl p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-500 uppercase">
                        Status
                      </span>
                      {selectedStatusFilters.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSelectedStatusFilters([])}
                          className="text-[11px] font-medium text-blue-600 hover:underline"
                        >
                          Limpar
                        </button>
                      )}
                    </div>
                    <div className="max-h-56 overflow-auto space-y-2 pr-1">
                      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                        <input
                          type="checkbox"
                          checked={selectedStatusFilters.includes(
                            DELAYED_STATUS_FILTER,
                          )}
                          onChange={() =>
                            toggleStatusFilter(DELAYED_STATUS_FILTER)
                          }
                          className="rounded border-slate-300 text-accent focus:ring-accent"
                        />
                        <span>Atrasado</span>
                      </label>
                      {Object.values(OrderStatus).map((status) => (
                        <label
                          key={status}
                          className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
                        >
                          <input
                            type="checkbox"
                            checked={selectedStatusFilters.includes(status)}
                            onChange={() => toggleStatusFilter(status)}
                            className="rounded border-slate-300 text-accent focus:ring-accent"
                          />
                          <span>{STATUS_LABELS[status] || status}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Date Range */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1">
                  <Calendar className="w-3 h-3" /> Previsão de Entrega
                </label>
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={dateRangeStart}
                    onChange={(e) => setDateRangeStart(e.target.value)}
                    className="w-full p-2 border border-slate-200 dark:border-white/10 rounded-lg text-xs bg-white dark:bg-dark-card dark:text-white focus:border-accent outline-none"
                  />
                  <input
                    type="date"
                    value={dateRangeEnd}
                    onChange={(e) => setDateRangeEnd(e.target.value)}
                    className="w-full p-2 border border-slate-200 dark:border-white/10 rounded-lg text-xs bg-white dark:bg-dark-card dark:text-white focus:border-accent outline-none"
                  />
                </div>
              </div>

              {/* No Movement Toggle */}
              {isNoMovementView && (
                <div className="col-span-1 lg:col-span-4 flex flex-wrap items-center gap-4 bg-red-50 dark:bg-red-900/10 p-3 rounded-lg border border-red-200 dark:border-red-900/30">
                  <span className="text-sm font-bold text-red-700 dark:text-red-400 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    Sem Movimentação:
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setNoMovementDays(2)}
                      className={clsx(
                        "px-3 py-1 rounded-md text-xs font-medium transition-colors border",
                        noMovementDays === 2
                          ? "bg-red-600 text-white border-red-600"
                          : "bg-white dark:bg-white/10 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-white/10 hover:bg-slate-50",
                      )}
                    >
                      2+ dias
                    </button>
                    <button
                      onClick={() => setNoMovementDays(5)}
                      className={clsx(
                        "px-3 py-1 rounded-md text-xs font-medium transition-colors border",
                        noMovementDays === 5
                          ? "bg-red-600 text-white border-red-600"
                          : "bg-white dark:bg-white/10 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-white/10 hover:bg-slate-50",
                      )}
                    >
                      5+ dias
                    </button>
                  </div>
                  <span className="text-xs text-red-600 dark:text-red-300 ml-auto">
                    Exibindo pedidos sem atualização há{" "}
                    <strong>{noMovementDays} dias</strong> ou mais.
                  </span>
                </div>
              )}

              {/* Actions */}
              <div className="col-span-1 lg:col-span-4 flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-white/5">
                <button
                  onClick={clearFilters}
                  className="text-slate-500 text-sm hover:text-slate-800 dark:hover:text-white px-4 py-2 font-medium"
                >
                  Limpar Filtros
                </button>
                <button
                  onClick={handleExternalSearchClick}
                  disabled={isFetchingSingle}
                  className="flex items-center justify-center px-4 py-2 bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-700 dark:text-white rounded-lg text-sm font-medium hover:bg-slate-50 dark:hover:bg-white/10 transition-colors"
                >
                  <Globe className="w-4 h-4 mr-2" />
                  Buscar API
                </button>
              </div>
            </div>
          )}
        </div>

        <div className={clsx("flex justify-end", !showFilters && "hidden")}>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <div ref={columnMenuRef} className="relative z-30 flex shrink-0">
              <button
                type="button"
                onClick={() => setIsColumnMenuOpen((current) => !current)}
                className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-slate-200 bg-white px-3.5 text-sm font-semibold tracking-tight text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
              >
                Colunas
                <span className="text-xs font-medium text-slate-400 dark:text-slate-500">
                  {activeColumns.length}/{ORDER_TABLE_COLUMNS.length}
                </span>
                <ChevronDown
                  className={clsx(
                    "h-4 w-4 transition-transform",
                    isColumnMenuOpen && "rotate-180",
                  )}
                />
              </button>

              {isColumnMenuOpen && (
                <div className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-[280px] rounded-xl border border-slate-200 bg-white p-3 shadow-xl dark:border-white/10 dark:bg-[#11131f]">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-800 dark:text-white">
                        Colunas visiveis
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Escolha o que deseja ver na tabela.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={showAllColumns}
                      className="text-xs font-semibold text-accent transition-colors hover:text-blue-700 dark:text-neon-blue dark:hover:text-cyan-300"
                    >
                      Mostrar todas
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-1.5">
                    {ORDER_TABLE_COLUMNS.map((column) => {
                      const isChecked = visibleColumnSet.has(column.key);

                      return (
                        <label
                          key={column.key}
                          className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-white/5"
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleVisibleColumn(column.key)}
                            className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent/30 dark:border-white/20 dark:bg-transparent dark:text-neon-blue dark:focus:ring-neon-blue/30"
                          />
                          <span>{column.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleExportHtmlReport}
                className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-slate-200 bg-white px-3.5 text-sm font-semibold tracking-tight text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
              >
                <Download className="h-3.5 w-3.5" />
                Abrir HTML
              </button>
              <button
                onClick={handleExportCsvReport}
                className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-slate-200 bg-white px-3.5 text-sm font-semibold tracking-tight text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
              >
                <Download className="h-3.5 w-3.5" />
                Baixar CSV
              </button>
            </div>

            {canShowIntegratorSyncButton && (
              <button
                onClick={() => setIsTraySyncModalOpen(true)}
                disabled={isTraySyncing}
                className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-slate-200 bg-white px-3.5 text-sm font-semibold tracking-tight text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
              >
                {isTraySyncing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Iniciando...
                  </>
                ) : isTrayJobRunning ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Acompanhar Sync
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-3.5 w-3.5" />
                    Sync Integradora
                  </>
                )}
              </button>
            )}

            <button
              onClick={handleSyncAll}
              disabled={isSyncRunning || showArchivedOrders}
              className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-accent px-4 text-sm font-semibold tracking-tight text-white shadow-sm transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neon-blue dark:text-black dark:hover:bg-cyan-400"
            >
              {showArchivedOrders ? (
                <>
                  <Archive className="h-3.5 w-3.5" />
                  Sync pausado nos arquivados
                </>
              ) : isSyncRunning ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Sincronizando...
                </>
              ) : (
                <>
                  <RefreshCw className="h-3.5 w-3.5" />
                  Sync Geral
                </>
              )}
            </button>

            {isSyncRunning && onCancelSync && (
              <button
                onClick={() => void onCancelSync()}
                className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-red-200 bg-red-50 px-4 text-sm font-semibold tracking-tight text-red-700 transition-colors hover:bg-red-100 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
              >
                <X className="h-3.5 w-3.5" />
                Cancelar Rastreio
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
        <span>
          Exibindo {pageStartIndex}-{pageEndIndex} de {sortedOrders.length}{" "}
          pedidos
        </span>
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Linhas
          </label>
          <select
            value={rowsPerPage}
            onChange={(event) => setRowsPerPage(Number(event.target.value))}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 focus:outline-none dark:border-white/10 dark:bg-dark-card dark:text-slate-200"
          >
            {ORDER_LIST_PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
            disabled={currentPage <= 1}
            className="rounded-md border border-slate-200 px-2 py-1 font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10"
          >
            Anterior
          </button>
          <span className="min-w-[78px] text-center font-semibold text-slate-700 dark:text-slate-200">
            {currentPage}/{totalPages}
          </span>
          <button
            type="button"
            onClick={() =>
              setCurrentPage((page) => Math.min(totalPages, page + 1))
            }
            disabled={currentPage >= totalPages}
            className="rounded-md border border-slate-200 px-2 py-1 font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10"
          >
            Proxima
          </button>
        </div>
      </div>

      {/* 2. Detailed Data Table */}
      <div className="glass-card relative min-h-[420px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-dark-border dark:bg-dark-card sm:min-h-[560px] lg:min-h-0 lg:flex-1">
        <div className="absolute inset-0 overflow-x-auto overflow-y-auto">
          <table
            className="w-full text-sm text-left border-collapse"
            style={{ minWidth: tableMinWidth }}
          >
            <thead className="text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase bg-slate-50 dark:bg-dark-card sticky top-0 z-10 shadow-sm backdrop-blur-md">
              <tr>
                <th
                  className={clsx(
                    "px-4 py-3 whitespace-nowrap bg-slate-50 dark:bg-[#11131f]",
                    getColumnVisibilityClass("orderNumber"),
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("orderNumber")}
                    className="inline-flex items-center gap-1 rounded-md transition-colors hover:text-slate-700 dark:hover:text-white"
                  >
                    <span>ID / Pedido</span>
                    {renderSortIcon("orderNumber")}
                  </button>
                </th>
                <th
                  className={clsx(
                    "px-4 py-3 whitespace-nowrap bg-slate-50 dark:bg-[#11131f]",
                    getColumnVisibilityClass("invoiceNumber"),
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("invoiceNumber")}
                    className="inline-flex items-center gap-1 rounded-md transition-colors hover:text-slate-700 dark:hover:text-white"
                  >
                    <span>Nota Fiscal</span>
                    {renderSortIcon("invoiceNumber")}
                  </button>
                </th>
                <th
                  className={clsx(
                    "px-4 py-3 whitespace-nowrap bg-slate-50 dark:bg-[#11131f]",
                    getColumnVisibilityClass("shippingDate"),
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("shippingDate")}
                    className="inline-flex items-center gap-1 rounded-md transition-colors hover:text-slate-700 dark:hover:text-white"
                  >
                    <span>Emissão</span>
                    {renderSortIcon("shippingDate")}
                  </button>
                </th>
                <th
                  className={clsx(
                    "px-4 py-3 whitespace-nowrap bg-slate-50 dark:bg-[#11131f]",
                    getColumnVisibilityClass("salesChannel"),
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("salesChannel")}
                    className="inline-flex items-center gap-1 rounded-md transition-colors hover:text-slate-700 dark:hover:text-white"
                  >
                    <span>Marketplace</span>
                    {renderSortIcon("salesChannel")}
                  </button>
                </th>
                <th
                  className={clsx(
                    "px-4 py-3 whitespace-nowrap bg-slate-50 dark:bg-[#11131f]",
                    getColumnVisibilityClass("freightType"),
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("freightType")}
                    className="inline-flex items-center gap-1 rounded-md transition-colors hover:text-slate-700 dark:hover:text-white"
                  >
                    <span>Transportadora</span>
                    {renderSortIcon("freightType")}
                  </button>
                </th>
                <th
                  className={clsx(
                    "px-4 py-3 whitespace-nowrap bg-slate-50 dark:bg-[#11131f]",
                    getColumnVisibilityClass("freightValue"),
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("freightValue")}
                    className="inline-flex items-center gap-1 rounded-md transition-colors hover:text-slate-700 dark:hover:text-white"
                  >
                    <span>Frete Pago</span>
                    {renderSortIcon("freightValue")}
                  </button>
                </th>

                <th
                  className={clsx(
                    "px-4 py-3 whitespace-nowrap bg-slate-50 dark:bg-[#11131f]",
                    getColumnVisibilityClass("recalculatedFreightValue"),
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("recalculatedFreightValue")}
                    className="inline-flex items-center gap-1 rounded-md transition-colors hover:text-slate-700 dark:hover:text-white"
                  >
                    <span>Frete Recalculado</span>
                    {renderSortIcon("recalculatedFreightValue")}
                  </button>
                </th>
                <th
                  className={clsx(
                    "px-4 py-3 whitespace-nowrap bg-slate-50 dark:bg-[#11131f]",
                    getColumnVisibilityClass("freightDifference"),
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("freightDifference")}
                    className="inline-flex items-center gap-1 rounded-md transition-colors hover:text-slate-700 dark:hover:text-white"
                  >
                    <span>Diferenca Frete</span>
                    {renderSortIcon("freightDifference")}
                  </button>
                </th>
                <th
                  className={clsx(
                    "px-4 py-3 whitespace-nowrap bg-slate-50 dark:bg-[#11131f]",
                    getColumnVisibilityClass("estimatedDeliveryDate"),
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("estimatedDeliveryDate")}
                    className="inline-flex items-center gap-1 rounded-md transition-colors hover:text-slate-700 dark:hover:text-white"
                  >
                    <span>Prev. Entrega</span>
                    {renderSortIcon("estimatedDeliveryDate")}
                  </button>
                </th>
                <th
                  className={clsx(
                    "px-4 py-3 whitespace-nowrap bg-slate-50 dark:bg-[#11131f]",
                    getColumnVisibilityClass("carrierEstimatedDeliveryDate"),
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("carrierEstimatedDeliveryDate")}
                    className="inline-flex items-center gap-1 rounded-md transition-colors hover:text-slate-700 dark:hover:text-white"
                  >
                    <span>Previsão Transportadora</span>
                    {renderSortIcon("carrierEstimatedDeliveryDate")}
                  </button>
                </th>
                <th
                  className={clsx(
                    "px-4 py-3 whitespace-nowrap bg-slate-50 dark:bg-[#11131f]",
                    getColumnVisibilityClass("lastUpdate"),
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("lastUpdate")}
                    className="inline-flex items-center gap-1 rounded-md transition-colors hover:text-slate-700 dark:hover:text-white"
                  >
                    <span>Última Movimentação</span>
                    {renderSortIcon("lastUpdate")}
                  </button>
                </th>
                <th
                  className={clsx(
                    "px-4 py-3 whitespace-nowrap text-center bg-slate-50 dark:bg-[#11131f]",
                    getColumnVisibilityClass("status"),
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("status")}
                    className="inline-flex items-center gap-1 rounded-md transition-colors hover:text-slate-700 dark:hover:text-white"
                  >
                    <span>Status</span>
                    {renderSortIcon("status")}
                  </button>
                </th>
                <th className="px-4 py-3 whitespace-nowrap text-right bg-slate-50 dark:bg-[#11131f]">
                  Ação
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5">
              {paginatedOrders.length > 0 ? (
                paginatedOrders.map((order) => (
                  <tr
                    key={order.id}
                    className="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors group"
                  >
                    <td
                      className={clsx(
                        "px-4 py-3 font-medium text-slate-900 dark:text-white",
                        getColumnVisibilityClass("orderNumber"),
                      )}
                    >
                      <div className="flex flex-col">
                        <div className="mb-0.5 flex items-center gap-1.5">
                          {!showArchivedOrders && onToggleMonitoredOrder && (
                            <button
                              type="button"
                              onClick={() => handleMonitorToggle(order)}
                              disabled={monitoringOrderIds.includes(order.id)}
                              className={clsx(
                                "rounded-full p-1 transition-colors",
                                monitoredOrderIdSet.has(order.id)
                                  ? "text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-500/10"
                                  : "text-slate-300 hover:bg-slate-100 hover:text-amber-500 dark:text-slate-500 dark:hover:bg-white/10",
                              )}
                              title={
                                monitoredOrderIdSet.has(order.id)
                                  ? "Remover dos pedidos monitorados"
                                  : "Adicionar aos pedidos monitorados"
                              }
                              aria-label={
                                monitoredOrderIdSet.has(order.id)
                                  ? "Remover dos pedidos monitorados"
                                  : "Adicionar aos pedidos monitorados"
                              }
                            >
                              <Star
                                className={clsx(
                                  "h-3.5 w-3.5",
                                  monitoredOrderIdSet.has(order.id)
                                    ? "fill-current"
                                    : "",
                                )}
                              />
                            </button>
                          )}
                          <span className="bg-slate-100 dark:bg-white/10 text-slate-600 dark:text-slate-300 px-1.5 py-0.5 rounded text-xs w-fit">
                            #{order.orderNumber}
                          </span>
                        </div>
                        <span className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-[150px]">
                          {order.customerName}
                        </span>
                      </div>
                    </td>
                    <td
                      className={clsx(
                        "px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap",
                        getColumnVisibilityClass("invoiceNumber"),
                      )}
                    >
                      {order.invoiceNumber || "-"}
                    </td>
                    <td
                      className={clsx(
                        "px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap",
                        getColumnVisibilityClass("shippingDate"),
                      )}
                    >
                      {order.shippingDate
                        ? new Date(order.shippingDate).toLocaleDateString()
                        : "-"}
                    </td>
                    <td
                      className={clsx(
                        "px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap",
                        getColumnVisibilityClass("salesChannel"),
                      )}
                    >
                      <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 uppercase tracking-wide">
                        {order.salesChannel}
                      </span>
                    </td>
                    <td
                      className={clsx(
                        "px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap",
                        getColumnVisibilityClass("freightType"),
                      )}
                    >
                      {normalizeCarrierName(order.freightType)}
                    </td>
                    <td
                      className={clsx(
                        "px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap",
                        getColumnVisibilityClass("freightValue"),
                      )}
                    >
                      {formatCurrency(order.freightValue)}
                    </td>

                    <td
                      className={clsx(
                        "px-4 py-3 text-slate-600 dark:text-slate-300",
                        getColumnVisibilityClass("recalculatedFreightValue"),
                      )}
                    >
                      <div className="flex flex-col">
                        <span className="whitespace-nowrap">
                          {formatCurrency(order.recalculatedFreightValue)}
                        </span>
                        <span className="text-[10px] text-slate-400 break-all">
                          {order.recalculatedQuotedCarrierName ||
                            "Sem cotacao no pedido"}
                        </span>
                      </div>
                    </td>
                    <td
                      className={clsx(
                        "px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap",
                        getColumnVisibilityClass("freightDifference"),
                      )}
                    >
                      {formatCurrency(getFreightDifference(order))}
                    </td>
                    <td
                      className={clsx(
                        "px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap",
                        getColumnVisibilityClass("estimatedDeliveryDate"),
                      )}
                    >
                      {formatDateOrDash(order.estimatedDeliveryDate)}
                    </td>
                    <td
                      className={clsx(
                        "px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap",
                        getColumnVisibilityClass(
                          "carrierEstimatedDeliveryDate",
                        ),
                      )}
                    >
                      {formatCarrierForecast(
                        order.carrierEstimatedDeliveryDate,
                      )}
                    </td>
                    <td
                      className={clsx(
                        "px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap",
                        getColumnVisibilityClass("lastUpdate"),
                      )}
                    >
                      <div className="flex flex-col">
                        <span className="text-xs">
                          {order.lastUpdate
                            ? new Date(order.lastUpdate).toLocaleDateString()
                            : "-"}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {order.lastUpdate
                            ? new Date(order.lastUpdate)
                                .toLocaleTimeString()
                                .slice(0, 5)
                            : ""}
                        </span>
                      </div>
                    </td>
                    <td
                      className={clsx(
                        "px-4 py-3 text-center",
                        getColumnVisibilityClass("status"),
                      )}
                    >
                      <StatusBadge
                        status={order.status}
                        delayed={order.isDelayed}
                        customStatus={order.manualCustomStatus}
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => void handleSyncOrderTracking(order)}
                          disabled={
                            syncingTrackingOrderIds.includes(order.id) ||
                            showArchivedOrders
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5 dark:hover:text-white"
                        >
                          {syncingTrackingOrderIds.includes(order.id) ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3.5 w-3.5" />
                          )}
                          Atualizar rastreio
                        </button>
                        {!showArchivedOrders &&
                          order.status !== OrderStatus.DELIVERED && (
                            <button
                              onClick={() => void handleMarkOrderDelivered(order)}
                              disabled={markingDeliveredOrderIds.includes(order.id)}
                              className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 px-2.5 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-emerald-900/40 dark:text-emerald-300 dark:hover:bg-emerald-900/20"
                            >
                              {markingDeliveredOrderIds.includes(order.id) ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              )}
                              Marcar entregue
                            </button>
                          )}
                        {enableArchiveControls && (
                          <button
                            onClick={() =>
                              handleArchiveToggle(order, !showArchivedOrders)
                            }
                            disabled={updatingArchiveOrderIds.includes(
                              order.id,
                            )}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-amber-200 hover:bg-amber-50 hover:text-amber-700 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5 dark:hover:text-white"
                          >
                            {updatingArchiveOrderIds.includes(order.id) ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : showArchivedOrders ? (
                              <ArchiveRestore className="h-3.5 w-3.5" />
                            ) : (
                              <Archive className="h-3.5 w-3.5" />
                            )}
                            {showArchivedOrders ? "Desarquivar" : "Arquivar"}
                          </button>
                        )}
                        <button
                          onClick={() => openTrackingLink(order)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5 dark:hover:text-white"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          Abrir rastreio
                        </button>
                        <button
                          onClick={() => setSelectedOrder(order)}
                          className="text-slate-400 hover:text-accent dark:hover:text-neon-blue p-1.5 rounded-full hover:bg-blue-50 dark:hover:bg-white/5 transition-colors"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={ORDER_TABLE_COLUMNS.length + 2}
                    className="px-6 py-12 text-center text-slate-400 dark:text-slate-500"
                  >
                    <Search className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p>Nenhum pedido encontrado com os filtros atuais.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedOrder && (
        <OrderDetail
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onOrderUpdated={(updatedOrder) => {
            setSelectedOrder(updatedOrder);
            onOrderUpdated?.(updatedOrder);
          }}
        />
      )}

      {isTraySyncModalOpen && onStartTraySync && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="flex min-h-full items-center justify-center">
            <div className="glass-card flex w-full max-w-3xl max-h-[calc(100vh-2rem)] flex-col overflow-hidden rounded-xl p-6 shadow-2xl animate-in zoom-in-95 border border-slate-200 dark:border-white/10 bg-white dark:bg-dark-card sm:max-h-[calc(100vh-4rem)]">
              <div className="flex justify-between items-center mb-6 shrink-0">
                <div>
                  <h3 className="text-lg font-bold text-slate-800 dark:text-white">
                    Sincronizar Pedidos da Integradora
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Defina o periodo e os status da {integrationLabel} que serao
                    buscados.
                  </p>
                </div>
                <button
                  onClick={() => setIsTraySyncModalOpen(false)}
                  className="text-slate-500 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
                {!activeIntegration && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900/30 dark:bg-amber-900/10 dark:text-amber-200">
                    Nenhuma integradora ativa foi identificada para esta empresa
                    no momento. O botao permanece visivel para todos os
                    usuarios, mas o sync manual depende de uma integracao
                    configurada.
                  </div>
                )}

                {activeIntegration && !hasSyncableIntegration && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900/30 dark:bg-amber-900/10 dark:text-amber-200">
                    A integradora ativa desta empresa e a {integrationLabel},
                    mas o sync manual pela aba Pedidos ainda nao esta disponivel
                    para esse conector.
                  </div>
                )}

                <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        Status da sincronizacao
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <span
                          className={clsx(
                            "inline-flex items-center rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wide",
                            trayStatusClass,
                          )}
                        >
                          {trayStatusLabel}
                        </span>
                        {traySyncJob?.currentOrderNumber && (
                          <span className="text-sm text-slate-600 dark:text-slate-300">
                            Status atual:{" "}
                            <strong>{traySyncJob.currentOrderNumber}</strong>
                          </span>
                        )}
                      </div>
                    </div>
                    {hasTrayJob && (
                      <div className="grid grid-cols-2 gap-3 text-sm sm:min-w-[240px]">
                        <div className="rounded-lg bg-white dark:bg-dark-card border border-slate-200 dark:border-white/10 px-3 py-2">
                          <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                            Progresso
                          </p>
                          <p className="font-semibold text-slate-800 dark:text-white">
                            {traySyncJob?.processed || 0}/
                            {traySyncJob?.total || 0}
                          </p>
                        </div>
                        <div className="rounded-lg bg-white dark:bg-dark-card border border-slate-200 dark:border-white/10 px-3 py-2">
                          <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                            Novos pedidos
                          </p>
                          <p className="font-semibold text-slate-800 dark:text-white">
                            {traySyncJob?.success || 0}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                  {isTrayJobRunning && (
                    <p className="mt-3 text-xs text-blue-600 dark:text-blue-300">
                      O processo continua executando mesmo se esta janela for
                      fechada.
                    </p>
                  )}
                  {traySyncJob?.error && (
                    <p className="mt-3 text-xs text-red-600 dark:text-red-300">
                      {traySyncJob.error}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase mb-2">
                    Buscar pedidos
                  </label>
                  <select
                    value={traySyncDays}
                    onChange={(e) =>
                      setTraySyncDays(
                        Number(e.target.value) as TraySyncFilters["days"],
                      )
                    }
                    className="w-full p-3 border border-slate-200 dark:border-white/10 rounded-lg text-sm bg-white dark:bg-dark-card dark:text-white focus:border-accent outline-none"
                    disabled={isTrayJobRunning}
                  >
                    {TRAY_DAY_OPTIONS.map((days) => (
                      <option key={days} value={days}>
                        {days} dias
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase mb-2">
                    {activeIntegration === "jet"
                      ? "idOrder da JET a serem buscados"
                      : "Status dos pedidos a serem buscados"}
                  </label>

                  <div className="rounded-lg border border-slate-200 dark:border-white/10 px-3 py-3">
                    <p className="text-sm font-medium text-slate-700 dark:text-white">
                      {activeIntegration === "jet"
                        ? "Selecao manual de idOrder"
                        : "Selecao manual de status"}
                    </p>
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      {isLoadingIntegrationStatuses
                        ? `Carregando status manuais da ${integrationLabel}...`
                        : hasConfiguredManualStatuses
                          ? `${integrationStatusOptions.length} status manual(is) configurado(s) para esta empresa na ${integrationLabel}.`
                          : isUsingIntegrationFallbackStatuses
                            ? `Sem status manual salvo. Usando ${integrationStatusOptions.length} status disponivel(is) da ${integrationLabel}.`
                            : `Nenhum status disponivel para esta empresa na ${integrationLabel}.`}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                      {activeIntegration === "jet"
                        ? "Para JET, salve os idOrder em Configuracoes > Integracao > Status manuais da integradora. O sync consulta cada idOrder selecionado."
                        : "O sync manual usa os status manuais salvos em Configuracoes > Integracao. Quando nao houver status manual, a lista da integradora ativa e usada automaticamente."}
                    </p>
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {integrationStatusOptions.map((status) => (
                        <label
                          key={status.value}
                          className={clsx(
                            "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                            integrationStatusOptions.length > 0
                              ? "border-slate-200 dark:border-white/10 cursor-pointer hover:bg-slate-50 dark:hover:bg-white/5"
                              : "border-slate-100 dark:border-white/5 opacity-60 cursor-not-allowed",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={selectedTrayStatuses.includes(status.value)}
                            onChange={() => toggleTrayStatus(status.value)}
                            disabled={
                              integrationStatusOptions.length === 0 ||
                              isTrayJobRunning ||
                              isLoadingIntegrationStatuses
                            }
                          />
                          <span className="flex items-center gap-1">
                            <span className="capitalize">{status.label}</span>
                            {typeof status.code === "number" && (
                              <span className="text-[11px] text-slate-400 dark:text-slate-500">
                                #{status.code}
                              </span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                    {!isLoadingIntegrationStatuses &&
                      integrationStatusOptions.length === 0 && (
                        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-200">
                          Nenhum status foi encontrado para o sync da
                          integradora. Cadastre status manuais em Configuracoes
                          &gt; Integracao ou valide a conexao da ERP ativa.
                        </p>
                      )}
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase">
                      Logs da sincronizacao
                    </label>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                      {trayLogs.length} registro(s)
                    </span>
                  </div>
                  <div className="max-h-64 overflow-auto rounded-xl border border-slate-200 dark:border-white/10 bg-slate-950 text-slate-100">
                    {trayLogs.length > 0 ? (
                      <div className="divide-y divide-white/5">
                        {trayLogs.map((log, index) => (
                          <div
                            key={`${log.timestamp}-${index}`}
                            className="px-4 py-3 font-mono text-xs"
                          >
                            <div className="flex items-start gap-3">
                              <span className="min-w-[72px] text-slate-400">
                                {new Date(log.timestamp).toLocaleTimeString()}
                              </span>
                              <span
                                className={clsx(
                                  "min-w-[64px] uppercase tracking-wide",
                                  log.level === "error"
                                    ? "text-red-300"
                                    : log.level === "success"
                                      ? "text-emerald-300"
                                      : "text-blue-300",
                                )}
                              >
                                {log.level}
                              </span>
                              <span className="flex-1 whitespace-pre-wrap break-words text-slate-100">
                                {log.message}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="px-4 py-6 text-center text-xs text-slate-400">
                        Os logs da Integradora aparecem aqui assim que a
                        sincronizacao for iniciada.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="pt-4 mt-4 flex gap-3 shrink-0 border-t border-slate-200 dark:border-white/10">
                <button
                  type="button"
                  onClick={() => setIsTraySyncModalOpen(false)}
                  className="flex-1 px-4 py-3 border border-slate-200 dark:border-white/10 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/5 disabled:opacity-50"
                >
                  Fechar
                </button>
                {isTrayJobRunning && onCancelTraySync && (
                  <button
                    type="button"
                    onClick={() => void onCancelTraySync()}
                    className="flex-1 px-4 py-3 border border-red-200 bg-red-50 rounded-lg text-red-700 hover:bg-red-100 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
                  >
                    Cancelar Sync de Pedidos
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleTraySync}
                  disabled={
                    isTraySyncing || isTrayJobRunning || !hasSyncableIntegration
                  }
                  className="flex-1 px-4 py-3 bg-accent dark:bg-neon-blue hover:bg-blue-600 dark:hover:bg-cyan-400 text-white dark:text-black rounded-lg font-bold shadow-lg shadow-blue-500/20 dark:shadow-neon-blue/20 flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isTraySyncing ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Iniciando...
                    </>
                  ) : isTrayJobRunning ? (
                    "Sincronizando em segundo plano"
                  ) : (
                    "Buscar pedidos"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* API Search Modal */}
      {isSearchModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="glass-card w-full max-w-md rounded-xl p-6 shadow-2xl animate-in zoom-in-95 border-t-4 border-accent dark:border-neon-blue bg-white dark:bg-dark-card">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="text-lg font-bold text-slate-800 dark:text-white flex items-center gap-2">
                  <Globe className="w-5 h-5 text-accent dark:text-neon-blue" />{" "}
                  Busca Externa
                </h3>
                <p className="text-xs text-slate-500">
                  Consultar Intelipost e SSW
                </p>
              </div>
              <button
                onClick={() => setIsSearchModalOpen(false)}
                className="text-slate-500 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={executeApiSearch} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                  Pedido, NF ou chave XML
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="Ex: pedido 123456, NF 109770 ou XML/CT-e"
                  value={apiSearchInput}
                  onChange={(e) => setApiSearchInput(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg p-3 text-lg font-mono tracking-wider text-slate-900 dark:text-white focus:border-accent dark:focus:border-neon-blue outline-none"
                />
              </div>

              <div className="pt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => setIsSearchModalOpen(false)}
                  className="flex-1 px-4 py-3 border border-slate-200 dark:border-white/10 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/5"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isFetchingSingle}
                  className="flex-1 px-4 py-3 bg-accent dark:bg-neon-blue hover:bg-blue-600 dark:hover:bg-cyan-400 text-white dark:text-black rounded-lg font-bold shadow-lg shadow-blue-500/20 dark:shadow-neon-blue/20 flex items-center justify-center gap-2"
                >
                  {isFetchingSingle ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    "Consultar"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
