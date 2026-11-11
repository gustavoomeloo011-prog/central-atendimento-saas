import { inQueue } from './queues.js';
import { renderSgp } from './sgp-panel.js';
import { showFlowEditor } from './flow-editor.js';
const app = document.querySelector('#app');
document.title = 'Atendimento SG Fibra';
let token = localStorage.getItem('central_token');
let state = {};
let activeId = null;
let menuClosed = localStorage.getItem('central_menu_closed') === null ? matchMedia('(max-width: 850px)').matches : localStorage.getItem('central_menu_closed') === '1';
let inboxMode = 'general';
let protocolQuery = '';
let mobilePane = 'list';
let whatsappMode = 'qr';
let replyTo = null;
let liveTimer = null;
const sgpData = new Map();
async function loadSgp(id) {
  const previous=sgpData.get(id);
  if(previous && Date.now()-previous.at<60000)return;
  sgpData.set(id,{at:Date.now(),value:null});
  let value;
  try { value=await api('/api/conversations/'+encodeURIComponent(id)+'/sgp'); }
  catch { value={status:'unavailable',message:'Não foi possível consultar os dados do SGP.'}; }
  sgpData.set(id,{at:Date.now(),value});
  const panel=document.querySelector('#sgpDetails');
  if(activeId===id&&panel)panel.innerHTML=renderSgp(value);
}

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Falha na operação.');
  return data;
};
const esc = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const formatPhone = value => { const digits = String(value || '').replace(/\D/g, '').slice(0, 13); if (digits.length <= 2) return digits ? '+' + digits : ''; if (digits.length <= 4) return '+' + digits.slice(0, 2) + ' (' + digits.slice(2); if (digits.length <= 9) return '+' + digits.slice(0, 2) + ' (' + digits.slice(2, 4) + ') ' + digits.slice(4); return '+' + digits.slice(0, 2) + ' (' + digits.slice(2, 4) + ') ' + digits.slice(4, 9) + '-' + digits.slice(9); };
const timeOf = value => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
const supervisor = () => ['supervisor', 'company_admin', 'superadmin'].includes(state.profile?.role);

function login() {
  app.innerHTML = '<section class="login"><div class="brand"><span class="tag">ATENDIMENTO SG FIBRA</span><h1>Central de Atendimento</h1><p class="muted">Conversas, equipes, filas e automações em um só lugar.</p></div><form class="card" id="login"><h2>Entrar</h2><label class="field">Usuário ou e-mail<input name="email" type="text" autocomplete="username" required></label><label class="field">Senha<input name="password" type="password" autocomplete="current-password" required></label><button class="btn">Entrar</button><button type="button" class="btn subtle" id="recover">Esqueci minha senha</button></form></section>';
  document.querySelector('#recover').onclick = async () => { const email = document.querySelector('[name=email]').value.trim(); if (!email) return alert('Informe seu e-mail para recuperar a senha.'); try { await api('/api/recover-password', { method: 'POST', body: JSON.stringify({ email }) }); alert('Se o e-mail estiver cadastrado, você receberá instruções para recuperar a senha.'); } catch (error) { alert(error.message); } };
  document.querySelector('#login').onsubmit = async event => {
    event.preventDefault();
    try {
      const login = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
      token = login.token;
      localStorage.setItem('central_token', token);
      boot();
    } catch (error) { alert(error.message); }
  };
}

async function boot() {
  try {
    sgpData.clear();
    state = await api('/api/bootstrap');
    const visible = item => inQueue(item,inboxMode,state.profile.id);
    activeId = (state.conversations || []).find(visible)?.id || null;
    state.detail = null;
    render();
    if (activeId) await openConversation(activeId);
    if (!liveTimer) liveTimer = setInterval(refreshLive, 2500);
  } catch {
    localStorage.removeItem('central_token');
    token = null;
    login();
  }
}

async function refreshLive() {
  if (!token || document.hidden || document.activeElement?.matches('textarea,input,select')) return;
  try {
    if(activeId&&document.querySelector('#sgpDetails'))void loadSgp(activeId);
    const next = await api('/api/bootstrap');
    const detail = activeId ? await api('/api/conversations/' + activeId) : null;
    const before = JSON.stringify([(state.conversations||[]).map(item=>[item.id,item.updated_at,item.last_message]),(state.detail?.messages||[]).map(item=>[item.id,item.delivery_status])]);
    const after = JSON.stringify([(next.conversations||[]).map(item=>[item.id,item.updated_at,item.last_message]),(detail?.messages||[]).map(item=>[item.id,item.delivery_status])]);
    if (before !== after || (inboxMode === 'closed' && document.querySelector('.list'))) { state = {...next,detail}; render(); }
  } catch {}
}

function messageHtml(message) {
  const internal = message.direction === 'internal';
  const attachment = message.attachment_path ? '<button class="attachment" type="button" data-attachment="' + esc(message.id) + '">📎 ' + esc(message.attachment_name || 'Abrir anexo') + '</button>' : '';
  const reply = message.reply_body ? '<div class="quoted">↩ ' + esc(message.reply_body) + '</div>' : '';
  const status = message.direction === 'outbound' ? ({pending:' · pendente',sending:' · enviando',sent:' ✓',delivered:' ✓✓',read:' ✓✓ lida',failed:' · falhou',unknown:' · indeterminada'}[message.delivery_status]||' · pendente') : '';
  return '<div class="message ' + (message.direction === 'outbound' ? 'outbound ' : '') + (internal ? 'internal' : '') + '" data-message-id="' + esc(message.id) + '" title="' + esc(message.error_message||'') + '"><b class="messageAuthor">' + esc((internal ? '🔒 ' : '') + (message.author_name || 'Atendente') + ':') + '</b>' + reply + '<div>' + esc(message.body) + '</div>' + attachment + '<small>' + esc(message.message_time || '') + status + (internal ? ' · somente equipe' : '') + '</small></div>';
}

async function openConversation(id) {
  activeId = id;
  state.detail = await api('/api/conversations/' + id);
  void loadSgp(id);
  mobilePane = 'chat';
  render();
}

function shell(content, title = 'Caixa de entrada') {
  return '<div class="shell"><aside class="side"><span class="tag">SIMULADOR</span><h2>Central</h2><p class="muted">' + esc(state.company.name) + '</p><div class="nav"><button class="navButton" id="inbox">◉ Caixa de entrada</button><button class="navButton" id="queues">◌ Filas</button><button class="navButton" id="team">◌ Equipe</button><button class="navButton" id="automations">◌ Automações</button><button class="navButton" id="indicators">◌ Indicadores</button><button class="navButton" id="settings">◌ Configurações</button><button class="btn subtle" id="logout">Sair</button></div></aside><header class="top"><button class="menuToggle" id="menuToggle" aria-label="Abrir ou fechar menu">☰</button><div><b>' + title + '</b> <span class="muted">· ' + esc(state.company.name) + '</span></div><div>' + esc(state.profile.name) + ' <span class="tag">' + esc(state.profile.role) + '</span></div></header>' + content + '</div>';
}

function render() {
  const list = [...(state.conversations || [])].sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
  const isInInboxMode = item => inQueue(item,inboxMode,state.profile.id);
  const matchesProtocol = item => !protocolQuery || String(item.protocol || '').toUpperCase().includes(protocolQuery.replace(/\s/g, '').toUpperCase());
  const isVisibleInList = item => matchesProtocol(item) && (protocolQuery ? true : isInInboxMode(item));
  const conversation = list.find(item => item.id === activeId);
  const messages = state.detail?.conversation?.id === activeId ? state.detail.messages : [];
  const queueCount = list.filter(isInInboxMode).length;
  const inbox = '<section class="list"><div class="toolbar"><span class="tag">FILA ' + queueCount + '</span>' + (inboxMode === 'closed' ? '<small class="retentionHint" title="Encerrados saem desta lista após 24 horas; o histórico é preservado">Sai da lista após 24h</small>' : '') + '<button class="btn subtle" id="refresh">Atualizar</button><label class="protocolSearch"><span>⌕</span><input id="protocolSearch" type="search" autocomplete="off" placeholder="Buscar protocolo…" aria-label="Buscar atendimento por protocolo" value="' + esc(protocolQuery) + '"></label></div>' + list.map(item => '<article class="conversation ' + (item.id === activeId ? 'active' : '') + '" data-id="' + item.id + '" data-protocol="' + esc(item.protocol || '') + '"' + (isVisibleInList(item) ? '' : ' hidden') + '><b>' + esc(item.contact_name) + '</b> <span class="tag ' + item.status + '">' + esc(item.status) + '</span><div class="muted">' + esc(item.last_message || item.subject) + '</div><small>' + esc(item.department_name) + ' · ' + esc(item.contact_phone) + '</small><small class="protocolLabel">' + esc(item.protocol || 'Protocolo pendente') + '</small></article>').join('') + '</section>';
  const shortcuts = (state.quickReplies || []).map(reply => '<button class="quick" data-quick="' + esc(reply.shortcut) + '">' + esc(reply.shortcut) + '</button>').join('');
  const quickDock = '<div class="quickDock"><button class="quickToggle" id="quickToggle" type="button" aria-label="Abrir mensagens rápidas">⚡</button><div class="quickPalette" id="quickPalette">' + shortcuts + '</div></div>';
  const client = conversation ? '<aside class="clientPanel"><div class="panelTitle"><span class="tag">CLIENTE</span><h2>' + esc(conversation.contact_name) + '</h2><span class="muted">Dados operacionais</span></div><div class="clientStatus"><span class="dot"></span><b>' + esc(conversation.status) + '</b><span class="muted"> · ' + esc(conversation.priority || 'normal') + '</span></div><dl class="clientData"><dt>Telefone</dt><dd>' + esc(conversation.contact_phone || 'Não informado') + '</dd><dt>Assunto</dt><dd>' + esc(conversation.subject || 'Não informado') + '</dd><dt>Fila</dt><dd>' + esc(conversation.department_name || conversation.department_id || 'Não informado') + '</dd><dt>Responsável</dt><dd>' + esc(conversation.assigned_name || 'Ainda não atribuído') + '</dd></dl><div class="sgpBox" id="sgpDetails" aria-live="polite">' + renderSgp(sgpData.get(activeId)?.value) + '</div></aside>' : '<aside class="clientPanel empty">Selecione um atendimento para ver os dados do cliente.</aside>';
  const replyPreview = replyTo ? '<div class="replyPreview"><span>Respondendo: ' + esc(replyTo.body) + '</span><button type="button" id="cancelReply">×</button></div>' : '';
  const chat = conversation ? '<section class="chat"><div class="mobileChatNav"><button class="btn subtle" id="backToList">← Conversas</button><button class="btn subtle" id="showClient">Dados do cliente</button></div><div class="chatHead"><div><h2>' + esc(conversation.contact_name) + '</h2><span class="muted">' + esc(conversation.contact_phone) + ' · ' + esc(conversation.subject) + '</span><div class="protocolHeader">Protocolo <b>' + esc(conversation.protocol || 'Aguardando geração') + '</b>' + (conversation.protocol ? '<button type="button" class="linkButton" id="copyProtocol">Copiar</button>' : '') + '</div><button class="linkButton" id="renameContact">Editar nome</button></div><div class="chatActions"><button class="btn subtle" id="internalNote">🔒 Nota interna</button><button class="btn subtle" id="simulate">Simular cliente</button><button class="btn subtle" id="assume">Assumir</button><button class="btn subtle" id="transfer">Transferir</button><button class="btn subtle" id="close">Encerrar</button></div></div><div class="messages">' + messages.map(messageHtml).join('') + '</div>' + replyPreview + '<form class="composer" id="send"><input id="attachmentInput" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,application/pdf" hidden><button class="attachButton" id="attachButton" type="button" title="Anexar foto, vídeo ou PDF">＋</button><textarea name="body" placeholder="Escreva uma mensagem"></textarea><span class="attachmentName" id="attachmentName"></span><button class="btn">Enviar</button></form></section>' : '<section class="chat empty">Selecione uma conversa.</section>';
  app.innerHTML = shell(inbox + chat + client);
  document.querySelector('.shell').dataset.mobilePane = mobilePane;
  const clientPanel = document.querySelector('.clientPanel');
  if (clientPanel) clientPanel.insertAdjacentHTML('afterbegin', '<button class="btn subtle mobileClientBack" id="backToChat">← Voltar ao chat</button>');
  const listToolbar = document.querySelector('.list .toolbar');
  if (listToolbar) {
    const modes = [
      { id: 'general', symbol: '◉', label: 'Geral' },
      { id: 'mine', symbol: '👤', label: 'Meus atendimentos' },
      { id: 'closed', symbol: '✓', label: 'Encerrados' }
    ];
    const mode = document.createElement('div'); mode.className = 'inboxModes';
    mode.innerHTML = modes.map(item => '<button class="btn queueMode ' + (inboxMode === item.id ? '' : 'subtle') + '" type="button" data-inbox-mode="' + item.id + '" aria-label="' + item.label + '" title="' + item.label + '">' + item.symbol + '</button>').join('') + '<button class="btn" id="newConversation" type="button" aria-label="Nova conversa" title="Nova conversa">＋</button>';
    mode.querySelectorAll('[data-inbox-mode]').forEach(button => {
      button.onclick = () => {
        inboxMode = button.dataset.inboxMode;
        protocolQuery = '';
        const next = list.find(isInInboxMode);
        const selectedStillVisible = list.some(item => item.id === activeId && isInInboxMode(item));
        if (!selectedStillVisible) {
          activeId = next?.id || null;
          state.detail = null;
        }
        render();
        if (next && activeId === next.id && state.detail?.conversation?.id !== next.id) openConversation(next.id);
      };
    });
    mode.querySelector('#newConversation').onclick=async()=>{const phone=prompt('DDD + número do WhatsApp (ex.: 11999999999)');if(!phone)return;const name=prompt('Nome do contato (opcional)')||'';try{const result=await api('/api/conversations',{method:'POST',body:JSON.stringify({phone,name})});await boot();await openConversation(result.conversation.id);}catch(error){alert(error.message);}};
    listToolbar.prepend(mode);
  }
  const brand = document.querySelector('.side h2'); if (brand) brand.textContent = 'Atendimento SG Fibra';
  bindShell();
  document.querySelector('#refresh').onclick = boot;
  const protocolInput = document.querySelector('#protocolSearch');
  if (protocolInput) protocolInput.oninput = () => {
    protocolQuery = protocolInput.value;
    document.querySelectorAll('.conversation').forEach(element => {
      const protocol = element.dataset.protocol || '';
      const matches = !protocolQuery || protocol.toUpperCase().includes(protocolQuery.replace(/\s/g, '').toUpperCase());
      const row = list.find(item => item.id === element.dataset.id);
      element.hidden = !(matches && row && (protocolQuery || isInInboxMode(row)));
    });
  };
  if (protocolInput) protocolInput.onkeydown = event => { if (event.key === 'Enter') { const match = list.find(matchesProtocol); if (match) { event.preventDefault(); openConversation(match.id); } } };
  if (document.querySelector('#backToList')) document.querySelector('#backToList').onclick = () => { mobilePane = 'list'; render(); };
  if (document.querySelector('#showClient')) document.querySelector('#showClient').onclick = () => { mobilePane = 'client'; render(); };
  if (document.querySelector('#backToChat')) document.querySelector('#backToChat').onclick = () => { mobilePane = 'chat'; render(); };
  document.querySelectorAll('.conversation').forEach(element => element.onclick = () => openConversation(element.dataset.id));
  document.querySelectorAll('[data-quick]').forEach(button => button.onclick = () => useQuick(button.dataset.quick));
  if (conversation) bindConversation(conversation);
  const copyProtocol = document.querySelector('#copyProtocol');
  if (copyProtocol) copyProtocol.onclick = async () => {
    try { await navigator.clipboard.writeText(conversation.protocol); copyProtocol.textContent = 'Copiado'; setTimeout(() => { if (copyProtocol.isConnected) copyProtocol.textContent = 'Copiar'; }, 1400); }
    catch { prompt('Copie o protocolo:', conversation.protocol); }
  };
}

function bindShell() {
  document.querySelector('.shell').classList.toggle('menuClosed', menuClosed);
  document.querySelector('#menuToggle').onclick = () => { menuClosed = !menuClosed; localStorage.setItem('central_menu_closed', menuClosed ? '1' : '0'); document.querySelector('.shell').classList.toggle('menuClosed', menuClosed); };
  document.querySelector('.top').onclick = event => { if (event.target.closest('#menuToggle') || menuClosed || !matchMedia('(max-width: 850px)').matches) return; menuClosed = true; localStorage.setItem('central_menu_closed','1'); document.querySelector('.shell').classList.add('menuClosed'); };
  document.querySelector('#logout').onclick = () => { localStorage.removeItem('central_token'); token = null; login(); };
  document.querySelector('#inbox').onclick = render;
  document.querySelector('#queues').onclick = () => openPanel('queues');
  document.querySelector('#team').onclick = () => openPanel('team');
  document.querySelector('#automations').onclick = () => openPanel('automations');
  document.querySelector('#indicators').onclick = () => openPanel('indicators');
  document.querySelector('#settings').onclick = settings;
}

async function openPanel(type) {
  const data = await api('/api/settings');
  if (type === 'queues') {
    const cards = data.departments.map(department => {
      const count = state.conversations.filter(item => item.department_id === department.id && item.status !== 'closed').length;
      return '<article class="card"><span class="tag">FILA</span><h2>' + esc(department.name) + '</h2><p class="muted">' + count + ' atendimento(s) ativo(s)</p></article>';
    }).join('');
    app.innerHTML = shell('<section class="settings"><div class="settingsHead"><div><h2>Filas de atendimento</h2><p class="muted">Organize instalação, reparo, dúvidas, financeiro e outras filas por empresa.</p></div><button class="btn subtle" id="back">Voltar</button></div><div class="settingsGrid">' + cards + '</div></section>', 'Filas');
  } else if (type === 'team') {
    const people = data.profiles.map(profile => '<article class="card"><h3>' + esc(profile.name) + '</h3><p class="muted">' + esc(profile.email) + '</p><span class="tag">' + esc(profile.role) + '</span> <span class="tag">' + esc(profile.status) + '</span></article>').join('');
    app.innerHTML = shell('<section class="settings"><div class="settingsHead"><div><h2>Equipe</h2><p class="muted">Atendentes individuais, status e permissões da empresa.</p></div><button class="btn" id="manageTeam">Gerenciar equipe</button></div><div class="settingsGrid">' + people + '</div></section>', 'Equipe');
    document.querySelector('#manageTeam').onclick = settings;
  } else if (type === 'automations') {
    const flows = (await api('/api/flows')).flows;
    const cards = flows.length ? flows.map(flow => '<article class="card"><span class="tag">' + esc(flow.status) + '</span><h3>' + esc(flow.name) + '</h3><p class="muted">Versão publicada: ' + esc(flow.published_version || 'nenhuma') + '</p></article>').join('') : '<article class="card"><h3>Nenhum fluxo cadastrado</h3><p class="muted">Crie o primeiro fluxo no editor visual.</p></article>';
    app.innerHTML = shell('<section class="settings"><div class="settingsHead"><div><h2>Automações</h2><p class="muted">Crie caminhos de atendimento com blocos conectados e teste antes de publicar.</p></div><button class="btn" id="manageAutomation">Abrir editor visual</button></div><div class="settingsGrid">' + cards + '</div></section>', 'Automações');
    document.querySelector('#manageAutomation').onclick = automationEditor;
  } else {
    const total = state.conversations.length;
    const waiting = state.conversations.filter(item => item.status === 'waiting').length;
    const open = state.conversations.filter(item => item.status === 'open').length;
    const closed = state.conversations.filter(item => item.status === 'closed').length;
    app.innerHTML = shell('<section class="settings"><div class="settingsHead"><div><h2>Indicadores</h2><p class="muted">Visão da empresa selecionada usando os dados persistidos da demonstração.</p></div><button class="btn subtle" id="back">Voltar</button></div><div class="settingsGrid"><article class="card"><span class="muted">Total de conversas</span><h2>' + total + '</h2></article><article class="card"><span class="muted">Na fila</span><h2>' + waiting + '</h2></article><article class="card"><span class="muted">Em atendimento</span><h2>' + open + '</h2></article><article class="card"><span class="muted">Finalizadas</span><h2>' + closed + '</h2></article></div></section>', 'Indicadores');
  }
  bindShell();
  const back = document.querySelector('#back');
  if (back) back.onclick = render;
}

async function automationEditor() {
  return showFlowEditor({app,api,shell,bindShell,esc,back:()=>openPanel('automations')});
}

function bindConversation(conversation) {
  document.querySelectorAll('[data-attachment]').forEach(button=>button.onclick=async event=>{event.stopPropagation();try{const response=await fetch('/api/attachments/'+button.dataset.attachment,{headers:{authorization:'Bearer '+token}});if(!response.ok)throw Error('Anexo indisponível.');const blob=await response.blob(),url=URL.createObjectURL(blob);window.open(url,'_blank','noopener');setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(error){alert(error.message);}});
  document.querySelectorAll('.message[data-message-id]').forEach(element => element.onclick = event => { if (event.target.closest('[data-attachment]')) return; const message = state.detail?.messages?.find(item => item.id === element.dataset.messageId); if (message?.direction !== 'internal') { replyTo = {id:message.id,body:message.body||message.attachment_name||'Anexo'}; render(); } });
  if (document.querySelector('#cancelReply')) document.querySelector('#cancelReply').onclick = () => { replyTo = null; render(); };
  document.querySelector('#renameContact').onclick = async () => { const name=prompt('Nome do contato',conversation.contact_name); if(!name)return; const phone=prompt('DDD + número do WhatsApp',String(conversation.contact_phone||'').replace(/^55/,''));if(!phone)return;try{await api('/api/conversations/'+conversation.id+'/contact',{method:'PATCH',body:JSON.stringify({name,phone})});await boot();await openConversation(conversation.id);}catch(error){alert(error.message);} };
  document.querySelector('#internalNote').onclick = async () => { const body=prompt('Anotação interna (não será enviada ao cliente)');if(!body)return;try{await api('/api/conversations/'+conversation.id+'/internal-notes',{method:'POST',body:JSON.stringify({body})});await openConversation(conversation.id);}catch(error){alert(error.message);} };
  const attachmentInput=document.querySelector('#attachmentInput');
  document.querySelector('#attachButton').onclick=()=>attachmentInput.click();
  attachmentInput.onchange=()=>{const file=attachmentInput.files?.[0];document.querySelector('#attachmentName').textContent=file?'📎 '+file.name:'';};
  const quickToggle = document.querySelector('#quickToggle');
  if (quickToggle) quickToggle.onclick = () => document.querySelector('#quickPalette').classList.toggle('visible');
  const composer = document.querySelector('#send');
  if (composer && !quickToggle) {
    const dock = document.createElement('div'); dock.className = 'quickDock';
    dock.innerHTML = '<button class="quickToggle" id="quickToggle" type="button" aria-label="Abrir mensagens rápidas">⚡</button><div class="quickPalette" id="quickPalette"><input class="quickSearch" id="quickSearch" placeholder="🔎 Pesquisar mensagem rápida"><div class="quickResults">' + (state.quickReplies || []).map(reply => '<button class="quick" data-title="' + esc(reply.shortcut + ' ' + reply.body) + '" data-quick="' + esc(reply.shortcut) + '"><b>' + esc(reply.shortcut) + '</b><span>' + esc(reply.body) + '</span></button>').join('') + '</div></div>';
    composer.prepend(dock);
    dock.querySelector('#quickToggle').onclick = () => dock.querySelector('#quickPalette').classList.toggle('visible');
    dock.querySelectorAll('[data-quick]').forEach(button => button.onclick = () => useQuick(button.dataset.quick));
    dock.querySelector('#quickSearch').oninput = event => { const term = event.target.value.toLowerCase(); dock.querySelectorAll('[data-quick]').forEach(button => { button.hidden = !button.dataset.title.toLowerCase().includes(term); }); };
  }
  document.querySelector('#send').onsubmit = async event => {
    event.preventDefault();
    try {
      const file=attachmentInput.files?.[0];
      if(file&&file.size>10*1024*1024)throw Error('O arquivo deve possuir no máximo 10 MB.');
      let attachment=null;
      if(file){const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('Não foi possível ler o arquivo.'));reader.readAsDataURL(file);});attachment={name:file.name,type:file.type,data};}
      const payload={body:new FormData(event.target).get('body'),reply_to_id:replyTo?.id||null,attachment};
      const button=event.submitter;button.disabled=true;button.textContent='Enviando…';
      await api('/api/conversations/' + conversation.id + '/messages', { method: 'POST', body: JSON.stringify(payload) });
      replyTo=null;
      await boot();
      await openConversation(conversation.id);
    } catch (error) { alert(error.message); }
  };
  document.querySelector('#assume').onclick = () => conversationAction(conversation.id, 'assume');
  document.querySelector('#close').onclick = () => conversationAction(conversation.id, 'close');
  document.querySelector('#simulate').onclick = async () => {
    const body = prompt('Mensagem simulada do cliente');
    if (!body) return;
    try {
      await api('/api/conversations/' + conversation.id + '/simulate', { method: 'POST', body: JSON.stringify({ body }) });
      await boot();
      await openConversation(conversation.id);
    } catch (error) { alert(error.message); }
  };
  document.querySelector('#transfer').onclick = async () => {
    const department = prompt('Fila: ' + state.departments.map(item => item.id).join(', '));
    if (department) conversationAction(conversation.id, 'transfer', { department_id: department });
  };
}

async function useQuick(shortcut) {
  const settings = await api('/api/settings');
  const reply = settings.replies.find(item => item.shortcut === shortcut);
  if (reply) document.querySelector('[name=body]').value = reply.body;
}

async function conversationAction(id, action, data = {}) {
  try {
    await api('/api/conversations/' + id + '/' + action, { method: 'POST', body: JSON.stringify(data) });
    if (action === 'close') { inboxMode = 'closed'; protocolQuery = ''; }
    if (action === 'assume') { inboxMode = 'mine'; protocolQuery = ''; }
    await boot();
    await openConversation(id);
  } catch (error) { alert(error.message); }
}

async function settings() {
  const data = await api('/api/settings');
  const manager = supervisor();
  const channelButton = manager ? '<button class="btn" id="whatsapp">WhatsApp Experimental</button>' : '';
  const agents = data.profiles.map(profile => '<li><b>' + esc(profile.name) + '</b> · ' + esc(profile.role) + ' · ' + esc(profile.status) + '</li>').join('');
  const queues = data.departments.map(department => '<li>' + esc(department.name) + ' <small class="muted">(' + esc(department.id) + ')</small></li>').join('');
  const replies = data.replies.map(reply => '<li><b>' + esc(reply.shortcut) + '</b> · ' + esc(reply.body) + '</li>').join('');
  const managerForms = manager ? '<div class="settingsGrid"><form class="card" id="agentForm"><h3>Novo atendente</h3><label class="field">Nome do atendente (aparece nas mensagens)<input name="name" required minlength="2" maxlength="80"></label><label class="field">E-mail<input name="email" type="email" required></label><label class="field">Senha inicial<input name="password" type="password" required></label><label class="field">Perfil<select name="role"><option value="agent">Atendente</option><option value="supervisor">Supervisor</option></select></label><button class="btn">Cadastrar atendente</button></form><form class="card" id="queueForm"><h3>Nova fila</h3><label class="field">Nome da fila<input name="name" placeholder="Instalação, reparo, dúvida ou financeiro"></label><button class="btn">Criar fila</button></form><form class="card" id="autoForm"><h3>Robô de atendimento</h3><label class="field">Mensagem inicial<textarea name="welcome_message">' + esc(data.settings?.welcome_message) + '</textarea></label><label class="field">Encaminhamento para fila<textarea name="fallback_message">' + esc(data.settings?.fallback_message) + '</textarea></label><label class="field">Tentativas antes de encaminhar<input name="max_attempts" type="number" min="1" max="5" value="' + esc(data.settings?.max_attempts || 2) + '"></label><button class="btn">Salvar robô</button></form><form class="card" id="quickForm"><h3>Mensagem rápida</h3><label class="field">Atalho<input name="shortcut" placeholder="/reparo"></label><label class="field">Mensagem<textarea name="body"></textarea></label><label class="field">Fila<select name="department_id"><option value="">Todas</option>' + data.departments.map(item => '<option value="' + esc(item.id) + '">' + esc(item.name) + '</option>').join('') + '</select></label><button class="btn">Adicionar resposta</button></form></div>' : '<p class="card">Seu perfil permite usar as filas e respostas. Um supervisor pode alterar cadastro de equipe, robô e automações.</p>';
  const profileForm='<form class="card profileForm" id="profileForm"><h3>Meu nome no atendimento</h3><p class="muted">Esse nome obrigatório aparece em negrito acima de todas as mensagens enviadas por você.</p><label class="field">Nome do atendente nas mensagens<input name="display_name" required minlength="2" maxlength="80" autocomplete="name" value="'+esc(state.profile.display_name||state.profile.name)+'"></label><label class="field">Telefone interno<input name="phone" value="'+esc(state.profile.phone||'')+'"></label><button class="btn">Salvar perfil</button></form>';
  app.innerHTML = shell('<section class="settings"><div class="settingsHead"><div><h2>Configurações de atendimento</h2><p class="muted">Filas, equipe, mensagens rápidas e regras do robô são separadas por empresa.</p></div><div><button class="btn subtle" id="back">Voltar à caixa</button>' + channelButton + '</div></div><div class="settingsGrid">'+profileForm+'</div>' + managerForms + '<div class="settingsGrid"><article class="card"><h3>Atendentes</h3><ul>' + agents + '</ul></article><article class="card"><h3>Filas configuradas</h3><ul>' + queues + '</ul></article><article class="card"><h3>Mensagens rápidas</h3><ul>' + replies + '</ul></article></div></section>', 'Configurações');
  bindShell();
  document.querySelector('#back').onclick = render;
  if (document.querySelector('#whatsapp')) document.querySelector('#whatsapp').onclick = whatsapp;
  document.querySelector('#profileForm').onsubmit=event=>submit(event,'/api/profile',async()=>{await boot();settings();},'PATCH');
  if (manager) {
    document.querySelector('#agentForm').onsubmit = event => submit(event, '/api/agents', settings);
    document.querySelector('#queueForm').onsubmit = event => submit(event, '/api/queues', settings);
    document.querySelector('#autoForm').onsubmit = event => submit(event, '/api/automation', settings);
    document.querySelector('#quickForm').onsubmit = event => submit(event, '/api/quick-replies', settings);
  }
}

async function submit(event, path, after, method='POST') {
  event.preventDefault();
  try {
    await api(path, { method, body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    await after();
  } catch (error) { alert(error.message); }
}

async function whatsapp() {
  const getStatus = () => api('/api/whatsapp/status');
  const draw = status => {
    const connected = status.status === 'CONNECTED';
    const pair = status.pairing || {};
    const code = pair.code && !pair.expired ? pair.code : null;
    const label = connected ? 'WhatsApp conectado com sucesso!' : code ? 'Código gerado, aguardando vinculação' : pair.expired ? 'Código expirado' : status.status === 'PAIRING_REQUESTED' ? 'Aguardando geração do código' : status.status === 'PAIRING_ERROR' || status.status === 'ERROR' ? 'Falha na conexão' : status.status === 'CONNECTING' || status.status === 'RECONNECTING' ? 'Conectando' : 'WhatsApp desconectado';
    const qr = status.qr ? '<img class="qr" src="' + status.qr + '" alt="QR Code do WhatsApp">' : '<div class="qrPlaceholder">Nenhum QR Code ativo</div>';
    const pairingView = '<form id="pairForm" class="pairForm"><label class="field">Número do WhatsApp com DDI e DDD<input name="number" type="tel" inputmode="tel" autocomplete="tel" placeholder="+55 (11) 9XXXX-XXXX" required></label><button class="btn" ' + (connected ? 'disabled' : '') + '>Gerar código de pareamento</button></form>' + (code ? '<div class="pairCode" aria-live="polite">' + esc(code.slice(0,4) + '-' + code.slice(4)) + '</div><button class="btn subtle" id="copyPair">Copiar código</button><p class="muted">O código expira em aproximadamente cinco minutos.</p>' : '') + '<ol class="pairInstructions"><li>Abra o WhatsApp no celular principal.</li><li>Entre em Configurações → Dispositivos conectados.</li><li>Selecione Conectar dispositivo.</li><li>Escolha Conectar com número de telefone.</li><li>Digite o código apresentado na central.</li><li>Aguarde a confirmação da conexão.</li></ol><p class="muted">Os nomes das opções podem variar conforme o aparelho e a versão do WhatsApp.</p>';
    const indicator = (name, value) => '<span class="statusPill"><i class="statusDot ' + (value ? 'ok' : 'bad') + '"></i>' + name + ': ' + (value ? 'Online' : 'Offline') + '</span>';
    const monitors = '<div class="statusMonitor"><b>Monitoramento</b><div>' + indicator('Backend', status.backendOnline !== false) + indicator('Conector', Boolean(status.connectorOnline)) + indicator('WhatsApp', Boolean(status.whatsappConnected || status.status === 'CONNECTED')) + indicator('QR ativo', Boolean(status.qrAvailable || status.qr)) + '</div></div>';
    app.innerHTML = shell('<section class="settings"><div class="settingsHead"><div><h2>WhatsApp Experimental</h2><p class="muted">Conector Baileys no Render para testes controlados.</p></div><button class="btn subtle" id="back">Voltar</button></div><div class="card whatsappCard">' + monitors + '<p aria-live="polite"><b>' + esc(label) + '</b></p><p><b>Número conectado:</b> ' + esc(status.phone || 'aguardando') + '</p><p><b>Robô:</b> '+(status.autoReplyEnabled?'Ativo':'Pausado')+'</p>' + (status.lastError ? '<p class="muted">' + esc(status.lastError) + '</p>' : '') + '<div class="pairTabs"><button class="btn ' + (whatsappMode === 'qr' ? '' : 'subtle') + '" id="showQr">QR Code</button><button class="btn ' + (whatsappMode === 'pair' ? '' : 'subtle') + '" id="showPair">Código de pareamento</button></div>' + (whatsappMode === 'qr' ? qr + '<button class="btn" id="connect">Conectar por QR Code</button>' : pairingView) + '<div class="pairTabs"><button class="btn" id="toggleRobot">'+(status.autoReplyEnabled?'Pausar robô':'Ativar robô')+'</button><button class="btn subtle" id="disconnect">Desconectar</button><button class="btn subtle" id="deleteSession">Encerrar e apagar sessão</button></div><hr><h3>Números autorizados</h3><form id="allow"><input name="number" type="tel" placeholder="+55 (11) 9XXXX-XXXX"><button class="btn">Autorizar número</button></form><p><b>Autorizados:</b> ' + esc(status.allowedCount) + '</p><button class="btn emergency" id="stop">Desativar todas as respostas automáticas</button></div></section>', 'WhatsApp Experimental');
    bindShell();
    document.querySelector('#back').onclick = settings;
    document.querySelector('#showQr').onclick = () => { whatsappMode = 'qr'; whatsapp(); };
    document.querySelector('#showPair').onclick = () => { whatsappMode = 'pair'; whatsapp(); };
    if (whatsappMode === 'qr') document.querySelector('#connect').onclick = async () => { document.querySelector('#connect').disabled = true; try { await api('/api/whatsapp/connect', { method: 'POST' }); whatsapp(); } catch (error) { alert(error.message); whatsapp(); } };
    if (whatsappMode === 'pair') {
      document.querySelector('#pairForm').onsubmit = async event => { event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; try { await api('/api/whatsapp/pairing-code', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); whatsapp(); } catch (error) { alert(error.message); button.disabled = false; whatsapp(); } };
      if (code) document.querySelector('#copyPair').onclick = () => navigator.clipboard.writeText(code).then(() => alert('Código copiado.')).catch(() => alert('Não foi possível copiar. Selecione o código na tela.'));
    }
    document.querySelector('#disconnect').onclick = async () => { if (confirm('Desconectar este WhatsApp?')) { await api('/api/whatsapp/disconnect', { method: 'POST' }); whatsapp(); } };
    document.querySelector('#toggleRobot').onclick=async()=>{await api('/api/whatsapp/auto-reply',{method:'POST',body:JSON.stringify({enabled:!status.autoReplyEnabled})});whatsapp();};
    document.querySelector('#deleteSession').onclick = async () => { if (confirm('Encerrar a conexão e apagar a sessão salva para permitir um novo pareamento?')) { try { await api('/api/whatsapp/logout-and-delete-session', { method: 'POST' }); const pending = await api('/api/whatsapp/connect', { method: 'POST' }); draw(pending); } catch (error) { alert(error.message); whatsapp(); } } };
    document.querySelector('#stop').onclick = async () => { await api('/api/whatsapp/emergency-stop', { method: 'POST' }); whatsapp(); };
    const numberInput = document.querySelector('#allow [name=number]');
    numberInput.oninput = () => { numberInput.value = formatPhone(numberInput.value); };
    document.querySelector('#allow').onsubmit = async event => { event.preventDefault(); await api('/api/whatsapp/authorize', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); whatsapp(); };
    if (['QR_PENDING','CONNECTING','RECONNECTING','PAIRING_REQUESTED','PAIRING_CODE'].includes(status.status)) setTimeout(() => { if (document.querySelector('#pairForm') || document.querySelector('#connect')) whatsapp(); }, 1500);
  };
  try { draw(await getStatus()); } catch { app.innerHTML = shell('<section class="settings"><h2>WhatsApp Experimental</h2><p class="card">Conector local indisponível. A vinculação remota pelo Render requer a futura ponte autenticada.</p><button class="btn subtle" id="back">Voltar</button></section>', 'WhatsApp Experimental'); bindShell(); document.querySelector('#back').onclick = settings; }
}

token ? boot() : login();
