import { randomUUID } from 'node:crypto';
import { createPersistence } from '../apps/web/src/persistence.mjs';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, DEMO_COMPANY_ID = 'demo-isp' } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DEMO_ADMIN_EMAIL || !DEMO_ADMIN_PASSWORD) throw new Error('Configure SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEMO_ADMIN_EMAIL e DEMO_ADMIN_PASSWORD fora do Git.');
const db = createPersistence();
try {
  const response = await fetch(`${SUPABASE_URL.replace(/\/$/,'')}/auth/v1/admin/users`, {
    method: 'POST', headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'content-type':'application/json' },
    body: JSON.stringify({ email: DEMO_ADMIN_EMAIL, password: DEMO_ADMIN_PASSWORD, email_confirm: true })
  });
  const user = await response.json();
  if (!response.ok) throw new Error(user.message || 'Falha ao criar usuário no Supabase Auth.');
  await db.query('insert into public.profiles(id,company_id,auth_user_id,name,display_name,email,role,status) values($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),DEMO_COMPANY_ID,user.id,'Supervisor Demo','Supervisor Demo',DEMO_ADMIN_EMAIL,'supervisor','available']);
  console.log('Administrador de demonstração cadastrado.');
} finally { await db.close(); }
