"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePlatformCreatedDate = void 0;
const safeDate = (value) => {
    if (!value)
        return null;
    try {
        const parsed = new Date(value);
        const year = parsed.getFullYear();
        if (Number.isNaN(parsed.getTime()) || year < 1900 || year > 2100) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
};
const resolvePlatformCreatedDate = (order) => {
    const explicitPlatformDate = safeDate(order.platformCreatedAt);
    if (explicitPlatformDate) {
        return explicitPlatformDate;
    }
    const payloadDate = safeDate(order.apiRawPayload?.date ||
        order.apiRawPayload?.date_add ||
        order.apiRawPayload?.created_at);
    if (payloadDate) {
        return payloadDate;
    }
    if (Array.isArray(order.trackingEvents) && order.trackingEvents.length > 0) {
        const earliestTrackingDate = order.trackingEvents.reduce((earliest, event) => {
            const eventDate = safeDate(event?.eventDate);
            if (!eventDate) {
                return earliest;
            }
            if (!earliest || eventDate.getTime() < earliest.getTime()) {
                return eventDate;
            }
            return earliest;
        }, null);
        if (earliestTrackingDate) {
            return earliestTrackingDate;
        }
    }
    return safeDate(order.shippingDate) || safeDate(order.createdAt);
};
exports.resolvePlatformCreatedDate = resolvePlatformCreatedDate;
