import test from 'node:test';
import assert from 'node:assert/strict';
import { inQueue } from '../apps/web/public/queues.js';
const now=Date.parse('2026-11-10T12:00:00Z');
test('Geral inclui robô e novos; Meus somente responsável',()=>{
  for(const status of ['open','waiting'])assert.equal(inQueue({status},'general','a'),true);
  assert.equal(inQueue({status:'open',assigned_profile_id:'a'},'general','a'),false);
  assert.equal(inQueue({status:'open',assigned_profile_id:'a'},'mine','a'),true);
  assert.equal(inQueue({status:'open',assigned_profile_id:'b'},'mine','a'),false);
});
test('encerrado sai de Meus e permanece em Encerrados somente por 24h',()=>{
  const c={status:'closed',assigned_profile_id:'a',closed_at:new Date(now-86399999).toISOString()};
  assert.equal(inQueue(c,'mine','a',now),false);
  assert.equal(inQueue(c,'general','a',now),false);
  assert.equal(inQueue(c,'closed','a',now),true);
  assert.equal(inQueue(c,'closed','a',now+1),false);
});
test('novo atendimento após encerramento volta ao Geral',()=>{
  assert.equal(inQueue({status:'waiting',assigned_profile_id:null},'general','a',now),true);
  assert.equal(inQueue({status:'closed',closed_at:new Date(now-86400001).toISOString()},'closed','a',now),false);
});
