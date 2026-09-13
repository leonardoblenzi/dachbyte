const safeDate = (value: unknown): Date | null => {
  if (!value) return null;

  try {
    const parsed = new Date(value as string | number | Date);
    const year = parsed.getFullYear();
    if (Number.isNaN(parsed.getTime()) || year < 1900 || year > 2100) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
};

export const resolvePlatformCreatedDate = (order: {
  platformCreatedAt?: unknown;
  apiRawPayload?: any;
  shippingDate?: unknown;
  createdAt?: unknown;
  trackingEvents?: Array<{ eventDate?: unknown }> | null;
}) => {
  const explicitPlatformDate = safeDate(order.platformCreatedAt);
  if (explicitPlatformDate) {
    return explicitPlatformDate;
  }

  const payloadDate = safeDate(
    order.apiRawPayload?.date ||
      order.apiRawPayload?.date_add ||
      order.apiRawPayload?.created_at,
  );
  if (payloadDate) {
    return payloadDate;
  }

  if (Array.isArray(order.trackingEvents) && order.trackingEvents.length > 0) {
    const earliestTrackingDate = order.trackingEvents.reduce<Date | null>(
      (earliest, event) => {
        const eventDate = safeDate(event?.eventDate);
        if (!eventDate) {
          return earliest;
        }

        if (!earliest || eventDate.getTime() < earliest.getTime()) {
          return eventDate;
        }

        return earliest;
      },
      null,
    );

    if (earliestTrackingDate) {
      return earliestTrackingDate;
    }
  }

  return safeDate(order.shippingDate) || safeDate(order.createdAt);
};
