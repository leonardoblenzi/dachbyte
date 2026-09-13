"use strict";

const archiveMessageId = (message = {}) => (
  message.archive_uid || `${message.company_id}:${message.id}:${message.timestamp || ""}`
);

const messageTimestamp = (message) => {
  const value = new Date(message?.timestamp || message?.created_at || 0).getTime();
  return Number.isFinite(value) ? value : 0;
};

function mergeArchiveMessages(current = [], changes = [], limit = 50_000) {
  const merged = new Map();
  for (const message of [...current, ...changes]) {
    if (!message || !message.id || !message.company_id) continue;
    const stableId = archiveMessageId(message);
    merged.set(stableId, { ...message, local_archive_uid: stableId });
  }
  return [...merged.values()]
    .sort((left, right) => messageTimestamp(left) - messageTimestamp(right))
    .slice(-Math.max(1, Number(limit) || 50_000));
}

function shouldCompactArchiveJournal(messageCount, limit = 250) {
  return Number(messageCount) >= Math.max(1, Number(limit) || 250);
}

module.exports = { archiveMessageId, mergeArchiveMessages, shouldCompactArchiveJournal };
