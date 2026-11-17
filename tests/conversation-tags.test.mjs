import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationTags} from '../apps/web/public/conversation-tags.js';
test('weekly contact frequency boundaries',()=>{
  for(const [count,tone] of [[1,'rare'],[2,'rare'],[3,'occasional'],[4,'occasional'],[5,'frequent']])assert.equal(conversationTags({weekly_contacts:count})[0].tone,tone);
  assert.deepEqual(conversationTags({weekly_contacts:0}),[]);
});
test('problem tags require facts, not queue name or missing SGP data',()=>{
  assert.deepEqual(conversationTags({department_name:'Financeiro',robot_facts:{internet_online:null,overdue_invoice_count:0}}),[]);
  assert.deepEqual(conversationTags({robot_facts:{internet_online:false,overdue_invoice_count:2},reported_slow:true}).map(x=>x.tone),['offline','debt','slow']);
  assert.deepEqual(conversationTags({robot_facts:{internet_online:false,overdue_invoice_count:2}},{status:'found',customer:{contracts:[{services:[{type:'internet',online:true}]}],invoices:{overdue:0,count:2}}}),[]);
});
