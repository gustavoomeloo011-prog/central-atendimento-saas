export function inQueue(item, mode, profileId, now = Date.now()) {
  if (mode === 'closed') {
    const closed = Date.parse(item.closed_at || item.updated_at);
    return item.status === 'closed' && Number.isFinite(closed) && now - closed < 86400000;
  }
  if (mode === 'mine') return item.status !== 'closed' && item.assigned_profile_id === profileId;
  // Includes new and bot-operated conversations, not only those waiting for humans.
  return item.status !== 'closed' && !item.assigned_profile_id;
}
