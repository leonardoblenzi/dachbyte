"use strict";

async function identifyVisibleOrders({accountId, codes, eligible, reconcile}) {
  const visible = [...new Set(codes.map(code => String(code).trim()).filter(Boolean))].slice(0, 20);
  const owned = await eligible(accountId, visible);
  const rows = new Array(owned.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(3, owned.length)}, async () => {
    for (;;) {
      const index = next++;
      if (index >= owned.length) return;
      try {
        rows[index] = await reconcile(accountId, owned[index]);
      } catch (_) {
        rows[index] = {code: owned[index], state: "failed"};
      }
    }
  }));
  return rows;
}

module.exports = {identifyVisibleOrders};
