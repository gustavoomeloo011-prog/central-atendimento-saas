import { randomUUID } from 'node:crypto';

const connectors = new Map();
const pending = new Map();

const entryFor = companyId => {
  if (!connectors.has(companyId)) connectors.set(companyId, { state: null, lastSeen: 0, commands: [] });
  return connectors.get(companyId);
};

export function connectorSnapshot(companyId) {
  const entry = entryFor(companyId);
  const online = Date.now() - entry.lastSeen < 10_000;
  return { ...(entry.state || { status: 'DISCONNECTED' }), connectorOnline: online, bridge: online ? 'ONLINE' : 'OFFLINE' };
}

export function syncConnector(companyId, input = {}) {
  const entry = entryFor(companyId);
  entry.state = input.state || entry.state;
  entry.lastSeen = Date.now();
  for (const result of input.results || []) {
    const waiter = pending.get(result.id);
    if (!waiter) continue;
    pending.delete(result.id);
    clearTimeout(waiter.timer);
    result.ok ? waiter.resolve(result.body || {}) : waiter.reject(Object.assign(new Error(result.body?.error || 'Falha no conector local.'), { status: result.status || 502 }));
  }
  return { ok: true, commands: entry.commands.splice(0, 20) };
}

export function dispatchConnector(companyId, action, method = 'POST', data = {}, timeoutMs = 25_000) {
  const entry = entryFor(companyId);
  if (Date.now() - entry.lastSeen >= 10_000) return Promise.reject(Object.assign(new Error('Conector do Windows está offline. Mantenha o computador e o conector ligados.'), { status: 503 }));
  const id = randomUUID();
  entry.commands.push({ id, action, method, data });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('O conector não respondeu dentro do prazo.'), { status: 504 })); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });
}
