import { createServer } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { createPairingController } from './pairing.mjs';

const port = Number(process.env.WHATSAPP_CONNECTOR_PORT || 3200);
const sessionDirectory = process.env.WHATSAPP_SESSION_DIR || join(process.cwd(), 'apps', 'connector', 'sessions');
const allowedNumbers = new Set(String(process.env.WHATSAPP_ALLOWED_NUMBERS || '').split(',').map(value => value.replace(/\D/g, '')).filter(Boolean));
const centralApiUrl = String(process.env.CENTRAL_API_URL || 'http://localhost:3100').replace(/\/$/, '');
const connectorToken = String(process.env.WHATSAPP_CONNECTOR_TOKEN || '');
const companyId = String(process.env.WHATSAPP_COMPANY_ID || 'isp');
const state = { status: 'DISCONNECTED', qr: null, phone: null, profileName: null, lastError: null, autoReplyEnabled: false, connectedAt: null, syncStatus: 'idle' };
let socket = null;
let starting = null;
let manualDisconnect = false;
let pairingReadyWaiters = [];
let authRegistered = false;
const pairing = createPairingController();

const json = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': 'http://localhost:3100' }); response.end(JSON.stringify(value)); };
const parse = request => new Promise(resolve => { let raw = ''; request.on('data', chunk => raw += chunk); request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } }); });
const numberFromJid = jid => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '').slice(0, 13);
const publicState = () => { const p=pairing.snapshot(); return { status: p.expired && state.status === 'PAIRING_CODE' ? 'PAIRING_EXPIRED' : state.status, qr: state.qr, phone: state.phone, profileName: state.profileName, lastError: state.lastError, autoReplyEnabled: state.autoReplyEnabled, connectedAt: state.connectedAt, syncStatus: state.syncStatus, allowedCount: allowedNumbers.size, pairing: p }; };

async function connect() {
  await mkdir(sessionDirectory, { recursive: true });
  const auth = await useMultiFileAuthState(sessionDirectory);
  authRegistered = Boolean(auth.state.creds.registered);
  state.status = auth.state.creds.registered ? 'CONNECTING' : 'QR_PENDING';
  state.lastError = null;
  const current = makeWASocket({ auth: auth.state, printQRInTerminal: false, browser: ['Central Experimental', 'Chrome', '1.0.0'] });
  socket = current;
  current.ev.on('creds.update', auth.saveCreds);
  current.ev.on('connection.update', async update => {
    if (socket !== current) return;
    if (update.qr && !pairing.snapshot().code) {
      state.status = 'QR_PENDING';
      state.qr = await QRCode.toDataURL(update.qr, { errorCorrectionLevel: 'M', margin: 2, width: 300 });
      pairingReadyWaiters.splice(0).forEach(resolve => resolve());
    }
    if (update.connection === 'open') {
      pairing.clear(); authRegistered = true;
      state.status = 'CONNECTED';
      state.qr = null;
      state.phone = current.user?.id ? numberFromJid(current.user.id) : null;
      state.profileName = current.user?.name || null;
      state.connectedAt = new Date().toISOString();
      state.syncStatus = 'new_messages_only';
    }
    if (update.connection === 'close') {
      state.qr = null; pairing.clear();
      await auth.saveCreds();
      const code = update.lastDisconnect?.error?.output?.statusCode;
      state.status = manualDisconnect ? 'DISCONNECTED' : code === DisconnectReason.loggedOut ? 'LOGGED_OUT' : 'RECONNECTING';
      state.lastError = String(update.lastDisconnect?.error?.message || 'Conexão encerrada') + ' (code ' + String(code || 'unknown') + ')';
      socket = null;
      if (!manualDisconnect && code !== DisconnectReason.loggedOut) setTimeout(() => { if (!socket && state.status === 'RECONNECTING') ensureConnected().catch(error => { state.status = 'ERROR'; state.lastError = error.message; }); }, 3000);
    }
  });
  current.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const message of messages || []) {
      const jid = message.key?.remoteJid;
      const sender = numberFromJid(jid);
      if (!sender || message.key?.fromMe || jid?.endsWith('@g.us') || jid === 'status@broadcast') continue;
      const body = message.message?.conversation || message.message?.extendedTextMessage?.text || message.message?.imageMessage?.caption || '';
      if (!body || !connectorToken) continue;
      fetch(centralApiUrl + '/api/internal/whatsapp/inbound', { method: 'POST', headers: { 'content-type': 'application/json', 'x-connector-token': connectorToken }, body: JSON.stringify({ company_id: companyId, phone: sender, name: message.pushName || sender, body, message_id: message.key?.id }) }).then(response => response.json()).then(async result => {
        console.log(JSON.stringify({ type: 'authorized_message', sender, messageId: message.key?.id, conversationId: result.conversation_id, queued: result.queued }));
        if (state.autoReplyEnabled && result.reply) {
          const sent = await socket.sendMessage(jid, { text: result.reply });
          await fetch(centralApiUrl + '/api/internal/whatsapp/outbound', { method: 'POST', headers: { 'content-type': 'application/json', 'x-connector-token': connectorToken }, body: JSON.stringify({ company_id: companyId, conversation_id: result.conversation_id, body: result.reply, message_id: sent?.key?.id }) });
        }
      }).catch(error => console.error(JSON.stringify({ type: 'bridge_error', sender, error: error.message })));
    }
  });
}
async function ensureConnected() {
  manualDisconnect = false;
  if (socket) return;
  if (!starting) starting = connect().finally(() => { starting = null; });
  await starting;
}
async function waitForPairingReady() {
  if (state.qr) return;
  await new Promise((resolve,reject) => {
    const ready = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { pairingReadyWaiters = pairingReadyWaiters.filter(waiter => waiter !== ready); reject(new Error('Conector não ficou pronto para pareamento. Tente novamente.')); }, 15_000);
    pairingReadyWaiters.push(ready);
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (!connectorToken || request.headers['x-connector-token'] !== connectorToken) return json(response, 401, { error: 'Acesso ao conector não autorizado.' });
  if (request.method === 'GET' && url.pathname === '/api/whatsapp/status') return json(response, 200, publicState());
  if (request.method === 'POST' && url.pathname === '/api/whatsapp/connect') {
    await ensureConnected();
    return json(response, 200, publicState());
  }
  if (request.method === 'POST' && url.pathname === '/api/whatsapp/pairing-code') {
    const input = await parse(request);
    if (input.company_id !== companyId) return json(response, 403, { error: 'Empresa não autorizada.' });
    if (state.status === 'CONNECTED' || authRegistered) return json(response, 409, { error: 'WhatsApp já autenticado.' });
    try {
      await ensureConnected();
      await waitForPairingReady();
      state.status = 'PAIRING_REQUESTED';
      const result = await pairing.request(socket, input.number, { connected: state.connectedAt && state.status === 'CONNECTED', registered: authRegistered });
      state.qr = null; state.status = 'PAIRING_CODE'; state.lastError = null;
      return json(response, 200, { ...publicState(), pairing: result });
    } catch (error) { state.status = pairing.snapshot().code ? 'PAIRING_CODE' : 'PAIRING_ERROR'; state.lastError = error.message; return json(response, 409, { error: error.message, ...publicState() }); }
  }
  if (request.method === 'POST' && url.pathname === '/api/whatsapp/emergency-stop') {
    state.autoReplyEnabled = false;
    return json(response, 200, publicState());
  }
  if (request.method === 'POST' && url.pathname === '/api/whatsapp/auto-reply') {
    const input = await parse(request);
    state.autoReplyEnabled = Boolean(input.enabled) && state.status === 'CONNECTED';
    return json(response, 200, publicState());
  }
  if (request.method === 'POST' && url.pathname === '/api/whatsapp/authorize') {
    const input = await parse(request);
    const number = String(input.number || '').replace(/\D/g, '');
    if (!number) return json(response, 400, { error: 'Informe um número.' });
    allowedNumbers.add(number);
    return json(response, 200, publicState());
  }
  if (request.method === 'POST' && url.pathname === '/api/whatsapp/send') {
    if (request.headers['x-connector-token'] !== connectorToken) return json(response, 401, { error: 'Conector não autorizado.' });
    const input = await parse(request); const phone = String(input.phone || '').replace(/\D/g, ''); const text = String(input.text || '').trim();
    if (state.status !== 'CONNECTED' || !socket) return json(response, 409, { error: 'WhatsApp desconectado.' });
    if (!phone || !text) return json(response, 400, { error: 'Telefone e texto são obrigatórios.' });
    const jid = phone + '@s.whatsapp.net'; const result = await socket.sendMessage(jid, { text });
    return json(response, 200, { ok: true, messageId: result?.key?.id || null });
  }
  if (request.method === 'POST' && url.pathname === '/api/whatsapp/disconnect') {
    manualDisconnect = true; pairing.clear();
    if (socket) { socket.end(undefined); socket = null; }
    state.status = 'DISCONNECTED'; state.qr = null; state.phone = null; state.profileName = null; state.autoReplyEnabled = false;
    return json(response, 200, publicState());
  }
  if (request.method === 'POST' && url.pathname === '/api/whatsapp/logout-and-delete-session') {
    manualDisconnect = true; pairing.clear();
    if (socket) { socket.logout(); socket = null; }
    await rm(sessionDirectory, { recursive: true, force: true });
    state.status = 'DISCONNECTED'; state.qr = null; state.phone = null; state.profileName = null; state.autoReplyEnabled = false;
    return json(response, 200, publicState());
  }
  json(response, 404, { error: 'Rota não encontrada.' });
});
server.listen(port, '127.0.0.1', () => console.log('WhatsApp experimental em http://127.0.0.1:' + port));
