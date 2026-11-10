const paths = new Set(['status','connect','pairing-code','emergency-stop','auto-reply','authorize','send','disconnect','logout-and-delete-session']);
export async function proxyWhatsApp(request, response, companyId) {
  const action = new URL(request.url,'http://localhost').pathname.split('/')[3];
  if (!paths.has(action)) { response.writeHead(404); response.end(); return; }
  const secret = process.env.WHATSAPP_CONNECTOR_TOKEN;
  const configuredCompany = process.env.WHATSAPP_COMPANY_ID || 'isp';
  if (companyId !== configuredCompany) { response.writeHead(403,{'content-type':'application/json'}); response.end(JSON.stringify({error:'Conector indisponível para esta empresa.'})); return; }
  const target = `http://127.0.0.1:${Number(process.env.WHATSAPP_CONNECTOR_PORT || 3200)}/api/whatsapp/${action}`;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let data = {};
  try { data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { response.writeHead(400); response.end(); return; }
  if (action === 'status') {
    if (process.env.BAILEYS_CLOUD_ENABLED === 'true') {
      try {
        const local = await fetch(target, { headers: { 'x-connector-token': secret }, signal: AbortSignal.timeout(3000) });
        const payload = local.ok ? await local.json() : null;
        if (payload) {
          response.writeHead(200, {'content-type':'application/json; charset=utf-8'});
          return response.end(JSON.stringify({ ...payload, backendOnline: true, connectorOnline: true, bridge: 'CLOUD' }));
        }
      } catch {}
      response.writeHead(200,{'content-type':'application/json; charset=utf-8'});
      return response.end(JSON.stringify({status:'CONNECTOR_UNAVAILABLE',backendOnline:true,connectorOnline:false,whatsappConnected:false,qrAvailable:false,bridge:'CLOUD'}));
    }
    response.writeHead(200,{'content-type':'application/json; charset=utf-8'});
    response.end(JSON.stringify(connectorSnapshot(companyId)));
    return;
  }
  try {
    const upstream = await fetch(target,{method:request.method,headers:{'content-type':'application/json','x-connector-token':secret},body:request.method==='GET'?undefined:JSON.stringify({...data,company_id:companyId}),signal:AbortSignal.timeout(10_000)});
    const raw = await upstream.text();
    let payload; try { payload = JSON.parse(raw); } catch { payload = { error: raw || 'Resposta inválida do conector.' }; }
    if (!upstream.ok && action === 'connect' && process.env.BAILEYS_CLOUD_ENABLED === 'true' && Number(payload.disconnectCode) === 401) {
      payload = { ...payload, error: 'A sessão salva foi rejeitada pelo WhatsApp (401). Use “Encerrar e apagar sessão” e tente conectar novamente para gerar um novo QR.' };
    }
    response.writeHead(upstream.status,{'content-type':'application/json; charset=utf-8'});
    response.end(JSON.stringify(payload));
  } catch {
    if (process.env.BAILEYS_CLOUD_ENABLED === 'true') {
      response.writeHead(503,{'content-type':'application/json; charset=utf-8'});
      return response.end(JSON.stringify({error:'Conector hospedado indisponível. Confira o processo Baileys nos logs do Render.'}));
    }
    try {
      const result = await dispatchConnector(companyId, action, request.method, {...data,company_id:companyId});
      response.writeHead(200,{'content-type':'application/json; charset=utf-8'});
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error.status || 503,{'content-type':'application/json; charset=utf-8'});
      response.end(JSON.stringify({error:error.message}));
    }
  }
}
import { connectorSnapshot, dispatchConnector } from './connector-bridge.mjs';

