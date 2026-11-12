import { createSgpClient } from './sgp-client.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createPersistence } from './persistence.mjs';
import { proxyWhatsApp } from './whatsapp-proxy.mjs';
import { dispatchConnector, syncConnector } from './connector-bridge.mjs';
import { validateFlow, newFlow, advanceFlow, sgFibraRobotFlow } from '../public/flow.js';
import { startCloudConnector, stopCloudConnector } from './cloud-connector.mjs';
import { buildMetaMessage, formatNumberedOptions, isInteractiveWindowExpired, parseMetaInbound } from './meta-interactive.mjs';

const db = createPersistence();
const sgp = createSgpClient();
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
async function sendBrevoRecovery(email, name, link) {
  const apiKey=String(process.env.BREVO_API_KEY||'').trim();
  if(!apiKey) return false;
  const senderEmail=String(process.env.BREVO_SENDER_EMAIL||'').trim(), senderName=String(process.env.BREVO_SENDER_NAME||'SG FIBRA').trim();
  if(!senderEmail) throw Object.assign(new Error('BREVO_SENDER_EMAIL não configurado.'),{status:503});
  const response=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{accept:'application/json','api-key':apiKey,'content-type':'application/json'},body:JSON.stringify({sender:{email:senderEmail,name:senderName},to:[{email,name:name||email}],subject:'SG FIBRA | Recuperação de acesso',htmlContent:`<div style="font-family:Arial;background:#f5f8fe;padding:32px"><div style="max-width:560px;margin:auto;background:#fff;padding:32px;border-radius:16px"><h1 style="color:#08172f">Recuperar acesso</h1><p>Olá, ${String(name||'').replace(/[<>&\"']/g,'')}!</p><p>Recebemos uma solicitação para redefinir a senha da sua conta na Central de Atendimento SG FIBRA.</p><p><a href="${link}" style="display:inline-block;background:#0866f5;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none">Redefinir minha senha</a></p><p>Este link é válido por 20 minutos e pode ser usado uma única vez.</p><p>Se você não solicitou essa alteração, ignore esta mensagem.</p></div></div>`})});
  if(!response.ok) { const result=await response.json().catch(()=>({})); throw Object.assign(new Error('Não foi possível enviar o e-mail de recuperação.'),{status:502,providerStatus:response.status,providerCode:String(result.code||'brevo_rejected').slice(0,80)}); }
  return true;
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
const selectedTransport = async company => {
  try{return (await db.one('select whatsapp_transport from public.company_settings where company_id=$1',[company]))?.whatsapp_transport || 'baileys';}
  catch(error){if(error.code==='42703')return 'baileys';throw error;}
};
const metaAccessToken = () => process.env.META_ACCESS_TOKEN || process.env.META_PERMANENT_ACCESS_TOKEN || process.env.META_TOKEN || process.env.WHATSAPP_CLOUD_API_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN || '';
const metaPhoneNumberId = () => process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_NUMBER_ID || '';
const metaApiVersion = () => String(process.env.META_GRAPH_API_VERSION || process.env.META_API_VERSION || '25.0').replace(/^v/i,'');
const metaApiConfigured = () => Boolean(metaAccessToken() && metaPhoneNumberId() && /^\d+\.\d+$/.test(metaApiVersion()));
async function metaSendMessage({phone,text,options=[],nodeId='',flowVersionId='',replyTo}) {
  const token=metaAccessToken(),phoneNumberId=metaPhoneNumberId(),version=metaApiVersion();
  if(!token||!phoneNumberId||!/^\d+\.\d+$/.test(version))throw Object.assign(new Error('Cloud API não configurada: confira o token, Phone Number ID e versão da Graph API no ambiente do Render.'),{status:503});
  if(!/^55\d{10,11}$/.test(String(phone||'')))throw Object.assign(new Error('A Cloud API exige o telefone do contato no formato internacional E.164.'),{status:409});
  const built=buildMetaMessage(phone,{text,options,nodeId,flowVersionId}),body=built.payload;
  if(replyTo)body.context={message_id:String(replyTo)};
  let response;
  try{response=await fetch(`https://graph.facebook.com/v${version}/${phoneNumberId}/messages`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20_000)});}
  catch(error){throw Object.assign(new Error('Resultado do envio Cloud API desconhecido; não repita automaticamente.'),{status:502,uncertain:true,cause:error});}
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(result.error?.error_user_msg||result.error?.message||'A Meta recusou o envio.'),{status:response.status,metaCode:result.error?.code||null});
  const messageId=String(result.messages?.[0]?.id||'');
  if(!messageId)throw Object.assign(new Error('A Meta não retornou um identificador de mensagem.'),{status:502,uncertain:true});
  return {messageId,accepted:true,mode:built.mode};
}
const metaSendText = payload => metaSendMessage(payload);
let currentAgentName = '';
async function sendOnTransport(transport,company,payload){
  const outgoingText=currentAgentName&&payload.text?`Atendente ${currentAgentName}:\n\n${String(payload.text).replace(/^[^:\n]{1,120}:\s*\n\s*\n/,'')}`:payload.text;
  if(transport==='meta'){
    if(payload.attachment?.data)throw Object.assign(new Error('Envio de anexos pela Cloud API ainda não está habilitado. Selecione Baileys ou envie uma mensagem de texto.'),{status:501});
    return metaSendMessage({phone:payload.phone,text:outgoingText,replyTo:payload.reply?.provider_message_id});
  }
  return connectorSend({...payload,text:outgoingText});
}
async function sendOnSelectedTransport(company,payload){return sendOnTransport(await selectedTransport(company),company,payload);}
async function deliverMetaOutbox(outboxId){
  const item=await db.transaction(async tx=>{
    const row=await tx.one("select * from public.whatsapp_outbox where id=$1 and status='pending' for update skip locked",[outboxId]);
    if(!row)return null;
    return tx.one("update public.whatsapp_outbox set status='leased',attempts=attempts+1,updated_at=now() where id=$1 returning *",[row.id]);
  });
  if(!item)return;
  try{
    const interactive=typeof item.interactive_payload==='string'?JSON.parse(item.interactive_payload||'{}'):(item.interactive_payload||{});
    if(isInteractiveWindowExpired(interactive))throw Object.assign(new Error('A janela de atendimento da Meta expirou; não foi enviada mensagem interativa.'),{status:409});
    const sent=await metaSendMessage({phone:item.to_phone,text:item.body,options:interactive.options||[],nodeId:interactive.nodeId||'',flowVersionId:interactive.flowVersionId||''});
    await db.transaction(async tx=>{
      await tx.query("update public.whatsapp_outbox set status='sent',provider_message_id=$1,last_error=null,updated_at=now() where id=$2",[sent.messageId,item.id]);
      await tx.query("update public.messages set provider_message_id=$1,delivery_status='sent',error_message=null where company_id=$2 and id=$3",[sent.messageId,item.company_id,item.idempotency_key.replace(/^meta-message:/,'')]);
    });
  }catch(error){
    const state=error.uncertain?'unknown':'failed';
    await db.transaction(async tx=>{
      await tx.query('update public.whatsapp_outbox set status=$1,last_error=$2,updated_at=now() where id=$3',[state,String(error.message||'Falha Cloud API').slice(0,500),item.id]);
      await tx.query('update public.messages set delivery_status=$1,error_message=$2 where company_id=$3 and id=$4',[state,String(error.message||'Falha Cloud API').slice(0,500),item.company_id,item.idempotency_key.replace(/^meta-message:/,'')]);
    });
  }
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
async function executePublishedFlow(tx,company,c,input,initialVariables={}){
  if(c.assigned_profile_id)return null;
  let run=await tx.one('select * from public.flow_runs where company_id=$1 and conversation_id=$2 for update',[company,c.id]);
  if(run?.status!=='active'&&run){
    if(c.status==='waiting'){
      const ahead=await tx.one("select count(*)::int count from public.conversations where company_id=$1 and status='waiting' and assigned_profile_id is null and id<>$2 and coalesce(human_started_at,created_at)<coalesce($3,now())",[company,c.id,c.human_started_at]);
      const count=Math.max(0,Number(ahead?.count||0));
      return {reply:`Aguarde seu atendente. Você tem ${count} pessoa(s) na sua frente.`,outbound:[{text:`Aguarde seu atendente. Você tem ${count} pessoa(s) na sua frente.`,options:[]}],queued:true};
    }
    return {reply:null,queued:false};
  }
  if(!run){
    const version=await tx.one("select f.id flow_id,v.id version_id from public.automation_flows f join public.automation_flow_versions v on v.flow_id=f.id and v.version=f.published_version where f.company_id=$1 and f.status='published' order by f.updated_at desc limit 1",[company]);
    if(!version)return null;
    run=await tx.one("insert into public.flow_runs(conversation_id,company_id,flow_id,version_id,status,variables) values($1,$2,$3,$4,'active',$5) returning *",[c.id,company,version.flow_id,version.version_id,initialVariables]);
  }
  const version=await tx.one('select definition from public.automation_flow_versions where company_id=$1 and id=$2',[company,run.version_id]);
  if(!version)return {reply:null,queued:false};
  const result=advanceFlow(version.definition,{nodeId:run.node_id,steps:run.steps,variables:run.variables},run.node_id?input:null);
  await tx.query('update public.flow_runs set node_id=$1,steps=$2,variables=$3,status=$4,updated_at=now() where company_id=$5 and conversation_id=$6',[result.nodeId,result.steps,result.variables,result.finished?'finished':'active',company,c.id]);
  if(result.transfer)await tx.query("update public.conversations set department_id=$1,assigned_profile_id=$2,status='waiting',human_started_at=coalesce(human_started_at,now()),updated_at=now() where company_id=$3 and id=$4",[result.transfer.departmentId,result.transfer.profileId,company,c.id]);
  const reachedEnd=result.executed.some(nodeId=>version.definition.nodes.some(node=>node.id===nodeId&&node.type==='end'));
  if(reachedEnd)await tx.query("update public.conversations set status='waiting',assigned_profile_id=null,closed_at=null,human_started_at=coalesce(human_started_at,now()),updated_at=now() where company_id=$1 and id=$2",[company,c.id]);
  const invoiceRequested=/segunda\s*via|fatura|boleto/i.test(String(result.lastReply||''));
  if(invoiceRequested){
    const sgpResult=await sgp.lookup(company,c.contact_phone);
    const items=(sgpResult.customer?.invoices?.items||[]).filter(item=>item?.id&&item?.dueDate).sort((a,b)=>String(a.dueDate).localeCompare(String(b.dueDate))).slice(-2);
    const invoiceLines=[];
    for(const item of items){
      try{const doc=await sgp.invoice(company,item.id);invoiceLines.push(`Fatura com vencimento em ${item.dueDate}:\n${doc.barcode?`Código de barras: ${doc.barcode}\n`:''}Boleto: ${doc.link}`);}catch{invoiceLines.push(`Fatura com vencimento em ${item.dueDate}: ${new URL('/admin/financeiro/titulo/print/documento/?q='+encodeURIComponent(item.id),process.env.SGP_BASE_URL).toString()}`);}
    }
    const text=invoiceLines.length?`Segue sua 2ª via:\n\n${invoiceLines.join('\n\n')}`:'Não localizei faturas vencidas ou próximas do vencimento no SGP.';
    result.output.push({type:'message',text,options:[]});
    await tx.query("update public.conversations set status='closed',assigned_profile_id=null,closed_at=now(),updated_at=now() where company_id=$1 and id=$2",[company,c.id]);
    result.transfer=null; result.finished=true;
  }
  if(result.transfer||reachedEnd){
    const ahead=await tx.one("select count(*)::int count from public.conversations where company_id=$1 and status='waiting' and assigned_profile_id is null and id<>$2 and coalesce(human_started_at,created_at)<now()",[company,c.id]);
    const count=Math.max(0,Number(ahead?.count||0));
    result.output.push({type:'message',text:`Seu atendimento foi encaminhado para a fila. Há ${count} pessoa(s) na sua frente.`,options:[]});
  }
  const outbound=result.output.filter(item=>item.type==='message').map(item=>({text:item.text,options:item.options||[],nodeId:item.nodeId||null,flowVersionId:run.version_id}));
  const reply=outbound.map(item=>formatNumberedOptions(item.text,item.options)).join('\n\n');
  return {reply:reply||null,outbound,selectedOption:result.lastReply||null,queued:Boolean(result.transfer||reachedEnd)};
}
async function sendConversationNotice(company, selected, session, text, options=[]){
  const messageId=randomUUID();
  const agentName=String(session.profile.display_name||session.profile.name||'Atendente').trim();
  currentAgentName=agentName;
  const bodyText=`Atendente ${agentName}:\n\n${text}`;
  await db.query("insert into public.messages(id,company_id,conversation_id,profile_id,body,direction,delivery_status) values($1,$2,$3,$4,$5,'outbound','pending')",[messageId,company,selected.id,session.profile.id,bodyText]);
  try{
    const transport=selected.transport||await selectedTransport(company);
    const sent=transport==='meta'
      ? await metaSendMessage({phone:selected.contact_phone,text:bodyText,options,nodeId:'rating',flowVersionId:'system'})
      : await sendOnTransport(transport,company,{phone:selected.contact_phone,jid:selected.channel_address,text,correlation_id:messageId});
    await db.query("update public.messages set provider_message_id=$1,delivery_status='sent',error_message=null where company_id=$2 and id=$3",[sent.messageId||null,company,messageId]);
  }catch(error){
    await db.query("update public.messages set delivery_status='failed',error_message=$1 where company_id=$2 and id=$3",[String(error.message||'Falha no envio').slice(0,500),company,messageId]);
    throw error;
  }
  return messageId;
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
    const expectedPhoneId=metaPhoneNumberId();
    if(expectedPhoneId&&entries.some(entry=>(entry.changes||[]).some(change=>change.value?.metadata?.phone_number_id&&String(change.value.metadata.phone_number_id)!==expectedPhoneId)))return json(response,403,{error:'Phone Number ID não autorizado.'});
    const companyTransport=await selectedTransport(company),initialVariablesByProvider=new Map();
    if(companyTransport==='meta'){
      for(const entry of entries)for(const change of (entry.changes||[]))for(const message of (change.value?.messages||[])){
        if(message.type!=='text')continue;
        const providerId=String(message.id||''),phone=String(message.from||'').replace(/\D/g,'');
        if(!providerId||!phone||await db.one('select event_id from public.connector_events where event_id=$1',[`message:${providerId}`]))continue;
        const existingRun=await db.one("select c.id,c.assigned_profile_id,fr.status run_status from public.conversations c left join public.flow_runs fr on fr.company_id=c.company_id and fr.conversation_id=c.id where c.company_id=$1 and (c.contact_phone=$2 or c.channel_address=$3) and c.status<>'closed' order by c.updated_at desc limit 1",[company,phone,`${phone}@s.whatsapp.net`]);
        const active=await db.one("select id from public.automation_flows where company_id=$1 and status='published' limit 1",[company]);
        if(active&&!existingRun?.assigned_profile_id&&!existingRun?.run_status){
          const sgpResult=await sgp.lookup(company,phone),services=sgpResult.status==='found'?sgpResult.customer?.contracts?.flatMap(contract=>contract.services||[])||[]:[],internet=services.find(service=>service.type==='internet')||null,invoices=sgpResult.status==='found'?sgpResult.customer?.invoices:null;
          initialVariablesByProvider.set(providerId,{client_found:sgpResult.status==='found',client_name:sgpResult.status==='found'?String(sgpResult.customer?.name||'').slice(0,120):'',client_lookup_status:sgpResult.status,internet_online:internet?.online??null,fiber_rx_dbm:internet?.rxDbm??null,fiber_tx_dbm:internet?.txDbm??null,open_invoice_count:invoices?.count??null,overdue_invoice_count:invoices?.overdue??null});
        }
      }
    }
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
          const inbound=parseMetaInbound(message);
          const text=inbound?.displayText||`[Mensagem ${message.type||'não suportada'}]`;
          if (!phone || !text) continue;
          const ratingValue=/^rating_[1-3]$/.test(String(inbound?.optionId||''))?Number(String(inbound.optionId).slice(-1)):Number(String(text).trim());
          if(Number.isInteger(ratingValue)&&ratingValue>=1&&ratingValue<=3){
            const rated=await tx.one("select c.id,c.protocol,null::text as closed_by_profile_id from public.conversations c left join public.conversation_ratings r on r.conversation_id=c.id where c.company_id=$1 and c.contact_phone=$2 and c.status='closed' and r.id is null and c.closed_at>now()-interval '24 hours' order by c.closed_at desc limit 1",[company,phone]);
            if(rated){try{await tx.query('insert into public.conversation_ratings(id,company_id,conversation_id,profile_id,protocol,stars) values($1,$2,$3,$4,$5,$6) on conflict(conversation_id) do nothing',[randomUUID(),company,rated.id,rated.closed_by_profile_id||null,rated.protocol,ratingValue]);}catch(error){if(error.code!=='42703')throw error;await tx.query('insert into public.conversation_ratings(id,company_id,conversation_id,protocol,stars) values($1,$2,$3,$4,$5) on conflict(conversation_id) do nothing',[randomUUID(),company,rated.id,rated.protocol,ratingValue]);}processed++;continue;}
          }
          const justClosed=await tx.one("select id from public.conversations where company_id=$1 and contact_phone=$2 and status='closed' and closed_at>now()-interval '1 minute' order by closed_at desc limit 1",[company,phone]);
          if(justClosed) { processed++; continue; }
          let c = await tx.one("select * from public.conversations where company_id=$1 and contact_phone=$2 and status<>'closed' order by updated_at desc limit 1 for update", [company, phone]);
          const provider=c?.transport||companyTransport;
          if((!c&&companyTransport!=='meta')||(c&&provider!=='meta')){processed++;continue;}
          if (!c) {
            const department = await tx.one('select id from public.departments where company_id=$1 order by id limit 1', [company]);
            if (!department) continue;
            const id = randomUUID();
            const protocol = (await tx.one('select public.next_protocol($1) protocol', [company])).protocol;
            c = await tx.one("insert into public.conversations(id,company_id,department_id,contact_name,contact_phone,channel_address,subject,status,priority,queue_type,protocol,transport,human_started_at) values($1,$2,$3,$4,$5,$6,'WhatsApp','waiting','normal',$3,$7,'meta',case when not exists(select 1 from public.automation_flows where company_id=$2 and status='published') then now() end) returning *", [id, company, department.id, value.contacts?.[0]?.profile?.name || phone, phone, `${phone}@s.whatsapp.net`, protocol]);
          }
          await tx.query("insert into public.messages(id,company_id,conversation_id,body,direction,provider_message_id,delivery_status) values($1,$2,$3,$4,'inbound',$5,'received') on conflict (provider_message_id) do nothing", [randomUUID(), company, c.id, text, providerId]);
          await tx.query('update public.conversations set updated_at=now() where company_id=$1 and id=$2', [company, c.id]);
          if(provider==='meta'&&!inbound?.unsupported&&!c.assigned_profile_id&&c.status!=='closed'){
            const flowInput=inbound?.kind==='option'?inbound:(inbound?.value||text);
            const graphReply=await executePublishedFlow(tx,company,c,flowInput,initialVariablesByProvider.get(providerId)||{});
            if(inbound?.kind==='option'&&graphReply?.selectedOption)await tx.query('update public.messages set body=$1 where company_id=$2 and provider_message_id=$3',[graphReply.selectedOption,company,providerId]);
            const deliveries=graphReply?.outbound?.length?graphReply.outbound:(graphReply?.reply?[{text:graphReply.reply,options:[]}]:[]);
            for(const delivery of deliveries){
              const messageId=randomUUID(),outboxId=randomUUID(),historyBody=formatNumberedOptions(delivery.text,delivery.options),messageTimestamp=Number(message.timestamp),receivedAt=Number.isFinite(messageTimestamp)&&messageTimestamp>0?messageTimestamp*1000:Date.now(),interactive={options:delivery.options||[],nodeId:delivery.nodeId||'',flowVersionId:delivery.flowVersionId||'',windowExpiresAt:new Date(receivedAt+24*60*60*1000).toISOString()};
              await tx.query("insert into public.messages(id,company_id,conversation_id,body,direction,delivery_status) values($1,$2,$3,$4,'outbound','pending')",[messageId,company,c.id,historyBody]);
              await tx.query("insert into public.whatsapp_outbox(id,company_id,conversation_id,idempotency_key,to_phone,body,interactive_payload) values($1,$2,$3,$4,$5,$6,$7) on conflict(company_id,idempotency_key) do nothing",[outboxId,company,c.id,`meta-message:${messageId}`,phone,String(delivery.text||''),interactive]);
            }
          }
          processed++;
        }
      }
    });
    const pendingMetaReplies=await db.query("select id from public.whatsapp_outbox where company_id=$1 and status='pending' and idempotency_key like 'meta-message:%' and created_at>now()-interval '5 minutes' order by created_at limit 20",[company]);
    for(const item of pendingMetaReplies)await deliverMetaOutbox(item.id);
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
  if (request.method === 'POST' && url.pathname === '/api/recover-password') {
    const input=await body(request),email=String(input.email||'').trim().toLowerCase();
    const generic={ok:true,message:'Se existir uma conta vinculada a este e-mail, enviaremos as instruções para recuperação de acesso.'};
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return json(response,200,generic);
    const profile=await db.one('select name,email,status from public.profiles where lower(email)=$1 and status not in (\'suspended\',\'revoked\') limit 1',[email]).catch(()=>null);
    if(!profile)return json(response,200,generic);
    let stage='supabase-link';
    try {
      if(profile&&process.env.BREVO_API_KEY){
        const base=String(process.env.APP_PUBLIC_URL||'').trim();
        const redirectTo=base?new URL('/',base).toString():undefined;
        const linkData=await authRequest('admin/generate_link','POST',{type:'recovery',email,...(redirectTo?{redirect_to:redirectTo}:{})},serviceKey,serviceKey);
        const link=String(linkData.action_link||linkData.properties?.action_link||'');
        if(link){stage='brevo-send';await sendBrevoRecovery(email,profile.name,link);}
        else {stage='supabase-recovery';await authRequest('recover','POST',{email,...(redirectTo?{redirect_to:redirectTo}:{})});}
      } else {stage='supabase-recovery';await authRequest('recover','POST',{email});}
      return json(response,200,generic);
    } catch(error) {
      console.error('[recovery] failed',JSON.stringify({stage,status:Number(error.status)||null,providerStatus:Number(error.providerStatus)||null,code:String(error.providerCode||error.code||'unknown').slice(0,80)}));
      return json(response,503,{ok:false,message:'Não foi possível enviar a recuperação agora. Tente novamente mais tarde.'});
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/recover-password/update') {
    const input=await body(request),password=String(input.password||'');
    if(password.length<8||password.length>128)return json(response,400,{error:'A nova senha deve ter entre 8 e 128 caracteres.'});
    const bearer=String(request.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if(!bearer)return json(response,401,{error:'Link de recuperação ausente ou expirado.'});
    try { await authRequest('user','PUT',{password},anonKey,bearer); return json(response,200,{ok:true}); }
    catch(error) { return json(response,400,{error:'Link de recuperação inválido ou expirado. Solicite um novo link.'}); }
  }
  if (request.method === 'POST' && url.pathname === '/api/internal/whatsapp/inbound') {
    if (!validConnector(request)) return json(response,401,{error:'Conector não autorizado.'});
    const input=await body(request), company=String(input.company_id||process.env.WHATSAPP_COMPANY_ID||''), phone=String(input.phone||'').replace(/\D/g,''), text=String(input.body||'').trim(),channelAddress=String(input.jid||'');
  if (!company || company !== process.env.WHATSAPP_COMPANY_ID || !phone || !text) return json(response,400,{error:'Empresa, telefone e mensagem são obrigatórios.'});
    const defaultTransport=await selectedTransport(company);
    const inboundProviderId=String(input.message_id||'')||null;
    if(inboundProviderId){const duplicate=await db.one('select conversation_id from public.messages where provider_message_id=$1',[inboundProviderId]);if(duplicate)return json(response,200,{ok:true,conversation_id:duplicate.conversation_id,reply:null,duplicate:true});}
    if(/^[1-3]$/.test(text)){
      const rated=await db.one("select c.id,c.protocol,c.contact_phone,c.channel_address,c.transport,null::text as closed_by_profile_id from public.conversations c left join public.conversation_ratings r on r.conversation_id=c.id where c.company_id=$1 and c.contact_phone=$2 and c.status='closed' and r.id is null and c.closed_at>now()-interval '24 hours' order by c.closed_at desc limit 1",[company,phone]).catch(()=>null);
      if(rated){try{await db.query('insert into public.conversation_ratings(id,company_id,conversation_id,profile_id,protocol,stars,comment) values($1,$2,$3,$4,$5,$6,$7) on conflict(conversation_id) do nothing',[randomUUID(),company,rated.id,rated.closed_by_profile_id||null,rated.protocol,Number(text),null]);}catch(error){if(error.code!=='42703')throw error;await db.query('insert into public.conversation_ratings(id,company_id,conversation_id,protocol,stars,comment) values($1,$2,$3,$4,$5,$6) on conflict(conversation_id) do nothing',[randomUUID(),company,rated.id,rated.protocol,Number(text),null]);}try{await sendOnTransport(rated.transport||defaultTransport,company,{phone:rated.contact_phone,jid:rated.channel_address,text:'Obrigado pela avaliação! Sua nota foi registrada.'});}catch{}return json(response,201,{ok:true,rating:Number(text),conversation_id:rated.id});}
    }
    const justClosed=await db.one("select id from public.conversations where company_id=$1 and contact_phone=$2 and status='closed' and closed_at>now()-interval '1 minute' order by closed_at desc limit 1",[company,phone]);
    if(justClosed)return json(response,202,{ok:true,ignored:true,reason:'Avaliação ou encerramento recente.'});
    // Look up SGP only when this conversation is about to start a robot run.
    // The adapter caches and coalesces requests; no SGP credentials/data leave the backend.
    const [activeFlow,existingRun]=await Promise.all([
      db.one("select id from public.automation_flows where company_id=$1 and status='published' limit 1",[company]),
      db.one("select c.id,c.transport,c.assigned_profile_id,fr.status as run_status from public.conversations c left join public.flow_runs fr on fr.company_id=c.company_id and fr.conversation_id=c.id where c.company_id=$1 and (c.channel_address=$2 or c.contact_phone=$3) and c.status<>'closed' order by c.updated_at desc limit 1",[company,channelAddress||null,phone])
    ]);
    const conversationTransport=existingRun?.transport||defaultTransport;
    if((existingRun&&conversationTransport!=='baileys')||(!existingRun&&defaultTransport!=='baileys'))return json(response,202,{ok:true,ignored:true,reason:'A conversa está vinculada a outro provedor WhatsApp.'});
    const shouldLookup=Boolean(activeFlow&&!existingRun?.assigned_profile_id&&!existingRun?.run_status);
    const sgpResult=shouldLookup?await sgp.lookup(company,phone):{status:'not_checked'};
    const sgpServices=(sgpResult.status==='found'?sgpResult.customer?.contracts||[]:[]).flatMap(contract=>contract.services||[]);
    const internetService=sgpServices.find(service=>service.type==='internet')||null;
    const invoiceSummary=sgpResult.status==='found'?sgpResult.customer?.invoices:null;
    const initialVariables={
      client_found:sgpResult.status==='found',
      client_name:sgpResult.status==='found'?String(sgpResult.customer?.name||'').slice(0,120):'',
      client_lookup_status:sgpResult.status,
      internet_online:internetService?.online??null,
      fiber_rx_dbm:internetService?.rxDbm??null,
      fiber_tx_dbm:internetService?.txDbm??null,
      open_invoice_count:invoiceSummary?.count??null,
      overdue_invoice_count:invoiceSummary?.overdue??null
    };
    const result=await db.transaction(async tx => {
      let c=await tx.one("select * from public.conversations where company_id=$1 and (channel_address=$2 or contact_phone=$3) and status<>'closed' order by updated_at desc limit 1 for update",[company,channelAddress||null,phone]);
      if(c&&(c.transport||defaultTransport)!=='baileys')return {conversation_id:c.id,protocol:c.protocol,reply:null,duplicate:false,ignored:true};
      if (!c&&defaultTransport!=='baileys')return {conversation_id:null,reply:null,duplicate:false,ignored:true};
      if (!c) { const d=await tx.one('select id from public.departments where company_id=$1 order by id limit 1',[company]); if (!d) throw Object.assign(new Error('Empresa sem fila.'),{status:409});
        const id=randomUUID(), protocol=(await tx.one('select public.next_protocol($1) protocol',[company])).protocol;
        c=await tx.one("insert into public.conversations(id,company_id,department_id,contact_name,contact_phone,channel_address,subject,status,priority,queue_type,protocol,transport,human_started_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'baileys',case when not exists(select 1 from public.automation_flows where company_id=$2 and status='published') then now() end) returning *",[id,company,d.id,input.name||phone,phone,channelAddress||null,'WhatsApp','waiting','normal',d.id,protocol]); }
      else if(channelAddress&&!c.channel_address){c=await tx.one('update public.conversations set channel_address=$1,contact_phone=case when length($2) between 10 and 15 then $2 else contact_phone end,updated_at=now() where company_id=$3 and id=$4 returning *',[channelAddress,phone,company,c.id]);}
      const providerId=inboundProviderId;
      if (providerId && await tx.one('select id from public.messages where provider_message_id=$1',[providerId])) return {conversation_id:c.id,protocol:c.protocol,reply:null,duplicate:true};
      await tx.query("insert into public.messages(id,company_id,conversation_id,body,direction,provider_message_id,delivery_status) values($1,$2,$3,$4,$5,$6,'received')",[randomUUID(),company,c.id,text,'inbound',providerId]);
      if(sgpResult.status==='found'&&!c.assigned_profile_id) await tx.query("update public.conversations set contact_name=$1 where company_id=$2 and id=$3 and (contact_name is null or contact_name='' or contact_name=contact_phone)",[String(sgpResult.customer?.name||phone).slice(0,180),company,c.id]);
      const graphReply=await executePublishedFlow(tx,company,c,text,initialVariables);
      if(graphReply)return {conversation_id:c.id,protocol:c.protocol,...graphReply};
      const settings=await tx.one('select * from public.automation_settings where company_id=$1',[company]);
      if (c.assigned_profile_id || c.status==='closed' || !settings) return {conversation_id:c.id,protocol:c.protocol,reply:null};
      const attempts=c.bot_attempts+1, financial=/financeiro|fatura|segunda via|boleto/i.test(text), queued=financial||attempts>=settings.max_attempts;
      const target=financial?await tx.one("select id from public.departments where company_id=$1 and name ilike '%financeiro%' limit 1",[company]):null;
      await tx.query("update public.conversations set department_id=$1,status=$2,bot_attempts=$3,human_started_at=case when $2='waiting' then coalesce(human_started_at,now()) else human_started_at end,updated_at=now() where company_id=$4 and id=$5",[target?.id||c.department_id,queued?'waiting':'open',attempts,company,c.id]);
      return {conversation_id:c.id,protocol:c.protocol,reply:queued?settings.fallback_message:settings.welcome_message,queued};
    });
    return json(response,201,{ok:true,...result});
  }
  if (request.method === 'POST' && url.pathname === '/api/internal/whatsapp/outbound') { if (!validConnector(request)) return json(response,401,{error:'Conector não autorizado.'}); const input=await body(request); const company=String(input.company_id||process.env.WHATSAPP_COMPANY_ID||''); if (company!==process.env.WHATSAPP_COMPANY_ID) return json(response,403,{error:'Empresa não autorizada.'}); const c=await conversation(company,String(input.conversation_id||'')); if (!c) return json(response,404,{error:'Conversa não encontrada.'}); const provider=String(input.message_id||'')||null; const existing=provider&&await db.one('select id from public.messages where provider_message_id=$1',[provider]); if (existing) return json(response,200,{ok:true,message_id:existing.id,delivery:'sent'}); const id=randomUUID(); await db.query('insert into public.messages(id,company_id,conversation_id,body,direction,provider_message_id) values($1,$2,$3,$4,$5,$6)',[id,company,c.id,String(input.body||''),'outbound',provider]); return json(response,201,{ok:true,message_id:id,delivery:'sent'}); }
  if(request.method==='POST'&&url.pathname==='/api/internal/whatsapp/delivery'){if(!validConnector(request))return json(response,401,{error:'Conector não autorizado.'});const input=await body(request),company=String(input.company_id||'');if(company!==process.env.WHATSAPP_COMPANY_ID)return json(response,403,{error:'Empresa não autorizada.'});const status=['sent','delivered','read'].includes(input.status)?input.status:'sent';await db.query('update public.messages set delivery_status=$1 where company_id=$2 and provider_message_id=$3',[status,company,String(input.message_id||'')]);return json(response,200,{ok:true});}
  const session=await sessionFor(request); if (!session) return json(response,401,{error:'Sessão expirada.'});
  if(request.method==='POST'&&/\/api\/conversations\/[^/]+\/messages$/.test(url.pathname)) currentAgentName=String(session.profile.display_name||session.profile.name||'Atendente').trim();
  const company=session.profile.company_id, pieces=url.pathname.split('/').filter(Boolean);
  if(request.method==='GET'&&pieces[0]==='api'&&pieces[1]==='attachments'&&pieces[2]){
    const message=await db.one('select attachment_path,attachment_type,attachment_name from public.messages where company_id=$1 and id=$2',[company,pieces[2]]);
    if(!message?.attachment_path)return json(response,404,{error:'Anexo não encontrado.'});
    const upstream=await fetch(`${supabaseUrl}/storage/v1/object/authenticated/chat-attachments/${message.attachment_path}`,{headers:{apikey:serviceKey,authorization:`Bearer ${serviceKey}`}});
    if(!upstream.ok)return json(response,upstream.status,{error:'Anexo indisponível.'});
    response.writeHead(200,{'content-type':message.attachment_type||'application/octet-stream','content-disposition':`inline; filename="${String(message.attachment_name||'arquivo').replace(/["\r\n]/g,'')}"`});
    return response.end(Buffer.from(await upstream.arrayBuffer()));
  }
  if (url.pathname.startsWith('/api/whatsapp/') && url.pathname !== '/api/whatsapp/transport') return admin(session) ? proxyWhatsApp(request,response,company) : json(response,403,{error:'Somente supervisores podem gerenciar a conexão.'});
  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    const [companyRow,conversations,departments,replies,robot]=await Promise.all([
      db.one('select * from public.companies where id=$1',[company]),
      db.query("select c.*,d.name department_name,p.name assignee_name,(select body from public.messages m where m.conversation_id=c.id order by created_at desc limit 1) last_message from public.conversations c join public.departments d on d.id=c.department_id left join public.profiles p on p.id=c.assigned_profile_id where c.company_id=$1 order by case c.status when 'waiting' then 0 else 1 end,c.updated_at desc",[company]),
      db.query('select * from public.departments where company_id=$1',[company]),db.query('select * from public.quick_replies where company_id=$1 order by shortcut',[company]),db.one("select exists(select 1 from public.automation_flows where company_id=$1 and status='published') enabled",[company])]);
    return json(response,200,{profile:session.profile,company:companyRow,conversations,departments,quickReplies:replies,robotEnabled:Boolean(robot?.enabled)});
  }
  if (request.method === 'GET' && url.pathname === '/api/settings') { const [profiles,departments,settings,replies,whatsappTransport,ratingStats]=await Promise.all([db.query('select id,name,email,role,status from public.profiles where company_id=$1 order by name',[company]),db.query('select * from public.departments where company_id=$1 order by name',[company]),db.one('select * from public.automation_settings where company_id=$1',[company]),db.query('select * from public.quick_replies where company_id=$1 order by shortcut',[company]),selectedTransport(company),db.query("select p.id,p.name,count(r.id)::int rated_count,coalesce(sum(r.stars),0)::int stars_total,coalesce(round(avg(r.stars),2),0)::numeric average_stars from public.profiles p left join public.conversation_ratings r on r.company_id=$1 and r.profile_id=p.id where p.company_id=$1 group by p.id,p.name order by p.name",[company]).catch(()=>[]) ]); return json(response,200,{profiles,departments,settings,replies,whatsappTransport,ratingStats,metaApiConfigured:metaApiConfigured()}); }
  if (request.method === 'GET' && url.pathname === '/api/queue-monitor') {
    const [conversations,departments,profiles]=await Promise.all([
      db.query("select c.id,c.contact_name,c.contact_phone,c.status,c.assigned_profile_id,c.department_id,c.human_started_at,c.created_at,c.updated_at,c.priority,c.protocol,d.name department_name,p.name assignee_name,exists(select 1 from public.flow_runs fr where fr.company_id=c.company_id and fr.conversation_id=c.id and fr.status='active') robot_active from public.conversations c join public.departments d on d.id=c.department_id left join public.profiles p on p.id=c.assigned_profile_id where c.company_id=$1",[company]),
      db.query('select id,name from public.departments where company_id=$1 order by name',[company]),
      db.query("select p.id,p.name,p.status,p.last_seen_at,count(c.id)::int assigned_count from public.profiles p left join public.conversations c on c.assigned_profile_id=p.id and c.company_id=p.company_id and c.status<>'closed' where p.company_id=$1 group by p.id,p.name,p.status,p.last_seen_at order by p.name",[company])
    ]);
    const active=conversations.filter(c=>c.status!=='closed'), waiting=active.filter(c=>c.status==='waiting'&&!c.assigned_profile_id), robot=active.filter(c=>c.robot_active), human=active.filter(c=>c.assigned_profile_id), now=Date.now();
    const queues=departments.map(d=>{const rows=active.filter(c=>c.department_id===d.id);const pending=rows.filter(c=>c.status==='waiting'&&!c.assigned_profile_id);const wait=pending.map(c=>Math.max(0,now-Date.parse(c.human_started_at||c.created_at))).filter(Number.isFinite);return {id:d.id,name:d.name,active:rows.length,waiting:pending.length,averageWaitMs:wait.length?Math.round(wait.reduce((a,b)=>a+b,0)/wait.length):0};});
    return json(response,200,{stats:{active:active.length,waiting:waiting.length,robot:robot.length,human:human.length,averageWaitMs:waiting.length?Math.round(waiting.map(c=>now-Date.parse(c.human_started_at||c.created_at)).reduce((a,b)=>a+b,0)/waiting.length):0},queues,waiting,profiles});
  }
  if(request.method==='PATCH'&&url.pathname==='/api/whatsapp/transport'){
    if(!admin(session))return json(response,403,{error:'Sem permissão.'});
    const input=await body(request),transport=String(input.transport||'');
    if(!['baileys','meta'].includes(transport))return json(response,400,{error:'Escolha Meta Cloud API ou Baileys.'});
    if(transport==='meta'&&!metaApiConfigured())return json(response,409,{error:'Configure no Render o token, Phone Number ID e META_GRAPH_API_VERSION antes de ativar a Cloud API.'});
    try{await db.query("insert into public.company_settings(company_id,whatsapp_transport) values($1,$2) on conflict(company_id) do update set whatsapp_transport=excluded.whatsapp_transport,updated_at=now()",[company,transport]);}
    catch(error){if(error.code==='42703')return json(response,503,{error:'Aplique a migration 009_whatsapp_transport.sql no Supabase para liberar a escolha do canal.'});throw error;}
    await audit(db,session,'whatsapp_transport_changed',company,'settings');
    return json(response,200,{ok:true,transport,metaApiConfigured:metaApiConfigured()});
  }
  if(request.method==='PATCH'&&url.pathname==='/api/profile'){const input=await body(request),display=String(input.display_name||'').trim();if(display.length<2||display.length>80)return json(response,400,{error:'Informe o nome que aparecerá nas mensagens (2 a 80 caracteres).'});await db.query('update public.profiles set display_name=$1,name=coalesce(nullif(name,\'\'),$1),phone=$2,last_seen_at=now() where company_id=$3 and id=$4',[display,String(input.phone||'').trim().slice(0,30)||null,company,session.profile.id]);return json(response,200,{ok:true});}
  if (request.method === 'POST' && url.pathname === '/api/agents') { if (!admin(session)) return json(response,403,{error:'Sem permissão.'}); const input=await body(request), name=String(input.name||'').trim(),email=String(input.email||'').trim().toLowerCase(),password=String(input.password||''),role=['agent','supervisor'].includes(input.role)?input.role:'agent'; if (name.length<2||name.length>80||!email.includes('@')||password.length<8) return json(response,400,{error:'Informe o nome que aparecerá nas mensagens, e-mail e senha de pelo menos 8 caracteres.'}); const user=await authRequest('admin/users','POST',{email,password,email_confirm:true},serviceKey); try { await db.transaction(async tx=>{ await tx.query('insert into public.profiles(id,company_id,auth_user_id,name,display_name,email,role,status) values($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),company,user.id,name,name,email,role,'available']); await audit(tx,session,'agent_created',user.id,'profile'); }); } catch(error) { await authRequest(`admin/users/${user.id}`,'DELETE',null,serviceKey).catch(()=>{}); throw error; } return json(response,201,{ok:true}); }
  if (request.method === 'POST' && url.pathname === '/api/queues') { if (!admin(session)) return json(response,403,{error:'Sem permissão.'}); const input=await body(request),name=String(input.name||'').trim(); if (!name) return json(response,400,{error:'Informe o nome da fila.'}); await db.transaction(async tx=>{ const id=randomUUID(); await tx.query('insert into public.departments(id,company_id,name) values($1,$2,$3)',[id,company,name]); await audit(tx,session,'queue_created',id,'department'); }); return json(response,201,{ok:true}); }
  if (request.method === 'POST' && url.pathname === '/api/automation') { if (!admin(session)) return json(response,403,{error:'Sem permissão.'}); const input=await body(request),welcome=String(input.welcome_message||'').trim(),fallback=String(input.fallback_message||'').trim(),attempts=Math.max(1,Math.min(5,Number(input.max_attempts)||2)); if (!welcome||!fallback) return json(response,400,{error:'Preencha as mensagens.'}); await db.transaction(async tx=>{ await tx.query('insert into public.automation_settings(company_id,welcome_message,fallback_message,max_attempts) values($1,$2,$3,$4) on conflict(company_id) do update set welcome_message=excluded.welcome_message,fallback_message=excluded.fallback_message,max_attempts=excluded.max_attempts',[company,welcome,fallback,attempts]); await audit(tx,session,'automation_updated',company,'automation'); }); return json(response,200,{ok:true}); }
  if (request.method === 'POST' && url.pathname === '/api/automation/toggle') { if (!admin(session)) return json(response,403,{error:'Sem permissão.'}); const input=await body(request); const enabled=input.enabled===true; const flow=await db.one("select id from public.automation_flows where company_id=$1 order by case status when 'published' then 0 when 'draft' then 1 else 2 end,updated_at desc limit 1",[company]); if(!flow)return json(response,409,{error:'Crie e publique um fluxo antes de ativar o robô.'}); await db.transaction(async tx=>{await tx.query("update public.automation_flows set status=$1,updated_at=now() where id=$2 and company_id=$3",[enabled?'published':'archived',flow.id,company]); await audit(tx,session,enabled?'automation_enabled':'automation_disabled',flow.id,'automation');}); return json(response,200,{ok:true,enabled}); }
  if (request.method === 'POST' && url.pathname === '/api/quick-replies') { if (!admin(session)) return json(response,403,{error:'Sem permissão.'}); const input=await body(request),shortcut=String(input.shortcut||'').trim(),reply=String(input.body||'').trim(); if (!shortcut.startsWith('/')||!reply) return json(response,400,{error:'Atalho e mensagem inválidos.'}); await db.query('insert into public.quick_replies(id,company_id,shortcut,body,department_id) values($1,$2,$3,$4,$5)',[randomUUID(),company,shortcut,reply,input.department_id||null]); return json(response,201,{ok:true}); }
  if(request.method==='POST'&&url.pathname==='/api/flows/sg-fibra/install'){
    if(!admin(session))return json(response,403,{error:'Sem permissão.'});
    const departments=await db.query('select id,name from public.departments where company_id=$1 order by name',[company]);
    if(!departments.length)return json(response,409,{error:'Cadastre ao menos uma fila antes de ativar o robô.'});
    const pick=pattern=>departments.find(item=>pattern.test(item.name))?.id||departments[0].id;
    const definition=sgFibraRobotFlow({supportDepartmentId:pick(/suporte|t[eé]cnic|reparo/i),financeDepartmentId:pick(/financeir|cobran/i),salesDepartmentId:pick(/venda|comercial/i)});
    const errors=validateFlow(definition,{departments});if(errors.length)return json(response,409,{error:errors.join(' ')});
    const result=await db.transaction(async tx=>{
      await tx.query('select pg_advisory_xact_lock(hashtext($1))',[company]);
      let target=await tx.one("select id,name from public.automation_flows where company_id=$1 and status='published' order by updated_at desc limit 1 for update",[company]);
      if(!target){target={id:randomUUID(),name:'Atendimento SG Fibra'};await tx.query("insert into public.automation_flows(id,company_id,name,status) values($1,$2,$3,'draft')",[target.id,company,target.name]);}
      await tx.query("update public.automation_flows set status='archived',updated_at=now() where company_id=$1 and id<>$2 and status in ('published','draft')",[company,target.id]);
      await tx.query("update public.automation_flow_versions set status='archived' where company_id=$1 and flow_id<>$2 and status in ('published','draft')",[company,target.id]);
      const next=await tx.one('select coalesce(max(version),0)+1 version from public.automation_flow_versions where company_id=$1 and flow_id=$2',[company,target.id]);
      await tx.query("update public.automation_flows set status='archived',updated_at=now() where company_id=$1 and status='published' and id<>$2",[company,target.id]);
      await tx.query("update public.automation_flow_versions set status='archived' where company_id=$1 and flow_id=$2 and status='published'",[company,target.id]);
      const versionId=randomUUID();
      await tx.query("insert into public.automation_flow_versions(id,company_id,flow_id,version,status,definition,published_at) values($1,$2,$3,$4,'published',$5,now())",[versionId,company,target.id,next.version,definition]);
      await tx.query("update public.automation_flows set status='published',published_version=$1,updated_at=now() where company_id=$2 and id=$3",[next.version,company,target.id]);
      await audit(tx,session,'robot_flow_activated',target.id,'automation');
      return {id:target.id,version:next.version};
    });
    return json(response,200,{ok:true,...result});
  }
  if (request.method === 'GET' && url.pathname === '/api/flows') return json(response,200,{flows:await db.query("select * from public.automation_flows where company_id=$1 and status<>'archived' order by case status when 'published' then 0 when 'draft' then 1 else 2 end,updated_at desc",[company])});
  if (request.method === 'POST' && url.pathname === '/api/flows') {
    if (!admin(session)) return json(response,403,{error:'Sem permissão.'});
    const input=await body(request),name=String(input.name||'').trim();
    if(!name)return json(response,400,{error:'Informe o nome do fluxo.'});
    const id=randomUUID();
    await db.transaction(async tx=>{
      await tx.query('insert into public.automation_flows(id,company_id,name) values($1,$2,$3)',[id,company,name]);
      await tx.query('insert into public.automation_flow_versions(id,company_id,flow_id,version,status,definition) values($1,$2,$3,1,$4,$5)',[randomUUID(),company,id,'draft',input.definition||newFlow()]);
    });
    return json(response,201,{id,version:1});
  }
  if (pieces[0]==='api' && pieces[1]==='flows' && pieces[2]) {
    const flow=await db.one('select * from public.automation_flows where id=$1 and company_id=$2',[pieces[2],company]);
    if(!flow)return json(response,404,{error:'Fluxo não encontrado.'});
    if(request.method==='GET')return json(response,200,{flow,versions:await db.query('select * from public.automation_flow_versions where company_id=$1 and flow_id=$2 order by version desc',[company,flow.id])});
    if(!admin(session))return json(response,403,{error:'Sem permissão.'});
    if(request.method==='POST'&&pieces[3]==='activate'){
      if(!flow.published_version)return json(response,409,{error:'Publique a versão validada antes de ativar o robô.'});
      await db.transaction(async tx=>{await tx.query('select pg_advisory_xact_lock(hashtext($1))',[company]);await tx.query("update public.automation_flows set status='archived',updated_at=now() where company_id=$1 and id<>$2 and status in ('published','draft')",[company,flow.id]);await tx.query("update public.automation_flow_versions set status='archived' where company_id=$1 and flow_id<>$2 and status in ('published','draft')",[company,flow.id]);await tx.query("update public.automation_flows set status='published',updated_at=now() where company_id=$1 and id=$2",[company,flow.id]);});
      return json(response,200,{ok:true,active:true});
    }
    if(request.method==='POST'&&pieces[3]==='disable'){await db.query("update public.automation_flows set status='archived',updated_at=now() where id=$1 and company_id=$2",[flow.id,company]);return json(response,200,{ok:true});}
    if((request.method==='POST'&&pieces[3]==='publish')||request.method==='PUT'){
      const input=await body(request),publish=pieces[3]==='publish';
      if(publish){const departments=await db.query('select id from public.departments where company_id=$1',[company]);const errors=validateFlow(input.definition,{departments});if(errors.length)return json(response,400,{error:errors.join(' ')});}
      const version=await db.transaction(async tx=>{
        const latest=await tx.one('select coalesce(max(version),0)+1 version from public.automation_flow_versions where flow_id=$1 and company_id=$2',[flow.id,company]);
        if(publish){await tx.query("update public.automation_flows set status='archived',updated_at=now() where company_id=$1 and id<>$2 and status in ('published','draft')",[company,flow.id]);await tx.query("update public.automation_flow_versions set status='archived' where company_id=$1 and flow_id<>$2 and status in ('published','draft')",[company,flow.id]);await tx.query("update public.automation_flow_versions set status='archived' where flow_id=$1 and company_id=$2 and status='published'",[flow.id,company]);}
        await tx.query('insert into public.automation_flow_versions(id,company_id,flow_id,version,status,definition,published_at) values($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),company,flow.id,latest.version,publish?'published':'draft',input.definition||{},publish?new Date():null]);
        await tx.query('update public.automation_flows set status=$1,published_version=$2,updated_at=now() where id=$3 and company_id=$4',[publish?'published':flow.status,publish?latest.version:flow.published_version,flow.id,company]);return latest.version;
      });
      return json(response,200,{ok:true,version});
    }
    if(request.method==='PUT')return json(response,200,{ok:true});
  }
  if(request.method==='POST'&&url.pathname==='/api/conversations'){
    const input=await body(request),raw=String(input.phone||'').replace(/\D/g,''),phone=raw.length===10||raw.length===11?'55'+raw:raw,name=String(input.name||'').trim()||phone;
    if(!/^55\d{10,11}$/.test(phone))return json(response,400,{error:'Informe DDD e número válidos.'});
    const transport=await selectedTransport(company);
    let created=await db.one("select * from public.conversations where company_id=$1 and contact_phone=$2 and status<>'closed' order by updated_at desc limit 1",[company,phone]);
    if(!created){const department=await db.one('select id from public.departments where company_id=$1 order by name limit 1',[company]);if(!department)return json(response,409,{error:'Cadastre uma fila antes de iniciar conversas.'});const id=randomUUID(),protocol=(await db.one('select public.next_protocol($1) protocol',[company])).protocol;created=await db.one("insert into public.conversations(id,company_id,department_id,contact_name,contact_phone,channel_address,subject,status,priority,queue_type,protocol,transport) values($1,$2,$3,$4,$5,$6,'WhatsApp','open','normal',$3,$7,$8) returning *",[id,company,department.id,name.slice(0,120),phone,phone+'@s.whatsapp.net',protocol,transport]);}
    return json(response,201,{conversation:created});
  }
  if (pieces[0]!=='api'||pieces[1]!=='conversations'||!pieces[2]) return json(response,404,{error:'Rota não encontrada.'});
  const selected=await conversation(company,pieces[2]); if (!selected) return json(response,404,{error:'Conversa não encontrada.'}); const id=selected.id;
    if (request.method==='GET'&&pieces.length===3) { const messages=await db.query("select m.*,case when m.direction='internal' then 'Nota interna' when m.direction='inbound' then 'Cliente' when m.profile_id is null then 'Atendimento automático' else coalesce(nullif(btrim(p.display_name),''),nullif(btrim(p.name),''),'Atendente') end author_name,to_char(m.created_at at time zone 'America/Sao_Paulo','HH24:MI') message_time,r.body reply_body from public.messages m left join public.profiles p on p.id=m.profile_id and p.company_id=m.company_id left join public.messages r on r.company_id=m.company_id and r.id=m.reply_to_id where m.company_id=$1 and m.conversation_id=$2 order by m.created_at",[company,id]); return json(response,200,{conversation:selected,messages}); }
  if(request.method==='POST'&&pieces.length===4&&pieces[3]==='send-invoice'){
    const requestInput=await body(request);
    if(selected.status==='closed'||selected.assigned_profile_id!==session.profile.id)return json(response,409,{error:'Assuma um atendimento aberto antes de enviar a fatura.'});
    const result=await sgp.lookup(company,selected.contact_phone),invoice=(result.customer?.invoices?.items||[]).find(item=>String(item.id)===String(requestInput.invoice_id));
    if(!invoice)return json(response,404,{error:'Fatura não encontrada ou já atualizada.'});
    const document=await sgp.invoice(company,invoice.id),agentName=String(session.profile.display_name||session.profile.name||'Atendente').trim();
    const barcode=document.barcode?`\n\nCódigo de barras:\n${document.barcode}`:'';
    const text=`Atendente ${agentName}:\n\nSegue sua fatura com vencimento em ${invoice.dueDate||'data não informada'}.${barcode}\n\nBoleto:\n${document.link}`;
    const messageId=randomUUID();
    await db.query("insert into public.messages(id,company_id,conversation_id,profile_id,body,direction,delivery_status) values($1,$2,$3,$4,$5,'outbound','pending')",[messageId,company,id,session.profile.id,text]);
    try{const sent=await sendOnTransport(selected.transport||await selectedTransport(company),company,{phone:selected.contact_phone,jid:selected.channel_address,text,correlation_id:messageId});await db.query("update public.messages set provider_message_id=$1,delivery_status='sent',error_message=null where company_id=$2 and id=$3",[sent.messageId||null,company,messageId]);return json(response,201,{ok:true,message_id:messageId,provider_message_id:sent.messageId||null});}
    catch(error){await db.query("update public.messages set delivery_status='failed',error_message=$1 where company_id=$2 and id=$3",[String(error.message||'Falha no envio').slice(0,500),company,messageId]);throw error;}
  }
  if(request.method==='GET'&&pieces.length===4&&pieces[3]==='sgp'){ response.setHeader('Cache-Control','no-store'); return json(response,200,await sgp.lookup(company,selected.contact_phone)); }
  if(request.method==='GET'&&pieces.length===4&&pieces[3]==='history'){ const history=await db.query("select c.id,c.protocol,c.status,c.created_at started_at,c.closed_at,c.department_id,d.name department_name,(select count(*)::int from public.messages m where m.company_id=c.company_id and m.conversation_id=c.id) message_count,(select body from public.messages m where m.company_id=c.company_id and m.conversation_id=c.id order by m.created_at desc limit 1) last_message from public.conversations c join public.departments d on d.id=c.department_id where c.company_id=$1 and c.contact_phone=$2 and c.id<>$3 order by c.created_at desc",[company,selected.contact_phone,id]); return json(response,200,{history}); }
  const action=pieces[3],input=await body(request);
  if(request.method==='POST'&&action==='messages'&&String(session.profile.display_name||'').trim().length<2)return json(response,409,{error:'Antes de enviar, configure seu nome de atendente em Configurações → Meu nome no atendimento.'});
  if (request.method==='POST'&&action==='messages') { if(selected.status==='closed') return json(response,409,{error:'Este atendimento está encerrado e não aceita novas mensagens.'}); if(selected.assigned_profile_id!==session.profile.id) return json(response,409,{error:'Clique em Assumir atendimento antes de enviar mensagens.'}); const text=String(input.body||'').trim(),attachment=input.attachment||null; if (!text&&!attachment?.data) return json(response,400,{error:'Escreva uma mensagem ou anexe um arquivo.'}); const channelAddress=String(selected.channel_address||''); if(!/^55\d{10,11}$/.test(String(selected.contact_phone||''))&&!/@(?:s\.whatsapp\.net|lid)$/i.test(channelAddress))return json(response,409,{error:'Confirme o identificador do WhatsApp antes de enviar.'}); const transport=selected.transport||await selectedTransport(company); if(transport==='meta'&&attachment?.data)return json(response,501,{error:'Envio de anexos pela Cloud API ainda não está habilitado. Selecione Baileys ou envie uma mensagem de texto.'}); const reply=input.reply_to_id?await db.one('select id,body,provider_message_id from public.messages where company_id=$1 and conversation_id=$2 and id=$3',[company,id,input.reply_to_id]):null; const messageId=randomUUID(); const outboundText=text?`${String(selected.contact_name||'Cliente').trim()}:\n\n${text}`:text; const stored=await storeAttachment(company,id,messageId,attachment); await db.transaction(async tx=>{await tx.query("update public.flow_runs set status='paused',updated_at=now() where company_id=$1 and conversation_id=$2",[company,id]);await tx.query("insert into public.messages(id,company_id,conversation_id,profile_id,body,direction,reply_to_id,attachment_path,attachment_name,attachment_type,delivery_status) values($1,$2,$3,$4,$5,'outbound',$6,$7,$8,$9,'pending')",[messageId,company,id,session.profile.id,outboundText,reply?.id||null,stored?.path||null,stored?.name||null,stored?.type||null]);await tx.query("update public.conversations set status='open',updated_at=now(),human_started_at=coalesce(human_started_at,now()) where id=$1 and company_id=$2",[id,company]);}); try{const sent=await sendOnTransport(transport,company,{phone:selected.contact_phone,jid:channelAddress,text:outboundText,correlation_id:messageId,attachment,reply:reply?{body:reply.body,provider_message_id:reply.provider_message_id}:null});await db.transaction(async tx=>{await tx.query("update public.messages set provider_message_id=$1,delivery_status='sent',error_message=null where company_id=$2 and id=$3",[sent.messageId||null,company,messageId]);await audit(tx,session,'message_sent',id);});return json(response,201,{ok:true,message_id:messageId,provider_message_id:sent.messageId||null,status:'sent',transport});}catch(error){await db.query("update public.messages set delivery_status=$1,error_message=$2 where company_id=$3 and id=$4",[error.uncertain?'unknown':'failed',String(error.message||'Falha no envio').slice(0,500),company,messageId]);throw error;} }
  if(request.method==='POST'&&action==='internal-notes'){const text=String(input.body||'').trim();if(!text)return json(response,400,{error:'Escreva a anotação interna.'});const noteId=randomUUID();await db.transaction(async tx=>{await tx.query("insert into public.messages(id,company_id,conversation_id,profile_id,body,direction,delivery_status) values($1,$2,$3,$4,$5,'internal','internal')",[noteId,company,id,session.profile.id,text]);await tx.query('insert into public.internal_notes(id,company_id,conversation_id,profile_id,body) values($1,$2,$3,$4,$5)',[noteId,company,id,session.profile.id,text]);await audit(tx,session,'internal_note_created',id);});return json(response,201,{ok:true});}
  if(request.method==='PATCH'&&action==='contact'){const name=String(input.name||'').trim(),raw=String(input.phone||selected.contact_phone||'').replace(/\D/g,''),phone=raw.length===10||raw.length===11?'55'+raw:raw;if(!name)return json(response,400,{error:'Informe o nome do contato.'});if(!/^55\d{10,11}$/.test(phone))return json(response,400,{error:'Informe DDD e número válidos.'});await db.query('update public.conversations set contact_name=$1,contact_phone=$2,channel_address=$3,updated_at=now() where company_id=$4 and id=$5',[name.slice(0,120),phone,phone+'@s.whatsapp.net',company,id]);return json(response,200,{ok:true});}
  if (request.method==='POST'&&action==='simulate') { const text=String(input.body||'').trim(); if (!text) return json(response,400,{error:'Escreva a mensagem simulada.'}); await db.transaction(async tx=>{ const c=await tx.one('select * from public.conversations where id=$1 and company_id=$2 for update',[id,company]); await tx.query('insert into public.messages(id,company_id,conversation_id,body,direction) values($1,$2,$3,$4,$5)',[randomUUID(),company,id,text,'inbound']); if (c.assigned_profile_id) return; const graphReply=await executePublishedFlow(tx,company,c,text); if(graphReply){if(graphReply.reply)await tx.query('insert into public.messages(id,company_id,conversation_id,body,direction) values($1,$2,$3,$4,$5)',[randomUUID(),company,id,graphReply.reply,'outbound']);return;} const settings=await tx.one('select * from public.automation_settings where company_id=$1',[company]); if (!settings) return; const attempts=c.bot_attempts+1,financial=/financeiro|fatura|segunda via|boleto/i.test(text),queued=financial||attempts>=settings.max_attempts; const target=financial?await tx.one("select id from public.departments where company_id=$1 and name ilike '%financeiro%' limit 1",[company]):null; await tx.query("update public.conversations set department_id=$1,status=$2,bot_attempts=$3,human_started_at=case when $2='waiting' then coalesce(human_started_at,now()) else human_started_at end,updated_at=now() where id=$4 and company_id=$5",[target?.id||c.department_id,queued?'waiting':'open',attempts,id,company]); await tx.query('insert into public.messages(id,company_id,conversation_id,body,direction) values($1,$2,$3,$4,$5)',[randomUUID(),company,id,queued?settings.fallback_message:settings.welcome_message,'outbound']); await audit(tx,session,queued?'bot_queued':'bot_replied',id); }); return json(response,201,{ok:true}); }
  if (request.method==='POST'&&['assume','close','transfer'].includes(action)) {
    const result=await db.transaction(async tx=>{
      const c=await tx.one('select * from public.conversations where company_id=$1 and id=$2 for update',[company,id]);
      if(action==='assume'||action==='close')await tx.query('update public.flow_runs set status=$1,updated_at=now() where company_id=$2 and conversation_id=$3',[action==='close'?'finished':'paused',company,id]);
      if(action==='assume')await tx.query("update public.conversations set assigned_profile_id=$1,status='open',closed_at=null,updated_at=now(),human_started_at=coalesce(human_started_at,now()) where id=$2 and company_id=$3",[session.profile.id,id,company]);
      if(action==='close'){
        try{await tx.query("update public.conversations set status='closed',assigned_profile_id=null,closed_by_profile_id=$3,closed_at=now(),updated_at=now() where id=$1 and company_id=$2",[id,company,session.profile.id]);}
        catch(error){if(error.code!=='42703')throw error;await tx.query("update public.conversations set status='closed',assigned_profile_id=null,closed_at=now(),updated_at=now() where id=$1 and company_id=$2",[id,company]);}
      }
      if(action==='transfer'){
        const d=await tx.one('select id from public.departments where id=$1 and company_id=$2',[input.department_id,company]);
        if(!d)return {error:'Setor inválido.'};
        const assignee=input.assigned_profile_id?await tx.one('select id from public.profiles where id=$1 and company_id=$2',[input.assigned_profile_id,company]):null;
        await tx.query("update public.conversations set department_id=$1,assigned_profile_id=$2,status='waiting',human_started_at=coalesce(human_started_at,now()),updated_at=now() where id=$3 and company_id=$4",[d.id,assignee?.id||null,id,company]);
      }
      await audit(tx,session,action==='assume'?'conversation_assumed':action==='close'?'conversation_closed':'conversation_transferred',id);
      return {ok:true,conversation:c};
    });
    if(result.error)return json(response,400,result);
    try{
      if(action==='assume')await sendConversationNotice(company,selected,session,'Olá! Sou o atendente '+String(session.profile.display_name||session.profile.name||'Atendente').trim()+'. Tudo bem? Como posso te auxiliar?');
      if(action==='close')await sendConversationNotice(company,selected,session,'Atendimento encerrado. Obrigado por falar com a SG Fibra! Avalie o atendimento:',[{id:'rating_1',label:'⭐ 1 estrela'},{id:'rating_2',label:'⭐ 2 estrelas'},{id:'rating_3',label:'⭐ 3 estrelas'}]);
    }catch(error){return json(response,200,{ok:true,warning:'Atendimento encerrado, mas a mensagem automática não pôde ser enviada agora.'});}
    return json(response,200,{ok:true});
  }
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
