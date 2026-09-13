import { API_BASE_URL } from '../config';

const isLegacyManifestConfigError = (error) => {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('manifesto do atualizador cloudflare nao configurado') ||
    message.includes('manifesto do atualizador cloudflare não configurado') ||
    message.includes('manifesto de atualizacao cloudflare nao configurado') ||
    message.includes('manifesto de atualização cloudflare não configurado')
  );
};

const fetchCompatibilityRelease = async (currentVersion = '') => {
  const params = new URLSearchParams({
    client_version: String(currentVersion || ''),
    t: String(Date.now()),
  });
  const response = await fetch(`${API_BASE_URL}/downloads/desktop/latest/meta?${params.toString()}`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail?.detail || `Cloudflare R2 indisponível para atualização (${response.status}).`);
  }
  const release = await response.json();
  return { ...release, compatibility_bridge: true };
};

export const checkDesktopRelease = async (currentVersion = '') => {
  if (!window.voltChatDesktop?.checkForUpdate) {
    throw new Error('Verificação de atualização indisponível neste cliente.');
  }
  try {
    return await window.voltChatDesktop.checkForUpdate();
  } catch (error) {
    // Ponte temporária apenas para desktops 0.1.39-0.1.41 que foram
    // empacotados com updater-config.json UTF-8/BOM. A fonte continua sendo
    // o latest.json do Cloudflare e o EXE é baixado diretamente do R2.
    if (!isLegacyManifestConfigError(error)) throw error;
    return fetchCompatibilityRelease(currentVersion);
  }
};

export const isLegacyUpdaterClient = (version = '') => {
  const parts = String(version || '0').split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const target = [0, 1, 42];
  for (let index = 0; index < Math.max(parts.length, target.length); index += 1) {
    const current = parts[index] || 0;
    const threshold = target[index] || 0;
    if (current !== threshold) return current < threshold;
  }
  return false;
};
