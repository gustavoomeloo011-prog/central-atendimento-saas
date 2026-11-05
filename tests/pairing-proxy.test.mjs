import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('painel exige login e supervisor; proxy envia empresa e token ao conector simulado', async () => {
  const directory = await mkdtemp(join(tmpdir(),'central-pairing-test-'));
  const mock = createServer(async (req,res) => {
    assert.equal(req.headers['x-connector-token'],'test-only-secret');
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const payload=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify(req.url.endsWith('pairing-code') ? {status:'PAIRING_CODE',pairing:{code:'ABCD1234'},company:payload.company_id} : req.url.endsWith('connect') ? {status:'QR_PENDING',qr:'data:image/png;base64,mock-qr'} : {status:'DISCONNECTED',pairing:{code:null}}));
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  const connectorPort=mock.address().port,webPort=connectorPort===65535?65534:connectorPort+1;
  const child=spawn(process.execPath,['apps/web/src/server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(webPort),DATABASE_PATH:join(directory,'test.db'),WHATSAPP_CONNECTOR_PORT:String(connectorPort),WHATSAPP_CONNECTOR_TOKEN:'test-only-secret',WHATSAPP_COMPANY_ID:'isp'},stdio:['ignore','ignore','pipe']});
  let childError=''; child.stderr.on('data',data=>childError+=data);
  const url=`http://127.0.0.1:${webPort}`;
  try {
    let ready=false;
    for(let i=0;i<50;i++){ try { const r=await fetch(url); if(r.ok){ready=true;break;} } catch {} await new Promise(resolve=>setTimeout(resolve,100)); }
    assert.equal(ready,true,childError);
    const denied=await fetch(url+'/api/whatsapp/status'); assert.equal(denied.status,401);
    const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'ana@conecta.demo',password:'demo'})}).then(r=>r.json());
    const result=await fetch(url+'/api/whatsapp/pairing-code',{method:'POST',headers:{authorization:'Bearer '+login.token,'content-type':'application/json'},body:JSON.stringify({number:'+55 (11) 97807-9451',company_id:'store'})});
    assert.equal(result.status,200); assert.deepEqual(await result.json(),{status:'PAIRING_CODE',pairing:{code:'ABCD1234'},company:'isp'});
    const qr=await fetch(url+'/api/whatsapp/connect',{method:'POST',headers:{authorization:'Bearer '+login.token}}).then(r=>r.json()); assert.equal(qr.status,'QR_PENDING'); assert.match(qr.qr,/^data:image\/png/);
    const agent=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'joao@conecta.demo',password:'demo'})}).then(r=>r.json());
    const forbidden=await fetch(url+'/api/whatsapp/status',{headers:{authorization:'Bearer '+agent.token}}); assert.equal(forbidden.status,403);
  } finally { if (child.exitCode === null) { child.kill(); await new Promise(resolve=>child.once('exit',resolve)); } await new Promise(resolve=>mock.close(resolve)); await rm(directory,{recursive:true,force:true}); }
});
