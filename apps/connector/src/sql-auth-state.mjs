import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import pg from 'pg';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';

const { Pool } = pg;
const keyText = process.env.BAILEYS_SESSION_ENCRYPTION_KEY || '';
if (!/^[a-f0-9]{64}$/i.test(keyText)) throw new Error('BAILEYS_SESSION_ENCRYPTION_KEY deve conter 32 bytes em hexadecimal.');
const key = Buffer.from(keyText, 'hex');
const companyId = String(process.env.WHATSAPP_COMPANY_ID || '');
const connectorNameBase = String(process.env.WHATSAPP_CONNECTOR_NAME || 'baileys-cloud');
const userId = String(process.env.WHATSAPP_USER_ID || '');
// Scope every lease and row to the authenticated user. This also keeps the
// legacy unique(company_id, connector_name) constraint from aliasing users.
const connectorName = userId ? `${connectorNameBase}:${userId}` : connectorNameBase;
const sessionName = String(process.env.WHATSAPP_SESSION_ID || connectorName);
const owner = `${process.pid}-${randomBytes(8).toString('hex')}`;

function seal(value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value, BufferJSON.replacer))), cipher.final()]);
  return { data, nonce, tag: cipher.getAuthTag() };
}
function open(data, nonce, tag) {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString(), BufferJSON.reviver);
}

export async function createSqlAuthState(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL é obrigatória para o estado Baileys.');
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: true } });
  if (!userId) throw new Error('WHATSAPP_USER_ID é obrigatório para uma sessão Baileys individual.');
  const sessionId = `${companyId}:${userId}:${sessionName}`;
  const query = (sql, values=[]) => pool.query(sql, values);
  async function read() {
    const { rows } = await query('select auth_state,auth_state_nonce,auth_state_tag from public.connector_sessions where company_id=$1 and user_id=$2 and session_id=$3', [companyId, userId, sessionName]);
    const row = rows[0];
    return row?.auth_state ? open(row.auth_state, row.auth_state_nonce, row.auth_state_tag) : { creds: initAuthCreds(), keys: {} };
  }
  async function write(value) {
    const sealed = seal(value);
    await query(`insert into public.connector_sessions(id,company_id,connector_name,user_id,session_id,status,auth_state,auth_state_nonce,auth_state_tag,last_seen_at)
      values($1,$2,$3,$4,$5,'CONNECTING',$6,$7,$8,$9,now())
      on conflict(company_id,connector_name) do update set user_id=excluded.user_id,session_id=excluded.session_id,auth_state=excluded.auth_state,auth_state_nonce=excluded.auth_state_nonce,auth_state_tag=excluded.auth_state_tag,last_seen_at=now()`,
      [sessionId, companyId, connectorName, userId, sessionName, sealed.data, sealed.nonce, sealed.tag]);
  }
  async function acquireLease() {
    const { rows } = await query('select public.acquire_connector_lease($1,$2,$3,60) acquired', [companyId, connectorName, owner]);
    if (!rows[0]?.acquired) throw new Error('Outra instância já possui a sessão Baileys.');
  }
  const loaded = await read();
  const state = { creds: loaded.creds || initAuthCreds(), keys: loaded.keys || {} };
  const save = () => write(state);
  const renewTimer = setInterval(() => query('select public.renew_connector_lease($1,$2,$3,60)', [companyId, connectorName, owner]).catch(()=>{}), 30_000);
  renewTimer.unref?.();
  async function close() { clearInterval(renewTimer); await query('select public.release_connector_lease($1,$2,$3)', [companyId, connectorName, owner]).catch(()=>{}); await pool.end(); }
  return {
    state,
    saveCreds: async next => { state.creds = next; await save(); },
    keys: {
      get: async (type, ids) => Object.fromEntries(ids.map(id => [id, state.keys[`${type}-${id}`]]).filter(([, value]) => value !== undefined)),
      set: async data => { for (const [type, values] of Object.entries(data)) for (const [id, value] of Object.entries(values)) { const key = `${type}-${id}`; if (value === null) delete state.keys[key]; else state.keys[key] = value; } await save(); },
    },
    acquireLease,
    close,
  };
}
