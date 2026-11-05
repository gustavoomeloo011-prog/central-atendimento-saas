export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_INTERVAL_MS = 60_000;
export const PAIRING_MAX_ATTEMPTS = 5;

export function normalizePairingNumber(value) {
  const raw = String(value || '').trim();
  if (!/^\+?[\d\s().-]+$/.test(raw)) throw new Error('Informe o número com DDI e DDD.');
  const digits = raw.replace(/\D/g, '');
  if (!/^[1-9]\d{9,14}$/.test(digits)) throw new Error('Número inválido. Informe DDI, DDD e número sem dígitos extras.');
  return digits;
}

export function createPairingController({ now = Date.now, intervalMs = PAIRING_INTERVAL_MS, ttlMs = PAIRING_TTL_MS, maxAttempts = PAIRING_MAX_ATTEMPTS } = {}) {
  let code = null, expiresAt = 0, lastAttemptAt = 0, attempts = 0, pending = false, hadCode = false;
  const clear = () => { code = null; expiresAt = 0; hadCode = false; };
  const snapshot = () => {
    if (code && now() >= expiresAt) { code = null; }
    return { code, expiresAt: code ? new Date(expiresAt).toISOString() : null, pending, expired: hadCode && !code };
  };
  async function request(socket, value, { connected = false, registered = false } = {}) {
    if (connected || registered) throw new Error('WhatsApp já autenticado. Não é necessário gerar código.');
    if (!socket?.requestPairingCode) throw new Error('Conector não está pronto para pareamento.');
    if (pending) throw new Error('Uma solicitação de código já está em andamento.');
    const phone = normalizePairingNumber(value);
    const current = now();
    if (attempts >= maxAttempts) throw new Error('Limite de tentativas atingido. Reinicie o conector mais tarde.');
    if (lastAttemptAt && current - lastAttemptAt < intervalMs) throw new Error('Aguarde antes de solicitar outro código.');
    pending = true; lastAttemptAt = current; attempts++; clear();
    try {
      const result = await socket.requestPairingCode(phone);
      if (typeof result !== 'string' || !/^[A-Z0-9]{8}$/i.test(result.replace(/[-\s]/g, ''))) throw new Error('O WhatsApp não retornou um código válido.');
      code = result.replace(/[-\s]/g, '').toUpperCase(); expiresAt = now() + ttlMs; hadCode = true;
      return { code, expiresAt: new Date(expiresAt).toISOString() };
    } finally { pending = false; }
  }
  return { request, snapshot, clear, get attempts() { return attempts; } };
}
