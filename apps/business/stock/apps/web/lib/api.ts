export const BASE_PATH = process.env.NEXT_PUBLIC_VOLTSTOCK_BASE_PATH ?? '/business/stock';
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? `${BASE_PATH}/api`;

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  role: string;
  tenantId: string;
  tenantSlug: string;
  companyId: string;
  branchId?: string;
};

export type StoredSession = {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
};

export function readSession(): StoredSession | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem('voltstock.session');
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    window.localStorage.removeItem('voltstock.session');
    return null;
  }
}

export function writeSession(session: StoredSession) {
  window.localStorage.setItem('voltstock.session', JSON.stringify(session));
}

export async function ensureSession(): Promise<StoredSession | null> {
  const current = readSession();
  if (current?.accessToken) {
    return current;
  }

  const response = await fetch(`${API_URL}/v1/auth/suite-session`, {
    credentials: 'include'
  }).catch(() => null);
  if (!response?.ok || response.status === 204) return null;

  const session = (await response.json()) as StoredSession;
  if (session?.accessToken) {
    writeSession(session);
    return session;
  }
  return null;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await ensureSession();
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');

  if (session?.accessToken) {
    headers.set('Authorization', `Bearer ${session.accessToken}`);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message ?? payload.error ?? 'Erro na API Volt Stock.');
  }

  return response.json() as Promise<T>;
}
