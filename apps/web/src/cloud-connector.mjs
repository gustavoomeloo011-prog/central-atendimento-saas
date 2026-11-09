import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let child = null;

export function startCloudConnector() {
  if (process.env.BAILEYS_CLOUD_ENABLED !== 'true') return null;
  const required = ['DATABASE_URL', 'BAILEYS_SESSION_ENCRYPTION_KEY', 'WHATSAPP_CONNECTOR_TOKEN', 'WHATSAPP_COMPANY_ID', 'WHATSAPP_USER_ID'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Baileys online não iniciado: variáveis ausentes (${missing.join(', ')}).`);
  if (child) return child;
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const connector = join(root, 'apps', 'connector', 'src', 'experimental.mjs');
  child = spawn(process.execPath, [connector], {
    cwd: root,
    env: { ...process.env, BAILEYS_SQL_STATE: 'true', WHATSAPP_CONNECTOR_PORT: process.env.WHATSAPP_CONNECTOR_PORT || '3200' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => process.stdout.write(`[baileys] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[baileys] ${chunk}`));
  child.on('exit', (code, signal) => {
    child = null;
    console.error(`[baileys] processo encerrado (${code ?? signal ?? 'desconhecido'}).`);
  });
  return child;
}

export function stopCloudConnector() {
  if (!child) return;
  child.kill('SIGTERM');
  child = null;
}
