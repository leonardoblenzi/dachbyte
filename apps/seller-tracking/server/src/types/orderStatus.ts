export const OrderStatus = {
  PENDING: 'PENDING',
  CREATED: 'CREATED',
  SHIPPED: 'SHIPPED',
  DELIVERY_ATTEMPT: 'DELIVERY_ATTEMPT',
  DELIVERED: 'DELIVERED',
  FAILURE: 'FAILURE',
  RETURNED: 'RETURNED',
  CANCELED: 'CANCELED',
  CHANNEL_LOGISTICS: 'CHANNEL_LOGISTICS',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];
