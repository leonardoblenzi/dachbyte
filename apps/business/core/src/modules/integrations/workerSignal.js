"use strict";

const listeners = new Set();

function onIntegrationQueueWake(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyIntegrationQueue() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (_error) {
      // Queue notifications are a best-effort latency optimization. Polling remains the fallback.
    }
  }
}

module.exports = { notifyIntegrationQueue, onIntegrationQueueWake };
