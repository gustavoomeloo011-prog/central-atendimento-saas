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
  console.log(JSON.stringify({ type: 'baileys_cloud_start', sqlState: process.env.BAILEYS_SQL_STATE === 'true', encryptionKeyConfigured: Boolean(process.env.BAILEYS_SESSION_ENCRYPTION_KEY), connectorTokenConfigured: Boolean(process.env.WHATSAPP_CONNECTOR_TOKEN), companyConfigured: Boolean(process.env.WHATSAPP_COMPANY_ID), userConfigured: Boolean(process.env.WHATSAPP_USER_ID) }));
  child = spawn(process.execPath, [connector], {
    cwd: root,
    env: { ...process.env, BAILEYS_SQL_STATE: 'true', WHATSAPP_CONNECTOR_PORT: process.env.WHATSAPP_CONNECTOR_PORT || '3200', CENTRAL_API_URL: `http://127.0.0.1:${Number(process.env.PORT || 3100)}` },
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
