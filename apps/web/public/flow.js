export const FLOW_TYPES = ['start','message','question','wait','condition','action','transfer','integration','end'];
export const FLOW_LABELS = {start:'Início',message:'Enviar mensagem',question:'Pergunta com opções',wait:'Aguardar resposta',condition:'Condição',action:'Ação',transfer:'Transferir atendimento',integration:'Integração externa',end:'Encerrar fluxo'};
export const newFlow = () => ({nodes:[{id:'start',type:'start',title:'Início',x:100,y:180,message:'',options:[]}],edges:[]});
export const newNode = (type,x=360,y=180) => ({id:crypto.randomUUID(),type,title:FLOW_LABELS[type]||'Etapa',x,y,message:'',options:type==='question'?[{id:crypto.randomUUID(),label:'Sim'},{id:crypto.randomUUID(),label:'Não'}]:[],invalidReply:'Escolha uma das opções apresentadas.',timeoutMinutes:0,condition:'',variable:'',value:'',departmentId:'',profileId:''});
export const outgoing = (flow,id,port='next') => flow.edges.find(edge=>edge.source===id && edge.port===port)?.target;
export function validateFlow(flow,{departments=[]}={}) {
  const errors=[]; if (!flow||!Array.isArray(flow.nodes)||!Array.isArray(flow.edges)||flow.nodes.some(n=>!n||typeof n.id!=='string'||typeof n.type!=='string'||!Array.isArray(n.options||[]))||flow.edges.some(e=>!e||typeof e.source!=='string'||typeof e.target!=='string'||typeof e.port!=='string')) return ['Estrutura do fluxo inválida.'];
  if(flow.nodes.length>300||flow.edges.length>600) errors.push('O fluxo excede o limite de 300 blocos ou 600 conexões.');
  if(flow.nodes.some(n=>String(n.message||'').length>4000||String(n.title||'').length>120||(n.options||[]).length>20)) errors.push('Um bloco excede o limite de texto ou de opções.');
  const ids=new Set(flow.nodes.map(n=>n.id));
  if(ids.size!==flow.nodes.length) errors.push('Existem identificadores de blocos duplicados.');
  const starts=flow.nodes.filter(n=>n.type==='start'); if(starts.length!==1) errors.push('O fluxo precisa de exatamente um bloco Início.');
  const incoming=new Set(flow.edges.map(e=>e.target));
  for(const n of flow.nodes){
    if(!FLOW_TYPES.includes(n.type)) errors.push(`Tipo inválido em ${n.title||n.id}.`);
    if(n.type!=='start'&&!incoming.has(n.id)) errors.push(`Bloco desconectado: ${n.title||n.id}.`);
    if(['message','question'].includes(n.type)&&!String(n.message||'').trim()) errors.push(`Preencha a mensagem de ${n.title||n.id}.`);
    if(n.type==='transfer'&&(!n.departmentId||!departments.some(d=>d.id===n.departmentId))) errors.push(`Escolha uma fila válida para ${n.title||n.id}.`);
    if(n.type==='action'&&!/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(String(n.variable||''))||n.type==='action'&&['constructor','prototype','__proto__'].includes(n.variable)) errors.push(`Defina uma variável segura para ${n.title||n.id}.`);
    if(n.type==='condition'&&!String(n.condition||'').trim()) errors.push(`Preencha a condição de ${n.title||n.id}.`);
    if(n.type==='integration') errors.push(`Integração externa ${n.title||n.id} ainda não possui executor seguro.`);
    const ports=n.type==='question'?(n.options||[]).map(o=>o.id):n.type==='condition'?['yes','no']:n.type==='end'||n.type==='transfer'?[]:['next'];
    if(n.type==='question'&&(!n.options?.length||n.options.some(o=>!String(o.label||'').trim())||new Set(n.options.map(o=>String(o.label||'').trim().toLowerCase())).size!==n.options.length)) errors.push(`As opções de ${n.title||n.id} precisam ser únicas e preenchidas.`);
    for(const port of ports) if(!outgoing(flow,n.id,port)) errors.push(`Caminho sem destino em ${n.title||n.id} (${port}).`);
  }
  const edges=new Set();for(const edge of flow.edges){if(!ids.has(edge.source)||!ids.has(edge.target)) errors.push('Há uma conexão para bloco inexistente.');const source=flow.nodes.find(n=>n.id===edge.source),target=flow.nodes.find(n=>n.id===edge.target);const validPorts=source?.type==='question'?(source.options||[]).map(o=>o.id):source?.type==='condition'?['yes','no']:['start','message','wait','action','integration'].includes(source?.type)?['next']:[];if(!validPorts.includes(edge.port)||target?.type==='start')errors.push('Há uma conexão com saída ou destino inválido.');const key=`${edge.source}:${edge.port}`;if(edges.has(key))errors.push('Há saídas duplicadas no mesmo bloco.');edges.add(key);}
  if(starts.length===1){const seen=new Set(),stack=[starts[0].id]; while(stack.length){const id=stack.pop();if(seen.has(id))continue;seen.add(id);flow.edges.filter(e=>e.source===id).forEach(e=>stack.push(e.target));} for(const n of flow.nodes)if(!seen.has(n.id))errors.push(`Bloco não alcançável: ${n.title||n.id}.`);}
  return [...new Set(errors)];
}
export function advanceFlow(flow, runtime, input=null, {maxSteps=40}={}) {
  const state={nodeId:runtime?.nodeId||flow.nodes.find(n=>n.type==='start')?.id,steps:runtime?.steps||0,variables:{...(runtime?.variables||{})},waiting:false,finished:false,transfer:null,output:[],executed:[]};
  for(let i=0;i<maxSteps;i++){
    const node=flow.nodes.find(n=>n.id===state.nodeId);if(!node){state.finished=true;break;}
    state.executed.push(node.id);state.steps++;
    if(state.steps>200){state.finished=true;state.output.push({type:'error',text:'Limite de etapas atingido.'});break;}
    if(node.type==='end'){state.finished=true;break;}
    if(node.type==='transfer'){state.transfer={departmentId:node.departmentId,profileId:node.profileId||null};state.finished=true;break;}
    if(node.type==='integration'){state.finished=true;state.output.push({type:'error',text:'Integração externa indisponível.'});break;}
    if(node.type==='action'&&node.variable)state.variables[node.variable]=node.value||'';
    if(node.type==='condition'){const matched=String(input??state.variables[node.variable]??'').toLowerCase().includes(String(node.condition||'').toLowerCase());state.nodeId=outgoing(flow,node.id,matched?'yes':'no');continue;}
    if(node.type==='message'&&node.message)state.output.push({type:'message',text:node.message,nodeId:node.id});
    if(node.type==='question'||node.type==='wait'){
      if(input===null){if(node.message)state.output.push({type:'message',text:node.message,nodeId:node.id,options:node.options||[]});state.waiting=true;break;}
      let port='next';
      if(node.type==='question'){
        const normalized=String(input).trim().toLowerCase();const chosen=(node.options||[]).find((o,index)=>o.id===input||o.label.toLowerCase()===normalized||String(index+1)===normalized);
        if(!chosen){state.output.push({type:'message',text:node.invalidReply||'Escolha uma das opções.',nodeId:node.id,options:node.options||[]});state.waiting=true;break;}
        port=chosen.id;
        state.variables.lastReply=String(chosen.label);
      }else state.variables.lastReply=String(input);
      input=null;state.nodeId=outgoing(flow,node.id,port);continue;
    }
    state.nodeId=outgoing(flow,node.id,'next');
    if(!state.nodeId){state.finished=true;break;}
  }
  if(state.executed.length>=maxSteps&&!state.waiting&&!state.finished){state.finished=true;state.output.push({type:'error',text:'Fluxo interrompido para evitar loop.'});}
  return state;
}
