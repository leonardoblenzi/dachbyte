import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, X } from 'lucide-react';
import { API_BASE_URL } from '../../config';
import { usePlatformDialog } from '../../contexts/PlatformDialogContext';
import { checkDesktopRelease, isLegacyUpdaterClient } from '../../utils/desktopUpdater';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_STORAGE_KEY = 'voltchat:last-version-check-at';
let fallbackLastCheckAt = 0;

const getLastCheckAt = () => {
  if (typeof window === 'undefined') return fallbackLastCheckAt;
  try {
    const storedValue = Number.parseInt(window.localStorage.getItem(LAST_CHECK_STORAGE_KEY) || '0', 10);
    return Number.isFinite(storedValue) ? storedValue : fallbackLastCheckAt;
  } catch {
    return fallbackLastCheckAt;
  }
};

const markVersionCheckAttempt = () => {
  const checkedAt = Date.now();
  fallbackLastCheckAt = checkedAt;
  try {
    window.localStorage.setItem(LAST_CHECK_STORAGE_KEY, String(checkedAt));
  } catch {
    // Sem armazenamento local, o temporizador da sessão ainda limita as consultas.
  }
};

const isVersionCheckDue = () => Date.now() - getLastCheckAt() >= CHECK_INTERVAL_MS;

const getVersionKey = (version) => {
  if (!version) return null;
  return [version.service, version.commit || version.version, version.build_time].filter(Boolean).join(':');
};

const fetchJsonNoCache = async (url) => {
  const separator = url.includes('?') ? '&' : '?';
  const response = await fetch(`${url}${separator}t=${Date.now()}`);
  if (!response.ok) throw new Error(`Version check failed: ${response.status}`);
  return response.json();
};

const resolveWebVersionUrl = () => {
  const publicUrl = process.env.PUBLIC_URL || '';
  if (publicUrl) return `${publicUrl}/version.json`;
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/chat')) {
    return '/chat/version.json';
  }
  return '/version.json';
};

const webVersionUrl = resolveWebVersionUrl();

const compareVersions = (current, available) => {
  const currentParts = String(current || '0').split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const availableParts = String(available || '0').split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(currentParts.length, availableParts.length);
  for (let index = 0; index < length; index += 1) {
    if ((availableParts[index] || 0) !== (currentParts[index] || 0)) {
      return (availableParts[index] || 0) - (currentParts[index] || 0);
    }
  }
  return 0;
};

const desktopReleasePayload = (release) => ({
  url: release.download_url,
  filename: release.filename,
  sha256: release.sha256,
  version: release.version,
  fileSize: release.file_size,
});

const VersionUpdatePrompt = () => {
  const dialog = usePlatformDialog();
  const initialWebVersion = useRef(null);
  const initialApiVersion = useRef(null);
  const notifiedUpdateKeyRef = useRef(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [dismissedKey, setDismissedKey] = useState(null);
  const [installing, setInstalling] = useState(false);

  const isDesktop = typeof window !== 'undefined' && Boolean(window.voltChatDesktop);
  const canPrepareInBackground = isDesktop && Boolean(
    window.voltChatDesktop?.prepareUpdate && window.voltChatDesktop?.installPreparedUpdate,
  );
  const canInstallLegacy = isDesktop && Boolean(
    window.voltChatDesktop?.installUpdate && window.voltChatDesktop?.getAppVersion,
  );
  const canInstallNatively = canPrepareInBackground || canInstallLegacy;

  useEffect(() => {
    let mounted = true;

    const notifyUpdateReady = (release) => {
      const updateKey = `desktop:${release.version}`;
      if (notifiedUpdateKeyRef.current === updateKey || !window.voltChatDesktop?.showNotification) return;
      notifiedUpdateKeyRef.current = updateKey;
      window.voltChatDesktop.showNotification({
        title: 'Atualização pronta',
        body: `A versão ${release.version} do VoltChat foi baixada. Abra o app e clique em Reiniciar e atualizar.`,
      }).catch(() => {});
    };

    const prepareDesktopRelease = async (release, updateKey) => {
      try {
        await window.voltChatDesktop.prepareUpdate(desktopReleasePayload(release));
        if (!mounted) return;
        setUpdateInfo({ updateKey, desktopRelease: release, status: 'ready' });
        notifyUpdateReady(release);
      } catch (error) {
        if (!mounted) return;
        setUpdateInfo({
          updateKey,
          desktopRelease: release,
          status: 'error',
          errorMessage: error.message || 'Não foi possível baixar a atualização.',
        });
      }
    };

    const checkVersions = async (force = false) => {
      let localVersion = null;
      if (isDesktop && canInstallNatively) {
        localVersion = await window.voltChatDesktop.getAppVersion().catch(() => null);
      }
      const legacyRecovery = isDesktop && isLegacyUpdaterClient(localVersion);
      if (!force && !legacyRecovery && !isVersionCheckDue()) return;
      markVersionCheckAttempt();

      try {
        if (isDesktop) {
          if (!window.voltChatDesktop?.checkForUpdate) {
            throw new Error('Verificacao de atualizacao Cloudflare indisponivel neste cliente.');
          }
          const release = await checkDesktopRelease(localVersion);
          const updateKey = `desktop:${release.version}`;
          const needsUpdate = !canInstallNatively || compareVersions(localVersion, release.version) > 0;
          if (!mounted || !needsUpdate || dismissedKey === updateKey) return;

          const releaseIsNative = Boolean(release.sha256 && !release.external_url);
          if (canPrepareInBackground && releaseIsNative) {
            // O download ocorre silenciosamente; a interface aparece apenas quando estiver pronto.
            await prepareDesktopRelease(release, updateKey);
          } else {
            setUpdateInfo({
              updateKey,
              desktopRelease: release,
              status: releaseIsNative ? 'legacy' : 'error',
              errorMessage: releaseIsNative ? null : 'O instalador precisa estar publicado no Cloudflare R2.',
            });
          }
          return;
        }

        const [webVersion, apiVersion] = await Promise.all([
          fetchJsonNoCache(webVersionUrl),
          fetchJsonNoCache(`${API_BASE_URL}/version`),
        ]);
        const webKey = getVersionKey(webVersion);
        const apiKey = getVersionKey(apiVersion);
        if (!initialWebVersion.current) initialWebVersion.current = webKey;
        if (!initialApiVersion.current) initialApiVersion.current = apiKey;

        const changedServices = [];
        if (initialWebVersion.current && webKey && webKey !== initialWebVersion.current) changedServices.push('web');
        if (initialApiVersion.current && apiKey && apiKey !== initialApiVersion.current) changedServices.push('api');
        const updateKey = [webKey, apiKey].filter(Boolean).join('|');
        if (mounted && changedServices.length > 0 && dismissedKey !== updateKey) {
          setUpdateInfo({ changedServices, updateKey });
        }
      } catch {
        // A checagem não deve atrapalhar o uso normal do app.
      }
    };

    let nextCheckTimer = null;
    const scheduleNextCheck = () => {
      window.clearTimeout(nextCheckTimer);
      const elapsedSinceLastCheck = Math.max(0, Date.now() - getLastCheckAt());
      const delay = Math.max(1000, CHECK_INTERVAL_MS - elapsedSinceLastCheck);
      nextCheckTimer = window.setTimeout(async () => {
        await checkVersions();
        scheduleNextCheck();
      }, delay);
    };

    checkVersions().finally(scheduleNextCheck);
    const handleDeploymentReconnect = () => {
      // O WebSocket somente emite este evento apos cair e reconectar.
      // Isso torna o aviso imediato depois de um deploy, sem polling continuo.
      checkVersions(true);
    };
    window.addEventListener("voltchat:reconnected", handleDeploymentReconnect);
    const handleForcedUpdateCheck = () => {
      checkVersions(true);
    };
    window.addEventListener("voltchat:force-update-check", handleForcedUpdateCheck);
    const handleVisibility = () => {
      if (!document.hidden && isVersionCheckDue()) {
        window.clearTimeout(nextCheckTimer);
        checkVersions().finally(scheduleNextCheck);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      mounted = false;
      window.clearTimeout(nextCheckTimer);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener("voltchat:reconnected", handleDeploymentReconnect);
      window.removeEventListener("voltchat:force-update-check", handleForcedUpdateCheck);
    };
  }, [canInstallNatively, canPrepareInBackground, dismissedKey, isDesktop]);

  const handleRefresh = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('refresh', Date.now().toString());
    window.location.replace(url.toString());
  };

  const handleUpdate = async () => {
    if (!updateInfo.desktopRelease) {
      handleRefresh();
      return;
    }

    const release = updateInfo.desktopRelease;
    const payload = desktopReleasePayload(release);
    setInstalling(true);
    try {
      if (canPrepareInBackground) {
        if (updateInfo.status !== 'ready') {
          await window.voltChatDesktop.prepareUpdate(payload);
          setUpdateInfo((current) => ({ ...current, status: 'ready', errorMessage: null }));
          setInstalling(false);
          return;
        }
        await window.voltChatDesktop.installPreparedUpdate(payload);
        return;
      }
      if (canInstallLegacy && release.sha256 && !release.external_url) {
        await window.voltChatDesktop.installUpdate(payload);
        return;
      }
      throw new Error('Atualizador nativo indisponível. Instale uma versão recente do VoltChat uma única vez.');
    } catch (error) {
      setInstalling(false);
      setUpdateInfo((current) => ({ ...current, status: 'error', errorMessage: error.message }));
      await dialog.alert({
        title: 'Atualização não iniciada',
        message: error.message || 'Não foi possível iniciar a atualização. Tente novamente.',
      });
    }
  };

  if (!updateInfo) return null;
  const desktopStatus = updateInfo.status;
  const updateButtonLabel = installing
    ? (desktopStatus === 'ready' ? 'Reiniciando...' : 'Baixando...')
    : desktopStatus === 'ready'
      ? 'Reiniciar e atualizar'
      : desktopStatus === 'error'
        ? 'Tentar novamente'
        : 'Atualizar';

  return (
    <div className="version-update" role="dialog" aria-live="polite" aria-label="Nova versão disponível">
      <div>
        <p className="m-0 text-sm font-extrabold text-slate-950">
          {updateInfo.desktopRelease ? 'Nova versão do VoltChat Desktop' : 'Nova versão disponível'}
        </p>
        <p className="m-0 mt-1 text-sm text-slate-500">
          {updateInfo.desktopRelease
            ? desktopStatus === 'ready'
              ? `A versão ${updateInfo.desktopRelease.version} já foi baixada e validada. Reinicie para concluir a atualização.`
              : desktopStatus === 'error'
                ? updateInfo.errorMessage
                : `A versão ${updateInfo.desktopRelease.version} está disponível para atualização.`
            : <>Atualização detectada em {updateInfo.changedServices.includes('api') ? 'API' : ''}
              {updateInfo.changedServices.length === 2 ? ' e ' : ''}
              {updateInfo.changedServices.includes('web') ? 'Web' : ''}. Atualize para carregar a versão mais recente.</>}
        </p>
      </div>
      <div className="version-update__actions">
        <button className="button-secondary" type="button" disabled={installing} onClick={() => {
          setDismissedKey(updateInfo.updateKey);
          setUpdateInfo(null);
        }}>
          <X size={16} /> Depois
        </button>
        <button className="button-primary" type="button" disabled={installing} onClick={handleUpdate}>
          {installing ? <LoaderCircle className="animate-spin" size={16} /> : <RefreshCw size={16} />}
          {updateButtonLabel}
        </button>
      </div>
    </div>
  );
};

export default VersionUpdatePrompt;