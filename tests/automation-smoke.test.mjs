import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('supervisor cria e publica fluxo; consulta após atualização', async () => {
  const directory=await mkdtemp(join(tmpdir(),'central-flows-test-'));
  const port=35000+Math.floor(Math.random()*10000);
  const child=spawn(process.execPath,['apps/web/src/server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),DATABASE_PATH:join(directory,'test.db')},stdio:['ignore','ignore','pipe']});
  let stderr=''; child.stderr.on('data',data=>stderr+=data);
  const base=`http://127.0.0.1:${port}`;
  try {
    let ready=false; for(let i=0;i<50;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{} await new Promise(resolve=>setTimeout(resolve,100));}
    assert.equal(ready,true,stderr);
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'Gustavo',password:'demo'})}).then(r=>r.json());
    assert.equal(login.profile.role,'supervisor');
    const call=(path,method='GET',payload)=>fetch(base+path,{method,headers:{authorization:'Bearer '+login.token,'content-type':'application/json'},body:payload?JSON.stringify(payload):undefined});
    const created=await call('/api/flows','POST',{name:'Fluxo de teste',definition:{nodes:[{id:'start',type:'menu',message:'Olá',options:[]}],edges:[]}}); assert.equal(created.status,201);
    const flow=await created.json();
    const published=await call(`/api/flows/${flow.id}/publish`,'POST',{definition:{nodes:[{id:'start',type:'menu',message:'Tudo bem?',options:[]}],edges:[]}}); assert.equal(published.status,200);
    const listed=await call('/api/flows').then(r=>r.json()); assert.equal(listed.flows.find(item=>item.id===flow.id)?.status,'published');
    const detail=await call(`/api/flows/${flow.id}`).then(r=>r.json()); assert.equal(detail.versions.length,2);
  } finally { if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));} await rm(directory,{recursive:true,force:true}); }
});
