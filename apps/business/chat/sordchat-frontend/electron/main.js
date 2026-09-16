const electron = require("electron");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { promisify } = require("util");
const { spawn } = require("child_process");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { pathToFileURL } = require("url");
const { mergeArchiveMessages, shouldCompactArchiveJournal } = require("./chatArchive");

if (!electron.app) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    env,
    stdio: "ignore",
    windowsHide: false,
  }).unref();
  process.exit(0);
}

const { app, BrowserWindow, desktopCapturer, ipcMain, Menu, Notification, safeStorage, session, shell } =
  electron;
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);
const CHAT_ARCHIVE_MAX_MESSAGES = 50_000;
const CHAT_ARCHIVE_JOURNAL_COMPACT_AT = 250;

const isDev = process.env.ELECTRON_START_URL;
const appIcon = path.join(__dirname, "assets", "icon.ico");

const loadJsonConfig = (filename) => {
  try {
    const configPath = path.join(__dirname, filename);
    const raw = fsSync.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.error(`Falha ao carregar ${filename}:`, error);
    return {};
  }
};

const runtimeConfig = loadJsonConfig("runtime-config.json");
const desktopChannel = String(
  process.env.VOLTCHAT_DESKTOP_CHANNEL || runtimeConfig.channel || "production",
).trim().toLowerCase();
if (!["staging", "production"].includes(desktopChannel)) {
  throw new Error(`Canal desktop invalido: ${desktopChannel}`);
}
const isStagingDesktop = desktopChannel === "staging";
const desktopWindowTitle = isStagingDesktop ? "DACHBYTE Chat — STAGING" : "DACHBYTE Chat";
app.setName(isStagingDesktop ? "VoltChat Staging" : "VoltChat");

if (isStagingDesktop) {
  // Staging must never reuse production cookies, auth-session.vcs, archives or Chromium data.
  app.setPath("userData", path.join(app.getPath("appData"), "VoltChat Staging"));
}

const normalizeRuntimeUrl = (value, fallback, { trailingSlash = false } = {}) => {
  const configured = String(value || fallback || "").trim();
  const target = new URL(configured);
  if (target.protocol !== "https:") {
    throw new Error(`VoltChat desktop exige URL HTTPS: ${configured}`);
  }
  target.hash = "";
  target.search = "";
  let normalized = target.toString();
  if (trailingSlash && !normalized.endsWith("/")) normalized += "/";
  if (!trailingSlash) normalized = normalized.replace(/\/$/, "");
  return normalized;
};

const productionWebUrl = normalizeRuntimeUrl(
  process.env.VOLTCHAT_WEB_URL || process.env.VOLTCORP_WEB_URL || runtimeConfig.webUrl,
  "https://www.voltcorporation.com.br/business/chat/",
  { trailingSlash: true },
);
const productionApiUrl = normalizeRuntimeUrl(
  process.env.VOLTCHAT_API_URL || process.env.VOLTCORP_API_URL || runtimeConfig.apiUrl,
  "https://www.voltcorporation.com.br/business/chat/api",
);

const loadUpdaterConfig = () => loadJsonConfig("updater-config.json");

const updaterConfig = loadUpdaterConfig();
const desktopUpdateManifestUrl = String(
  process.env.VOLTCHAT_UPDATE_MANIFEST_URL || updaterConfig.manifestUrl || "",
).trim();
let mainWindow = null;
let splashWindow = null;
let productionRetryTimer = null;
let productionLoadFailures = 0;
let isQuitting = false;
let preparedUpdate = null;
let preparingUpdatePromise = null;

const getProductionLoginUrl = () => new URL(
  "login",
  productionWebUrl.endsWith("/") ? productionWebUrl : `${productionWebUrl}/`,
).toString();

const loadProductionLogin = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadURL(getProductionLoginUrl(), {
    extraHeaders: "Cache-Control: no-cache\r\nPragma: no-cache\r\n",
  });
};

const scheduleProductionRetry = () => {
  if (productionRetryTimer || !mainWindow || mainWindow.isDestroyed()) return;
  const delay = Math.min(15000, 1000 * (2 ** Math.min(productionLoadFailures, 4)));
  productionLoadFailures += 1;
  console.warn(`VoltChat web indisponivel; nova tentativa em ${delay}ms.`);
  productionRetryTimer = setTimeout(() => {
    productionRetryTimer = null;
    loadProductionLogin();
  }, delay);
};
ipcMain.handle("voltchat:quit-app", () => {
  isQuitting = true;
  app.quit();
  return { quitting: true };
});

ipcMain.handle("voltchat:relaunch-app", () => {
  isQuitting = true;
  // Relanca o processo sem limpar a sessao criptografada do usuario.
  setImmediate(() => {
    app.relaunch();
    app.quit();
  });
  return { relaunching: true };
});

const getDesktopSessionPath = () => path.join(app.getPath("userData"), "auth-session.vcs");

const readDesktopSession = async () => {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = await fs.readFile(getDesktopSessionPath());
    const parsed = JSON.parse(safeStorage.decryptString(encrypted));
    if (!parsed || typeof parsed.token !== "string" || !parsed.token || !parsed.user || typeof parsed.user !== "object") {
      return null;
    }
    return { token: parsed.token, user: parsed.user };
  } catch {
    return null;
  }
};

const saveDesktopSession = async (payload = {}) => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("A protecao de dados do Windows nao esta disponivel.");
  }
  if (typeof payload.token !== "string" || !payload.token || !payload.user || typeof payload.user !== "object") {
    throw new Error("Sessao invalida.");
  }
  const sessionPath = getDesktopSessionPath();
  const temporaryPath = `${sessionPath}.tmp-${process.pid}`;
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.writeFile(temporaryPath, safeStorage.encryptString(JSON.stringify({
    token: payload.token,
    user: payload.user,
    savedAt: new Date().toISOString(),
  })));
  await fs.rm(sessionPath, { force: true });
  await fs.rename(temporaryPath, sessionPath);
  return { saved: true };
};

const clearDesktopSession = async () => {
  await fs.rm(getDesktopSessionPath(), { force: true });
  return { cleared: true };
};

ipcMain.handle("voltchat:get-saved-session", () => readDesktopSession());
ipcMain.handle("voltchat:save-session", (_event, payload = {}) => saveDesktopSession(payload));
ipcMain.handle("voltchat:clear-saved-session", () => clearDesktopSession());
const getVoltChatDownloadsDirectory = async () => {
  const downloads = app.getPath("downloads");
  const voltChatDir = path.join(downloads, isStagingDesktop ? "VoltChat Staging" : "VoltChat");

  try {
    await fs.mkdir(voltChatDir, { recursive: true });
    return voltChatDir;
  } catch (error) {
    // fallback to the system Downloads folder when VoltChat subfolder cannot be created
    try {
      await fs.mkdir(downloads, { recursive: true });
      return downloads;
    } catch {
      return app.getPath("temp");
    }
  }
};

const getAvailableDownloadPath = async (directory, filename) => {
  const parsed = path.parse(path.basename(filename || "arquivo"));
  const safeName = `${parsed.name || "arquivo"}${parsed.ext}`;
  let candidate = path.join(directory, safeName);
  let attempt = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(
        directory,
        `${parsed.name || "arquivo"} (${attempt})${parsed.ext}`,
      );
      attempt += 1;
    } catch {
      return candidate;
    }
  }
};

ipcMain.handle("voltchat:download-file", async (_event, payload = {}) => {
  const { url, filename, token } = payload;
  if (!url || !token) {
    throw new Error("Dados de download invalidos.");
  }

  const resolvedUrl = new URL(
    url,
    `${productionApiUrl.replace(/\/$/, "")}/`,
  ).toString();
  const apiOrigin = new URL(productionApiUrl).origin;
  if (new URL(resolvedUrl).origin !== apiOrigin) {
    throw new Error("URL de download nao autorizada.");
  }

  const response = await fetch(resolvedUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Nao foi possivel baixar o arquivo (${response.status}).`);
  }

  const directory = getVoltChatDownloadsDirectory();
  try {
    await fs.mkdir(directory, { recursive: true });
    const savedPath = await getAvailableDownloadPath(directory, filename);
    await fs.writeFile(savedPath, Buffer.from(await response.arrayBuffer()));
    return { savedPath };
  } catch (error) {
    throw new Error(
      `Nao foi possivel salvar em ${directory}. Reinstale o VoltChat para configurar a permissao de downloads. ${error.message}`,
    );
  }
});

const archiveSegment = (value) => {
  const segment = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(segment)) {
    throw new Error("Identificador de arquivo local invalido.");
  }
  return segment;
};

const readEncryptedChatArchive = async (archivePath) => {
  try {
    const encrypted = await fs.readFile(archivePath);
    const compressedBase64 = safeStorage.decryptString(encrypted);
    const json = await gunzipAsync(Buffer.from(compressedBase64, "base64"));
    const parsed = JSON.parse(json.toString("utf8"));
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`Nao foi possivel ler o cofre local: ${error.message}`);
  }
};

const writeEncryptedChatArchive = async (archivePath, payload) => {
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 6 });
  const encrypted = safeStorage.encryptString(compressed.toString("base64"));
  const temporaryPath = `${archivePath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, encrypted);
  await fs.rm(archivePath, { force: true });
  await fs.rename(temporaryPath, archivePath);
};

ipcMain.handle("voltchat:archive-chat-history", async (_event, payload = {}) => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("A protecao de dados do Windows nao esta disponivel.");
  }
  const userId = archiveSegment(payload.userId);
  const messages = Array.isArray(payload.messages)
    ? payload.messages.filter((message) => message && message.id && !message.pending).slice(-50000)
    : [];
  const byCompany = new Map();
  for (const message of messages) {
    if (!message.company_id) continue;
    const companyId = archiveSegment(message.company_id);
    if (!byCompany.has(companyId)) byCompany.set(companyId, []);
    byCompany.get(companyId).push(message);
  }
  const root = path.join(
    app.getPath("documents"),
    isStagingDesktop ? "VoltChatStagingArchives" : "VoltChatArchives",
  );
  const saved = [];
  for (const [companyId, companyMessages] of byCompany.entries()) {
    const directory = path.join(root, `company-${companyId}`, `user-${userId}`);
    const archivePath = path.join(directory, "chat-history.vca");
    const journalPath = path.join(directory, "chat-history.pending.vca");
    await fs.mkdir(directory, { recursive: true });
    // The pending journal stays intentionally small. Rewriting a 50k-message
    // encrypted archive after every received message froze the Electron UI.
    const journal = mergeArchiveMessages(
      await readEncryptedChatArchive(journalPath),
      companyMessages,
      CHAT_ARCHIVE_MAX_MESSAGES,
    );

    if (shouldCompactArchiveJournal(journal.length, CHAT_ARCHIVE_JOURNAL_COMPACT_AT)) {
      const compacted = mergeArchiveMessages(
        await readEncryptedChatArchive(archivePath),
        journal,
        CHAT_ARCHIVE_MAX_MESSAGES,
      );
      await writeEncryptedChatArchive(archivePath, {
        format: "voltchat-local-archive",
        version: 2,
        company_id: companyId,
        user_id: userId,
        saved_at: new Date().toISOString(),
        message_count: compacted.length,
        messages: compacted,
      });
      await fs.rm(journalPath, { force: true });
      saved.push({ companyId, archivePath, messageCount: compacted.length, compacted: true });
      continue;
    }

    await writeEncryptedChatArchive(journalPath, {
      format: "voltchat-local-archive-journal",
      version: 2,
      company_id: companyId,
      user_id: userId,
      saved_at: new Date().toISOString(),
      message_count: journal.length,
      messages: journal,
    });
    saved.push({ companyId, archivePath, journalPath, messageCount: journal.length, compacted: false });
  }
  return { root, saved };
});
ipcMain.handle("voltchat:get-app-version", () => app.getVersion());
ipcMain.handle("voltchat:get-runtime-info", () => ({
  channel: desktopChannel,
  webUrl: productionWebUrl,
  apiUrl: productionApiUrl,
  updateManifestUrl: desktopUpdateManifestUrl,
}));

ipcMain.handle("voltchat:open-external", async (_event, value) => {
  try {
    const target = new URL(value);
    if (target.protocol !== "https:") throw new Error("Link inseguro.");
    await shell.openExternal(target.toString());
    return { opened: true };
  } catch {
    throw new Error("Link de download invalido.");
  }
});

ipcMain.handle("voltchat:show-notification", (_event, payload = {}) => {
  if (process.platform === "win32" && mainWindow && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
  if (!Notification.isSupported()) return { shown: false };
  const notification = new Notification({
    title: String(payload.title || desktopWindowTitle).slice(0, 120),
    body: String(payload.body || "").slice(0, 500),
    icon: payload.icon || appIcon,
    silent: false,
  });
  notification.on("click", () => {
    if (!mainWindow) createWindow();
    mainWindow.flashFrame(false);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("voltchat:notification-clicked", {
      senderId: payload.senderId || null,
      groupId: payload.groupId || null,
      messageId: payload.messageId || null,
    });
  });
  notification.show();
  return { shown: true };
});

const getUpdateInstallerPath = (filename) => {
  const safeFilename = path.basename(filename || "VoltChat-Setup.exe");
  return path.join(
    app.getPath("temp"),
    isStagingDesktop ? "VoltChat-Staging" : "VoltChat",
    "updates",
    safeFilename,
  );
};

const isAuthorizedUpdateUrl = (value) => {
  try {
    const target = new URL(value);
    if (target.protocol !== "https:") return false;

    const isCloudflareR2 = target.hostname.endsWith(".r2.cloudflarestorage.com");
    const configuredUpdateOrigin = String(process.env.VOLTCHAT_UPDATE_ORIGIN || "").trim();
    const isConfiguredUpdateOrigin = configuredUpdateOrigin
      ? target.origin === new URL(configuredUpdateOrigin).origin
      : false;
    const manifestOrigin = desktopUpdateManifestUrl
      ? new URL(desktopUpdateManifestUrl).origin
      : "";
    const isManifestOrigin = Boolean(manifestOrigin && target.origin === manifestOrigin);

    return isCloudflareR2 || isConfiguredUpdateOrigin || isManifestOrigin;
  } catch {
    return false;
  }
};

const validateUpdatePayload = (payload = {}) => {
  const url = String(payload.url || "");
  const filename = path.basename(String(payload.filename || ""));
  const sha256 = String(payload.sha256 || "").toLowerCase();
  const version = String(payload.version || "");
  if (
    !url ||
    !filename.toLowerCase().endsWith(".exe") ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !isAuthorizedUpdateUrl(url)
  ) {
    throw new Error("Pacote de atualizacao invalido.");
  }
  return { url, filename, sha256, version };
};

const fetchDesktopReleaseManifest = async () => {
  if (!desktopUpdateManifestUrl) {
    throw new Error("Manifesto do atualizador Cloudflare nao configurado.");
  }
  const manifestUrl = new URL(desktopUpdateManifestUrl);
  manifestUrl.searchParams.set("t", String(Date.now()));
  const response = await fetch(manifestUrl.toString(), {
    cache: "no-store",
    redirect: "follow",
    headers: { "User-Agent": `VoltChat/${app.getVersion()} updater` },
  });
  if (!response.ok) {
    throw new Error(`Cloudflare R2 indisponivel para atualizacao (${response.status}).`);
  }
  if (new URL(response.url).origin !== new URL(desktopUpdateManifestUrl).origin) {
    throw new Error("Manifesto de atualizacao redirecionado para origem nao autorizada.");
  }
  const manifest = await response.json();
  const manifestChannel = String(manifest.channel || "production").trim().toLowerCase();
  if (manifestChannel !== desktopChannel) {
    throw new Error(
      `Canal de atualizacao invalido: desktop=${desktopChannel} manifesto=${manifestChannel}.`,
    );
  }
  const validated = validateUpdatePayload({
    url: manifest.download_url,
    filename: manifest.filename,
    sha256: manifest.sha256,
    version: manifest.version,
  });
  const fileSize = Number(manifest.file_size || 0);
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new Error("Tamanho invalido no manifesto de atualizacao.");
  }
  return {
    version: validated.version,
    platform: String(manifest.platform || "windows"),
    filename: validated.filename,
    content_type: String(manifest.content_type || "application/octet-stream"),
    file_size: fileSize,
    sha256: validated.sha256,
    download_url: validated.url,
    published_at: manifest.published_at || null,
    external_url: false,
    direct_download: true,
    source: "cloudflare-r2",
  };
};

ipcMain.handle("voltchat:check-desktop-update", () => fetchDesktopReleaseManifest());

const sendUpdateProgress = (payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("voltchat:update-progress", payload);
  }
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const fetchDesktopUpdateWithRetry = async (url) => {
  const retryableStatuses = new Set([502, 503, 504]);
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store", redirect: "follow" });
      if (response.ok || !retryableStatuses.has(response.status) || attempt === 2) {
        return response;
      }
      lastError = new Error(`Servidor temporariamente indisponível (${response.status}).`);
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
    }

    // A VPS pode levar alguns segundos para voltar apos um deploy.
    await sleep(1500 * (attempt + 1));
  }

  throw lastError || new Error("Não foi possível baixar a atualização.");
};
const hashFile = (filePath) => new Promise((resolve, reject) => {
  const digest = crypto.createHash("sha256");
  const input = fsSync.createReadStream(filePath);
  input.on("data", (chunk) => digest.update(chunk));
  input.on("error", reject);
  input.on("end", () => resolve(digest.digest("hex")));
});

const downloadDesktopUpdate = async (payload = {}) => {
  const release = validateUpdatePayload(payload);
  const installerPath = getUpdateInstallerPath(release.filename);
  const temporaryPath = `${installerPath}.part`;
  await fs.mkdir(path.dirname(installerPath), { recursive: true });

  try {
    const existingHash = await hashFile(installerPath);
    if (existingHash.toLowerCase() === release.sha256) {
      preparedUpdate = { ...release, installerPath };
      sendUpdateProgress({ status: "ready", version: release.version, percent: 100 });
      return { ready: true, cached: true, version: release.version };
    }
    await fs.rm(installerPath, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") await fs.rm(installerPath, { force: true });
  }

  await fs.rm(temporaryPath, { force: true });
  sendUpdateProgress({ status: "downloading", version: release.version, percent: 0 });
  try {
    const response = await fetchDesktopUpdateWithRetry(release.url);
    if (!response.ok || !response.body) {
      throw new Error(`Nao foi possivel baixar a atualizacao (${response.status}).`);
    }
    if (!isAuthorizedUpdateUrl(response.url)) {
      throw new Error("A API redirecionou a atualizacao para um endereco nao autorizado.");
    }

    const expectedBytes = Number(response.headers.get("content-length") || payload.fileSize || 0);
    const digest = crypto.createHash("sha256");
    let receivedBytes = 0;
    let lastPercent = -1;
    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        digest.update(chunk);
        const percent = expectedBytes > 0
          ? Math.min(99, Math.floor((receivedBytes / expectedBytes) * 100))
          : null;
        if (percent === null || percent !== lastPercent) {
          lastPercent = percent;
          sendUpdateProgress({
            status: "downloading",
            version: release.version,
            percent,
            receivedBytes,
            totalBytes: expectedBytes || null,
          });
        }
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body),
      progress,
      fsSync.createWriteStream(temporaryPath),
    );
    const downloadedHash = digest.digest("hex");
    if (downloadedHash.toLowerCase() !== release.sha256) {
      throw new Error("A verificacao de seguranca da atualizacao falhou.");
    }
    if (expectedBytes > 0 && receivedBytes !== expectedBytes) {
      throw new Error("A atualizacao foi baixada de forma incompleta.");
    }

    await fs.rm(installerPath, { force: true });
    await fs.rename(temporaryPath, installerPath);
    preparedUpdate = { ...release, installerPath };
    sendUpdateProgress({ status: "ready", version: release.version, percent: 100 });
    return { ready: true, cached: false, version: release.version };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    sendUpdateProgress({ status: "error", version: release.version, message: error.message });
    throw error;
  }
};

const prepareDesktopUpdate = (payload = {}) => {
  if (preparingUpdatePromise) return preparingUpdatePromise;
  preparingUpdatePromise = downloadDesktopUpdate(payload)
    .finally(() => { preparingUpdatePromise = null; });
  return preparingUpdatePromise;
};

const spawnDetached = (command, args, options = {}) => new Promise((resolve, reject) => {
  let child;
  try {
    child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      ...options,
    });
  } catch (error) {
    reject(error);
    return;
  }
  child.once("error", reject);
  child.once("spawn", () => {
    child.unref();
    resolve();
  });
});

const launchDesktopInstaller = async (installerPath) => {
  try {
    await spawnDetached(installerPath, ["/S", "--updated"]);
    return { fallback: false };
  } catch (directError) {
    if (process.platform !== "win32") throw directError;

    // Alguns Windows bloqueiam CreateProcess para executáveis recém-baixados
    // dentro de Temp. ShellExecute usa o lançador nativo e não derruba o app.
    const openError = await shell.openPath(installerPath);
    if (!openError) return { fallback: true, manual: true };

    const quotedInstaller = String(installerPath).replace(/"/g, "\\\"");
    try {
      await spawnDetached(process.env.ComSpec || "cmd.exe", [
        "/d",
        "/s",
        "/c",
        `start "" "${quotedInstaller}" /S --updated`,
      ]);
      return { fallback: true };
    } catch (shellError) {
      throw new Error(
        `Não foi possível iniciar o instalador (${directError.code || directError.message}). ` +
        `Tente baixar novamente ou abra o arquivo em ${installerPath}.`,
      );
    }
  }
};

const installPreparedDesktopUpdate = async (payload = {}) => {
  const release = validateUpdatePayload(payload);
  const ready = preparedUpdate &&
    preparedUpdate.filename === release.filename &&
    preparedUpdate.sha256 === release.sha256
    ? preparedUpdate
    : { ...release, installerPath: getUpdateInstallerPath(release.filename) };
  const installedHash = await hashFile(ready.installerPath).catch(() => "");
  if (installedHash.toLowerCase() !== release.sha256) {
    throw new Error("A atualizacao ainda nao esta pronta. Aguarde o download terminar.");
  }

  await launchDesktopInstaller(ready.installerPath);
  setTimeout(() => {
    isQuitting = true;
    app.quit();
  }, 700);
  return { started: true };
};

ipcMain.handle("voltchat:prepare-update", (_event, payload = {}) =>
  prepareDesktopUpdate(payload));

ipcMain.handle("voltchat:install-prepared-update", (_event, payload = {}) =>
  installPreparedDesktopUpdate(payload));

// Compatibilidade com versoes instaladas que ainda usam o fluxo de um unico clique.
ipcMain.handle("voltchat:install-update", async (_event, payload = {}) => {
  await prepareDesktopUpdate(payload);
  return installPreparedDesktopUpdate(payload);
});

const getLocalAppUrl = () => {
  const indexPath = path.join(__dirname, "..", "build", "index.html");
  return `${pathToFileURL(indexPath).toString()}#/login`;
};

if (process.platform === "win32") {
  app.setAppUserModelId(isStagingDesktop ? "com.voltcorp.app.staging" : "com.voltcorp.app");
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 430,
    height: 250,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: "#071a31",
    icon: appIcon,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;display:grid;height:100vh;place-items:center;background:radial-gradient(circle at 50% 20%,#123d70,#071a31 68%);color:#eaf6ff;font-family:Segoe UI,sans-serif}.wrap{display:grid;place-items:center;gap:17px}.brand{font-size:30px;font-weight:900;letter-spacing:-1px}.brand b{color:#38bdf8}.loader{width:190px;height:4px;overflow:hidden;border-radius:9px;background:rgba(255,255,255,.13)}.loader:after{display:block;width:45%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#38bdf8,#2563eb);content:"";animation:load 1.1s infinite ease-in-out}@keyframes load{from{transform:translateX(-110%)}to{transform:translateX(330%)}}small{color:#a9c7e7;font-weight:600}</style></head><body><div class="wrap"><div class="brand"><b>Volt</b>Chat</div><div class="loader"></div><small>Conectando sua equipe...</small></div></body></html>`;
  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    minWidth: 1024,
    minHeight: 680,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#071a31",
      symbolColor: "#dbeafe",
      height: 44,
    },
    backgroundColor: "#f6f7f9",
    title: desktopWindowTitle,
    icon: appIcon,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.on("focus", () => {
    if (process.platform === "win32") mainWindow?.flashFrame(false);
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.minimize();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.once("ready-to-show", () => {
    splashWindow?.close();
    splashWindow = null;
    mainWindow?.show();
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      console.error(
        `Falha ao carregar ${validatedURL}: ${errorCode} ${errorDescription}`,
      );
      if (!isDev && isMainFrame && validatedURL.startsWith(productionWebUrl)) {
        // Durante um deploy a VPS pode responder temporariamente 502. Nao
        // carregue o bundle local antigo: ele deixaria o desktop sem recursos
        // novos. Mantemos a mesma tela e tentamos a versao online novamente.
        scheduleProductionRetry();
      }
    },
  );

  mainWindow.webContents.on("did-finish-load", () => {
    if (mainWindow.webContents.getURL().startsWith(productionWebUrl)) {
      productionLoadFailures = 0;
      if (productionRetryTimer) {
        clearTimeout(productionRetryTimer);
        productionRetryTimer = null;
      }
    }
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Processo de renderizacao encerrado: ${details.reason}`);
  });

  if (isDev) {
    const startUrl = new URL(process.env.ELECTRON_START_URL);
    startUrl.pathname = "/login";
    startUrl.hash = "";
    mainWindow.loadURL(startUrl.toString());
  } else {
    loadProductionLogin();
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const isAppNavigation = isDev
      ? url.startsWith(process.env.ELECTRON_START_URL)
      : url.startsWith(productionWebUrl);
    if (isAppNavigation) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });
}

const isTrustedMediaOrigin = (value = "") => {
  try {
    if (value.startsWith("file:")) return true;
    const target = new URL(value);
    if (target.origin === new URL(productionWebUrl).origin) return true;
    return Boolean(
      isDev && target.origin === new URL(process.env.ELECTRON_START_URL).origin,
    );
  } catch {
    return false;
  }
};

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details = {}) => {
      if (permission !== "media") {
        callback(false);
        return;
      }
      const requestingUrl = details.requestingUrl || webContents.getURL();
      callback(isTrustedMediaOrigin(requestingUrl));
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details = {}) => {
      if (permission !== "media") return false;
      return isTrustedMediaOrigin(requestingOrigin || webContents.getURL());
    },
  );
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (!isTrustedMediaOrigin(request.frame?.url || request.securityOrigin || "")) {
        callback({});
        return;
      }
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
        callback(sources[0] ? { video: sources[0] } : {});
      } catch (error) {
        console.error("Falha ao selecionar tela para compartilhamento:", error);
        callback({});
      }
    },
    { useSystemPicker: true },
  );
  Menu.setApplicationMenu(null);
  if (process.platform === "win32" && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, path: app.getPath("exe") });
  }
  createSplashWindow();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  // No Windows, o VoltChat permanece ativo ate o usuario clicar em Sair.
});
