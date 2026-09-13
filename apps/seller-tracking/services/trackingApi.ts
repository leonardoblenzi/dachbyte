
import { Order, OrderStatus, TrackingEvent } from '../types';

// NOTE: In a production environment, these should be environment variables.
const INTELIPOST_API_URL = 'https://tracking-graphql.intelipost.com.br/';
// ID from the working request example
const DEFAULT_CLIENT_ID = '40115'; 

// ✅ QUERY ATUALIZADA
const INTELIPOST_QUERY = `
query ($clientId: ID, $orderNumber: String, $orderHash: String) {
  trackingStatus(clientId: $clientId, orderNumber: $orderNumber, orderHash: $orderHash) {
    client {
      id
    }
    order {
      order_number
    }
    tracking {
      status
      status_label
      estimated_delivery_date_lp
      history {
        event_date
        status_label
        provider_message
        macro_state { code }
      }
    }
    logistic_provider {
      name
    }
    end_customer {
      address {
        city
        state
      }
    }
  }
}
`;

const mapIntelipostStatusToEnum = (status: string): OrderStatus => {
  const s = status ? status.toUpperCase() : '';
  if (s.includes('SAIU PARA ENTREGA') || s.includes('DELIVERY_ATTEMPT') || s.includes('TO_BE_DELIVERED') || s.includes('SAIU PARA')) return OrderStatus.DELIVERY_ATTEMPT;
  if (s.includes('ENTREGUE') || s.includes('DELIVERED')) return OrderStatus.DELIVERED;
  if (s.includes('EM TRÂNSITO') || s.includes('SHIPPED') || s.includes('TRANSIT')) return OrderStatus.SHIPPED;
  if (s.includes('CRIADO') || s.includes('CREATED')) return OrderStatus.CREATED;
  if (s.includes('FALHA') || s.includes('FAILURE') || s.includes('ROUBO') || s.includes('AVARIA')) return OrderStatus.FAILURE;
  if (s.includes('DEVOL') || s.includes('RETURN')) return OrderStatus.RETURNED;
  if (s.includes('CANCEL') || s.includes('CANCELED')) return OrderStatus.CANCELED;
  return OrderStatus.PENDING;
};

const resolveTrackingStatus = (trackingData: any, historyMapped: TrackingEvent[]): OrderStatus => {
  const latestHistory = historyMapped.length > 0
    ? historyMapped.reduce((prev, current) =>
        new Date(prev.date) > new Date(current.date) ? prev : current,
      )
    : null;

  return mapIntelipostStatusToEnum(
    [
      trackingData?.tracking?.status,
      trackingData?.tracking?.status_label,
      latestHistory?.status,
      latestHistory?.description,
    ]
      .filter(Boolean)
      .join(' '),
  );
};

const parseCarrierForecastFromText = (text: string | null | undefined) => {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) return null;

  const match = normalizedText.match(
    /previs[aã]o\s+de\s+entrega\s*:\s*(\d{2})\/(\d{2})\/(\d{2,4})/i,
  );

  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]) - 1;
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  const parsedDate = new Date(year, month, day);

  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  parsedDate.setHours(23, 59, 59, 999);
  return parsedDate;
};

const resolveCarrierEstimatedDate = (
  historyMapped: TrackingEvent[],
) => {
  const orderedTexts = historyMapped
    .slice()
    .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime())
    .map((event) => event.description);

  for (const text of orderedTexts) {
    const parsedDate = parseCarrierForecastFromText(text);
    if (parsedDate) {
      return parsedDate;
    }
  }

  return null;
};

const toCleanString = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

/**
 * Fetches a single order directly from Intelipost using the GraphQL Query.
 */
export const fetchSingleOrder = async (
  orderNumber: string,
  intelipostClientId = DEFAULT_CLIENT_ID,
): Promise<Partial<Order> | null> => {
  const cleanOrderNumber = toCleanString(orderNumber);
  const resolvedClientId = toCleanString(intelipostClientId) || DEFAULT_CLIENT_ID;

  if (!cleanOrderNumber) {
    return null;
  }

  try {
    const payload = {
      operationName: null,
      query: INTELIPOST_QUERY,
      variables: {
        clientId: resolvedClientId,
        orderHash: resolvedClientId,
        orderNumber: cleanOrderNumber
      }
    };

    const response = await fetch(INTELIPOST_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://status.ondeestameupedido.com'
        // User-Agent removed to prevent browser safety errors
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const json = await response.json();
      
      if (json.errors) return null;

      const trackingData = json.data?.trackingStatus;

      if (trackingData) {
        // Real Data Found - Map and Return
        const historyMapped: TrackingEvent[] = (trackingData.tracking.history || []).map((h: any) => ({
          status: h.macro_state?.code || 'UNKNOWN',
          description: h.provider_message || h.status_label,
          date: new Date(h.event_date),
          city: trackingData.end_customer?.address?.city || '',
          state: trackingData.end_customer?.address?.state || ''
        }));

        const carrierEstimatedDate =
          resolveCarrierEstimatedDate(historyMapped);
        
        // Determine last update date from history or current time
        const lastEventDate = historyMapped.length > 0 
            ? new Date(Math.max(...historyMapped.map(e => new Date(e.date).getTime())))
            : new Date();

        return {
          orderNumber: trackingData.order.order_number,
          status: resolveTrackingStatus(trackingData, historyMapped),
          freightType: trackingData.logistic_provider?.name || 'Desconhecida',
          estimatedDeliveryDate: carrierEstimatedDate || new Date(),
          carrierEstimatedDeliveryDate: carrierEstimatedDate,
          trackingHistory: historyMapped,
          lastUpdate: lastEventDate,
          city: trackingData.end_customer?.address?.city || '',
          state: trackingData.end_customer?.address?.state || ''
        };
      }
    }
  } catch (error) {
    console.warn("Falha na conexão com API Real.", error);
  }
  return null;
};

/**
 * Syncs multiple orders.
 * 1. Skips finalized orders and CANCELED orders.
 * 2. Handles 'ColetasME2', 'Shopee Xpress' AND 'Priority' by forcing STATUS = CHANNEL_LOGISTICS.
 * 3. For others, fetches REAL data from Intelipost.
 * 4. Updates 'Transportadora' (freightType) ONLY from API sync for non-marketplace orders.
 */
export const syncOrdersWithIntelipost = async (
  orders: Order[],
  intelipostClientId = DEFAULT_CLIENT_ID,
): Promise<Order[]> => {
  
  const updatedOrders = await Promise.all(orders.map(async (order) => {
    
    // 1. Skip if Finalized (Delivered, Canceled, etc)
    if ([OrderStatus.DELIVERED, OrderStatus.FAILURE, OrderStatus.RETURNED, OrderStatus.CANCELED].includes(order.status)) {
        return order;
    }

    // 2. Handle Marketplace Logistics / Priority (No Intelipost Call)
    // Checks for specific strings or if it already is channel logistics
    const freightType = toCleanString(order.freightType);
    const isChannelManaged = 
        ['ColetasME2', 'Shopee Xpress'].includes(freightType) || 
        freightType.toLowerCase().includes('priorit') ||
        order.status === OrderStatus.CHANNEL_LOGISTICS;

    if (isChannelManaged) {
        // Force status to Channel Logistics if not already set or finalized
        const history = [...order.trackingHistory];
        
        // Add a mock history entry if empty to show something in UI
        if (history.length === 0) {
            history.push({
                status: 'CHANNEL_LOGISTICS',
                description: 'Logística gerenciada pelo canal de venda',
                date: new Date(order.shippingDate),
                city: order.city,
                state: order.state
            });
        }

        return {
            ...order,
            status: OrderStatus.CHANNEL_LOGISTICS,
            trackingHistory: history,
            lastUpdate: order.shippingDate // Or last history date
        };
    }

    // 3. Actionable Order: Fetch Real Data from Intelipost
    try {
        const fetchedData = await fetchSingleOrder(
          toCleanString(order.orderNumber),
          intelipostClientId,
        );
        
        if (fetchedData) {
            const newStatus = fetchedData.status || order.status;
            const newEstimatedDate =
              fetchedData.estimatedDeliveryDate || order.estimatedDeliveryDate;
            const hasEstimatedDate = Boolean(newEstimatedDate);
            const isDelayed =
              hasEstimatedDate &&
              newStatus !== OrderStatus.DELIVERED &&
              new Date() > new Date(newEstimatedDate as Date);

            return {
                ...order,
                ...fetchedData, // This overwrites freightType with the real one from Intelipost
                isDelayed,
                lastApiSync: new Date(),
                // lastUpdate is already set correctly in fetchSingleOrder based on event date
            };
        }
    } catch (e) {
        console.error(`Error syncing order ${order.orderNumber}`, e);
    }

    return order;
  }));

  return updatedOrders;
};
