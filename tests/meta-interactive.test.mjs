import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMetaMessage, decodeFlowOptionRef, encodeFlowOptionRef, parseMetaInbound, formatNumberedOptions, isInteractiveWindowExpired } from '../apps/web/src/meta-interactive.mjs';
import { advanceFlow } from '../apps/web/public/flow.js';

const options = count => Array.from({length:count},(_,index)=>({id:`option-${index+1}`,label:`Opção ${index+1}`}));

test('Meta envia até três opções como botões com IDs estáveis ligados ao bloco',()=>{
  const message=buildMetaMessage('5511999990000',{text:'Como posso ajudar?',options:options(3),nodeId:'question-1',flowVersionId:'version-7'});
  assert.equal(message.mode,'buttons');
  assert.equal(message.payload.type,'interactive');
  assert.equal(message.payload.interactive.type,'button');
  assert.equal(message.payload.interactive.action.buttons.length,3);
  assert.deepEqual(decodeFlowOptionRef(message.payload.interactive.action.buttons[1].reply.id),{kind:'option',nodeId:'question-1',optionId:'option-2'});
});

test('Meta envia de quatro a dez opções como lista clicável',()=>{
  const message=buildMetaMessage('5511999990000',{text:'Qual problema você enfrenta?',options:options(5),nodeId:'support',flowVersionId:'v1'});
  assert.equal(message.mode,'list');
  assert.equal(message.payload.interactive.type,'list');
  assert.equal(message.payload.interactive.action.button,'Ver opções');
  assert.equal(message.payload.interactive.action.sections[0].rows.length,5);
});

test('mais de dez alternativas usa fallback numérico completo, sem truncar',()=>{
  const all=options(11);
  const message=buildMetaMessage('5511999990000',{text:'Escolha',options:all,nodeId:'menu',flowVersionId:'v1'});
  assert.equal(message.mode,'text-fallback');
  assert.match(message.reason,/submenus/);
  assert.match(message.payload.text.body,/11\. Opção 11/);
});

test('rótulo de botão longo não é cortado e usa fallback textual',()=>{
  const message=buildMetaMessage('5511999990000',{text:'Menu',options:[{id:'long',label:'Solicitar liberação de sinal'}],nodeId:'menu',flowVersionId:'v1'});
  assert.equal(message.mode,'text-fallback');
  assert.match(message.payload.text.body,/Solicitar liberação de sinal/);
});

test('respostas de botão, lista e template viram identificadores internos',()=>{
  const ref=encodeFlowOptionRef('q1','yes');
  assert.deepEqual(parseMetaInbound({type:'interactive',interactive:{button_reply:{id:ref,title:'Sim'}}}),{kind:'option',nodeId:'q1',optionId:'yes',displayText:'Sim'});
  assert.deepEqual(parseMetaInbound({type:'interactive',interactive:{list_reply:{id:ref,title:'Sim'}}}),{kind:'option',nodeId:'q1',optionId:'yes',displayText:'Sim'});
  assert.deepEqual(parseMetaInbound({type:'button',button:{payload:ref,text:'Sim'}}),{kind:'option',nodeId:'q1',optionId:'yes',displayText:'Sim'});
});

test('clique válido avança apenas na pergunta ativa; referência antiga não avança',()=>{
  const flow={
    nodes:[{id:'start',type:'start'},{id:'q1',type:'question',message:'Primeira?',options:[{id:'one',label:'Um'},{id:'two',label:'Dois'}]},{id:'q2',type:'question',message:'Segunda?',options:[{id:'next',label:'Continuar'}]},{id:'done',type:'end'}],
    edges:[{source:'start',port:'next',target:'q1'},{source:'q1',port:'one',target:'q2'},{source:'q1',port:'two',target:'done'},{source:'q2',port:'next',target:'done'}],
  };
  const first=advanceFlow(flow,null);
  const stale=advanceFlow(flow,{nodeId:'q2',steps:first.steps,variables:{}},{kind:'option',nodeId:'q1',optionId:'one'});
  assert.equal(stale.nodeId,'q2');
  assert.equal(stale.finished,false);
  assert.equal(stale.lastReply,null);
  const valid=advanceFlow(flow,first,{kind:'option',nodeId:'q1',optionId:'one'});
  assert.equal(valid.nodeId,'q2');
  assert.equal(valid.lastReply,'Um');
});

test('Baileys mantém texto com opções numeradas',()=>{
  assert.equal(formatNumberedOptions('Escolha:',options(2)),'Escolha:\n\n1. Opção 1\n2. Opção 2');
});

test('mensagens interativas vencidas não são reenviadas fora da janela de 24h',()=>{
  const expiresAt=new Date(1_000_000).toISOString();
  assert.equal(isInteractiveWindowExpired({options:options(2),windowExpiresAt:expiresAt},999_999),false);
  assert.equal(isInteractiveWindowExpired({options:options(2),windowExpiresAt:expiresAt},1_000_000),true);
  assert.equal(isInteractiveWindowExpired({options:[],windowExpiresAt:expiresAt},2_000_000),false);
  assert.equal(isInteractiveWindowExpired({options:options(2)},2_000_000),true);
});
