function createRequestId(prefix = "req") {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `${prefix}_${randomId}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

export { createRequestId };
