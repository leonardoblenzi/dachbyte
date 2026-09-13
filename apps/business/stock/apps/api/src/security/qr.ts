import { createHmac, randomUUID } from 'node:crypto';
import { env } from '../config/env';

export type QrEntityType = 'product' | 'location' | 'pallet' | 'lot' | 'serial' | 'document';

const prefixes: Record<QrEntityType, string> = {
  product: 'PROD',
  location: 'LOC',
  pallet: 'PAL',
  lot: 'LOT',
  serial: 'SER',
  document: 'MOV'
};

export function createQrToken(entityType: QrEntityType): string {
  const payload = `VS-${prefixes[entityType]}-${randomUUID()}`;
  const signature = createHmac('sha256', env.QR_HMAC_SECRET).update(payload).digest('base64url').slice(0, 18);
  return `${payload}.${signature}`;
}

export function verifyQrToken(token: string): boolean {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) {
    return false;
  }

  const expected = createHmac('sha256', env.QR_HMAC_SECRET).update(payload).digest('base64url').slice(0, 18);
  return expected === signature;
}
