export function inQueue(item, mode, profileId, now = Date.now()) {
  if (mode === 'closed') {
    const closed = Date.parse(item.closed_at || item.updated_at);
    return item.status === 'closed' && Number.isFinite(closed) && now - closed < 86400000;
  }
  if (mode === 'mine') return item.status !== 'closed' && item.assigned_profile_id === profileId;
  if (mode === 'human') return item.status === 'waiting' && item.human_started_at && !item.assigned_profile_id;
  return item.status !== 'closed' && !item.assigned_profile_id && !item.human_started_at;
}
