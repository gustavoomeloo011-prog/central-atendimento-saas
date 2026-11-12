export const FLOW_TYPES = ['start','message','question','wait','condition','action','transfer','integration','end'];
export const FLOW_LABELS = {start:'Início',message:'Enviar mensagem',question:'Pergunta com opções',wait:'Aguardar resposta',condition:'Condição',action:'Ação',transfer:'Transferir atendimento',integration:'Integração externa',end:'Encerrar fluxo'};
export const ROBOT_ACTION_CATALOG = [
  {group:'Mensagens',id:'message.send',name:'Enviar mensagem',type:'message',available:true},
  {group:'Mensagens',id:'question.options',name:'Pergunta com opções',type:'question',available:true},
  {group:'Mensagens',id:'input.text',name:'Receber texto',type:'wait',available:true},
  {group:'Controle',id:'condition.check',name:'Verificar condição',type:'condition',available:true},
  {group:'Controle',id:'variable.set',name:'Salvar variável',type:'action',available:true},
  {group:'Controle',id:'identity.verify',name:'Verificar autenticação',type:'integration',available:false,requires:'identity'},
  {group:'Controle',id:'queue.transfer',name:'Transferir para fila',type:'transfer',available:true},
  {group:'Controle',id:'flow.end',name:'Encerrar atendimento',type:'end',available:true},
  ...['client.cpf','contract.get','contract.select','invoice.get','invoice.copy','invoice.due','invoice.amount','promise.create','service.status','tickets.list','ticket.create'].map((id,index)=>({group:'Operações SGP',id,name:['Consultar cliente por CPF','Consultar contrato','Selecionar contrato','Consultar fatura','Enviar 2ª via','Consultar vencimento','Consultar valor','Registrar promessa de pagamento','Consultar status do serviço','Consultar chamados','Criar chamado'][index],type:'integration',available:false,requires:'sgp'})),
];
export const SHARED_IDENTIFICATION = {
  version:1,
  greeting:'Olá! 👋 Sou o assistente virtual da SG Fibra. Você já é nosso cliente?',
  options:['Sou cliente','Não sou cliente'],
  cpfPrompt:'Para localizar seu cadastro e continuar o atendimento, por favor, informe o CPF do titular do contrato, apenas com números.',
  maxAttempts:3,
  notFound:'Não consegui localizar um contrato com os dados informados. Deseja tentar novamente ou falar com um atendente?',
  unavailable:'Não consegui consultar seu cadastro neste momento. Vou encaminhar você para nossa equipe.',
};
export function normalizeCpf(value){return String(value||'').replace(/\D/g,'');}
export function isValidCpf(value){const cpf=normalizeCpf(value);if(!/^\d{11}$/.test(cpf)||/^(\d)\1{10}$/.test(cpf))return false;for(let size=9;size<=10;size++){let sum=0;for(let i=0;i<size;i++)sum+=Number(cpf[i])*(size+1-i);const digit=(sum*10)%11%10;if(digit!==Number(cpf[size]))return false;}return true;}
export const newFlow = () => ({nodes:[{id:'start',type:'start',title:'Início',x:100,y:180,message:'',options:[]}],edges:[]});
export const newNode = (type,x=360,y=180) => ({id:crypto.randomUUID(),type,title:FLOW_LABELS[type]||'Etapa',x,y,message:'',options:type==='question'?[{id:crypto.randomUUID(),label:'Sim'},{id:crypto.randomUUID(),label:'Não'}]:[],invalidReply:'Escolha uma das opções apresentadas.',timeoutMinutes:0,condition:'',variable:'',value:'',departmentId:'',profileId:'',actionId:''});
export function exampleFlow(){
  const flow=newFlow();
  const add=(title,message,labels)=>{const node=newNode('question');node.title=title;node.message=message;node.options=labels.map(label=>({id:crypto.randomUUID(),label}));flow.nodes.push(node);return node;};
  const end=title=>{const node=newNode('end');node.title=title;flow.nodes.push(node);return node;};
  const link=(a,port,b)=>flow.edges.push({id:crypto.randomUUID(),source:a.id,port,target:b.id});
  const initial=add('Mensagem inicial','Olá! Você já é nosso cliente?',['Sou cliente','Não sou cliente']);
  const client=add('Fluxo do cliente','Como posso ajudar?',['Suporte','Financeiro','Promoções']);
  const newClient=add('Fluxo para novos clientes','O que você deseja?',['Conhecer planos','Consultar cobertura','Falar com vendas']);
  const support=add('Fluxo de suporte','Qual é o problema?',['Sem sinal','Lentidão','Outro problema']);
  const billing=add('Fluxo financeiro','Escolha uma opção',['2ª via','Pagamento','Negociação']);
  const promo=add('Fluxo de promoções','Quer participar da promoção?',['Sim','Não']);
  link(flow.nodes[0],'next',initial);link(initial,initial.options[0].id,client);link(initial,initial.options[1].id,newClient);
  link(client,client.options[0].id,support);link(client,client.options[1].id,billing);link(client,client.options[2].id,promo);
  for(const question of [newClient,support,billing,promo])for(const option of question.options)link(question,option.id,end(`Configurar: ${option.label}`));
  return flow;
}
export const outgoing = (flow,id,port='next') => flow.edges.find(edge=>edge.source===id && edge.port===port)?.target;

// Starter automation for the three selectable company profiles. Department IDs
// are supplied by the backend so every transfer stays inside the tenant.
export function sgFibraRobotFlow({supportDepartmentId='',financeDepartmentId='',salesDepartmentId=''}={}) {
  const flow=newFlow();
  const add=(type,title,message='',options=[])=>{const node=newNode(type);node.title=title;node.message=message;node.options=options.map(label=>({id:crypto.randomUUID(),label}));flow.nodes.push(node);return node;};
  const edge=(source,port,target)=>flow.edges.push({id:crypto.randomUUID(),source:source.id,port,target:target.id});
  const next=(source,target)=>edge(source,'next',target);
  const finish=(source,title,message,port='next')=>{const note=add('message',title,message);const end=add('end',`Encerrar: ${title}`);edge(source,port,note);next(note,end);return end;};
  const transfer=(source,title,departmentId,message='Vou encaminhar você para nossa equipe. Um atendente continuará o atendimento por aqui.',port='next')=>{
    const note=add('message',title,message),target=add('transfer',`Transferir: ${title}`);target.departmentId=departmentId;edge(source,port,note);next(note,target);return target;
  };
  const greeting=add('message','Boas-vindas','Olá, eu sou o assistente virtual da SG Fibra. Como posso te ajudar?');
  const known=add('condition','Cliente localizado no SGP');known.variable='client_found';known.condition='true';
  next(flow.nodes[0],greeting);next(greeting,known);
  const welcome=add('message','Boas-vindas ao cliente','Que bom te receber novamente, {{client_name}}. Me diz como posso te auxiliar.');
  edge(known,'yes',welcome);
  const clientMenu=add('question','Menu do cliente','Escolha uma opção:',['Suporte técnico','Financeiro','Falar com atendente']);
  next(welcome,clientMenu);
  const identify=add('question','Identificar cliente','Você já é cliente da SG Fibra?',['Sou cliente','Não sou cliente']);
  edge(known,'no',identify);
  const unknownClientMenu=add('question','Menu para cliente','Como posso ajudar?',['Suporte técnico','Financeiro','Falar com atendente']);
  edge(identify,identify.options[0].id,unknownClientMenu);
  const prospectMenu=add('question','Menu para novos clientes','O que você deseja?',['Conhecer planos','Consultar cobertura','Falar com vendas']);
  edge(identify,identify.options[1].id,prospectMenu);

  const support=add('question','Suporte técnico','Qual problema você está enfrentando?',['Internet lenta','Sem conexão','Outro problema']);
  edge(clientMenu,clientMenu.options[0].id,support);edge(unknownClientMenu,unknownClientMenu.options[0].id,support);
  const restart=add('message','Reiniciar modem','Vamos tentar um procedimento rápido: desligue o modem da tomada, aguarde 2 minutos e ligue novamente. Espere as luzes estabilizarem.');
  edge(support,support.options[0].id,restart);
  const check=add('question','Confirmar conexão','A conexão voltou ao normal?',['Sim','Não']);next(restart,check);
  finish(check,'Conexão restabelecida','Que bom! Se a lentidão voltar, pode chamar a gente novamente.',check.options[0].id);
  transfer(check,'Lentidão continua',supportDepartmentId,'Vou encaminhar o caso para o suporte técnico.',check.options[1].id);
  transfer(support,'Sem conexão',supportDepartmentId,'Vou encaminhar o caso de falta de conexão para o suporte técnico.',support.options[1].id);
  const describe=add('wait','Descrever problema','Por favor, descreva brevemente o que está acontecendo.');
  edge(support,support.options[2].id,describe);transfer(describe,'Outro problema técnico',supportDepartmentId);

  const finance=add('question','Financeiro','Como podemos ajudar?',['2ª via da fatura','Solicitar liberação de sinal por 24 horas','Falar com atendente']);
  edge(clientMenu,clientMenu.options[1].id,finance);edge(unknownClientMenu,unknownClientMenu.options[1].id,finance);
  transfer(finance,'Segunda via da fatura',financeDepartmentId,'Vou encaminhar seu pedido de segunda via para o Financeiro. Depois que a fatura for enviada, o atendente poderá encerrar este atendimento.',finance.options[0].id);
  transfer(finance,'Solicitação de liberação de sinal',financeDepartmentId,'Vou encaminhar sua solicitação de liberação de sinal por 24 horas para a equipe financeira verificar.',finance.options[1].id);
  transfer(finance,'Atendimento financeiro',financeDepartmentId,'Vou chamar um atendente do financeiro para continuar com você.',finance.options[2].id);
  transfer(clientMenu,'Atendimento humano',supportDepartmentId,'Vou chamar um atendente para continuar com você.',clientMenu.options[2].id);
  transfer(unknownClientMenu,'Atendimento humano',supportDepartmentId,'Vou chamar um atendente para continuar com você.',unknownClientMenu.options[2].id);
  const salesDepartment=salesDepartmentId||supportDepartmentId;
  for(const [index,option] of prospectMenu.options.entries())transfer(prospectMenu,option.label,salesDepartment,index===0?'Vou encaminhar seu interesse em conhecer os planos para nossa equipe comercial.':index===1?'Vou encaminhar sua consulta de cobertura para nossa equipe comercial.':'Vou chamar um atendente de vendas para continuar com você.',option.id);
  return flow;
}

function renderTemplate(value,variables={}) {
  return String(value||'').replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g,(_,key)=>{
    const result=key.split('.').reduce((item,part)=>item&&typeof item==='object'?item[part]:undefined,variables);
    return result==null?'':String(result);
  });
}
export function validateFlow(flow,{departments=[]}={}) {
  const errors=[]; if (!flow||!Array.isArray(flow.nodes)||!Array.isArray(flow.edges)||flow.nodes.some(n=>!n||typeof n.id!=='string'||typeof n.type!=='string'||!Array.isArray(n.options||[]))||flow.edges.some(e=>!e||typeof e.source!=='string'||typeof e.target!=='string'||typeof e.port!=='string')) return ['Estrutura do fluxo inválida.'];
  if(flow.nodes.length>300||flow.edges.length>600) errors.push('O fluxo excede o limite de 300 blocos ou 600 conexões.');
  if(flow.nodes.some(n=>String(n.message||'').length>4000||String(n.title||'').length>120||(n.options||[]).length>20)) errors.push('Um bloco excede o limite de texto ou de opções.');
  const ids=new Set(flow.nodes.map(n=>n.id));
  if(ids.size!==flow.nodes.length) errors.push('Existem identificadores de blocos duplicados.');
  const optionIds=new Set();
  for(const option of flow.nodes.flatMap(n=>n.options||[])){if(typeof option.id!=='string'||!option.id)errors.push('Toda alternativa precisa de um identificador estável.');else if(optionIds.has(option.id))errors.push('Existem identificadores de alternativas duplicados.');else optionIds.add(option.id);}
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
    if(n.type==='end'&&String(n.title||'').startsWith('Configurar:')) errors.push(`Complete a etapa ${n.title} antes de publicar.`);
    const ports=n.type==='question'?(n.options||[]).map(o=>o.id):n.type==='condition'?['yes','no']:n.type==='end'||n.type==='transfer'?[]:['next'];
    if(n.type==='question'&&(!n.options?.length||n.options.some(o=>!String(o.label||'').trim())||new Set(n.options.map(o=>String(o.label||'').trim().toLowerCase())).size!==n.options.length)) errors.push(`As opções de ${n.title||n.id} precisam ser únicas e preenchidas.`);
    for(const port of ports) if(!outgoing(flow,n.id,port)) errors.push(`Caminho sem destino em ${n.title||n.id} (${port}).`);
  }
  const edges=new Set();for(const edge of flow.edges){if(!ids.has(edge.source)||!ids.has(edge.target)) errors.push('Há uma conexão para bloco inexistente.');const source=flow.nodes.find(n=>n.id===edge.source),target=flow.nodes.find(n=>n.id===edge.target);const validPorts=source?.type==='question'?(source.options||[]).map(o=>o.id):source?.type==='condition'?['yes','no']:['start','message','wait','action','integration'].includes(source?.type)?['next']:[];if(!validPorts.includes(edge.port)||target?.type==='start')errors.push('Há uma conexão com saída ou destino inválido.');const key=`${edge.source}:${edge.port}`;if(edges.has(key))errors.push('Há saídas duplicadas no mesmo bloco.');edges.add(key);}
  if(starts.length===1){const seen=new Set(),stack=[starts[0].id]; while(stack.length){const id=stack.pop();if(seen.has(id))continue;seen.add(id);flow.edges.filter(e=>e.source===id).forEach(e=>stack.push(e.target));} for(const n of flow.nodes)if(!seen.has(n.id))errors.push(`Bloco não alcançável: ${n.title||n.id}.`);}
  return [...new Set(errors)];
}
export function advanceFlow(flow, runtime, input=null, {maxSteps=40}={}) {
  const state={nodeId:runtime?.nodeId||flow.nodes.find(n=>n.type==='start')?.id,steps:runtime?.steps||0,variables:{...(runtime?.variables||{})},waiting:false,finished:false,transfer:null,output:[],executed:[],lastReply:null};
  for(let i=0;i<maxSteps;i++){
    const node=flow.nodes.find(n=>n.id===state.nodeId);if(!node){state.finished=true;break;}
    if(input&&typeof input==='object'&&input.kind==='option'&&node.type!=='question'){state.output.push({type:'error',text:'A opção não pertence à pergunta atual.'});state.waiting=node.type==='wait';break;}
    state.executed.push(node.id);state.steps++;
    if(state.steps>200){state.finished=true;state.output.push({type:'error',text:'Limite de etapas atingido.'});break;}
    if(node.type==='end'){state.finished=true;break;}
    if(node.type==='transfer'){state.transfer={departmentId:node.departmentId,profileId:node.profileId||null};state.finished=true;break;}
    if(node.type==='integration'){state.finished=true;state.output.push({type:'error',text:'Integração externa indisponível.'});break;}
    if(node.type==='action'&&node.variable)state.variables[node.variable]=node.value||'';
    if(node.type==='condition'){const matched=String(input??state.variables[node.variable]??'').toLowerCase().includes(String(node.condition||'').toLowerCase());state.nodeId=outgoing(flow,node.id,matched?'yes':'no');continue;}
    if(node.type==='message'&&node.message)state.output.push({type:'message',text:renderTemplate(node.message,state.variables),nodeId:node.id});
    if(node.type==='question'||node.type==='wait'){
      if(input===null){if(node.message)state.output.push({type:'message',text:renderTemplate(node.message,state.variables),nodeId:node.id,options:node.options||[]});state.waiting=true;break;}
      let port='next';
      if(node.type==='question'){
        const selected=input&&typeof input==='object'&&input.kind==='option'?input:null;
        const normalized=selected?'':String(input).trim().toLowerCase();const chosen=(node.options||[]).find((o,index)=>selected?(selected.nodeId===node.id&&selected.optionId===o.id):(o.id===input||o.label.toLowerCase()===normalized||String(index+1)===normalized));
        if(!chosen){state.output.push({type:'message',text:node.invalidReply||'Escolha uma das opções.',nodeId:node.id,options:node.options||[]});state.waiting=true;break;}
        port=chosen.id;
        state.variables.lastReply=String(chosen.label);
        state.lastReply=String(chosen.label);
      }else state.variables.lastReply=String(input);
      input=null;state.nodeId=outgoing(flow,node.id,port);continue;
    }
    state.nodeId=outgoing(flow,node.id,'next');
    if(!state.nodeId){state.finished=true;break;}
  }
  if(state.executed.length>=maxSteps&&!state.waiting&&!state.finished){state.finished=true;state.output.push({type:'error',text:'Fluxo interrompido para evitar loop.'});}
  return state;
}
