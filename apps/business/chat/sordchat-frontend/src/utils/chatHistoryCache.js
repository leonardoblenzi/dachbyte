const DB_NAME = 'voltchat-local-history';
const STORE_NAME = 'histories';

const openDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const withStore = async (mode, action) => {
  if (!('indexedDB' in window)) return null;
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const historyKey = (userId) => `user:${userId}`;
const historyResetKey = (userId, companyId) => `reset:${userId}:${companyId}`;

export const loadLocalChatHistory = async (userId) => {
  if (!userId) return [];
  try {
    const record = await withStore('readonly', (store) => store.get(historyKey(userId)));
    return record?.messages || [];
  } catch {
    return [];
  }
};

export const saveLocalChatHistory = async (userId, messages) => {
  if (!userId) return;
  try {
    await withStore('readwrite', (store) => store.put({
      key: historyKey(userId),
      messages,
      savedAt: new Date().toISOString(),
    }));
  } catch {
    // O chat continua funcionando caso o navegador não permita armazenamento local.
  }
};

export const removeLocalChatMessage = async (userId, messageId) => {
  const current = await loadLocalChatHistory(userId);
  await saveLocalChatHistory(userId, current.filter((message) => String(message.id) !== String(messageId)));
};

export const clearLocalChatHistory = async (userId, receiverId = null) => {
  const current = await loadLocalChatHistory(userId);
  const next = current.filter((message) => {
    if (receiverId) {
      return !(
        (String(message.sender_id) === String(userId) && String(message.receiver_id) === String(receiverId))
        || (String(message.sender_id) === String(receiverId) && String(message.receiver_id) === String(userId))
      );
    }
    return message.receiver_id !== null && message.receiver_id !== undefined;
  });
  await saveLocalChatHistory(userId, next);
};
export const applyLocalChatHistoryReset = async (userId, companyId, resetAt) => {
  if (!userId || !companyId || !resetAt) return false;
  const incomingReset = new Date(resetAt).getTime();
  if (!Number.isFinite(incomingReset)) return false;
  try {
    const currentReset = await withStore('readonly', (store) => store.get(historyResetKey(userId, companyId)));
    const appliedReset = new Date(currentReset?.resetAt || 0).getTime();
    if (Number.isFinite(appliedReset) && appliedReset >= incomingReset) return false;
    const currentHistory = await loadLocalChatHistory(userId);
    const remainingHistory = currentHistory.filter((message) => (
      message.company_id && String(message.company_id) !== String(companyId)
    ));
    await saveLocalChatHistory(userId, remainingHistory);
    await withStore('readwrite', (store) => store.put({
      key: historyResetKey(userId, companyId),
      resetAt,
    }));
    return true;
  } catch {
    return false;
  }
};
