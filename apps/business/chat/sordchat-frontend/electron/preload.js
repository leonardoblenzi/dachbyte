const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voltChatDesktop', {
  customTitleBar: true,
  quitApp: () => ipcRenderer.invoke("voltchat:quit-app"),
  relaunchApp: () => ipcRenderer.invoke("voltchat:relaunch-app"),
  getSavedSession: () => ipcRenderer.invoke("voltchat:get-saved-session"),
  saveSession: (payload) => ipcRenderer.invoke("voltchat:save-session", payload),
  clearSavedSession: () => ipcRenderer.invoke("voltchat:clear-saved-session"),
  downloadFile: (payload) => ipcRenderer.invoke('voltchat:download-file', payload),
  archiveChatHistory: (payload) => ipcRenderer.invoke('voltchat:archive-chat-history', payload),
  getAppVersion: () => ipcRenderer.invoke('voltchat:get-app-version'),
  getRuntimeInfo: () => ipcRenderer.invoke('voltchat:get-runtime-info'),
  checkForUpdate: () => ipcRenderer.invoke('voltchat:check-desktop-update'),
  installUpdate: (payload) => ipcRenderer.invoke('voltchat:install-update', payload),
  prepareUpdate: (payload) => ipcRenderer.invoke('voltchat:prepare-update', payload),
  installPreparedUpdate: (payload) => ipcRenderer.invoke('voltchat:install-prepared-update', payload),
  onUpdateProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('voltchat:update-progress', listener);
    return () => ipcRenderer.removeListener('voltchat:update-progress', listener);
  },
  showNotification: (payload) => ipcRenderer.invoke('voltchat:show-notification', payload),
  openExternal: (url) => ipcRenderer.invoke('voltchat:open-external', url),
  onNotificationClicked: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('voltchat:notification-clicked', listener);
    return () => ipcRenderer.removeListener('voltchat:notification-clicked', listener);
  },
});
