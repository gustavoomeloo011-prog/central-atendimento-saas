import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAttachment,uploadMetaAttachment,mediaMessage,trustedMetaMediaUrl} from '../apps/web/src/meta-media.mjs';

test('authenticated media allows Meta CDN and rejects lookalikes and insecure URLs',()=>{
  assert.equal(trustedMetaMediaUrl('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1').hostname,'lookaside.fbsbx.com');
  for(const url of ['https://lookaside.fbsbx.com.evil.test/a','http://lookaside.fbsbx.com/a','https://127.0.0.1/a','https://token@lookaside.fbsbx.com/a'])assert.throws(()=>trustedMetaMediaUrl(url));
});

test('audio formats are validated without accepting unsupported WebM',()=>{
  assert.equal(validateAttachment({type:'audio/ogg; codecs=opus',data:'YWJj'}).type,'audio/ogg');
  assert.throws(()=>validateAttachment({type:'audio/webm',data:'YWJj'}),/Formato/);
  assert.throws(()=>validateAttachment({type:'audio/mpeg',data:''}),/máximo/);
});
test('upload uses authenticated multipart and the actual provider media ID',async()=>{
  let calls=0;
  const result=await uploadMetaAttachment({type:'audio/mpeg',data:'YWJj',name:'teste.mp3'},{token:'test',phoneNumberId:'123',version:'25.0',fetchImpl:async(url,request)=>{
    calls++;
    assert.equal(url,'https://graph.facebook.com/v25.0/123/media');
    assert.equal(request.headers.authorization,'Bearer test');
    assert.equal(request.body.get('messaging_product'),'whatsapp');
    assert.equal(request.body.get('file').type,'audio/mpeg');
    return {ok:true,json:async()=>({id:'456'})};
  }});
  assert.equal(calls,1);
  assert.deepEqual(mediaMessage('5511999999999',result,'caption ignored'),{messaging_product:'whatsapp',recipient_type:'individual',to:'5511999999999',type:'audio',audio:{id:'456'}});
});
test('PDF preserves filename and caption; rejected upload never supplies a sendable ID',async()=>{
  assert.deepEqual(mediaMessage('55',{kind:'document',id:'1',name:'fatura.pdf'},'Texto').document,{id:'1',filename:'fatura.pdf',caption:'Texto'});
  await assert.rejects(uploadMetaAttachment({type:'application/pdf',data:'YWJj'},{token:'test',phoneNumberId:'123',version:'25.0',fetchImpl:async()=>({ok:false,json:async()=>({error:{code:190}})})}),/recusou/);
});
