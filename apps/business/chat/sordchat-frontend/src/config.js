export const API_BASE_URL = process.env.REACT_APP_API_URL || '/business/chat/api';

const resolveWebSocketBaseUrl = () => {
  if (process.env.REACT_APP_WS_URL) return process.env.REACT_APP_WS_URL;
  if (/^https?:/i.test(API_BASE_URL)) return API_BASE_URL.replace(/^http/i, 'ws');
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${API_BASE_URL.startsWith('/') ? '' : '/'}${API_BASE_URL}`;
  }
  return API_BASE_URL;
};

export const WS_BASE_URL = resolveWebSocketBaseUrl();
export const DESKTOP_DOWNLOAD_URL =
  process.env.REACT_APP_DESKTOP_DOWNLOAD_URL || `${API_BASE_URL}/downloads/desktop/latest`;
export const DESKTOP_PACKAGE_DOWNLOAD_URL =
  process.env.REACT_APP_DESKTOP_PACKAGE_DOWNLOAD_URL || `${API_BASE_URL}/downloads/desktop/package`;
