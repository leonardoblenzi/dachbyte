export function positionMenu(trigger, menu, viewport) {
  const margin = 8;
  const left = Math.max(margin, Math.min(trigger.right - menu.width, viewport.width - menu.width - margin));
  const below = trigger.bottom + margin;
  const above = trigger.top - menu.height - margin;
  const top = below + menu.height <= viewport.height - margin
    ? below
    : above >= margin ? above : Math.max(margin, viewport.height - menu.height - margin);
  return { left, top };
}
