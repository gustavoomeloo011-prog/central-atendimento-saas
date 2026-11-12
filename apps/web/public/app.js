const attendanceLabel = value => ({waiting:'Aguardando',open:'Em atendimento',closed:'Encerrado'}[value] || value || 'Não informado');
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
let clientPanelOpen = localStorage.getItem('central_client_panel') !== '0';
let whatsappView = 0;
let whatsappTimer = null;
function leaveWhatsApp() { whatsappView++; clearTimeout(whatsappTimer); }
let whatsappMode = 'qr';
let replyTo = null;
let liveTimer = null;
let currentView = 'login';
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
  if(activeId===id&&panel){panel.innerHTML=renderSgp(value); panel.querySelectorAll('.invoiceSend').forEach(button=>button.onclick=async()=>{try{button.disabled=true;await api('/api/conversations/'+encodeURIComponent(id)+'/send-invoice',{method:'POST',body:JSON.stringify({invoice_id:button.dataset.invoiceId})});button.textContent='Fatura enviada';}catch(error){button.disabled=false;alert(error.message);}});}
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
const initials = value => String(value || '?').trim().split(/\s+/).slice(0,2).map(part=>part[0]||'').join('').toUpperCase();
const elapsed = value => { const date=new Date(value),seconds=Math.max(0,Math.floor((Date.now()-date)/1000)); if(Number.isNaN(date.valueOf()))return ''; if(seconds<60)return seconds+'s'; const minutes=Math.floor(seconds/60); if(minutes<60)return String(minutes).padStart(2,'0')+'m '+String(seconds%60).padStart(2,'0')+'s'; const hours=Math.floor(minutes/60); return String(hours).padStart(2,'0')+'h '+String(minutes%60).padStart(2,'0')+'m'; };
const durationBetween = (start, end = Date.now()) => { const seconds=Math.max(0,Math.floor((new Date(end)-new Date(start))/1000)); if(!Number.isFinite(seconds))return ''; if(seconds<60)return seconds+'s'; const minutes=Math.floor(seconds/60); if(minutes<60)return String(minutes).padStart(2,'0')+'m '+String(seconds%60).padStart(2,'0')+'s'; const hours=Math.floor(minutes/60); return String(hours).padStart(2,'0')+'h '+String(minutes%60).padStart(2,'0')+'m'; };
const supervisor = () => ['supervisor', 'company_admin', 'superadmin'].includes(state.profile?.role);
const queueTone = item => { const text=String(item.department_name||item.subject||'').toLowerCase(); return /financ|fatura|boleto/.test(text)?'tone-finance':/suporte|t[eé]cnic|reparo|sinal/.test(text)?'tone-support':/segunda|2ª|via/.test(text)?'tone-invoice':/venda|comercial|plano/.test(text)?'tone-sales':'tone-default'; };

function login() {
  currentView = 'login';
  leaveWhatsApp();
  app.innerHTML = '<section class="login"><div class="brand"><span class="tag">ATENDIMENTO SG FIBRA</span><h1>Central de Atendimento</h1><p class="muted">Conversas, equipes, filas e automações em um só lugar.</p></div><form class="card" id="login"><h2>Entrar</h2><label class="field">Usuário ou e-mail<input name="email" type="text" autocomplete="username" required></label><label class="field">Senha<input name="password" type="password" autocomplete="current-password" required></label><button class="btn">Entrar</button><button type="button" class="btn subtle" id="recover">Esqueci minha senha</button></form></section>';
  document.querySelector('#recover').onclick = () => { app.innerHTML='<section class="login"><div class="brand"><span class="tag">ATENDIMENTO SG FIBRA</span><h1>Recuperar acesso</h1><p class="muted">Informe o e-mail cadastrado para receber um link de recuperação.</p></div><form class="card" id="recovery"><label class="field">E-mail cadastrado<input name="email" type="email" autocomplete="email" required></label><button class="btn">Enviar link</button><button type="button" class="btn subtle" id="backLogin">Voltar ao login</button><p class="muted" id="recoveryMessage"></p></form></section>'; document.querySelector('#backLogin').onclick=login; document.querySelector('#recovery').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;button.textContent='Enviando…';try{const result=await api('/api/recover-password',{method:'POST',body:JSON.stringify({email:new FormData(event.target).get('email')})});document.querySelector('#recoveryMessage').textContent=result.message||'Se existir uma conta vinculada a este e-mail, enviaremos as instruções para recuperação de acesso.';button.textContent='Solicitação enviada';}catch(error){document.querySelector('#recoveryMessage').textContent=error.message;button.disabled=false;button.textContent='Tentar novamente';}}; };
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

function passwordReset() {
  currentView='reset-password';
  app.innerHTML='<section class="login"><div class="brand"><span class="tag">ATENDIMENTO SG FIBRA</span><h1>Redefinir senha</h1><p class="muted">Escolha uma nova senha para sua conta.</p></div><form class="card" id="passwordReset"><label class="field">Nova senha<input name="password" type="password" autocomplete="new-password" minlength="8" required></label><label class="field">Confirmar senha<input name="confirm" type="password" autocomplete="new-password" minlength="8" required></label><button class="btn">Salvar nova senha</button><p class="muted" id="resetMessage"></p></form></section>';
  document.querySelector('#passwordReset').onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.target));if(values.password!==values.confirm){document.querySelector('#resetMessage').textContent='As senhas não coincidem.';return;}const button=event.submitter;button.disabled=true;try{await api('/api/recover-password/update',{method:'POST',body:JSON.stringify({password:values.password})});localStorage.removeItem('central_token');token=null;history.replaceState(null,'',location.pathname+location.search);document.querySelector('#resetMessage').textContent='Senha atualizada. Entre com a nova senha.';setTimeout(login,1200);}catch(error){document.querySelector('#resetMessage').textContent=error.message;button.disabled=false;}};
}

async function boot() {
  try {
    sgpData.clear();
    state = await api('/api/bootstrap');
    if (!state.robotEnabled && inboxMode === 'general') inboxMode = 'human';
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
  if (currentView !== 'inbox' || !token || document.hidden || document.activeElement?.matches('textarea,input,select')) return;
  try {
    if(activeId&&document.querySelector('#sgpDetails'))void loadSgp(activeId);
    const next = await api('/api/bootstrap');
    const detail = activeId ? await api('/api/conversations/' + activeId) : null;
    if (currentView !== 'inbox') return;
    const before = JSON.stringify([(state.conversations||[]).map(item=>[item.id,item.updated_at,item.last_message]),(state.detail?.messages||[]).map(item=>[item.id,item.delivery_status])]);
    const after = JSON.stringify([(next.conversations||[]).map(item=>[item.id,item.updated_at,item.last_message]),(detail?.messages||[]).map(item=>[item.id,item.delivery_status])]);
    if (before !== after || (inboxMode === 'closed' && document.querySelector('.list'))) { state = {...next,detail}; render(); }
  } catch {}
}

setInterval(() => {
  if (currentView !== 'inbox') return;
  document.querySelectorAll('[data-clock-start]').forEach(clock => { clock.textContent=elapsed(clock.dataset.clockStart); });
}, 1000);

function messageHtml(message) {
  const internal = message.direction === 'internal';
  const robot = !internal && message.direction === 'outbound' && /autom[aá]tico|rob[oô]/i.test(message.author_name || '');
  const attachment = message.attachment_path ? '<button class="attachment" type="button" data-attachment="' + esc(message.id) + '">📎 ' + esc(message.attachment_name || 'Abrir anexo') + '</button>' : '';
  const reply = message.reply_body ? '<div class="quoted">↩ ' + esc(message.reply_body) + '</div>' : '';
  const status = message.direction === 'outbound' ? ({pending:' · pendente',sending:' · enviando',sent:' ✓',delivered:' ✓✓',read:' ✓✓ lida',failed:' · falhou',unknown:' · indeterminada'}[message.delivery_status]||' · pendente') : '';
  const author = internal ? 'Nota interna' : robot ? 'Robô SG Fibra' : message.direction === 'inbound' ? 'Cliente' : (message.author_name || 'Atendente');
  return '<div class="message ' + (message.direction === 'outbound' ? 'outbound ' : 'inbound ') + (robot ? 'robot ' : '') + (internal ? 'internal' : '') + '" data-message-id="' + esc(message.id) + '" title="' + esc(message.error_message||'') + '"><b class="messageAuthor">' + (robot ? '<span class="authorIcon">🤖</span>' : internal ? '<span class="authorIcon">▣</span>' : '') + esc(author) + '</b>' + reply + '<div>' + esc(message.body) + '</div>' + attachment + (message.delivery_status==='failed'?'<p class="sendFailure" role="status">Não enviada: '+esc(message.error_message||'Falha no envio')+'</p>':'') + '<small>' + esc(message.message_time || '') + status + (internal ? ' · somente equipe' : '') + '</small></div>';
}

async function showConversationHistory(conversation) {
  try {
    const result=await api('/api/conversations/'+encodeURIComponent(conversation.id)+'/history');
    const history=result.history||[];
    document.querySelector('#historyOverlay')?.remove();
    app.insertAdjacentHTML('beforeend','<div class="historyOverlay" id="historyOverlay"><section class="historyDialog" role="dialog" aria-modal="true" aria-labelledby="historyTitle"><header class="historyHead"><div><h2 id="historyTitle">Histórico de atendimentos</h2><small>'+esc(conversation.contact_name)+' · '+history.length+' atendimento(s) anterior(es)</small></div><button class="btn subtle" id="closeHistory">Fechar</button></header><div class="historyBody" id="historyBody">'+(history.length?'<div class="historyList">'+history.map(item=>'<button class="historyItem" data-history-id="'+esc(item.id)+'"><b>'+esc(item.protocol||'Sem protocolo')+' · '+esc(attendanceLabel(item.status))+'</b><span>'+esc(item.department_name||'Sem fila')+'</span><small>'+esc(item.started_at?new Date(item.started_at).toLocaleString('pt-BR'):'Data indisponível')+(item.closed_at?' — encerrado '+new Date(item.closed_at).toLocaleString('pt-BR'):'')+' · '+Number(item.message_count||0)+' mensagens</small><small>Última mensagem: '+esc(item.last_message||'Sem mensagens')+'</small></button>').join('')+'</div>':'<p class="muted">Ainda não há atendimentos anteriores para este telefone.</p>')+'</div></section></div>');
    const overlay=document.querySelector('#historyOverlay');
    const close=()=>overlay.remove();
    document.querySelector('#closeHistory').onclick=close;
    overlay.onclick=event=>{if(event.target===overlay)close();};
    overlay.querySelectorAll('[data-history-id]').forEach(button=>button.onclick=async()=>{
      const body=document.querySelector('#historyBody');body.innerHTML='<p class="muted">Carregando conversa completa…</p>';
      try{
        const detail=await api('/api/conversations/'+encodeURIComponent(button.dataset.historyId));
        const item=history.find(row=>row.id===button.dataset.historyId);
        body.innerHTML='<button class="btn subtle" id="historyBack">← Todos os atendimentos</button><p><b>'+esc(item?.protocol||'Sem protocolo')+'</b> · '+esc(item?.department_name||'Sem fila')+' · '+esc(item?.started_at?new Date(item.started_at).toLocaleString('pt-BR'):'')+'</p><div class="historyThread" id="historyThread">'+(detail.messages||[]).map(messageHtml).join('')+'</div>';
        document.querySelector('#historyBack').onclick=()=>showConversationHistory(conversation);
        document.querySelectorAll('#historyThread [data-attachment]').forEach(link=>link.onclick=async event=>{event.stopPropagation();try{const response=await fetch('/api/attachments/'+link.dataset.attachment,{headers:{authorization:'Bearer '+token}});if(!response.ok)throw Error('Anexo indisponível.');const blob=await response.blob(),url=URL.createObjectURL(blob);window.open(url,'_blank','noopener');setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(error){alert(error.message);}});
        const thread=document.querySelector('#historyThread');thread.scrollTop=thread.scrollHeight;
      }catch(error){body.innerHTML='<p role="alert">'+esc(error.message||'Não foi possível abrir a conversa.')+'</p><button class="btn subtle" id="historyBack">← Voltar</button>';document.querySelector('#historyBack').onclick=()=>showConversationHistory(conversation);}
    });
  }catch(error){alert(error.message||'Não foi possível carregar o histórico.');}
}

async function openConversation(id) {
  activeId = id;
  state.detail = await api('/api/conversations/' + id);
  void loadSgp(id);
  mobilePane = 'chat';
  render();
}

function shell(content, title = 'Caixa de entrada') {
  const active = title === 'Caixa de entrada' ? 'inbox' : ({Filas:'queues',Equipe:'team',Automações:'automations',Indicadores:'indicators',Configurações:'settings'}[title] || 'inbox');
  const nav = [['inbox','▣','Atendimentos'],['queues','◇','Filas'],['team','♙','Equipe'],['automations','♙','Robôs'],['indicators','▥','Indicadores'],['settings','⚙','Configurações']].map(([id,icon,label])=>'<button class="navButton '+(active===id?'activeNav':'')+'" id="'+id+'"><span>'+icon+'</span> '+label+'</button>').join('');
  return '<div class="shell'+(clientPanelOpen?'':' clientPanelClosed')+'"><aside class="side"><div class="sideBrand"><span class="brandMark">◔</span><div><h2>SG Fibra</h2><small>Central de atendimento</small></div></div><div class="nav">'+nav+'<button class="navButton logoutButton" id="logout"><span>↪</span> Sair</button></div></aside><header class="top"><button class="menuToggle" id="menuToggle" aria-label="Abrir ou fechar menu">☰</button><div class="pageTitle"><b>' + (title === 'Caixa de entrada' ? 'Atendimentos' : title) + '</b><span class="muted">' + esc(state.company.name) + '</span></div><div class="profileBadge"><span class="profileAvatar">' + esc(initials(state.profile.name)) + '</span><span><b>' + esc(state.profile.name) + '</b><small>' + esc(state.profile.role) + '</small></span></div></header>' + content + '</div>';
}

function render() {
  currentView = 'inbox';
  leaveWhatsApp();
  const list = [...(state.conversations || [])].sort((a, b) => {
    if (inboxMode === 'human' || inboxMode === 'general') return new Date(a.human_started_at || a.created_at || 0) - new Date(b.human_started_at || b.created_at || 0);
    if (inboxMode === 'closed') return new Date(b.closed_at || b.updated_at || 0) - new Date(a.closed_at || a.updated_at || 0);
    return new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0);
  });
  const isInInboxMode = item => inQueue(item,inboxMode,state.profile.id);
  const matchesProtocol = item => { const query=protocolQuery.trim().toUpperCase(); if(!query)return true; return [item.protocol,item.contact_name,item.contact_phone,item.department_name,item.subject,item.last_message].some(value=>String(value||'').toUpperCase().includes(query)); };
  const isVisibleInList = item => matchesProtocol(item) && (protocolQuery ? true : isInInboxMode(item));
  const conversation = list.find(item => item.id === activeId);
  const messages = state.detail?.conversation?.id === activeId ? state.detail.messages : [];
  const queueCount = list.filter(isInInboxMode).length;
  const queueName = ({general:'🤖 Robô / Geral',human:'🎧 Aguardando atendente',mine:'👤 Meus atendimentos',closed:'✅ Encerrados'})[inboxMode] || 'Atendimentos';
  const inbox = '<section class="list"><div class="listTitle"><div><h2>Conversas <span class="queueTotal">'+queueCount+'</span></h2><small class="activeQueueLabel">'+esc(queueName)+'</small></div><button class="iconButton" id="refresh" title="Atualizar">↻</button></div><div class="toolbar">' + (inboxMode === 'closed' ? '<small class="retentionHint" title="Encerrados saem desta lista após 24 horas; o histórico é preservado">Visíveis por 24h · conversas antigas permanecem no histórico</small>' : '') + '<label class="protocolSearch"><span>⌕</span><input id="protocolSearch" type="search" autocomplete="off" placeholder="Cliente, telefone ou protocolo…" aria-label="Buscar atendimento" value="' + esc(protocolQuery) + '"></label></div><div class="conversationList">' + list.map(item => { const waiting=item.status==='waiting'; const clockStart=waiting?(item.human_started_at||item.created_at):item.status==='closed'?(item.closed_at||item.updated_at):(item.updated_at||item.created_at); const clockTitle=waiting?'Tempo aguardando atendente':item.status==='open'?'Última atividade':'Encerrado há'; const owner=item.assignee_name?'👤 '+item.assignee_name:waiting?'⌛ Sem responsável':'🤖 Robô'; return '<article class="conversation ' + (item.id === activeId ? 'active ' : '') + queueTone(item) + '" data-id="' + item.id + '" data-protocol="' + esc(item.protocol || '') + '"' + (isVisibleInList(item) ? '' : ' hidden') + '><span class="conversationAvatar">' + esc(initials(item.contact_name)) + '</span><div class="conversationMain"><div class="conversationTop"><b>' + esc(item.contact_name) + '</b><time title="'+clockTitle+'">◷ <span data-clock-start="'+esc(clockStart)+'">' + esc(elapsed(clockStart)) + '</span></time></div><div class="conversationPreview">' + esc(item.last_message || item.subject) + '</div><div class="conversationMeta"><span class="statusChip ' + item.status + ' ' + queueTone(item) + '">' + esc(attendanceLabel(item.status)) + '</span><small title="Fila">' + esc(item.department_name || 'Sem fila') + '</small></div><small class="conversationOwner">'+esc(owner)+'</small><small class="protocolLabel">' + esc(item.protocol || 'Protocolo pendente') + '</small></div></article>'; }).join('') + '</div></section>';
  const shortcuts = (state.quickReplies || []).map(reply => '<button class="quick" data-quick="' + esc(reply.shortcut) + '">' + esc(reply.shortcut) + '</button>').join('');
  const quickDock = '<div class="quickDock"><button class="quickToggle" id="quickToggle" type="button" aria-label="Abrir mensagens rápidas">⚡</button><div class="quickPalette" id="quickPalette">' + shortcuts + '</div></div>';
  const client = conversation ? '<aside class="clientPanel"><div class="panelTitle"><div><span class="eyebrow">Informações do cliente</span><h2>' + esc(conversation.contact_name) + '</h2></div><span class="statusChip ' + esc(conversation.status) + '">' + esc(attendanceLabel(conversation.status)) + '</span></div><dl class="clientData"><dt>Telefone</dt><dd>' + esc(formatPhone(conversation.contact_phone) || 'Não informado') + '</dd><dt>Assunto</dt><dd>' + esc(conversation.subject || 'Não informado') + '</dd><dt>Fila</dt><dd>' + esc(conversation.department_name || conversation.department_id || 'Não informado') + '</dd><dt>Responsável</dt><dd>' + esc(conversation.assignee_name || state.conversations.find(item=>item.id===conversation.id)?.assignee_name || 'Ainda não atribuído') + '</dd><dt>Protocolo</dt><dd>' + esc(conversation.protocol || 'Pendente') + '</dd></dl><div class="sgpBox" id="sgpDetails" aria-live="polite">' + renderSgp(sgpData.get(activeId)?.value) + '</div></aside>' : '<aside class="clientPanel empty">Selecione um atendimento para ver os dados do cliente.</aside>';
  const replyPreview = replyTo ? '<div class="replyPreview"><span>Respondendo: ' + esc(replyTo.body) + '</span><button type="button" id="cancelReply">×</button></div>' : '';
  const canSend = Boolean(conversation && conversation.status !== 'closed' && conversation.assigned_profile_id === state.profile?.id);
  const sendHint = conversation && !canSend ? '<div class="sendLockHint" role="status">' + (conversation.status === 'closed' ? 'Atendimento encerrado. Reabra/assuma um novo atendimento para responder.' : conversation.assigned_profile_id ? 'Atendimento com outro agente. A mensagem fica bloqueada.' : 'Assuma o atendimento para liberar o envio de mensagens.') + '</div>' : '';
  const waitingNow=conversation?.status==='waiting'; const closedNow=conversation?.status==='closed'; const clockStart=waitingNow?(conversation.human_started_at||conversation.created_at):(conversation.created_at||conversation.updated_at); const clockLabel=waitingNow?'Tempo aguardando atendente':closedNow?'Duração total do atendimento':'Tempo de atendimento'; const clockValue=closedNow?durationBetween(conversation.created_at,conversation.closed_at||Date.now()):elapsed(clockStart);
  const chat = conversation ? '<section class="chat"><div class="mobileChatNav"><button class="btn subtle" id="backToList">← Conversas</button><button class="btn subtle" id="showClient">Dados do cliente</button></div><div class="chatHead"><div class="chatIdentity"><span class="conversationAvatar">' + esc(initials(conversation.contact_name)) + '</span><div><h2>' + esc(conversation.contact_name) + '</h2><span class="channelLine">● WhatsApp <i>•</i> Fila: ' + esc(conversation.department_name || 'Sem fila') + '</span><div class="protocolHeader"><b>' + esc(conversation.protocol || 'Protocolo pendente') + '</b>' + (conversation.protocol ? '<button type="button" class="linkButton" id="copyProtocol">Copiar</button>' : '') + '<button class="linkButton historyLink" id="history" aria-label="Abrir histórico completo de conversas">◷ Histórico</button><button class="linkButton" id="toggleClientPanel" aria-label="Abrir ou fechar dados do cliente">' + (clientPanelOpen ? '▣ Ocultar dados' : '▣ Mostrar dados') + '</button><button class="linkButton" id="renameContact">Editar contato</button></div></div></div><div class="waitTime"><small>' + clockLabel + '</small><b ' + (closedNow?'':'data-clock-start="'+esc(clockStart)+'"') + '>' + esc(clockValue) + '</b></div></div><div class="chatActions"><button class="btn primaryAction" id="assume" ' + (canSend ? 'disabled aria-pressed="true"' : '') + '>' + (canSend ? '✓ Assumido por você' : '♙ Assumir atendimento') + '</button><button class="btn subtle" id="transfer">⇄ Transferir</button><button class="btn subtle" id="close">✓ Encerrar</button><button class="btn subtle" id="internalNote">▣ Nota interna</button><button class="btn subtle simulationAction" id="simulate">Simular cliente</button></div>' + sendHint + '<div class="messages">' + messages.map(messageHtml).join('') + '</div>' + replyPreview + '<form class="composer" id="send"><div class="composerTools">' + quickDock + '<button class="attachButton" id="attachButton" type="button" title="Anexar foto, vídeo ou PDF" ' + (canSend ? '' : 'disabled') + '>⌕</button></div><input id="attachmentInput" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,application/pdf" hidden ' + (canSend ? '' : 'disabled') + '><textarea name="body" placeholder="' + (canSend ? 'Digite uma mensagem…' : 'Assuma o atendimento para responder') + '" ' + (canSend ? '' : 'disabled') + '></textarea><span class="attachmentName" id="attachmentName"></span><button class="btn sendButton" aria-label="Enviar mensagem" ' + (canSend ? '' : 'disabled') + '>➤</button></form></section>' : '<section class="chat empty">Selecione uma conversa.</section>';
  app.innerHTML = shell(inbox + chat + client);
  document.querySelector('.shell').dataset.mobilePane = mobilePane;
  const clientPanel = document.querySelector('.clientPanel');
  if (clientPanel) clientPanel.insertAdjacentHTML('afterbegin', '<button class="btn subtle mobileClientBack" id="backToChat">← Voltar ao chat</button>');
  const listToolbar = document.querySelector('.list .toolbar');
  if (listToolbar) {
    const modes = [
      { id: 'general', symbol: '🤖', label: 'Robô / Geral' },
      { id: 'human', symbol: '🕒', label: 'Aguardando atendente' },
      { id: 'mine', symbol: '👤', label: 'Meus atendimentos' },
      { id: 'closed', symbol: '✅', label: 'Encerrados' }
    ].filter(item => state.robotEnabled || item.id !== 'general');
    const mode = document.createElement('div'); mode.className = 'inboxModes';
    mode.innerHTML = modes.map(item => { const count=list.filter(row=>inQueue(row,item.id,state.profile.id)).length; return '<button class="btn queueMode ' + (inboxMode === item.id ? '' : 'subtle') + '" type="button" data-inbox-mode="' + item.id + '" aria-label="' + item.label + ', ' + count + ' conversas" title="' + item.label + ' ('+count+')">' + item.symbol + '<span class="queueCount">' + count + '</span></button>'; }).join('') + '<button class="iconButton" id="newConversation" type="button" aria-label="Nova conversa" title="Nova conversa">＋</button>';
    mode.querySelectorAll('[data-inbox-mode]').forEach(button => {
      button.onclick = () => {
        inboxMode = button.dataset.inboxMode;
        protocolQuery = '';
        activeId = null;
        state.detail = null;
        render();
      };
    });
    mode.querySelector('#newConversation').onclick=async()=>{const phone=prompt('DDD + número do WhatsApp (ex.: 11999999999)');if(!phone)return;const name=prompt('Nome do contato (opcional)')||'';try{const result=await api('/api/conversations',{method:'POST',body:JSON.stringify({phone,name})});await boot();await openConversation(result.conversation.id);}catch(error){alert(error.message);}};
    listToolbar.prepend(mode);
  }
  bindShell();
  document.querySelector('#refresh').onclick = boot;
  const protocolInput = document.querySelector('#protocolSearch');
  if (protocolInput) protocolInput.oninput = () => {
    protocolQuery = protocolInput.value;
    document.querySelectorAll('.conversation').forEach(element => {
      const row = list.find(item => item.id === element.dataset.id);
      element.hidden = !(row && matchesProtocol(row) && (protocolQuery || isInInboxMode(row)));
    });
  };
  if (protocolInput) protocolInput.onkeydown = event => { if (event.key === 'Enter') { const match = list.find(matchesProtocol); if (match) { event.preventDefault(); openConversation(match.id); } } };
  if (document.querySelector('#backToList')) document.querySelector('#backToList').onclick = () => { mobilePane = 'list'; render(); };
  if (document.querySelector('#showClient')) document.querySelector('#showClient').onclick = () => { mobilePane = 'client'; render(); };
  if (document.querySelector('#toggleClientPanel')) document.querySelector('#toggleClientPanel').onclick = () => { clientPanelOpen = !clientPanelOpen; localStorage.setItem('central_client_panel', clientPanelOpen ? '1' : '0'); render(); };
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
  currentView = 'panel';
  leaveWhatsApp();
  app.innerHTML = '<section class="settings loadingPanel"><p class="card">Carregando…</p></section>';
  const data = await api('/api/settings');
  if (type === 'queues') {
    const monitor=await api('/api/queue-monitor');
    const fmt=ms=>{const s=Math.max(0,Math.floor(ms/1000));return String(Math.floor(s/60)).padStart(2,'0')+'m '+String(s%60).padStart(2,'0')+'s';};
    const stat=(label,value,tone)=>'<article class="card queueStat '+tone+'"><span>'+label+'</span><h2>'+value+'</h2></article>';
    const rows=monitor.queues.map(q=>'<tr><td><b>'+esc(q.name)+'</b></td><td>'+q.active+'</td><td>'+q.waiting+'</td><td>'+fmt(q.averageWaitMs)+'</td></tr>').join('');
    const waiting=monitor.waiting.sort((a,b)=>Date.parse(a.human_started_at||a.created_at)-Date.parse(b.human_started_at||b.created_at)).slice(0,12).map(c=>'<article class="queueWaiting" data-open-conversation="'+esc(c.id)+'"><b>'+esc(c.contact_name)+'</b><span>'+esc(c.department_name)+' · '+(c.assignee_name||'Aguardando atendente')+'</span><time>'+fmt(Date.now()-Date.parse(c.human_started_at||c.created_at))+'</time></article>').join('')||'<p class="muted">Nenhum cliente aguardando.</p>';
    const people=monitor.profiles.map(p=>'<li><b>'+esc(p.name)+'</b> · '+esc(p.status||'offline')+' · '+p.assigned_count+' atendimento(s)</li>').join('');
    app.innerHTML=shell('<section class="queueDashboard"><div class="settingsHead"><div><h2>Filas em tempo real</h2><p class="muted">Monitoramento operacional da empresa. Atualize para acompanhar mudanças recentes.</p></div><button class="btn subtle" id="back">Voltar</button></div><div class="queueStats">'+stat('Conversas ativas',monitor.stats.active,'blue')+stat('Com robô',monitor.stats.robot,'purple')+stat('Aguardando humano',monitor.stats.waiting,'orange')+stat('Em atendimento',monitor.stats.human,'green')+stat('Espera média',fmt(monitor.stats.averageWaitMs),'blue')+'</div><div class="queueGrid"><article class="card"><h3>Filas</h3><table class="queueTable"><thead><tr><th>Fila</th><th>Ativos</th><th>Aguardando</th><th>Espera média</th></tr></thead><tbody>'+rows+'</tbody></table></article><aside class="card"><h3>Clientes aguardando</h3><div>'+waiting+'</div></aside><aside class="card"><h3>Atendentes</h3><ul>'+people+'</ul></aside></div></section>','Filas');
    document.querySelectorAll('[data-open-conversation]').forEach(el=>el.onclick=()=>openConversation(el.dataset.openConversation));
  } else if (type === 'team') {
    const people = data.profiles.map(profile => '<article class="card"><h3>' + esc(profile.name) + '</h3><p class="muted">' + esc(profile.email) + '</p><span class="tag">' + esc(profile.role) + '</span> <span class="tag">' + esc(profile.status) + '</span></article>').join('');
    app.innerHTML = shell('<section class="settings"><div class="settingsHead"><div><h2>Equipe</h2><p class="muted">Atendentes individuais, status e permissões da empresa.</p></div><button class="btn" id="manageTeam">Gerenciar equipe</button></div><div class="settingsGrid">' + people + '</div></section>', 'Equipe');
    document.querySelector('#manageTeam').onclick = settings;
  } else if (type === 'automations') {
    const flows = (await api('/api/flows')).flows;
    const cards = flows.length ? flows.map(flow => '<article class="card"><span class="tag">' + esc(flow.status === 'published' ? 'ATIVO' : flow.status) + '</span><h3>' + esc(flow.name) + '</h3><p class="muted">Versão publicada: ' + esc(flow.published_version || 'nenhuma') + '</p></article>').join('') : '<article class="card"><h3>Nenhum fluxo cadastrado</h3><p class="muted">Abra o editor visual e configure o atendimento SG Fibra.</p></article>';
    const enabled=flows.some(flow=>flow.status==='published');
    app.innerHTML = shell('<section class="settings"><div class="settingsHead"><div><h2>Automações</h2><p class="muted">Crie caminhos de atendimento com blocos conectados e teste antes de publicar.</p></div><div class="automationActions"><label class="switchLabel">Robô <input type="checkbox" id="robotToggle" '+(enabled?'checked':'')+'><span class="switchTrack"></span></label><button class="btn" id="manageAutomation">Abrir editor visual</button></div></div><div class="settingsGrid">' + cards + '</div></section>', 'Automações');
    document.querySelector('#manageAutomation').onclick = automationEditor;
    document.querySelector('#robotToggle').onchange=async event=>{try{await api('/api/automation/toggle',{method:'POST',body:JSON.stringify({enabled:event.target.checked})});await openPanel('automations');}catch(error){event.target.checked=!event.target.checked;alert(error.message);}};
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
  currentView = 'editor';
  leaveWhatsApp();
  return showFlowEditor({app,api,shell,bindShell,esc,back:()=>openPanel('automations')});
}

function bindConversation(conversation) {
  const oldToggle=document.querySelector('#toggleClientPanel');
  if(oldToggle){ const panel=document.querySelector('.clientPanel'); const title=panel?.querySelector('.panelTitle'); if(clientPanelOpen){ oldToggle.remove(); if(title&&!title.querySelector('.clientPanelToggle')){ const button=document.createElement('button'); button.className='iconButton clientPanelToggle'; button.type='button'; button.title='Ocultar dados do cliente'; button.textContent='×'; button.onclick=()=>{clientPanelOpen=false;localStorage.setItem('central_client_panel','0');render();}; title.appendChild(button); } } else { oldToggle.textContent='▣ Mostrar dados'; oldToggle.title='Mostrar dados do cliente'; oldToggle.style.display='inline-flex'; oldToggle.onclick=()=>{clientPanelOpen=true;localStorage.setItem('central_client_panel','1');render();}; } }
  document.querySelectorAll('[data-attachment]').forEach(button=>button.onclick=async event=>{event.stopPropagation();try{const response=await fetch('/api/attachments/'+button.dataset.attachment,{headers:{authorization:'Bearer '+token}});if(!response.ok)throw Error('Anexo indisponível.');const blob=await response.blob(),url=URL.createObjectURL(blob);window.open(url,'_blank','noopener');setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(error){alert(error.message);}});
  document.querySelectorAll('.message[data-message-id]').forEach(element => element.onclick = event => { if (event.target.closest('[data-attachment]')) return; const message = state.detail?.messages?.find(item => item.id === element.dataset.messageId); if (message?.direction !== 'internal') { replyTo = {id:message.id,body:message.body||message.attachment_name||'Anexo'}; render(); } });
  if (document.querySelector('#cancelReply')) document.querySelector('#cancelReply').onclick = () => { replyTo = null; render(); };
  document.querySelector('#renameContact').onclick = async () => { const name=prompt('Nome do contato',conversation.contact_name); if(!name)return; const phone=prompt('DDD + número do WhatsApp',String(conversation.contact_phone||'').replace(/^55/,''));if(!phone)return;try{await api('/api/conversations/'+conversation.id+'/contact',{method:'PATCH',body:JSON.stringify({name,phone})});await boot();await openConversation(conversation.id);}catch(error){alert(error.message);} };
  const historyButton=document.querySelector('#history');
  if(historyButton) historyButton.onclick=()=>showConversationHistory(conversation);
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
      const rawBody=String(new FormData(event.target).get('body')||''); const agentLabel=String(state.profile.display_name||state.profile.name||'Atendente').trim(); const payload={body:rawBody,reply_to_id:replyTo?.id||null,attachment,agent_label:agentLabel};
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
    if (action === 'close') { inboxMode = 'closed'; protocolQuery = ''; activeId = null; state.detail = null; }
    if (action === 'assume') { inboxMode = 'mine'; protocolQuery = ''; }
    await boot();
    if (action !== 'close') await openConversation(id);
  } catch (error) { alert(error.message); }
}

async function settings() {
  currentView = 'settings';
  leaveWhatsApp();
  const data = await api('/api/settings');
  const manager = supervisor();
  const channelButton = manager ? '<button class="btn" id="whatsapp">WhatsApp Experimental</button>' : '';
  const agents = data.profiles.map(profile => '<li><b>' + esc(profile.name) + '</b> · ' + esc(profile.role) + ' · ' + esc(profile.status) + '</li>').join('');
  const queues = data.departments.map(department => '<li>' + esc(department.name) + ' <small class="muted">(' + esc(department.id) + ')</small></li>').join('');
  const replies = data.replies.map(reply => '<li><b>' + esc(reply.shortcut) + '</b> · ' + esc(reply.body) + '</li>').join('');
  const transportControl=manager?'<form class="card" id="transportForm"><h3>Canal WhatsApp ativo</h3><p class="muted">Escolha por qual integração o chat e o robô desta empresa enviam mensagens.</p><label class="field">Integração<select name="transport"><option value="baileys" '+(data.whatsappTransport==='baileys'?'selected':'')+'>Baileys</option><option value="meta" '+(data.whatsappTransport==='meta'?'selected':'')+'>API oficial da Meta</option></select></label><p class="muted">Cloud API: '+(data.metaApiConfigured?'configurada no servidor':'faltam variáveis no servidor')+'. A Meta exige janela de atendimento aberta para texto livre; anexos ainda não estão habilitados aqui. As credenciais nunca são enviadas ao navegador.</p><button class="btn">Salvar canal ativo</button></form>':'';
  const managerForms = manager ? '<div class="settingsGrid"><form class="card" id="agentForm"><h3>Novo atendente</h3><label class="field">Nome do atendente (aparece nas mensagens)<input name="name" required minlength="2" maxlength="80"></label><label class="field">E-mail<input name="email" type="email" required></label><label class="field">Senha inicial<input name="password" type="password" required></label><label class="field">Perfil<select name="role"><option value="agent">Atendente</option><option value="supervisor">Supervisor</option></select></label><button class="btn">Cadastrar atendente</button></form><form class="card" id="queueForm"><h3>Nova fila</h3><label class="field">Nome da fila<input name="name" placeholder="Instalação, reparo, dúvida ou financeiro"></label><button class="btn">Criar fila</button></form><form class="card" id="autoForm"><h3>Robô de atendimento</h3><label class="field">Mensagem inicial<textarea name="welcome_message">' + esc(data.settings?.welcome_message) + '</textarea></label><label class="field">Encaminhamento para fila<textarea name="fallback_message">' + esc(data.settings?.fallback_message) + '</textarea></label><label class="field">Tentativas antes de encaminhar<input name="max_attempts" type="number" min="1" max="5" value="' + esc(data.settings?.max_attempts || 2) + '"></label><button class="btn">Salvar robô</button></form><form class="card" id="quickForm"><h3>Mensagem rápida</h3><label class="field">Atalho<input name="shortcut" placeholder="/reparo"></label><label class="field">Mensagem<textarea name="body"></textarea></label><label class="field">Fila<select name="department_id"><option value="">Todas</option>' + data.departments.map(item => '<option value="' + esc(item.id) + '">' + esc(item.name) + '</option>').join('') + '</select></label><button class="btn">Adicionar resposta</button></form></div>' : '<p class="card">Seu perfil permite usar as filas e respostas. Um supervisor pode alterar cadastro de equipe, robô e automações.</p>';
  const profileForm='<form class="card profileForm" id="profileForm"><h3>Meu nome no atendimento</h3><p class="muted">Esse nome obrigatório aparece em negrito acima de todas as mensagens enviadas por você.</p><label class="field">Nome do atendente nas mensagens<input name="display_name" required minlength="2" maxlength="80" autocomplete="name" value="'+esc(state.profile.display_name||state.profile.name)+'"></label><label class="field">Telefone interno<input name="phone" value="'+esc(state.profile.phone||'')+'"></label><button class="btn">Salvar perfil</button></form>';
  app.innerHTML = shell('<section class="settings"><div class="settingsHead"><div><h2>Configurações de atendimento</h2><p class="muted">Filas, equipe, mensagens rápidas e regras do robô são separadas por empresa.</p></div><div><button class="btn subtle" id="back">Voltar à caixa</button>' + channelButton + '</div></div><div class="settingsGrid">'+profileForm+transportControl+'</div>' + managerForms + '<div class="settingsGrid"><article class="card"><h3>Atendentes</h3><ul>' + agents + '</ul></article><article class="card"><h3>Filas configuradas</h3><ul>' + queues + '</ul></article><article class="card"><h3>Mensagens rápidas</h3><ul>' + replies + '</ul></article></div></section>', 'Configurações');
  bindShell();
  document.querySelector('#back').onclick = render;
  if (document.querySelector('#whatsapp')) document.querySelector('#whatsapp').onclick = whatsapp;
  document.querySelector('#profileForm').onsubmit=event=>submit(event,'/api/profile',async()=>{await boot();settings();},'PATCH');
  if (manager) {
    document.querySelector('#transportForm').onsubmit=event=>submit(event,'/api/whatsapp/transport',settings,'PATCH');
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
  currentView = 'whatsapp';
  const view = ++whatsappView;
  clearTimeout(whatsappTimer);
  const refresh = () => { if (view === whatsappView) whatsapp(); };
  const getStatus = () => api('/api/whatsapp/status');
  const draw = status => {
    if (view !== whatsappView) return;
    const connected = status.status === 'CONNECTED';
    const pair = status.pairing || {};
    const code = pair.code && !pair.expired ? pair.code : null;
    const label = connected ? 'WhatsApp conectado com sucesso!' : status.qr ? 'QR Code pronto para leitura' : status.status === 'QR_PENDING' ? 'Gerando QR Code' : code ? 'Código gerado, aguardando vinculação' : pair.expired ? 'Código expirado' : status.status === 'PAIRING_REQUESTED' ? 'Aguardando geração do código' : status.status === 'PAIRING_ERROR' || status.status === 'ERROR' ? 'Falha na conexão' : status.status === 'CONNECTING' || status.status === 'RECONNECTING' ? 'Conectando' : 'WhatsApp desconectado';
    const qr = status.qr ? '<img class="qr" src="' + status.qr + '" alt="QR Code do WhatsApp">' : '<div class="qrPlaceholder">Nenhum QR Code ativo</div>';
    const pairingView = '<form id="pairForm" class="pairForm"><label class="field">Número do WhatsApp com DDI e DDD<input name="number" type="tel" inputmode="tel" autocomplete="tel" placeholder="+55 (11) 9XXXX-XXXX" required></label><button class="btn" ' + (connected ? 'disabled' : '') + '>Gerar código de pareamento</button></form>' + (code ? '<div class="pairCode" aria-live="polite">' + esc(code.slice(0,4) + '-' + code.slice(4)) + '</div><button class="btn subtle" id="copyPair">Copiar código</button><p class="muted">O código expira em aproximadamente cinco minutos.</p>' : '') + '<ol class="pairInstructions"><li>Abra o WhatsApp no celular principal.</li><li>Entre em Configurações → Dispositivos conectados.</li><li>Selecione Conectar dispositivo.</li><li>Escolha Conectar com número de telefone.</li><li>Digite o código apresentado na central.</li><li>Aguarde a confirmação da conexão.</li></ol><p class="muted">Os nomes das opções podem variar conforme o aparelho e a versão do WhatsApp.</p>';
    const indicator = (name, value) => '<span class="statusPill"><i class="statusDot ' + (value ? 'ok' : 'bad') + '"></i>' + name + ': ' + (value ? 'Online' : 'Offline') + '</span>';
    const monitors = '<div class="statusMonitor"><b>Monitoramento</b><div>' + indicator('Backend', status.backendOnline !== false) + indicator('Conector', Boolean(status.connectorOnline)) + indicator('WhatsApp', Boolean(status.whatsappConnected || status.status === 'CONNECTED')) + indicator('QR ativo', Boolean(status.qrAvailable || status.qr)) + '</div></div>';
    app.innerHTML = shell('<section class="settings"><div class="settingsHead"><div><h2>WhatsApp Experimental</h2><p class="muted">Conector Baileys no Render para testes controlados.</p></div><button class="btn subtle" id="back">Voltar</button></div><div class="card whatsappCard">' + monitors + '<p aria-live="polite"><b>' + esc(label) + '</b></p><p><b>Número conectado:</b> ' + esc(status.phone || 'aguardando') + '</p><p><b>Robô:</b> '+(status.autoReplyEnabled?'Ativo':'Pausado')+'</p>' + (status.lastError ? '<p class="muted">' + esc(status.lastError) + '</p>' : '') + '<div class="pairTabs"><button class="btn ' + (whatsappMode === 'qr' ? '' : 'subtle') + '" id="showQr">QR Code</button><button class="btn ' + (whatsappMode === 'pair' ? '' : 'subtle') + '" id="showPair">Código de pareamento</button></div>' + (whatsappMode === 'qr' ? qr + '<button class="btn" id="connect">Conectar por QR Code</button>' : pairingView) + '<div class="pairTabs"><button class="btn" id="toggleRobot">'+(status.autoReplyEnabled?'Pausar robô':'Ativar robô')+'</button><button class="btn subtle" id="disconnect">Desconectar</button><button class="btn subtle" id="deleteSession">Encerrar e apagar sessão</button></div><hr><h3>Números autorizados</h3><form id="allow"><input name="number" type="tel" placeholder="+55 (11) 9XXXX-XXXX"><button class="btn">Autorizar número</button></form><p><b>Autorizados:</b> ' + esc(status.allowedCount) + '</p><button class="btn emergency" id="stop">Desativar todas as respostas automáticas</button></div></section>', 'WhatsApp Experimental');
    bindShell();
    document.querySelector('#back').onclick = settings;
    document.querySelector('#showQr').onclick = () => { whatsappMode = 'qr'; refresh(); };
    document.querySelector('#showPair').onclick = () => { whatsappMode = 'pair'; refresh(); };
    if (whatsappMode === 'qr') document.querySelector('#connect').onclick = async () => { document.querySelector('#connect').disabled = true; try { await api('/api/whatsapp/connect', { method: 'POST' }); refresh(); } catch (error) { alert(error.message); refresh(); } };
    if (whatsappMode === 'pair') {
      document.querySelector('#pairForm').onsubmit = async event => { event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; try { await api('/api/whatsapp/pairing-code', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); refresh(); } catch (error) { alert(error.message); button.disabled = false; refresh(); } };
      if (code) document.querySelector('#copyPair').onclick = () => navigator.clipboard.writeText(code).then(() => alert('Código copiado.')).catch(() => alert('Não foi possível copiar. Selecione o código na tela.'));
    }
    document.querySelector('#disconnect').onclick = async () => { if (confirm('Desconectar este WhatsApp?')) { await api('/api/whatsapp/disconnect', { method: 'POST' }); refresh(); } };
    document.querySelector('#toggleRobot').onclick=async()=>{await api('/api/whatsapp/auto-reply',{method:'POST',body:JSON.stringify({enabled:!status.autoReplyEnabled})});refresh();};
    document.querySelector('#deleteSession').onclick = async () => { if (confirm('Encerrar a conexão e apagar a sessão salva para permitir um novo pareamento?')) { try { await api('/api/whatsapp/logout-and-delete-session', { method: 'POST' }); const pending = await api('/api/whatsapp/connect', { method: 'POST' }); draw(pending); } catch (error) { alert(error.message); refresh(); } } };
    document.querySelector('#stop').onclick = async () => { await api('/api/whatsapp/emergency-stop', { method: 'POST' }); refresh(); };
    const numberInput = document.querySelector('#allow [name=number]');
    numberInput.oninput = () => { numberInput.value = formatPhone(numberInput.value); };
    document.querySelector('#allow').onsubmit = async event => { event.preventDefault(); await api('/api/whatsapp/authorize', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); refresh(); };
    if (['QR_PENDING','CONNECTING','RECONNECTING','PAIRING_REQUESTED','PAIRING_CODE'].includes(status.status)) whatsappTimer = setTimeout(() => { if (view === whatsappView && !document.activeElement?.matches('input')) refresh(); }, 1500);
  };
  try { draw(await getStatus()); } catch (error) { if (view !== whatsappView) return; app.innerHTML = shell('<section class="settings"><h2>WhatsApp Experimental</h2><p class="card">Não foi possível consultar o conector no servidor. ' + esc(error.message) + '</p><button class="btn subtle" id="back">Voltar</button></section>', 'WhatsApp Experimental'); bindShell(); document.querySelector('#back').onclick = settings; }
}

const recoveryParams=new URLSearchParams(location.hash.slice(1));
if(recoveryParams.get('type')==='recovery'&&recoveryParams.get('access_token')){token=recoveryParams.get('access_token');passwordReset();}
else token ? boot() : login();
