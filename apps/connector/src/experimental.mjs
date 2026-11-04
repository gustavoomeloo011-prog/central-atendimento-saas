import { createServer } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';

const port = Number(process.env.WHATSAPP_CONNECTOR_PORT || 3200);
const sessionDirectory = process.env.WHATSAPP_SESSION_DIR || join(process.cwd(), 'apps', 'connector', 'sessions');
const allowedNumbers = new Set(String(process.env.WHATSAPP_ALLOWED_NUMBERS || '').split(',').map(value => value.replace(/\D/g, '')).filter(Boolean));
const state = { status: 'disconnected', qr: null, phone: null, lastError: null, autoReplyEnabled: false, connectedAt: null };
let socket = null;

const json = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': 'http://localhost:3100' }); response.end(JSON.stringify(value)); };
const parse = request => new Promise(resolve => { let raw = ''; request.on('data', chunk => raw += chunk); request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } }); });
const numberFromJid = jid => String(jid || '').split('@')[0].replace(/\D/g, '');
const publicState = () => ({ status: state.status, qr: state.qr, phone: state.phone, lastError: state.lastError, autoReplyEnabled: state.autoReplyEnabled, connectedAt: state.connectedAt, allowedCount: allowedNumbers.size });

async function connect() {
  await mkdir(sessionDirectory, { recursive: true });
  const auth = await useMultiFileAuthState(sessionDirectory);
  state.status = auth.state.creds.registered ? 'connecting' : 'waiting_qr';
  state.lastError = null;
  socket = makeWASocket({ auth: auth.state, printQRInTerminal: false, browser: ['Central Experimental', 'Chrome', '1.0.0'] });
  socket.ev.on('creds.update', auth.saveCreds);
  socket.ev.on('connection.update', async update => {
    if (update.qr) {
      state.status = 'waiting_qr';
      state.qr = await QRCode.toDataURL(update.qr, { errorCorrectionLevel: 'M', margin: 2, width: 300 });
    }
    if (update.connection === 'open') {
      state.status = 'connected';
      state.qr = null;
      state.phone = socket.user?.id ? numberFromJid(socket.user.id) : null;
      state.connectedAt = new Date().toISOString();
    }
    if (update.connection === 'close') {
      state.qr = null;
      const code = update.lastDisconnect?.error?.output?.statusCode;
      state.status = code === DisconnectReason.loggedOut ? 'disconnected' : 'reconnecting';
      state.lastError = String(update.lastDisconnect?.error?.message || 'Conexão encerrada');
      socket = null;
    }
  });
  socket.ev.on('messages.upsert', ({ messages }) => {
    for (const message of messages || []) {
      const jid = message.key?.remoteJid;
      const sender = numberFromJid(jid);
      if (!sender || message.key?.fromMe || jid?.endsWith('@g.us') || jid === 'status@broadcast') continue;
      if (!allowedNumbers.has(sender)) continue;
      console.log(JSON.stringify({ type: 'authorized_message', sender, messageId: message.key?.id }));
      // A próxima etapa envia este evento ao motor central autenticado.
      // Nenhuma resposta automática sai enquanto autoReplyEnabled estiver falso.
    }
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'access-control-allow-origin': 'http://localhost:3100', 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'content-type' }); return response.end(); }
  if (request.method === 'GET' && url.pathname === '/api/whatsapp/status') return json(response, 200, publicState());
  if (request.method === 'POST' && url.pathname === '/api/whatsapp/connect') {
    if (!socket) await connect();
    return json(response, 200, publicState());
  }
  if (request.method === 'POST' && url.pathname === '/api/whatsapp/emergency-stop') {
    state.autoReplyEnabled = false;
    return json(response, 200, publicState());
  }
  if (request.method === 'POST' && url.pathname === '/api/whatsapp/auto-reply') {
    const input = await parse(request);
    state.autoReplyEnabled = Boolean(input.enabled) && allowedNumbers.size > 0;
    return json(response, 200, publicState());
  }
  if (request.method === 'POST' && url.pathname === '/api/whatsapp/authorize') {
    const input = await parse(request);
    const number = String(input.number || '').replace(/\D/g, '');
    if (!number) return json(response, 400, { error: 'Informe um número.' });
    allowedNumbers.add(number);
    return json(response, 200, publicState());
  }
  if (request.method === 'POST' && url.pathname === '/api/whatsapp/disconnect') {
    if (socket) { socket.end(undefined); socket = null; }
    state.status = 'disconnected'; state.qr = null; state.phone = null; state.autoReplyEnabled = false;
    return json(response, 200, publicState());
  }
  if (request.method === 'POST' && url.pathname === '/api/whatsapp/logout-and-delete-session') {
    if (socket) { socket.logout(); socket = null; }
    await rm(sessionDirectory, { recursive: true, force: true });
    state.status = 'disconnected'; state.qr = null; state.phone = null; state.autoReplyEnabled = false;
    return json(response, 200, publicState());
  }
  json(response, 404, { error: 'Rota não encontrada.' });
});
server.listen(port, () => console.log('WhatsApp experimental em http://localhost:' + port));
