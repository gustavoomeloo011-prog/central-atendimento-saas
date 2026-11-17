import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMetaEdit,applyStoredMetaEdit} from '../apps/web/src/meta-edits.mjs';
import {visibleMessageBody} from '../apps/web/public/chat-view.js';
const event={type:'edit',from:'5511999999999',edit:{original_message_id:'original',message:{type:'text',text:{body:'Texto corrigido'}}}};
test('actual edit envelope targets original message and preserves empty edits',()=>{
  assert.deepEqual(parseMetaEdit(event),{originalId:'original',body:'Texto corrigido',phone:'5511999999999'});
  assert.equal(parseMetaEdit({type:'text'}),null);
  assert.equal(parseMetaEdit({...event,edit:{...event.edit,message:{type:'image'}}}),null);
});
test('edits are scoped to company, sender and inbound direction, without creating a new attendance',async()=>{
  const calls=[];
  const db={one:async(sql,args)=>{calls.push({sql,args});return calls.length===1?{payload:event}:{conversation_id:'conversation'};}};
  assert.equal(await applyStoredMetaEdit(db,'company','original'),true);
  assert.deepEqual(calls[1].args,['company','original','Texto corrigido','5511999999999']);
  assert.match(calls[1].sql,/m.direction='inbound'/);
  assert.match(calls[0].sql,/timestamp/);
  assert.equal(calls.length,2);
});
test('media players have no generated placeholder but keep captions and missing-media descriptions',()=>{
  for(const type of ['image','audio','document','video','sticker'])assert.equal(visibleMessageBody({body:`[Mensagem ${type}]`,attachment_path:'meta:1'}),'');
  assert.equal(visibleMessageBody({body:'Comprovante',attachment_path:'meta:1'}),'Comprovante');
  assert.equal(visibleMessageBody({body:'[Mensagem image]'}),'[Mensagem image]');
});
