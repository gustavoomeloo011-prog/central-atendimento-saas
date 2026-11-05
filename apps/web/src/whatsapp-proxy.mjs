const paths = new Set(['status','connect','pairing-code','emergency-stop','auto-reply','authorize','send','disconnect','logout-and-delete-session']);
export async function proxyWhatsApp(request, response, companyId) {
  const action = new URL(request.url,'http://localhost').pathname.split('/')[3];
  if (!paths.has(action)) { response.writeHead(404); response.end(); return; }
  const secret = process.env.WHATSAPP_CONNECTOR_TOKEN;
  const configuredCompany = process.env.WHATSAPP_COMPANY_ID || 'isp';
  if (companyId !== configuredCompany) { response.writeHead(403,{'content-type':'application/json'}); response.end(JSON.stringify({error:'Conector indisponível para esta empresa.'})); return; }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let data = {};
  try { data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { response.writeHead(400); response.end(); return; }
  if (action === 'status') {
    response.writeHead(200,{'content-type':'application/json; charset=utf-8'});
    response.end(JSON.stringify(connectorSnapshot(companyId)));
    return;
  }
  const target = `http://127.0.0.1:${Number(process.env.WHATSAPP_CONNECTOR_PORT || 3200)}/api/whatsapp/${action}`;
  try {
    const upstream = await fetch(target,{method:request.method,headers:{'content-type':'application/json','x-connector-token':secret},body:request.method==='GET'?undefined:JSON.stringify({...data,company_id:companyId}),signal:AbortSignal.timeout(10_000)});
    response.writeHead(upstream.status,{'content-type':'application/json; charset=utf-8'});
    response.end(await upstream.text());
  } catch {
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

