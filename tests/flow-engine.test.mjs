import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceFlow, validateFlow } from '../apps/web/public/flow.js';

const graph={
  nodes:[
    {id:'start',type:'start',title:'Início'},
    {id:'client',type:'question',title:'É cliente?',message:'Você já é cliente?',options:[{id:'yes',label:'Sim'},{id:'no',label:'Não'}]},
    {id:'support',type:'question',title:'Assunto',message:'Qual o assunto?',options:[{id:'slow',label:'Internet lenta'},{id:'other',label:'Outro'}]},
    {id:'sales',type:'message',title:'Vendas',message:'Conheça nossos planos.'},
    {id:'diagnostic',type:'message',title:'Diagnóstico',message:'Reinicie o equipamento.'},
    {id:'queue',type:'transfer',title:'Atendimento',departmentId:'support'},
    {id:'end',type:'end',title:'Fim'}
  ],
  edges:[
    {source:'start',port:'next',target:'client'},
    {source:'client',port:'yes',target:'support'},
    {source:'client',port:'no',target:'sales'},
    {source:'support',port:'slow',target:'diagnostic'},
    {source:'support',port:'other',target:'queue'},
    {source:'sales',port:'next',target:'end'},
    {source:'diagnostic',port:'next',target:'queue'}
  ]
};

test('caminhos podem ter várias etapas e aceitam botão ou número',()=>{
  assert.deepEqual(validateFlow(graph,{departments:[{id:'support'}]}),[]);
  let state=advanceFlow(graph,null);
  assert.equal(state.nodeId,'client');
  assert.equal(state.output[0].options.length,2);
  state=advanceFlow(graph,state,'1');
  assert.equal(state.nodeId,'support');
  state=advanceFlow(graph,state,'Internet lenta');
  assert.equal(state.transfer.departmentId,'support');
  assert.equal(state.output[0].text,'Reinicie o equipamento.');
  assert.equal(state.finished,true);
});

test('resposta inválida mantém a pergunta e conexões faltantes impedem publicação',()=>{
  const state=advanceFlow(graph,advanceFlow(graph,null),'talvez');
  assert.equal(state.waiting,true);
  assert.equal(state.nodeId,'client');
  const broken=structuredClone(graph);
  broken.edges=broken.edges.filter(edge=>edge.port!=='no');
  assert.match(validateFlow(broken,{departments:[{id:'support'}]}).join(' '),/Caminho sem destino/);
});

test('ciclo excessivo para sem travar o processo',()=>{
  const loop={nodes:[{id:'start',type:'start'},{id:'again',type:'action',variable:'x',value:'1'}],edges:[{source:'start',port:'next',target:'again'},{source:'again',port:'next',target:'again'}]};
  const result=advanceFlow(loop,null);
  assert.equal(result.finished,true);
  assert.match(result.output.at(-1).text,/loop/);
});
