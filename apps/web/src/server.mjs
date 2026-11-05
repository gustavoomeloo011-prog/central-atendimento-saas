import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { proxyWhatsApp } from './whatsapp-proxy.mjs';
import { syncConnector } from './connector-bridge.mjs';
import { validateFlow, newFlow, advanceFlow } from '../public/flow.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const databasePath = process.env.DATABASE_PATH || join(process.cwd(), 'data', 'central-atendimento.db');
await mkdir(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec('pragma foreign_keys=on;' +
  'create table if not exists companies(id text primary key,name text not null,kind text not null);' +
  'create table if not exists profiles(id text primary key,company_id text not null,name text not null,email text unique not null,role text not null,password text not null,status text not null);' +
  'create table if not exists departments(id text primary key,company_id text not null,name text not null);' +
  'create table if not exists conversations(id text primary key,company_id text not null,department_id text not null,assigned_profile_id text,contact_name text not null,contact_phone text not null,subject text not null,status text not null,priority text not null,created_at text not null,updated_at text not null);' +
  'create table if not exists messages(id text primary key,company_id text not null,conversation_id text not null,profile_id text,body text not null,direction text not null,created_at text not null);' +
  'create table if not exists audit_events(id text primary key,company_id text not null,profile_id text,action text not null,entity_type text not null,entity_id text not null,created_at text not null);');
const columns = db.prepare('pragma table_info(conversations)').all().map(column => column.name);
if (!columns.includes('queue_type')) db.exec("alter table conversations add column queue_type text not null default 'support'");
if (!columns.includes('bot_attempts')) db.exec("alter table conversations add column bot_attempts integer not null default 0");
db.exec('create table if not exists automation_settings(company_id text primary key,welcome_message text not null,fallback_message text not null,max_attempts integer not null);' +
  'create table if not exists quick_replies(id text primary key,company_id text not null,shortcut text not null,body text not null,department_id text);' +
  'create table if not exists automation_flows(id text primary key,company_id text not null,name text not null,status text not null default \'draft\',published_version integer,created_at text not null,updated_at text not null);' +
  'create table if not exists automation_flow_versions(id text primary key,flow_id text not null,version integer not null,status text not null,definition text not null,created_at text not null,published_at text);');
db.exec('create table if not exists flow_runs(conversation_id text primary key,company_id text not null,flow_id text not null,version_id text not null,node_id text,steps integer not null default 0,variables text not null default \'{}\',status text not null);' +
  'create table if not exists flow_events(company_id text not null,provider_message_id text not null,conversation_id text not null,primary key(company_id,provider_message_id));');
if (!db.prepare('select count(*) total from companies').get().total) {
  const now = new Date().toISOString();
  const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
  db.exec(
    "insert into companies values('isp','Conecta Demo','isp'),('store','Casa & Cia Demo','general');" +
    "insert into profiles values('ana','isp','Ana Supervisora','ana@conecta.demo','supervisor','demo','available'),('joao','isp','João Atendimento','joao@conecta.demo','agent','demo','available'),('bia','store','Bia Loja','bia@casa.demo','company_admin','demo','available');" +
    "insert into departments values('support','isp','Suporte Técnico'),('billing','isp','Financeiro'),('sales','store','Vendas');" +
    "insert into conversations(id,company_id,department_id,assigned_profile_id,contact_name,contact_phone,subject,status,priority,created_at,updated_at,queue_type,bot_attempts) values('c1','isp','support',null,'Mariana Souza','11987654321','Sem conexão','waiting','high'," + quote(now) + "," + quote(now) + ",'support',0),('c2','isp','billing','joao','Carlos Lima','11999112233','Segunda via','open','normal'," + quote(now) + "," + quote(now) + ",'billing',0),('c3','store','sales','bia','Renata Alves','11980001122','Quero conhecer os produtos','open','normal'," + quote(now) + "," + quote(now) + ",'sales',0);" +
    "insert into messages values('m1','isp','c1',null,'Olá. Estou sem internet desde esta manhã.','inbound'," + quote(now) + "),('m2','isp','c2',null,'Olá, preciso da segunda via da fatura.','inbound'," + quote(now) + "),('m3','isp','c2','joao','Vou encaminhar sua solicitação ao financeiro.','outbound'," + quote(now) + "),('m4','store','c3',null,'Olá, vocês entregam na região central?','inbound'," + quote(now) + ");"
  );
  db.exec("insert into automation_settings values('isp','Olá. Sou o assistente virtual da Conecta. Como posso ajudar?','Não consegui resolver por aqui. Vou encaminhar você para a fila adequada.',2),('store','Olá. Como posso ajudar?','Vou encaminhar você para nossa equipe.',2);" +
    "insert into quick_replies values('qr1','isp','/sem_sinal','Vou verificar as informações disponíveis sobre sua conexão.','support'),('qr2','isp','/financeiro','Vou encaminhar sua solicitação ao financeiro.','billing'),('qr3','store','/entrega','Vou verificar a disponibilidade de entrega na sua região.','sales');");
}
if (!db.prepare('select count(*) total from automation_settings').get().total) {
  db.exec("insert into automation_settings values('isp','Olá. Sou o assistente virtual da Conecta. Como posso ajudar?','Não consegui resolver por aqui. Vou encaminhar você para a fila adequada.',2),('store','Olá. Como posso ajudar?','Vou encaminhar você para nossa equipe.',2);" +
    "insert into quick_replies values('qr1','isp','/sem_sinal','Vou verificar as informações disponíveis sobre sua conexão.','support'),('qr2','isp','/financeiro','Vou encaminhar sua solicitação ao financeiro.','billing'),('qr3','store','/entrega','Vou verificar a disponibilidade de entrega na sua região.','sales');");
}

// Extensões compatíveis: nunca removem dados existentes.
const profileColumns = db.prepare('pragma table_info(profiles)').all().map(column => column.name);
if (!profileColumns.includes('display_name')) db.exec("alter table profiles add column display_name text");
if (!profileColumns.includes('avatar_url')) db.exec("alter table profiles add column avatar_url text");
if (!profileColumns.includes('phone')) db.exec("alter table profiles add column phone text");
if (!profileColumns.includes('department_id')) db.exec("alter table profiles add column department_id text");
if (!profileColumns.includes('created_at')) db.exec("alter table profiles add column created_at text");
if (!profileColumns.includes('last_seen_at')) db.exec("alter table profiles add column last_seen_at text");
const conversationColumns = db.prepare('pragma table_info(conversations)').all().map(column => column.name);
if (!conversationColumns.includes('protocol')) db.exec("alter table conversations add column protocol text");
if (!conversationColumns.includes('closed_at')) db.exec("alter table conversations add column closed_at text");
if (!conversationColumns.includes('human_started_at')) db.exec("alter table conversations add column human_started_at text");
db.prepare('insert or ignore into profiles(id,company_id,name,email,role,password,status) values(?,?,?,?,?,?,?)').run('gustavo-demo','isp','Gustavo','gustavo@conecta.demo','supervisor','demo','available');
db.exec('create unique index if not exists idx_conversations_protocol on conversations(protocol);' +
  'create table if not exists internal_notes(id text primary key,company_id text not null,conversation_id text not null,profile_id text,body text not null,created_at text not null);' +
  'create table if not exists conversation_ratings(id text primary key,company_id text not null,conversation_id text not null,protocol text,stars integer not null,comment text,created_at text not null);');
const protocolFor = (companyId, id) => { const existing = db.prepare('select protocol from conversations where id=? and company_id=?').get(id, companyId)?.protocol; if (existing) return existing; const day = new Date().toISOString().slice(0,10).replaceAll('-', ''); const rows = db.prepare('select protocol from conversations where protocol like ?').all(day + '-%'); const next = rows.reduce((max, row) => Math.max(max, Number(row.protocol.slice(9)) || 0), 0) + 1; const protocol = day + '-' + String(next).padStart(6, '0'); db.prepare('update conversations set protocol=? where id=? and company_id=?').run(protocol, id, companyId); return protocol; };
for (const row of db.prepare('select id,company_id from conversations where protocol is null').all()) protocolFor(row.company_id, row.id);

const sessions = new Map();
const respond = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
const parseBody = request => new Promise((resolve, reject) => { let raw = ''; request.on('data', part => raw += part); request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON inválido')); } }); });
const getSession = request => sessions.get((request.headers.authorization || '').replace('Bearer ', ''));
const getConversation = (session, id) => db.prepare('select * from conversations where id=? and company_id=?').get(id, session.profile.company_id);
const event = (session, action, id) => db.prepare('insert into audit_events values(?,?,?,?,?,?,?)').run(randomUUID(), session.profile.company_id, session.profile.id, action, 'conversation', id, new Date().toISOString());
const connectorToken = process.env.WHATSAPP_CONNECTOR_TOKEN || '';
const connectorTokenHash = process.env.WHATSAPP_CONNECTOR_TOKEN_SHA256 || 'ba1d61baf0ccebe68c4f94d00479f1f2802fe08b4aa0a93dde90bf8ecd9dda15';
const validBridgeToken = request => {
  const supplied = String(request.headers['x-connector-token'] || '');
  if (connectorToken) return supplied.length === connectorToken.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(connectorToken));
  const digest = createHash('sha256').update(supplied).digest('hex');
  return digest.length === connectorTokenHash.length && timingSafeEqual(Buffer.from(digest), Buffer.from(connectorTokenHash));
};
function runPublishedFlow(companyId, conversation, input) {
  if (conversation.assigned_profile_id) return null;
  let run = db.prepare('select * from flow_runs where company_id=? and conversation_id=?').get(companyId,conversation.id);
  if (run && run.status !== 'active') return null;
  if (!run) {
    const version=db.prepare("select f.id flow_id,v.id version_id from automation_flows f join automation_flow_versions v on v.flow_id=f.id and v.version=f.published_version where f.company_id=? and f.status='published' order by f.updated_at desc limit 1").get(companyId);
    if (!version) return null;
    db.prepare('insert into flow_runs(conversation_id,company_id,flow_id,version_id,status) values(?,?,?,?,?)').run(conversation.id,companyId,version.flow_id,version.version_id,'active');
    run=db.prepare('select * from flow_runs where conversation_id=?').get(conversation.id);
  }
  const version=db.prepare('select definition from automation_flow_versions where id=? and flow_id=?').get(run.version_id,run.flow_id);
  if (!version) return null;
  const graph=JSON.parse(version.definition);
  const result=advanceFlow(graph,{nodeId:run.node_id,steps:run.steps,variables:JSON.parse(run.variables)},run.node_id?input:null);
  db.prepare('update flow_runs set node_id=?,steps=?,variables=?,status=? where conversation_id=?').run(result.nodeId,result.steps,JSON.stringify(result.variables),result.finished?'finished':'active',conversation.id);
  if (result.transfer) db.prepare("update conversations set department_id=?,assigned_profile_id=?,status='waiting',updated_at=? where id=? and company_id=?").run(result.transfer.departmentId,result.transfer.profileId,new Date().toISOString(),conversation.id,companyId);
  const reply=result.output.filter(item=>item.type==='message').map(item=>item.text+(item.options?.length?'\n'+item.options.map((option,index)=>`${index+1}. ${option.label}`).join('\n'):'' )).join('\n\n');
  return {reply:reply||null,queued:Boolean(result.transfer),result};
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'POST' && url.pathname === '/api/internal/connector/sync') {
    if (!validBridgeToken(request)) return respond(response, 401, { error: 'Conector não autorizado.' });
    const input = await parseBody(request), company = String(input.company_id || '');
    if (!company || company !== (process.env.WHATSAPP_COMPANY_ID || 'isp')) return respond(response, 403,{ error:'Empresa não autorizada.' });
    return respond(response, 200, syncConnector(company, input));
  }
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return response.end(await readFile(join(publicDir, 'index.html')));
  }
  if (request.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const file = join(publicDir, url.pathname.slice(8));
    if (!existsSync(file)) return respond(response, 404, { error: 'Arquivo não encontrado.' });
    response.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'application/javascript' });
    return response.end(await readFile(file));
  }
  if (request.method === 'POST' && url.pathname === '/api/login') {
    const input = await parseBody(request);
    const login = String(input.email || '').trim().toLowerCase();
    const profile = db.prepare('select * from profiles where (lower(email)=? or lower(name)=?) and password=?').get(login, login, input.password);
    if (!profile) return respond(response, 401, { error: 'Credenciais de demonstração inválidas.' });
    const token = randomUUID();
    sessions.set(token, { profile });
    return respond(response, 200, { token, profile: { name: profile.name, role: profile.role } });
  }
  if (request.method === 'POST' && url.pathname === '/api/internal/whatsapp/inbound') {
    if (!connectorToken || request.headers['x-connector-token'] !== connectorToken) return respond(response, 401, { error: 'Conector não autorizado.' });
    const input = await parseBody(request);
    const companyId = String(input.company_id || process.env.WHATSAPP_COMPANY_ID || 'isp');
    const phone = String(input.phone || '').replace(/\D/g, '');
    const body = String(input.body || '').trim();
    if (!phone || !body) return respond(response, 400, { error: 'Telefone e mensagem são obrigatórios.' });
    const providerId=String(input.provider_message_id||input.message_id||'').trim();
    if(providerId){const prior=db.prepare('select conversation_id from flow_events where company_id=? and provider_message_id=?').get(companyId,providerId);if(prior)return respond(response,200,{ok:true,conversation_id:prior.conversation_id,duplicate:true,reply:null});}
    const now = new Date().toISOString();
    let conversation = db.prepare("select * from conversations where company_id=? and contact_phone=? and status!='closed' order by updated_at desc limit 1").get(companyId, phone);
    if (!conversation) {
      const department = db.prepare('select id from departments where company_id=? order by id limit 1').get(companyId);
      if (!department) return respond(response, 409, { error: 'A empresa não possui fila configurada.' });
      const id = 'wa-' + randomUUID();
      db.prepare('insert into conversations(id,company_id,department_id,assigned_profile_id,contact_name,contact_phone,subject,status,priority,created_at,updated_at,queue_type,bot_attempts) values(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, companyId, department.id, null, input.name || phone, phone, 'WhatsApp', 'waiting', 'normal', now, now, department.id, 0);
      conversation = db.prepare('select * from conversations where id=?').get(id);
    }
    if(providerId)db.prepare('insert into flow_events values(?,?,?)').run(companyId,providerId,conversation.id);
    const protocol = protocolFor(companyId, conversation.id);
    const settings = db.prepare('select * from automation_settings where company_id=?').get(companyId);
    const inboundCount = db.prepare("select count(*) total from messages where conversation_id=? and direction='inbound'").get(conversation.id).total + 1;
    db.prepare('insert into messages values(?,?,?,?,?,?,?)').run(randomUUID(), companyId, conversation.id, null, body, 'inbound', now);
    const graphReply=runPublishedFlow(companyId,conversation,body);
    if(graphReply)return respond(response,201,{ok:true,conversation_id:conversation.id,protocol,reply:graphReply.reply,queued:graphReply.queued});
    if(conversation.assigned_profile_id || db.prepare('select status from flow_runs where conversation_id=?').get(conversation.id)) return respond(response,201,{ok:true,conversation_id:conversation.id,protocol,reply:null,queued:false});
    const financial = /financeiro|fatura|segunda via|boleto/i.test(body);
    const reachedLimit = settings && inboundCount >= settings.max_attempts;
    let reply = null;
    if (settings && (financial || reachedLimit)) {
      const target = financial ? db.prepare("select id from departments where company_id=? and lower(name) like '%financeiro%' limit 1").get(companyId) : null;
      db.prepare('update conversations set department_id=?,status=?,bot_attempts=?,updated_at=? where id=?').run(target?.id || conversation.department_id, 'waiting', inboundCount, now, conversation.id);
      reply = settings.fallback_message;
    } else if (settings) {
      db.prepare('update conversations set status=?,bot_attempts=?,updated_at=? where id=?').run('open', inboundCount, now, conversation.id);
      reply = settings.welcome_message;
    }
    return respond(response, 201, { ok: true, conversation_id: conversation.id, protocol, reply, queued: Boolean(financial || reachedLimit) });
  }
  if (request.method === 'POST' && url.pathname === '/api/internal/whatsapp/outbound') {
    if (!connectorToken || request.headers['x-connector-token'] !== connectorToken) return respond(response, 401, { error: 'Conector não autorizado.' });
    const input = await parseBody(request); const companyId = String(input.company_id || process.env.WHATSAPP_COMPANY_ID || 'isp'); const conversationId = String(input.conversation_id || ''); const body = String(input.body || '').trim();
    if (!conversationId || !body) return respond(response, 400, { error: 'Conversa e mensagem são obrigatórias.' });
    const now = new Date().toISOString(); const messageId = randomUUID();
    db.prepare('insert into messages values(?,?,?,?,?,?,?)').run(messageId, companyId, conversationId, null, body, 'outbound', now);
    db.prepare('update conversations set updated_at=? where id=? and company_id=?').run(now, conversationId, companyId);
    return respond(response, 201, { ok: true, message_id: messageId, delivery: 'sent' });
  }
  const session = getSession(request);
  if (!session) return respond(response, 401, { error: 'Sessão expirada.' });
  const companyId = session.profile.company_id;
  if (url.pathname.startsWith('/api/whatsapp/')) return ['supervisor','company_admin','superadmin'].includes(session.profile.role) ? proxyWhatsApp(request,response,companyId) : respond(response,403,{error:'Somente supervisores podem gerenciar a conexão.'});
  const pieces = url.pathname.split('/').filter(Boolean);
  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    const conversations = db.prepare('select c.*,d.name department_name,p.name assignee_name,(select body from messages m where m.conversation_id=c.id order by created_at desc limit 1) last_message from conversations c join departments d on d.id=c.department_id left join profiles p on p.id=c.assigned_profile_id where c.company_id=? order by case c.status when \'waiting\' then 0 else 1 end,c.updated_at desc').all(companyId);
    return respond(response, 200, { profile: session.profile, company: db.prepare('select * from companies where id=?').get(companyId), conversations, departments: db.prepare('select * from departments where company_id=?').all(companyId), quickReplies: db.prepare('select * from quick_replies where company_id=? order by shortcut').all(companyId) });
  }
  if (request.method === 'GET' && url.pathname === '/api/settings') {
    const profiles = db.prepare('select id,name,email,role,status from profiles where company_id=? order by name').all(companyId);
    const departments = db.prepare('select * from departments where company_id=? order by name').all(companyId);
    const settings = db.prepare('select * from automation_settings where company_id=?').get(companyId);
    const replies = db.prepare('select * from quick_replies where company_id=? order by shortcut').all(companyId);
    return respond(response, 200, { profiles, departments, settings, replies });
  }
  const canManage = ['supervisor', 'company_admin', 'superadmin'].includes(session.profile.role);
  if (request.method === 'POST' && url.pathname === '/api/agents') {
    if (!canManage) return respond(response, 403, { error: 'Somente supervisor ou administrador pode cadastrar atendentes.' });
    const input = await parseBody(request);
    const name = String(input.name || '').trim();
    const email = String(input.email || '').trim().toLowerCase();
    const password = String(input.password || '');
    const role = ['agent', 'supervisor'].includes(input.role) ? input.role : 'agent';
    if (!name || !email.includes('@') || password.length < 4) return respond(response, 400, { error: 'Informe nome, e-mail válido e senha com ao menos 4 caracteres.' });
    try {
      db.prepare('insert into profiles values(?,?,?,?,?,?,?)').run(randomUUID(), companyId, name, email, role, password, 'available');
    } catch {
      return respond(response, 409, { error: 'Já existe um usuário com este e-mail.' });
    }
    event(session, 'agent_created', 'profile');
    return respond(response, 201, { ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/api/queues') {
    if (!canManage) return respond(response, 403, { error: 'Somente supervisor ou administrador pode criar filas.' });
    const input = await parseBody(request);
    const name = String(input.name || '').trim();
    if (!name) return respond(response, 400, { error: 'Informe o nome da fila.' });
    db.prepare('insert into departments values(?,?,?)').run(randomUUID(), companyId, name);
    event(session, 'queue_created', 'department');
    return respond(response, 201, { ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/api/automation') {
    if (!canManage) return respond(response, 403, { error: 'Somente supervisor ou administrador pode configurar o robô.' });
    const input = await parseBody(request);
    const welcome = String(input.welcome_message || '').trim();
    const fallback = String(input.fallback_message || '').trim();
    const attempts = Math.max(1, Math.min(5, Number(input.max_attempts) || 2));
    if (!welcome || !fallback) return respond(response, 400, { error: 'Preencha as duas mensagens automáticas.' });
    db.prepare('insert into automation_settings values(?,?,?,?) on conflict(company_id) do update set welcome_message=excluded.welcome_message,fallback_message=excluded.fallback_message,max_attempts=excluded.max_attempts').run(companyId, welcome, fallback, attempts);
    event(session, 'automation_updated', 'automation');
    return respond(response, 200, { ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/api/quick-replies') {
    if (!canManage) return respond(response, 403, { error: 'Somente supervisor ou administrador pode criar mensagens rápidas.' });
    const input = await parseBody(request);
    const shortcut = String(input.shortcut || '').trim();
    const reply = String(input.body || '').trim();
    if (!shortcut.startsWith('/') || !reply) return respond(response, 400, { error: 'O atalho deve começar com / e a mensagem deve ser preenchida.' });
    db.prepare('insert into quick_replies values(?,?,?,?,?)').run(randomUUID(), companyId, shortcut, reply, input.department_id || null);
    event(session, 'quick_reply_created', 'quick_reply');
    return respond(response, 201, { ok: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/flows') {
    return respond(response, 200, { flows: db.prepare('select * from automation_flows where company_id=? order by updated_at desc').all(companyId) });
  }
  if (request.method === 'POST' && url.pathname === '/api/flows') {
    if (!canManage) return respond(response, 403, { error: 'Somente supervisor ou administrador pode criar fluxos.' });
    const input = await parseBody(request); const name = String(input.name || '').trim();
    if (!name) return respond(response, 400, { error: 'Informe o nome do fluxo.' });
    const now = new Date().toISOString(); const flowId = randomUUID(); const versionId = randomUUID();
    const definition = JSON.stringify(input.definition || newFlow());
    db.prepare('insert into automation_flows values(?,?,?,?,?,?,?)').run(flowId, companyId, name, 'draft', null, now, now);
    db.prepare('insert into automation_flow_versions values(?,?,?,?,?,?,?)').run(versionId, flowId, 1, 'draft', definition, now, null);
    return respond(response, 201, { id: flowId, version: 1 });
  }
  if (pieces?.[0] === 'api' && pieces[1] === 'flows' && pieces[2]) {
    const flow = db.prepare('select * from automation_flows where id=? and company_id=?').get(pieces[2], companyId);
    if (!flow) return respond(response, 404, { error: 'Fluxo não encontrado.' });
    if (request.method === 'GET') return respond(response, 200, { flow, versions: db.prepare('select * from automation_flow_versions where flow_id=? order by version desc').all(flow.id) });
    if (!canManage) return respond(response, 403, { error: 'Sem permissão para editar fluxos.' });
    if (request.method === 'POST' && pieces[3] === 'publish') {
      const input = await parseBody(request);
      const errors = validateFlow(input.definition, { departments: db.prepare('select * from departments where company_id=?').all(companyId) });
      if (errors.length) return respond(response, 400, { error: errors.join(' ') });
      db.prepare("update automation_flow_versions set status='archived' where flow_id=? and status='published'").run(flow.id);
      const version = db.prepare('select coalesce(max(version),0)+1 version from automation_flow_versions where flow_id=?').get(flow.id).version;
      const now = new Date().toISOString();
      db.prepare('insert into automation_flow_versions values(?,?,?,?,?,?,?)').run(randomUUID(), flow.id, version, 'published', JSON.stringify(input.definition || {}), now, now);
      db.prepare("update automation_flows set status='archived',updated_at=? where company_id=? and id<>? and status='published'").run(now,companyId,flow.id);
      db.prepare('update automation_flows set status=?,published_version=?,updated_at=? where id=?').run('published', version, now, flow.id);
      return respond(response, 200, { ok: true, version });
    }
    if (request.method === 'POST' && pieces[3] === 'disable') {
      db.prepare('update automation_flows set status=?,updated_at=? where id=? and company_id=?').run('archived',new Date().toISOString(),flow.id,companyId);
      return respond(response,200,{ok:true});
    }
    if (request.method === 'PUT') {
      const input = await parseBody(request); const now = new Date().toISOString();
      const version = db.prepare('select coalesce(max(version),0)+1 version from automation_flow_versions where flow_id=?').get(flow.id).version;
      db.prepare('insert into automation_flow_versions values(?,?,?,?,?,?,?)').run(randomUUID(), flow.id, version, 'draft', JSON.stringify(input.definition || {}), now, null);
      db.prepare('update automation_flows set updated_at=? where id=?').run(now, flow.id);
      return respond(response, 200, { ok: true, version });
    }
  }
  if (pieces[0] !== 'api' || pieces[1] !== 'conversations') return respond(response, 404, { error: 'Rota não encontrada.' });
  const id = pieces[2];
  const selected = getConversation(session, id);
  if (!selected) return respond(response, 404, { error: 'Conversa não encontrada.' });
  if (request.method === 'GET' && pieces.length === 3) {
    protocolFor(companyId, id);
    const messages = db.prepare("select m.*,coalesce(p.name,'Cliente') || ' · ' || substr(m.created_at,12,5) || case when m.direction='outbound' then ' · ✓✓' else '' end author_name from messages m left join profiles p on p.id=m.profile_id where m.conversation_id=? and m.company_id=? order by m.created_at").all(id, companyId);
    return respond(response, 200, { conversation: selected, messages });
  }
  const action = pieces[3];
  const input = await parseBody(request);
  const now = new Date().toISOString();
  if (request.method === 'POST' && action === 'messages') {
    const message = String(input.body || '').trim();
    if (!message) return respond(response, 400, { error: 'Escreva uma mensagem.' });
    db.prepare('insert into messages values(?,?,?,?,?,?,?)').run(randomUUID(), companyId, id, session.profile.id, message, 'outbound', now);
    db.prepare('update conversations set status=?,assigned_profile_id=?,updated_at=? where id=?').run('open', session.profile.id, now, id);
    db.prepare("update flow_runs set status='paused' where conversation_id=? and company_id=?").run(id,companyId);
    event(session, 'message_sent', id);
    return respond(response, 201, { ok: true });
  }
  if (request.method === 'POST' && action === 'simulate') {
    const message = String(input.body || '').trim();
    if (!message) return respond(response, 400, { error: 'Escreva a mensagem simulada do cliente.' });
    const settings = db.prepare('select * from automation_settings where company_id=?').get(companyId);
    const inboundCount = db.prepare("select count(*) total from messages where conversation_id=? and direction='inbound'").get(id).total + 1;
    db.prepare('insert into messages values(?,?,?,?,?,?,?)').run(randomUUID(), companyId, id, null, message, 'inbound', now);
    const graphReply=runPublishedFlow(companyId,selected,message);
    if(graphReply){if(graphReply.reply)db.prepare('insert into messages values(?,?,?,?,?,?,?)').run(randomUUID(),companyId,id,null,graphReply.reply,'outbound',now);return respond(response,201,{ok:true});}
    if(selected.assigned_profile_id || db.prepare('select status from flow_runs where conversation_id=?').get(id)) return respond(response,201,{ok:true});
    const financial = /financeiro|fatura|segunda via|boleto/i.test(message);
    const reachedLimit = inboundCount >= settings.max_attempts;
    if (financial || reachedLimit) {
      const target = financial ? db.prepare("select id from departments where company_id=? and lower(name) like '%financeiro%' limit 1").get(companyId) : selected.department_id;
      db.prepare('update conversations set department_id=?,assigned_profile_id=null,status=?,bot_attempts=?,updated_at=? where id=?').run(target?.id || selected.department_id, 'waiting', inboundCount, now, id);
      db.prepare('insert into messages values(?,?,?,?,?,?,?)').run(randomUUID(), companyId, id, null, settings.fallback_message, 'outbound', now);
      event(session, 'bot_queued', id);
    } else {
      db.prepare('update conversations set status=?,bot_attempts=?,updated_at=? where id=?').run('open', inboundCount, now, id);
      db.prepare('insert into messages values(?,?,?,?,?,?,?)').run(randomUUID(), companyId, id, null, settings.welcome_message, 'outbound', now);
      event(session, 'bot_replied', id);
    }
    return respond(response, 201, { ok: true });
  }
  if (request.method === 'POST' && action === 'assume') {
    db.prepare('update conversations set assigned_profile_id=?,status=?,updated_at=? where id=?').run(session.profile.id, 'open', now, id);
    db.prepare("update flow_runs set status='paused' where conversation_id=? and company_id=?").run(id,companyId);
    event(session, 'conversation_assumed', id);
    return respond(response, 200, { ok: true });
  }
  if (request.method === 'POST' && action === 'close') {
    db.prepare('update conversations set status=?,updated_at=? where id=?').run('closed', now, id);
    db.prepare("update flow_runs set status='finished' where conversation_id=? and company_id=?").run(id,companyId);
    event(session, 'conversation_closed', id);
    return respond(response, 200, { ok: true });
  }
  if (request.method === 'POST' && action === 'transfer') {
    const department = db.prepare('select * from departments where id=? and company_id=?').get(input.department_id, companyId);
    if (!department) return respond(response, 400, { error: 'Setor inválido.' });
    const assignee = input.assigned_profile_id ? db.prepare('select id from profiles where id=? and company_id=?').get(input.assigned_profile_id, companyId) : null;
    db.prepare('update conversations set department_id=?,assigned_profile_id=?,status=?,updated_at=? where id=?').run(department.id, assignee?.id || null, 'waiting', now, id);
    event(session, 'conversation_transferred', id);
    return respond(response, 200, { ok: true });
  }
  respond(response, 404, { error: 'Ação não encontrada.' });
});
const port = Number(process.env.PORT || 3100);
server.listen(port, () => console.log('Central demo em http://localhost:' + port));
