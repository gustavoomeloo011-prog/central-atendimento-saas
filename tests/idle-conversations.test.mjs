import test from 'node:test';
import assert from 'node:assert/strict';
import {closeIdleConversations} from '../apps/web/src/idle-conversations.mjs';

test('idle sweep closes only rechecked candidates and never sends messages',async()=>{
  const queries=[];
  const tx={query:async(sql,args)=>{queries.push({sql,args});return sql.startsWith('select c.id')?[{id:'old',company_id:'a'},{id:'new-message',company_id:'b'}]:[];},one:async(sql,args)=>{queries.push({sql,args});return args[0]==='old'?{id:'old'}:null;}};
  assert.equal(await closeIdleConversations({transaction:fn=>fn(tx)}),1);
  assert.match(queries[0].sql,/10 hours/);
  assert.match(queries[0].sql,/skip locked/);
  const updates=queries.filter(q=>q.sql.startsWith('update public.conversations'));
  assert.equal(updates.length,2);
  assert.ok(updates.every(q=>q.sql.includes('max(m.created_at)')&&q.sql.includes('c.company_id=$2')));
  assert.equal(queries.filter(q=>q.sql.includes('conversation_closed_inactivity')).length,1);
  assert.ok(!queries.some(q=>/insert into public.(messages|whatsapp_outbox)/.test(q.sql)));
  assert.ok(!queries.some(q=>q.args?.[0]==='b'&&q.sql.includes("status='finished'")));
});
