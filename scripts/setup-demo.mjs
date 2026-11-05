import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createPersistence } from '../apps/web/src/persistence.mjs';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const email = 'gustavo@demo.local';
const password = process.env.DEMO_AUTH_PASSWORD;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !password) throw new Error('Configure as variáveis do Supabase e DEMO_AUTH_PASSWORD no .env.');

const auth = async (path, method = 'GET', payload) => {
  const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json'
    },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || result.msg || result.error || `Supabase Auth retornou ${response.status}.`);
  return result;
};

const db = createPersistence();
try {
  const seed = await readFile(new URL('../packages/database/seeds/demo.sql', import.meta.url), 'utf8');
  await db.query(seed);

  const list = await auth(`admin/users?page=1&per_page=1000`);
  let user = list.users?.find(item => item.email?.toLowerCase() === email);
  if (user) user = await auth(`admin/users/${user.id}`, 'PUT', { password, email_confirm: true });
  else user = await auth('admin/users', 'POST', { email, password, email_confirm: true });

  await db.query(
    `insert into public.profiles(id,company_id,auth_user_id,name,display_name,email,role,status)
     values($1,'demo-isp',$2,'Gustavo','Gustavo',$3,'supervisor','available')
     on conflict(auth_user_id) do update set name='Gustavo',display_name='Gustavo',role='supervisor',status='available'`,
    [randomUUID(), user.id, email]
  );
  console.log('Ambiente de demonstração pronto: Gustavo.');
} finally {
  await db.close();
}
