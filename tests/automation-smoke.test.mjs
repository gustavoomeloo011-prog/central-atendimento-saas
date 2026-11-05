import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('supervisor cria e publica fluxo; consulta após atualização', async () => {
  const directory=await mkdtemp(join(tmpdir(),'central-flows-test-'));
  const port=35000+Math.floor(Math.random()*10000);
  const child=spawn(process.execPath,['apps/web/src/server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),DATABASE_PATH:join(directory,'test.db'),WHATSAPP_CONNECTOR_TOKEN:'test-connector'},stdio:['ignore','ignore','pipe']});
  let stderr=''; child.stderr.on('data',data=>stderr+=data);
  const base=`http://127.0.0.1:${port}`;
  try {
    let ready=false; for(let i=0;i<50;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{} await new Promise(resolve=>setTimeout(resolve,100));}
    assert.equal(ready,true,stderr);
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'Gustavo',password:'demo'})}).then(r=>r.json());
    assert.equal(login.profile.role,'supervisor');
    const call=(path,method='GET',payload)=>fetch(base+path,{method,headers:{authorization:'Bearer '+login.token,'content-type':'application/json'},body:payload?JSON.stringify(payload):undefined});
    const definition={nodes:[{id:'start',type:'start',title:'Início'},{id:'question',type:'question',title:'Cliente?',message:'Você já é cliente?',options:[{id:'yes',label:'Sim'},{id:'no',label:'Não'}]},{id:'yes-end',type:'end',title:'Cliente'},{id:'no-end',type:'end',title:'Novo'}],edges:[{source:'start',port:'next',target:'question'},{source:'question',port:'yes',target:'yes-end'},{source:'question',port:'no',target:'no-end'}]};
    const created=await call('/api/flows','POST',{name:'Fluxo de teste',definition}); assert.equal(created.status,201);
    const flow=await created.json();
    const published=await call(`/api/flows/${flow.id}/publish`,'POST',{definition}); assert.equal(published.status,200);
    const listed=await call('/api/flows').then(r=>r.json()); assert.equal(listed.flows.find(item=>item.id===flow.id)?.status,'published');
    const detail=await call(`/api/flows/${flow.id}`).then(r=>r.json()); assert.equal(detail.versions.length,2);
    const inbound=(message_id,body)=>fetch(base+'/api/internal/whatsapp/inbound',{method:'POST',headers:{'content-type':'application/json','x-connector-token':'test-connector'},body:JSON.stringify({company_id:'isp',phone:'5511999990000',message_id,body})}).then(r=>r.json());
    const first=await inbound('smoke-1','Olá');assert.match(first.reply,/Você já é cliente/);assert.match(first.reply,/1\. Sim/);
    const second=await inbound('smoke-2','1');assert.equal(second.reply,null);
    const duplicate=await inbound('smoke-2','1');assert.equal(duplicate.duplicate,true);
    const another=await fetch(base+'/api/internal/whatsapp/inbound',{method:'POST',headers:{'content-type':'application/json','x-connector-token':'test-connector'},body:JSON.stringify({company_id:'isp',phone:'5511999990001',message_id:'smoke-3',body:'Olá'})}).then(r=>r.json());
    assert.match(another.reply,/Você já é cliente/);
    assert.equal((await call(`/api/conversations/${another.conversation_id}/assume`,'POST',{})).status,200);
    const afterHuman=await fetch(base+'/api/internal/whatsapp/inbound',{method:'POST',headers:{'content-type':'application/json','x-connector-token':'test-connector'},body:JSON.stringify({company_id:'isp',phone:'5511999990001',message_id:'smoke-4',body:'Sim'})}).then(r=>r.json());
    assert.equal(afterHuman.reply,null);
  } finally { if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));} await rm(directory,{recursive:true,force:true}); }
});
