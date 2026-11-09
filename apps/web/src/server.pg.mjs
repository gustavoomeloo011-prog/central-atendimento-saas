import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createPersistence } from './persistence.mjs';
import { proxyWhatsApp } from './whatsapp-proxy.mjs';
import { dispatchConnector, syncConnector } from './connector-bridge.mjs';
import { validateFlow, newFlow, advanceFlow } from '../public/flow.js';
import { startCloudConnector, stopCloudConnector } from './cloud-connector.mjs';

const db = createPersistence();
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !anonKey || !serviceKey) throw new Error('SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY são obrigatórias.');
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
const body = request => new Promise((resolve, reject) => { let raw = '', failed = false; request.on('data', p => { if (failed) return; raw += p; if (raw.length > 15_000_000) { failed = true; reject(Object.assign(new Error('Arquivo maior que o limite de 10 MB.'),{status:413})); } }); request.on('end', () => { if (failed) return; try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Object.assign(new Error('JSON inválido'),{status:400})); } }); });
const rawBody = request => new Promise((resolve, reject) => { const chunks = []; let size = 0; request.on('data', chunk => { size += chunk.length; if (size > 1_000_000) return reject(Object.assign(new Error('Webhook maior que o limite permitido.'), { status: 413 })); chunks.push(Buffer.from(chunk)); }); request.on('end', () => resolve(Buffer.concat(chunks))); request.on('error', reject); });
async function authRequest(path, method, payload, key = anonKey, bearer = key) {
  const response = await fetch(`${supabaseUrl}/auth/v1/${path}`, { method, headers: { apikey: key, authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.msg || result.error_description || result.message || 'Falha na autenticação.'), { status: response.status });
  return result;
}
async function sessionFor(request) {
  const token = (request.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return null;
  const user = await authRequest('user', 'GET', null, anonKey, token).catch(() => null);
  if (!user?.id) return null;
  const profile = await db.one('select id,company_id,name,email,role,status,display_name,avatar_url,phone,department_id,created_at,last_seen_at from public.profiles where auth_user_id=$1', [user.id]);
  return profile ? { profile, user } : null;
}
const admin = session => ['supervisor','company_admin','superadmin'].includes(session.profile.role);
const audit = (tx, session, action, id, type = 'conversation') => tx.query('insert into public.audit_events(id,company_id,profile_id,action,entity_type,entity_id) values($1,$2,$3,$4,$5,$6)', [randomUUID(), session.profile.company_id, session.profile.id, action, type, id]);
const validConnector = request => { const a = Buffer.from(String(request.headers['x-connector-token'] || '')); const b = Buffer.from(String(process.env.WHATSAPP_CONNECTOR_TOKEN || '')); return b.length > 0 && a.length === b.length && timingSafeEqual(a,b); };
const safeEqualText = (left, right) => { const a = Buffer.from(String(left || '')); const b = Buffer.from(String(right || '')); return a.length > 0 && a.length === b.length && timingSafeEqual(a, b); };
const validMetaSignature = (request, raw) => { const secret = process.env.META_APP_SECRET || ''; const signature = String(request.headers['x-hub-signature-256'] || ''); if (!secret || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false; return safeEqualText(signature, `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`); };
const conversation = (company, id) => db.one('select * from public.conversations where company_id=$1 and id=$2',[company,id]);
async function connectorSend(payload) {
  const response = await fetch(`http://127.0.0.1:${Number(process.env.WHATSAPP_CONNECTOR_PORT || 3200)}/api/whatsapp/send`, { method:'POST', headers:{'content-type':'application/json','x-connector-token':process.env.WHATSAPP_CONNECTOR_TOKEN||''}, body:JSON.stringify(payload), signal:AbortSignal.timeout(20_000) }).catch(() => null);
  if (!response) return dispatchConnector(process.env.WHATSAPP_COMPANY_ID, 'send', 'POST', {...payload,company_id:process.env.WHATSAPP_COMPANY_ID});
  const result = await response.json().catch(()=>({}));
  if (!response.ok) throw Object.assign(new Error(result.error||'Falha no envio ao WhatsApp.'),{status:response.status});
  return result;
}
async function storeAttachment(company,conversationId,messageId,attachment) {
  if (!attachment?.data) return null;
  const bytes=Buffer.from(String(attachment.data),'base64');
  if (!bytes.length||bytes.length>10*1024*1024) throw Object.assign(new Error('O anexo deve possuir no máximo 10 MB.'),{status:400});
  const type=String(attachment.type||'application/octet-stream');
  if (!['image/jpeg','image/png','image/webp','video/mp4','application/pdf'].includes(type)) throw Object.assign(new Error('Formato de anexo não permitido.'),{status:400});
  const extension=type==='image/jpeg'?'jpg':type==='image/png'?'png':type==='image/webp'?'webp':type==='video/mp4'?'mp4':'pdf';
  const path=`${company}/${conversationId}/${messageId}.${extension}`;
  const response=await fetch(`${supabaseUrl}/storage/v1/object/chat-attachments/${path}`,{method:'POST',headers:{apikey:serviceKey,authorization:`Bearer ${serviceKey}`,'content-type':type,'x-upsert':'false'},body:bytes});
  if(!response.ok)throw Object.assign(new Error('Não foi possível guardar o anexo.'),{status:502});
  return {path,name:String(attachment.name||`arquivo.${extension}`).slice(0,180),type};
}
async function executePublishedFlow(tx,company,c,input){
  if(c.assigned_profile_id)return null;
  let run=await tx.one('select * from public.flow_runs where company_id=$1 and conversation_id=$2 for update',[company,c.id]);
  if(run?.status!=='active'&&run)return {reply:null,queued:false};
  if(!run){
    const version=await tx.one("select f.id flow_id,v.id version_id from public.automation_flows f join public.automation_flow_versions v on v.flow_id=f.id and v.version=f.published_version where f.company_id=$1 and f.status='published' order by f.updated_at desc limit 1",[company]);
    if(!version)return null;
    run=await tx.one("insert into public.flow_runs(conversation_id,company_id,flow_id,version_id,status) values($1,$2,$3,$4,'active') returning *",[c.id,company,version.flow_id,version.version_id]);
  }
  const version=await tx.one('select definition from public.automation_flow_versions where company_id=$1 and id=$2',[company,run.version_id]);
  if(!version)return {reply:null,queued:false};
  const result=advanceFlow(version.definition,{nodeId:run.node_id,steps:run.steps,variables:run.variables},run.node_id?input:null);
  await tx.query('update public.flow_runs set node_id=$1,steps=$2,variables=$3,status=$4,updated_at=now() where company_id=$5 and conversation_id=$6',[result.nodeId,result.steps,result.variables,result.finished?'finished':'active',company,c.id]);
  if(result.transfer)await tx.query("update public.conversations set department_id=$1,assigned_profile_id=$2,status='waiting',updated_at=now() where company_id=$3 and id=$4",[result.transfer.departmentId,result.transfer.profileId,company,c.id]);
  const reply=result.output.filter(item=>item.type==='message').map(item=>item.text+(item.options?.length?'\n'+item.options.map((option,index)=>`${index+1}. ${option.label}`).join('\n'):'' )).join('\n\n');
  return {reply:reply||null,queued:Boolean(result.transfer)};
}

async function handle(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { response.writeHead(200, {'content-type':'text/html; charset=utf-8'}); return response.end(await readFile(join(publicDir,'index.html'))); }
  if (request.method === 'GET' && url.pathname.startsWith('/assets/')) { const file = join(publicDir, url.pathname.slice(8)); if (!existsSync(file)) return json(response,404,{error:'Arquivo não encontrado.'}); response.writeHead(200,{'content-type':file.endsWith('.css')?'text/css':'application/javascript'}); return response.end(await readFile(file)); }
  if (request.method === 'GET' && url.pathname === '/health') { await db.one('select 1 ok'); return json(response,200,{backend:'online',database:'online'}); }
  if (url.pathname === '/api/webhooks/meta/whatsapp' && request.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const verifyToken = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && safeEqualText(verifyToken, process.env.META_WEBHOOK_VERIFY_TOKEN) && challenge) {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return response.end(challenge);
    }
    return json(response, 403, { error: 'Verificação do webhook recusada.' });
  }
  if (url.pathname === '/api/webhooks/meta/whatsapp' && request.method === 'POST') {
    const raw = await rawBody(request);
    if (!validMetaSignature(request, raw)) return json(response, 401, { error: 'Assinatura do webhook inválida.' });
    let input; try { input = JSON.parse(raw.toString('utf8')); } catch { return json(response, 400, { error: 'JSON inválido.' }); }
    const company = String(process.env.WHATSAPP_COMPANY_ID || '');
    if (!company) return json(response, 503, { error: 'Empresa do WhatsApp não configurada.' });
    const expectedWaba = String(process.env.META_WABA_ID || '');
    const entries = Array.isArray(input.entry) ? input.entry : [];
    if (expectedWaba && entries.some(entry => String(entry.id || '') !== expectedWaba)) return json(response, 403, { error: 'WABA não autorizada.' });
    let processed = 0, duplicates = 0;
    await db.transaction(async tx => {
      for (const entry of entries) for (const change of (entry.changes || [])) {
        const value = change.value || {};
        for (const status of (value.statuses || [])) {
          const eventId = `status:${status.id}:${status.status}`;
          const claimed = await tx.one('insert into public.connector_events(event_id,company_id,event_type,provider_message_id,payload,processed_at) values($1,$2,$3,null,$4,now()) on conflict (event_id) do nothing returning event_id', [eventId, company, 'meta.status', status]);
          if (!claimed) { duplicates++; continue; }
          await tx.query('update public.messages set delivery_status=$1,error_message=$2 where company_id=$3 and provider_message_id=$4', [String(status.status || 'unknown'), status.errors?.[0]?.title || status.errors?.[0]?.message || null, company, String(status.id || '')]);
          processed++;
        }
        for (const message of (value.messages || [])) {
          const providerId = String(message.id || '');
          if (!providerId) continue;
          const claimed = await tx.one('insert into public.connector_events(event_id,company_id,event_type,provider_message_id,payload,processed_at) values($1,$2,$3,$4,$5,now()) on conflict (event_id) do nothing returning event_id', [`message:${providerId}`, company, 'meta.message', providerId, message]);
          if (!claimed) { duplicates++; continue; }
          const phone = String(message.from || '').replace(/\D/g, '');
          const text = message.type === 'text' ? String(message.text?.body || '').trim() : `[Mensagem ${message.type || 'não suportada'}]`;
          if (!phone || !text) continue;
          let c = await tx.one("select * from public.conversations where company_id=$1 and contact_phone=$2 and status<>'closed' order by updated_at desc limit 1 for update", [company, phone]);
          if (!c) {
            const department = await tx.one('select id from public.departments where company_id=$1 order by id limit 1', [company]);
            if (!department) continue;
            const id = randomUUID();
            const protocol = (await tx.one('select public.next_protocol($1) protocol', [company])).protocol;
            c = await tx.one("insert into public.conversations(id,company_id,department_id,contact_name,contact_phone,channel_address,subject,status,priority,queue_type,protocol) values($1,$2,$3,$4,$5,$6,'WhatsApp','waiting','normal',$3,$7) returning *", [id, company, department.id, value.contacts?.[0]?.profile?.name || phone, phone, `${phone}@s.whatsapp.net`, protocol]);
          }
          await tx.query("insert into public.messages(id,company_id,conversation_id,body,direction,provider_message_id,delivery_status) values($1,$2,$3,$4,'inbound',$5,'received') on conflict (provider_message_id) do nothing", [randomUUID(), company, c.id, text, providerId]);
          await tx.query('update public.conversations set updated_at=now() where company_id=$1 and id=$2', [company, c.id]);
          processed++;
        }
      }
    });
    return json(response, 200, { ok: true, processed, duplicates });
  }
  if (request.method === 'POST' && url.pathname === '/api/internal/connector/sync') {
    if (!validConnector(request)) return json(response,401,{error:'Conector não autorizado.'});
    const input = await body(request), company = String(input.company_id || '');
    if (!company || company !== process.env.WHATSAPP_COMPANY_ID) return json(response,403,{error:'Empresa não autorizada.'});
    return json(response,200,syncConnector(company,input));
  }
  if (request.method === 'POST' && url.pathname === '/api/login') {
    const input = await body(request);
    const entered = String(input.email||'').trim().toLowerCase();
    const email = entered === 'gustavo' ? 'gustavo@demo.local' : entered;
    const password = entered === 'gustavo' && input.password === 'demo' ? process.env.DEMO_AUTH_PASSWORD : input.password;
    const auth = await authRequest('token?grant_type=password','POST',{email,password});
    const profile = await db.one('select id,company_id,name,role from public.profiles where auth_user_id=$1',[auth.user.id]);
    if (!profile) return json(response,403,{error:'Usuário não vinculado a uma empresa.'});
    return json(response,200,{token:auth.access_token,profile});
  }
  if (request.method === 'POST' && url.pathname === '/api/recover-password') { const input=await body(request); await authRequest('recover','POST',{email:String(input.email||'').trim().toLowerCase()}); return json(response,200,{ok:true}); }
  if (request.method === 'POST' && url.pathname === '/api/internal/whatsapp/inbound') {
    if (!validConnector(request)) return json(response,401,{error:'Conector não autorizado.'});
    const input=await body(request), company=String(input.company_id||process.env.WHATSAPP_COMPANY_ID||''), phone=String(input.phone||'').replace(/\D/g,''), text=String(input.body||'').trim(),channelAddress=String(input.jid||'');
    if (!company || company !== process.env.WHATSAPP_COMPANY_ID || !phone || !text) return json(response,400,{error:'Empresa, telefone e mensagem são obrigatórios.'});
    const result=await db.transaction(async tx => {
      let c=await tx.one("select * from public.conversations where company_id=$1 and (channel_address=$2 or contact_phone=$3) and status<>'closed' order by updated_at desc limit 1 for update",[company,channelAddress||null,phone]);
      if (!c) { const d=await tx.one('select id from public.departments where company_id=$1 order by id limit 1',[company]); if (!d) throw Object.assign(new Error('Empresa sem fila.'),{status:409});
        const id=randomUUID(), protocol=(await tx.one('select public.next_protocol($1) protocol',[company])).protocol;
        c=await tx.one('insert into public.conversations(id,company_id,department_id,contact_name,contact_phone,channel_address,subject,status,priority,queue_type,protocol) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',[id,company,d.id,input.name||phone,phone,channelAddress||null,'WhatsApp','waiting','normal',d.id,protocol]); }
      else if(channelAddress&&!c.channel_address){c=await tx.one('update public.conversations set channel_address=$1,contact_phone=case when length($2) between 10 and 15 then $2 else contact_phone end,updated_at=now() where company_id=$3 and id=$4 returning *',[channelAddress,phone,company,c.id]);}
      const providerId=String(input.message_id||'')||null;
      if (providerId && await tx.one('select id from public.messages where provider_message_id=$1',[providerId])) return {conversation_id:c.id,protocol:c.protocol,reply:null,duplicate:true};
      await tx.query("insert into public.messages(id,company_id,conversation_id,body,direction,provider_message_id,delivery_status) values($1,$2,$3,$4,$5,$6,'received')",[randomUUID(),company,c.id,text,'inbound',providerId]);
      const graphReply=await executePublishedFlow(tx,company,c,text);
      if(graphReply)return {conversation_id:c.id,protocol:c.protocol,...graphReply};
      const settings=await tx.one('select * from public.automation_settings where company_id=$1',[company]);
      if (c.assigned_profile_id || c.status==='closed' || !settings) return {conversation_id:c.id,protocol:c.protocol,reply:null};
      const attempts=c.bot_attempts+1, financial=/financeiro|fatura|segunda via|boleto/i.test(text), queued=financial||attempts>=settings.max_attempts;
      const target=financial?await tx.one("select id from public.departments where company_id=$1 and name ilike '%financeiro%' limit 1",[company]):null;
      await tx.query('update public.conversations set department_id=$1,status=$2,bot_attempts=$3,updated_at=now() where company_id=$4 and id=$5',[target?.id||c.department_id,queued?'waiting':'open',attempts,company,c.id]);
      return {conversation_id:c.id,protocol:c.protocol,reply:queued?settings.fallback_message:settings.welcome_message,queued};
    });
    return json(response,201,{ok:true,...result});
  }
  if (request.method === 'POST' && url.pathname === '/api/internal/whatsapp/outbound') { if (!validConnector(request)) return json(response,401,{error:'Conector não autorizado.'}); const input=await body(request); const company=String(input.company_id||process.env.WHATSAPP_COMPANY_ID||''); if (company!==process.env.WHATSAPP_COMPANY_ID) return json(response,403,{error:'Empresa não autorizada.'}); const c=await conversation(company,String(input.conversation_id||'')); if (!c) return json(response,404,{error:'Conversa não encontrada.'}); const provider=String(input.message_id||'')||null; const existing=provider&&await db.one('select id from public.messages where provider_message_id=$1',[provider]); if (existing) return json(response,200,{ok:true,message_id:existing.id,delivery:'sent'}); const id=randomUUID(); await db.query('insert into public.messages(id,company_id,conversation_id,body,direction,provider_message_id) values($1,$2,$3,$4,$5,$6)',[id,company,c.id,String(input.body||''),'outbound',provider]); return json(response,201,{ok:true,message_id:id,delivery:'sent'}); }
  if(request.method==='POST'&&url.pathname==='/api/internal/whatsapp/delivery'){if(!validConnector(request))return json(response,401,{error:'Conector não autorizado.'});const input=await body(request),company=String(input.company_id||'');if(company!==process.env.WHATSAPP_COMPANY_ID)return json(response,403,{error:'Empresa não autorizada.'});const status=['sent','delivered','read'].includes(input.status)?input.status:'sent';await db.query('update public.messages set delivery_status=$1 where company_id=$2 and provider_message_id=$3',[status,company,String(input.message_id||'')]);return json(response,200,{ok:true});}
  const session=await sessionFor(request); if (!session) return json(response,401,{error:'Sessão expirada.'});
  const company=session.profile.company_id, pieces=url.pathname.split('/').filter(Boolean);
  if(request.method==='GET'&&pieces[0]==='api'&&pieces[1]==='attachments'&&pieces[2]){
    const message=await db.one('select attachment_path,attachment_type,attachment_name from public.messages where company_id=$1 and id=$2',[company,pieces[2]]);
    if(!message?.attachment_path)return json(response,404,{error:'Anexo não encontrado.'});
    const upstream=await fetch(`${supabaseUrl}/storage/v1/object/authenticated/chat-attachments/${message.attachment_path}`,{headers:{apikey:serviceKey,authorization:`Bearer ${serviceKey}`}});
    if(!upstream.ok)return json(response,upstream.status,{error:'Anexo indisponível.'});
    response.writeHead(200,{'content-type':message.attachment_type||'application/octet-stream','content-disposition':`inline; filename="${String(message.attachment_name||'arquivo').replace(/["\r\n]/g,'')}"`});
    return response.end(Buffer.from(await upstream.arrayBuffer()));
  }
  if (url.pathname.startsWith('/api/whatsapp/')) return admin(session) ? proxyWhatsApp(request,response,company) : json(response,403,{error:'Somente supervisores podem gerenciar a conexão.'});
  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    const [companyRow,conversations,departments,replies]=await Promise.all([
      db.one('select * from public.companies where id=$1',[company]),
      db.query("select c.*,d.name department_name,p.name assignee_name,(select body from public.messages m where m.conversation_id=c.id order by created_at desc limit 1) last_message from public.conversations c join public.departments d on d.id=c.department_id left join public.profiles p on p.id=c.assigned_profile_id where c.company_id=$1 order by case c.status when 'waiting' then 0 else 1 end,c.updated_at desc",[company]),
      db.query('select * from public.departments where company_id=$1',[company]),db.query('select * from public.quick_replies where company_id=$1 order by shortcut',[company])]);
    return json(response,200,{profile:session.profile,company:companyRow,conversations,departments,quickReplies:replies});
  }
  if (request.method === 'GET' && url.pathname === '/api/settings') { const [profiles,departments,settings,replies]=await Promise.all([db.query('select id,name,email,role,status from public.profiles where company_id=$1 order by name',[company]),db.query('select * from public.departments where company_id=$1 order by name',[company]),db.one('select * from public.automation_settings where company_id=$1',[company]),db.query('select * from public.quick_replies where company_id=$1 order by shortcut',[company])]); return json(response,200,{profiles,departments,settings,replies}); }
  if(request.method==='PATCH'&&url.pathname==='/api/profile'){const input=await body(request),display=String(input.display_name||'').trim();if(!display)return json(response,400,{error:'O nome de exibição é obrigatório.'});await db.query('update public.profiles set display_name=$1,name=coalesce(nullif(name,\'\'),$1),phone=$2,last_seen_at=now() where company_id=$3 and id=$4',[display.slice(0,80),String(input.phone||'').trim().slice(0,30)||null,company,session.profile.id]);return json(response,200,{ok:true});}
  if (request.method === 'POST' && url.pathname === '/api/agents') { if (!admin(session)) return json(response,403,{error:'Sem permissão.'}); const input=await body(request), name=String(input.name||'').trim(),email=String(input.email||'').trim().toLowerCase(),password=String(input.password||''),role=['agent','supervisor'].includes(input.role)?input.role:'agent'; if (!name||!email.includes('@')||password.length<8) return json(response,400,{error:'Informe nome, e-mail e senha de pelo menos 8 caracteres.'}); const user=await authRequest('admin/users','POST',{email,password,email_confirm:true},serviceKey); try { await db.transaction(async tx=>{ await tx.query('insert into public.profiles(id,company_id,auth_user_id,name,display_name,email,role,status) values($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),company,user.id,name,name,email,role,'available']); await audit(tx,session,'agent_created',user.id,'profile'); }); } catch(error) { await authRequest(`admin/users/${user.id}`,'DELETE',null,serviceKey).catch(()=>{}); throw error; } return json(response,201,{ok:true}); }
  if (request.method === 'POST' && url.pathname === '/api/queues') { if (!admin(session)) return json(response,403,{error:'Sem permissão.'}); const input=await body(request),name=String(input.name||'').trim(); if (!name) return json(response,400,{error:'Informe o nome da fila.'}); await db.transaction(async tx=>{ const id=randomUUID(); await tx.query('insert into public.departments(id,company_id,name) values($1,$2,$3)',[id,company,name]); await audit(tx,session,'queue_created',id,'department'); }); return json(response,201,{ok:true}); }
  if (request.method === 'POST' && url.pathname === '/api/automation') { if (!admin(session)) return json(response,403,{error:'Sem permissão.'}); const input=await body(request),welcome=String(input.welcome_message||'').trim(),fallback=String(input.fallback_message||'').trim(),attempts=Math.max(1,Math.min(5,Number(input.max_attempts)||2)); if (!welcome||!fallback) return json(response,400,{error:'Preencha as mensagens.'}); await db.transaction(async tx=>{ await tx.query('insert into public.automation_settings(company_id,welcome_message,fallback_message,max_attempts) values($1,$2,$3,$4) on conflict(company_id) do update set welcome_message=excluded.welcome_message,fallback_message=excluded.fallback_message,max_attempts=excluded.max_attempts',[company,welcome,fallback,attempts]); await audit(tx,session,'automation_updated',company,'automation'); }); return json(response,200,{ok:true}); }
  if (request.method === 'POST' && url.pathname === '/api/quick-replies') { if (!admin(session)) return json(response,403,{error:'Sem permissão.'}); const input=await body(request),shortcut=String(input.shortcut||'').trim(),reply=String(input.body||'').trim(); if (!shortcut.startsWith('/')||!reply) return json(response,400,{error:'Atalho e mensagem inválidos.'}); await db.query('insert into public.quick_replies(id,company_id,shortcut,body,department_id) values($1,$2,$3,$4,$5)',[randomUUID(),company,shortcut,reply,input.department_id||null]); return json(response,201,{ok:true}); }
  if (request.method === 'GET' && url.pathname === '/api/flows') return json(response,200,{flows:await db.query('select * from public.automation_flows where company_id=$1 order by updated_at desc',[company])});
  if (request.method === 'POST' && url.pathname === '/api/flows') { if (!admin(session)) return json(response,403,{error:'Sem permissão.'}); const input=await body(request),name=String(input.name||'').trim(); if (!name) return json(response,400,{error:'Informe o nome do fluxo.'}); const id=randomUUID(); await db.transaction(async tx=>{ await tx.query('insert into public.automation_flows(id,company_id,name) values($1,$2,$3)',[id,company,name]); await tx.query('insert into public.automation_flow_versions(id,company_id,flow_id,version,status,definition) values($1,$2,$3,1,$4,$5)',[randomUUID(),company,id,'draft',input.definition||newFlow()]); }); return json(response,201,{id,version:1}); }
  if (pieces[0]==='api' && pieces[1]==='flows' && pieces[2]) { const flow=await db.one('select * from public.automation_flows where id=$1 and company_id=$2',[pieces[2],company]); if (!flow) return json(response,404,{error:'Fluxo não encontrado.'}); if (request.method==='GET') return json(response,200,{flow,versions:await db.query('select * from public.automation_flow_versions where company_id=$1 and flow_id=$2 order by version desc',[company,flow.id])}); if (!admin(session)) return json(response,403,{error:'Sem permissão.'}); if(request.method==='POST'&&pieces[3]==='disable'){await db.query("update public.automation_flows set status='archived',updated_at=now() where id=$1 and company_id=$2",[flow.id,company]);return json(response,200,{ok:true});} if ((request.method==='POST'&&pieces[3]==='publish')||request.method==='PUT') { const input=await body(request),publish=pieces[3]==='publish'; if(publish){const departments=await db.query('select id from public.departments where company_id=$1',[company]);const errors=validateFlow(input.definition,{departments});if(errors.length)return json(response,400,{error:errors.join(' ')});} const version=await db.transaction(async tx=>{ const latest=await tx.one('select coalesce(max(version),0)+1 version from public.automation_flow_versions where flow_id=$1 and company_id=$2',[flow.id,company]); if (publish) await tx.query("update public.automation_flow_versions set status='archived' where flow_id=$1 and company_id=$2 and status='published'",[flow.id,company]); await tx.query('insert into public.automation_flow_versions(id,company_id,flow_id,version,status,definition,published_at) values($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),company,flow.id,latest.version,publish?'published':'draft',input.definition||{},publish?new Date():null]); await tx.query('update public.automation_flows set status=$1,published_version=$2,updated_at=now() where id=$3 and company_id=$4',[publish?'published':flow.status,publish?latest.version:flow.published_version,flow.id,company]); return latest.version; }); return json(response,200,{ok:true,version}); } }
  if(request.method==='POST'&&url.pathname==='/api/conversations'){
    const input=await body(request),raw=String(input.phone||'').replace(/\D/g,''),phone=raw.length===10||raw.length===11?'55'+raw:raw,name=String(input.name||'').trim()||phone;
    if(!/^55\d{10,11}$/.test(phone))return json(response,400,{error:'Informe DDD e número válidos.'});
    let created=await db.one("select * from public.conversations where company_id=$1 and contact_phone=$2 and status<>'closed' order by updated_at desc limit 1",[company,phone]);
    if(!created){const department=await db.one('select id from public.departments where company_id=$1 order by name limit 1',[company]);if(!department)return json(response,409,{error:'Cadastre uma fila antes de iniciar conversas.'});const id=randomUUID(),protocol=(await db.one('select public.next_protocol($1) protocol',[company])).protocol;created=await db.one("insert into public.conversations(id,company_id,department_id,contact_name,contact_phone,channel_address,subject,status,priority,queue_type,protocol) values($1,$2,$3,$4,$5,$6,'WhatsApp','open','normal',$3,$7) returning *",[id,company,department.id,name.slice(0,120),phone,phone+'@s.whatsapp.net',protocol]);}
    return json(response,201,{conversation:created});
  }
  if (pieces[0]!=='api'||pieces[1]!=='conversations'||!pieces[2]) return json(response,404,{error:'Rota não encontrada.'});
  const selected=await conversation(company,pieces[2]); if (!selected) return json(response,404,{error:'Conversa não encontrada.'}); const id=selected.id;
  if (request.method==='GET'&&pieces.length===3) { const messages=await db.query("select m.*,coalesce(p.display_name,p.name,'Cliente') author_name,to_char(m.created_at at time zone 'America/Sao_Paulo','HH24:MI') message_time,r.body reply_body from public.messages m left join public.profiles p on p.id=m.profile_id left join public.messages r on r.company_id=m.company_id and r.id=m.reply_to_id where m.company_id=$1 and m.conversation_id=$2 order by m.created_at",[company,id]); return json(response,200,{conversation:selected,messages}); }
  const action=pieces[3],input=await body(request);
  if (request.method==='POST'&&action==='messages') { const text=String(input.body||'').trim(),attachment=input.attachment||null; if (!text&&!attachment?.data) return json(response,400,{error:'Escreva uma mensagem ou anexe um arquivo.'}); if(!/^55\d{10,11}$/.test(String(selected.contact_phone||'')))return json(response,409,{error:'Confirme o DDD e o número do contato antes de enviar.'}); const reply=input.reply_to_id?await db.one('select id,body,provider_message_id from public.messages where company_id=$1 and conversation_id=$2 and id=$3',[company,id,input.reply_to_id]):null; const messageId=randomUUID(); const stored=await storeAttachment(company,id,messageId,attachment); await db.transaction(async tx=>{await tx.query("update public.flow_runs set status='paused',updated_at=now() where company_id=$1 and conversation_id=$2",[company,id]);await tx.query("insert into public.messages(id,company_id,conversation_id,profile_id,body,direction,reply_to_id,attachment_path,attachment_name,attachment_type,delivery_status) values($1,$2,$3,$4,$5,'outbound',$6,$7,$8,$9,'pending')",[messageId,company,id,session.profile.id,text,reply?.id||null,stored?.path||null,stored?.name||null,stored?.type||null]);await tx.query("update public.conversations set status='open',assigned_profile_id=$1,channel_address=$4,updated_at=now(),human_started_at=coalesce(human_started_at,now()) where id=$2 and company_id=$3",[session.profile.id,id,company,selected.contact_phone+'@s.whatsapp.net']);}); try{const sent=await connectorSend({phone:selected.contact_phone,text,attachment,reply:reply?{body:reply.body,provider_message_id:reply.provider_message_id}:null});await db.transaction(async tx=>{await tx.query("update public.messages set provider_message_id=$1,delivery_status='sent',error_message=null where company_id=$2 and id=$3",[sent.messageId||null,company,messageId]);await audit(tx,session,'message_sent',id);});return json(response,201,{ok:true,message_id:messageId,provider_message_id:sent.messageId||null,status:'sent'});}catch(error){await db.query("update public.messages set delivery_status='failed',error_message=$1 where company_id=$2 and id=$3",[String(error.message||'Falha no envio').slice(0,500),company,messageId]);throw error;} }
  if(request.method==='POST'&&action==='internal-notes'){const text=String(input.body||'').trim();if(!text)return json(response,400,{error:'Escreva a anotação interna.'});const noteId=randomUUID();await db.transaction(async tx=>{await tx.query("insert into public.messages(id,company_id,conversation_id,profile_id,body,direction,delivery_status) values($1,$2,$3,$4,$5,'internal','internal')",[noteId,company,id,session.profile.id,text]);await tx.query('insert into public.internal_notes(id,company_id,conversation_id,profile_id,body) values($1,$2,$3,$4,$5)',[noteId,company,id,session.profile.id,text]);await audit(tx,session,'internal_note_created',id);});return json(response,201,{ok:true});}
  if(request.method==='PATCH'&&action==='contact'){const name=String(input.name||'').trim(),raw=String(input.phone||selected.contact_phone||'').replace(/\D/g,''),phone=raw.length===10||raw.length===11?'55'+raw:raw;if(!name)return json(response,400,{error:'Informe o nome do contato.'});if(!/^55\d{10,11}$/.test(phone))return json(response,400,{error:'Informe DDD e número válidos.'});await db.query('update public.conversations set contact_name=$1,contact_phone=$2,channel_address=$3,updated_at=now() where company_id=$4 and id=$5',[name.slice(0,120),phone,phone+'@s.whatsapp.net',company,id]);return json(response,200,{ok:true});}
  if (request.method==='POST'&&action==='simulate') { const text=String(input.body||'').trim(); if (!text) return json(response,400,{error:'Escreva a mensagem simulada.'}); await db.transaction(async tx=>{ const c=await tx.one('select * from public.conversations where id=$1 and company_id=$2 for update',[id,company]); await tx.query('insert into public.messages(id,company_id,conversation_id,body,direction) values($1,$2,$3,$4,$5)',[randomUUID(),company,id,text,'inbound']); if (c.assigned_profile_id) return; const graphReply=await executePublishedFlow(tx,company,c,text); if(graphReply){if(graphReply.reply)await tx.query('insert into public.messages(id,company_id,conversation_id,body,direction) values($1,$2,$3,$4,$5)',[randomUUID(),company,id,graphReply.reply,'outbound']);return;} const settings=await tx.one('select * from public.automation_settings where company_id=$1',[company]); if (!settings) return; const attempts=c.bot_attempts+1,financial=/financeiro|fatura|segunda via|boleto/i.test(text),queued=financial||attempts>=settings.max_attempts; const target=financial?await tx.one("select id from public.departments where company_id=$1 and name ilike '%financeiro%' limit 1",[company]):null; await tx.query('update public.conversations set department_id=$1,status=$2,bot_attempts=$3,updated_at=now() where id=$4 and company_id=$5',[target?.id||c.department_id,queued?'waiting':'open',attempts,id,company]); await tx.query('insert into public.messages(id,company_id,conversation_id,body,direction) values($1,$2,$3,$4,$5)',[randomUUID(),company,id,queued?settings.fallback_message:settings.welcome_message,'outbound']); await audit(tx,session,queued?'bot_queued':'bot_replied',id); }); return json(response,201,{ok:true}); }
  if (request.method==='POST'&&['assume','close','transfer'].includes(action)) { const result=await db.transaction(async tx=>{ const c=await tx.one('select * from public.conversations where company_id=$1 and id=$2 for update',[company,id]); if(action==='assume'||action==='close')await tx.query('update public.flow_runs set status=$1,updated_at=now() where company_id=$2 and conversation_id=$3',[action==='close'?'finished':'paused',company,id]); if (action==='assume') await tx.query("update public.conversations set assigned_profile_id=$1,status='open',updated_at=now(),human_started_at=coalesce(human_started_at,now()) where id=$2 and company_id=$3",[session.profile.id,id,company]); if (action==='close') await tx.query("update public.conversations set status='closed',closed_at=now(),updated_at=now() where id=$1 and company_id=$2",[id,company]); if (action==='transfer') { const d=await tx.one('select id from public.departments where id=$1 and company_id=$2',[input.department_id,company]); if (!d) return {error:'Setor inválido.'}; const assignee=input.assigned_profile_id?await tx.one('select id from public.profiles where id=$1 and company_id=$2',[input.assigned_profile_id,company]):null; await tx.query("update public.conversations set department_id=$1,assigned_profile_id=$2,status='waiting',updated_at=now() where id=$3 and company_id=$4",[d.id,assignee?.id||null,id,company]); } await audit(tx,session,action==='assume'?'conversation_assumed':action==='close'?'conversation_closed':'conversation_transferred',id); return {ok:true}; }); return json(response,result.error?400:200,result); }
  return json(response,404,{error:'Ação não encontrada.'});
}
const server=createServer((req,res)=>{ handle(req,res).catch(error=>{ console.error('Request failed:',error.message); if (!res.headersSent) { const status=error.status||500; json(res,status,{error:(status>=400&&status<500)||status===503?error.message:'Falha na consulta.'}); } }); });
const port=Number(process.env.PORT||3100);
server.listen(port,()=>{
  console.log(`Central PostgreSQL na porta ${port}`);
  try { startCloudConnector(); } catch (error) { console.error(`[baileys] ${error.message}`); }
});
process.once('SIGTERM', () => { stopCloudConnector(); server.close(() => process.exit(0)); });
process.once('SIGINT', () => { stopCloudConnector(); server.close(() => process.exit(0)); });
