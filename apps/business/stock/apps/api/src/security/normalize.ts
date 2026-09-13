export function normalizeIdentifier(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}
