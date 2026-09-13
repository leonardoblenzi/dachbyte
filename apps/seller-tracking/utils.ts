
import { Order, OrderStatus } from "./types";

export const toText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  return String(value);
};

const normalizeFreightText = (value: unknown) =>
  toText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

export const normalizeTrackingHistory = (value: unknown) => {
  if (!Array.isArray(value)) return [];

  return value.map((event) => ({
    status: toText((event as any)?.status) || "UNKNOWN",
    description: toText((event as any)?.description) || "Evento de rastreamento",
    date: (event as any)?.date ?? new Date(),
    city: toText((event as any)?.city),
    state: toText((event as any)?.state),
  }));
};

export const normalizeExcludedPlatformFreight = (
  freightType: string | null | undefined,
): string | null => {
  const normalized = normalizeFreightText(freightType);

  if (!normalized) return null;

  if (
    [
      "encomenda normal",
      "normal ao endereço",
      "normal ao endereco",
      "padrÃ£o ao endereÃ§o",
      "padrao ao endereco",
    ].includes(normalized) ||
    normalized.includes("priorit")
  ) {
    return "ColetasME2";
  }

  if (["shopee xpress", "retirada pelo comprador"].includes(normalized)) {
    return "Shopee Xpress";
  }

  if (
    ["retirada normal na agencia", "retirada na agencia"].includes(normalized)
  ) {
    return "Retirada na Agencia";
  }

  if (
    normalized.includes("correios") ||
    normalized.includes("sedex") ||
    normalized === "pac" ||
    normalized.startsWith("pac ") ||
    normalized.endsWith(" pac") ||
    normalized.includes(" pac ") ||
    normalized.includes("pac tray")
  ) {
    return "Correios";
  }

  return null;
};

export const isChannelManagedFreight = (
  freightType: string | null | undefined,
): boolean => Boolean(normalizeExcludedPlatformFreight(freightType));

export const isExcludedPlatformFreight = (
  freightType: string | null | undefined,
): boolean => false;

export const isChannelManagedOrder = (order: Pick<Order, "status" | "freightType">) =>
  order.status === OrderStatus.CHANNEL_LOGISTICS;

export const parseOptionalDate = (value: unknown): Date | null => {
  if (!value) return null;

  if (typeof value === "string") {
    const normalized = value.trim();
    const dateOnlyMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const isoMidnightMatch = normalized.match(
      /^(\d{4})-(\d{2})-(\d{2})T00:00(?::00(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/i,
    );

    if (dateOnlyMatch || isoMidnightMatch) {
      const [, yearRaw, monthRaw, dayRaw] = (dateOnlyMatch || isoMidnightMatch)!;
      const year = Number(yearRaw);
      const month = Number(monthRaw) - 1;
      const day = Number(dayRaw);
      const localNoon = new Date(year, month, day, 12, 0, 0, 0);

      if (!Number.isNaN(localNoon.getTime()) && year >= 1900) {
        return localNoon;
      }
    }
  }

  const parsed = new Date(value as string | number | Date);
  if (Number.isNaN(parsed.getTime()) || parsed.getFullYear() < 1900) {
    return null;
  }

  return parsed;
};

const normalizeDelayDate = (value: unknown) => {
  const parsed = parseOptionalDate(value);
  if (!parsed) return null;

  parsed.setHours(23, 59, 59, 999);
  return parsed;
};

const isClosedForDelay = (status: OrderStatus) =>
  [
    OrderStatus.DELIVERED,
    OrderStatus.FAILURE,
    OrderStatus.RETURNED,
    OrderStatus.CANCELED,
    OrderStatus.CHANNEL_LOGISTICS,
  ].includes(status);

export const isCarrierDelayedOrder = (
  order: Pick<Order, "status" | "carrierEstimatedDeliveryDate">,
) => {
  const carrierDate = normalizeDelayDate(order.carrierEstimatedDeliveryDate);
  if (!carrierDate || isClosedForDelay(order.status)) {
    return false;
  }

  return Date.now() > carrierDate.getTime();
};

export const isPlatformDelayedOrder = (
  order: Pick<Order, "status" | "estimatedDeliveryDate">,
) => {
  const estimatedDate = normalizeDelayDate(order.estimatedDeliveryDate);
  if (!estimatedDate || isClosedForDelay(order.status)) {
    return false;
  }

  return Date.now() > estimatedDate.getTime();
};

export const resolvePlatformCreatedDate = (
  order: Pick<Order, "shippingDate" | "trackingHistory"> & {
    platformCreatedAt?: unknown;
    createdAt?: unknown;
  },
) => {
  const explicitPlatformDate = parseOptionalDate(order.platformCreatedAt);
  if (explicitPlatformDate) {
    return explicitPlatformDate;
  }

  const trackingHistory = normalizeTrackingHistory(order.trackingHistory);
  if (trackingHistory.length > 0) {
    const earliestTrackingEvent = trackingHistory.reduce((earliest, current) =>
      new Date(current.date).getTime() < new Date(earliest.date).getTime()
        ? current
        : earliest,
    );
    const earliestTrackingDate = parseOptionalDate(earliestTrackingEvent.date);
    if (earliestTrackingDate) {
      return earliestTrackingDate;
    }
  }

  return (
    parseOptionalDate(order.shippingDate) || parseOptionalDate(order.createdAt)
  );
};

export const formatDateOrDash = (value: unknown, locale = "pt-BR"): string => {
  const parsed = parseOptionalDate(value);
  return parsed ? parsed.toLocaleDateString(locale) : "-";
};

export const formatCarrierForecast = (value: unknown, locale = "pt-BR"): string => {
  const parsed = parseOptionalDate(value);
  return parsed ? parsed.toLocaleDateString(locale) : "Sem previsão no rastreio";
};

const normalizeFailureText = (value: unknown) =>
  toText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

export const isFailureTrackingEvent = (event: unknown): boolean => {
  const combined = `${toText((event as any)?.status)} ${toText((event as any)?.description)}`.trim();

  if (!combined) {
    return false;
  }

  if (mapIntelipostStatusToEnum(combined) === OrderStatus.FAILURE) {
    return true;
  }

  const normalized = normalizeFailureText(combined);
  return [
    "CLARIFY_DELIVERY_FAIL",
    "DELIVERY_FAIL",
    "INSUCESSO",
    "NAO ENTREG",
    "ENDERECO INVALIDO",
    "ENDERECO NAO LOCALIZADO",
    "DESTINATARIO AUSENTE",
    "RECUSA",
    "RECUSADO",
  ].some((token) => normalized.includes(token));
};

export const getLatestDeliveryFailureEvent = (
  order: Pick<Order, "trackingHistory">,
) => {
  const trackingHistory = normalizeTrackingHistory(order.trackingHistory);
  const failureEvents = trackingHistory.filter((event) =>
    isFailureTrackingEvent(event),
  );

  if (failureEvents.length === 0) {
    return null;
  }

  return failureEvents.reduce((latest, current) =>
    new Date(latest.date) > new Date(current.date) ? latest : current,
  );
};

export const isOrderWithDeliveryFailure = (
  order: Pick<Order, "status" | "trackingHistory">,
): boolean =>
  order.status === OrderStatus.FAILURE ||
  getLatestDeliveryFailureEvent(order) !== null;

export const isPendingDeliveryFailureOrder = (
  order: Pick<Order, "status" | "trackingHistory" | "freightType">,
): boolean => {
  if (
    order.status === OrderStatus.DELIVERED ||
    order.status === OrderStatus.CANCELED ||
    order.status === OrderStatus.CHANNEL_LOGISTICS
  ) {
    return false;
  }

  return isOrderWithDeliveryFailure(order);
};

export const mapIntelipostStatusToEnum = (status: string): OrderStatus => {
  const s = status ? status.toUpperCase() : '';
  // Colocando SAIU PARA ENTREGA ANTES de EM TRÂNSITO para evitar sobrescrever
  if (s.includes('SAIU PARA ENTREGA') || s.includes('DELIVERY_ATTEMPT') || s.includes('TO_BE_DELIVERED') || s.includes('SAIU PARA')) return OrderStatus.DELIVERY_ATTEMPT;
  if (s.includes('ENTREGUE') || s.includes('DELIVERED')) return OrderStatus.DELIVERED;
  if (s.includes('EM TRÂNSITO') || s.includes('SHIPPED') || s.includes('TRANSIT') || s.includes('IN_TRANSIT')) return OrderStatus.SHIPPED;
  if (s.includes('CRIADO') || s.includes('CREATED') || s.includes('NEW')) return OrderStatus.CREATED;
  if (s.includes('FALHA') || s.includes('FAILURE') || s.includes('ROUBO') || s.includes('AVARIA') || s.includes('CLARIFY_DELIVERY_FAIL')) return OrderStatus.FAILURE;
  if (s.includes('DEVOL') || s.includes('RETURN')) return OrderStatus.RETURNED;
  if (s.includes('CANCEL') || s.includes('CANCELED')) return OrderStatus.CANCELED;
  
  // Default fallback for ambiguous cases
  return OrderStatus.PENDING;
};

/**
 * Determina o status efetivo do pedido com base no histórico de rastreamento mais recente.
 * Se houver histórico, usa o evento mais recente para determinar o status.
 * Caso contrário, retorna o status atual do pedido.
 */
export const getEffectiveOrderStatus = (order: Order): OrderStatus => {
  const trackingHistory = normalizeTrackingHistory(order.trackingHistory);

  if (trackingHistory.length === 0) {
    return order.status;
  }

  // Encontrar o evento mais recente
  const latestEvent = trackingHistory.reduce((prev, current) => {
    return (new Date(prev.date) > new Date(current.date)) ? prev : current;
  });

  // Mapear o status do evento para o enum OrderStatus
  // Se o status mapeado for PENDING (não reconhecido), manter o status original se ele for mais específico
  const mappedStatus = mapIntelipostStatusToEnum(
    `${latestEvent.status || ""} ${latestEvent.description || ""}`,
  );

  // Se o status mapeado for válido e diferente de PENDING, usar ele.
  // PENDING é o fallback do mapIntelipostStatusToEnum.
  if (mappedStatus !== OrderStatus.PENDING) {
      return mappedStatus;
  }

  // Se o evento for algo como "CHANNEL_LOGISTICS", podemos não ter mapeado acima, mas pode ser válido.
  if (latestEvent.status === 'CHANNEL_LOGISTICS') {
      return OrderStatus.CHANNEL_LOGISTICS;
  }

  return order.status;
};

/**
 * Normaliza o nome da transportadora removendo sufixos e caracteres indesejados.
 * Ex: "LMS Logistica (Frete Fixo)" -> "LMS Logistica"
 * Ex: "Jamef Jamef Standard" -> "Jamef"
 */
export const normalizeCarrierName = (name: string | null | undefined): string => {
  if (!name) return 'Desconhecida';

  let normalized = toText(name).toLowerCase();

  // Remove termos indesejados
  const termsToRemove = [
    /\(frete fixo\)/g,
    /- standard/g,
    /\bstandard\b/g,
    /\./g // Remove pontos
  ];

  termsToRemove.forEach(term => {
    normalized = normalized.replace(term, '');
  });

  // Remove espaços extras e trim
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // Title Case (Capitalizar primeira letra de cada palavra)
  const words = normalized.split(' ').map(word => {
    return word.charAt(0).toUpperCase() + word.slice(1);
  });

  // Remove duplicatas consecutivas (ex: Jamef Jamef -> Jamef)
  const uniqueWords = words.filter((word, index) => {
    return index === 0 || word !== words[index - 1];
  });

  return uniqueWords.join(' ');
};

/**
 * Verifica se um pedido foi entregue no prazo.
 * O pedido deve ter status DELIVERED.
 * A data de entrega (lastUpdate) deve ser menor ou igual à data estimada (estimatedDeliveryDate).
 */
export const isOrderOnTime = (order: Order): boolean => {
  if (order.status !== OrderStatus.DELIVERED) return false;

  const estimated = parseOptionalDate(order.estimatedDeliveryDate);
  if (!estimated) return false;

  // Set estimated to end of day to be inclusive
  estimated.setHours(23, 59, 59, 999);

  const delivered = new Date(order.lastUpdate);
  
  return delivered <= estimated;
};

/**
 * Verifica se um pedido está "Em Rota" (Saiu para entrega).
 * Considera o status DELIVERY_ATTEMPT ou o último evento de rastreamento ser TO_BE_DELIVERED.
 */
export const isOrderOnRoute = (order: Order): boolean => {
  if (order.status === OrderStatus.DELIVERY_ATTEMPT) return true;

  const trackingHistory = normalizeTrackingHistory(order.trackingHistory);

  if (trackingHistory.length > 0) {
    const latestEvent = trackingHistory.reduce((prev, current) => {
      return (new Date(prev.date) > new Date(current.date)) ? prev : current;
    });

    return (
      latestEvent.status === "TO_BE_DELIVERED" ||
      mapIntelipostStatusToEnum(
        `${latestEvent.status || ""} ${latestEvent.description || ""}`,
      ) === OrderStatus.DELIVERY_ATTEMPT
    );
  }

  return false;
};
