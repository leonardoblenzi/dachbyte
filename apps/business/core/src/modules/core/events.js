function emitEvent(store, type, payload = {}, context = {}) {
  const event = {
    id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    type,
    payload,
    actorUserId: context.actorUserId || null,
    createdAt: new Date().toISOString(),
  };
  store.events.push(event);
  return event;
}

function listEvents(store) {
  return store.events;
}

module.exports = {
  emitEvent,
  listEvents,
};
