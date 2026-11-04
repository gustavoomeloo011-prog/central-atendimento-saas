const app = document.querySelector('#app');
let token = localStorage.getItem('central_token');
let state = {};
let activeId = null;

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
const supervisor = () => ['supervisor', 'company_admin', 'superadmin'].includes(state.profile?.role);

function login() {
  app.innerHTML = '<section class="login"><div class="brand"><span class="tag">DEMONSTRAÇÃO MULTIEMPRESA</span><h1>Central de Atendimento</h1><p class="muted">Conversas, equipes, filas e automações em uma central compartilhada.</p><p class="muted">Canal simulado. Nenhum WhatsApp real ou SGP é conectado nesta etapa.</p></div><form class="card" id="login"><h2>Entrar na demonstração</h2><label class="field">E-mail<input name="email" type="email"></label><label class="field">Senha<input name="password" type="password"></label><button class="btn">Entrar</button><p class="muted">Senha: <b>demo</b></p><div class="demo"><button type="button" class="btn subtle" data-email="ana@conecta.demo">Ana · ISP</button><button type="button" class="btn subtle" data-email="bia@casa.demo">Bia · Loja</button></div></form></section>';
  document.querySelectorAll('[data-email]').forEach(button => button.onclick = () => document.querySelector('[name=email]').value = button.dataset.email);
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
    state = await api('/api/bootstrap');
    activeId = state.conversations[0]?.id || null;
    state.detail = null;
    render();
    if (activeId) await openConversation(activeId);
  } catch {
    localStorage.removeItem('central_token');
    token = null;
    login();
  }
}

async function openConversation(id) {
  activeId = id;
  state.detail = await api('/api/conversations/' + id);
  render();
}

function shell(content, title = 'Caixa de entrada') {
  return '<div class="shell"><aside class="side"><span class="tag">SIMULADOR</span><h2>Central</h2><p class="muted">' + esc(state.company.name) + '</p><div class="nav"><button class="navButton" id="inbox">◉ Caixa de entrada</button><button class="navButton" id="queues">◌ Filas</button><button class="navButton" id="team">◌ Equipe</button><button class="navButton" id="automations">◌ Automações</button><button class="navButton" id="indicators">◌ Indicadores</button><button class="navButton" id="settings">◌ Configurações</button><button class="btn subtle" id="logout">Sair</button></div></aside><header class="top"><div><b>' + title + '</b> <span class="muted">· ' + esc(state.company.name) + '</span></div><div>' + esc(state.profile.name) + ' <span class="tag">' + esc(state.profile.role) + '</span></div></header>' + content + '</div>';
}

function render() {
  const list = state.conversations || [];
  const conversation = list.find(item => item.id === activeId);
  const messages = state.detail?.conversation?.id === activeId ? state.detail.messages : [];
  const inbox = '<section class="list"><div class="toolbar"><span class="tag">FILA ' + list.filter(item => item.status === 'waiting').length + '</span><button class="btn subtle" id="refresh">Atualizar</button></div>' + list.map(item => '<article class="conversation ' + (item.id === activeId ? 'active' : '') + '" data-id="' + item.id + '"><b>' + esc(item.contact_name) + '</b> <span class="tag ' + item.status + '">' + esc(item.status) + '</span><div class="muted">' + esc(item.last_message || item.subject) + '</div><small>' + esc(item.department_name) + ' · ' + esc(item.contact_phone) + '</small></article>').join('') + '</section>';
  const shortcuts = (state.quickReplies || []).map(reply => '<button class="quick" data-quick="' + esc(reply.shortcut) + '">' + esc(reply.shortcut) + '</button>').join('');
  const chat = conversation ? '<section class="chat"><div class="chatHead"><div><h2>' + esc(conversation.contact_name) + '</h2><span class="muted">' + esc(conversation.contact_phone) + ' · ' + esc(conversation.subject) + '</span></div><div><button class="btn subtle" id="simulate">Simular cliente</button><button class="btn subtle" id="assume">Assumir</button><button class="btn subtle" id="transfer">Transferir</button><button class="btn subtle" id="close">Encerrar</button></div></div><div class="quickRow"><span class="muted">Mensagens rápidas</span>' + shortcuts + '</div><div class="messages">' + messages.map(message => '<div class="message ' + (message.direction === 'outbound' ? 'outbound' : '') + '">' + esc(message.body) + '<small>' + esc(message.author_name || 'Cliente') + '</small></div>').join('') + '</div><form class="composer" id="send"><textarea name="body" placeholder="Escreva uma mensagem simulada"></textarea><button class="btn">Enviar</button></form></section>' : '<section class="chat empty">Selecione uma conversa.</section>';
  app.innerHTML = shell(inbox + chat);
  bindShell();
  document.querySelector('#refresh').onclick = boot;
  document.querySelectorAll('.conversation').forEach(element => element.onclick = () => openConversation(element.dataset.id));
  document.querySelectorAll('[data-quick]').forEach(button => button.onclick = () => useQuick(button.dataset.quick));
  if (conversation) bindConversation(conversation);
}

function bindShell() {
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
    const quick = data.replies.map(reply => '<li><b>' + esc(reply.shortcut) + '</b> · ' + esc(reply.body) + '</li>').join('');
    app.innerHTML = shell('<section class="settings"><div class="settingsHead"><div><h2>Automações</h2><p class="muted">Mensagens configuráveis e encaminhamento controlado para filas.</p></div><button class="btn" id="manageAutomation">Editar automações</button></div><div class="settingsGrid"><article class="card"><h3>Mensagem inicial</h3><p>' + esc(data.settings?.welcome_message) + '</p></article><article class="card"><h3>Encaminhamento</h3><p>' + esc(data.settings?.fallback_message) + '</p></article><article class="card"><h3>Mensagens rápidas</h3><ul>' + quick + '</ul></article></div></section>', 'Automações');
    document.querySelector('#manageAutomation').onclick = settings;
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

function bindConversation(conversation) {
  document.querySelector('#send').onsubmit = async event => {
    event.preventDefault();
    try {
      await api('/api/conversations/' + conversation.id + '/messages', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
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
  const managerForms = manager ? '<div class="settingsGrid"><form class="card" id="agentForm"><h3>Novo atendente</h3><label class="field">Nome<input name="name"></label><label class="field">E-mail<input name="email" type="email"></label><label class="field">Senha inicial<input name="password" type="password"></label><label class="field">Perfil<select name="role"><option value="agent">Atendente</option><option value="supervisor">Supervisor</option></select></label><button class="btn">Cadastrar atendente</button></form><form class="card" id="queueForm"><h3>Nova fila</h3><label class="field">Nome da fila<input name="name" placeholder="Instalação, reparo, dúvida ou financeiro"></label><button class="btn">Criar fila</button></form><form class="card" id="autoForm"><h3>Robô de atendimento</h3><label class="field">Mensagem inicial<textarea name="welcome_message">' + esc(data.settings?.welcome_message) + '</textarea></label><label class="field">Encaminhamento para fila<textarea name="fallback_message">' + esc(data.settings?.fallback_message) + '</textarea></label><label class="field">Tentativas antes de encaminhar<input name="max_attempts" type="number" min="1" max="5" value="' + esc(data.settings?.max_attempts || 2) + '"></label><button class="btn">Salvar robô</button></form><form class="card" id="quickForm"><h3>Mensagem rápida</h3><label class="field">Atalho<input name="shortcut" placeholder="/reparo"></label><label class="field">Mensagem<textarea name="body"></textarea></label><label class="field">Fila<select name="department_id"><option value="">Todas</option>' + data.departments.map(item => '<option value="' + esc(item.id) + '">' + esc(item.name) + '</option>').join('') + '</select></label><button class="btn">Adicionar resposta</button></form></div>' : '<p class="card">Seu perfil permite usar as filas e respostas. Um supervisor pode alterar cadastro de equipe, robô e automações.</p>';
  app.innerHTML = shell('<section class="settings"><div class="settingsHead"><div><h2>Configurações de atendimento</h2><p class="muted">Filas, equipe, mensagens rápidas e regras do robô são separadas por empresa.</p></div><div><button class="btn subtle" id="back">Voltar à caixa</button>' + channelButton + '</div></div>' + managerForms + '<div class="settingsGrid"><article class="card"><h3>Atendentes</h3><ul>' + agents + '</ul></article><article class="card"><h3>Filas configuradas</h3><ul>' + queues + '</ul></article><article class="card"><h3>Mensagens rápidas</h3><ul>' + replies + '</ul></article></div></section>', 'Configurações');
  bindShell();
  document.querySelector('#back').onclick = render;
  if (document.querySelector('#whatsapp')) document.querySelector('#whatsapp').onclick = whatsapp;
  if (manager) {
    document.querySelector('#agentForm').onsubmit = event => submit(event, '/api/agents', settings);
    document.querySelector('#queueForm').onsubmit = event => submit(event, '/api/queues', settings);
    document.querySelector('#autoForm').onsubmit = event => submit(event, '/api/automation', settings);
    document.querySelector('#quickForm').onsubmit = event => submit(event, '/api/quick-replies', settings);
  }
}

async function submit(event, path, after) {
  event.preventDefault();
  try {
    await api(path, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    await after();
  } catch (error) { alert(error.message); }
}

async function whatsapp() {
  const getStatus = async () => fetch('http://localhost:3200/api/whatsapp/status').then(response => response.json());
  const draw = status => {
    const qr = status.qr ? '<img class="qr" src="' + status.qr + '" alt="QR Code do WhatsApp">' : '<div class="qrPlaceholder">Nenhum QR Code ativo</div>';
    app.innerHTML = shell('<section class="settings"><div class="settingsHead"><div><h2>WhatsApp Experimental</h2><p class="muted">Conector local Baileys para testes controlados. Nenhuma mensagem é enviada automaticamente.</p></div><button class="btn subtle" id="back">Voltar</button></div><div class="card whatsappCard"><p><b>Status:</b> ' + esc(status.status) + '</p><p><b>Número conectado:</b> ' + esc(status.phone || 'aguardando') + '</p>' + qr + '<div class="toolbar"><button class="btn" id="connect">Conectar WhatsApp</button><button class="btn subtle" id="disconnect">Desconectar</button><button class="btn subtle" id="deleteSession">Encerrar e apagar sessão</button></div><hr><h3>Números autorizados</h3><p class="muted">Apenas números cadastrados podem acionar o modo experimental.</p><form id="allow"><input name="number" placeholder="5511999999999"><button class="btn">Autorizar número</button></form><p><b>Autorizados:</b> ' + esc(status.allowedCount) + '</p><button class="btn emergency" id="stop">Desativar todas as respostas automáticas</button></div></section>', 'WhatsApp Experimental');
    bindShell();
    document.querySelector('#back').onclick = settings;
    document.querySelector('#connect').onclick = async () => { await fetch('http://localhost:3200/api/whatsapp/connect', { method: 'POST' }); whatsapp(); };
    document.querySelector('#disconnect').onclick = async () => { await fetch('http://localhost:3200/api/whatsapp/disconnect', { method: 'POST' }); whatsapp(); };
    document.querySelector('#deleteSession').onclick = async () => { if (confirm('Apagar a sessão local do WhatsApp?')) { await fetch('http://localhost:3200/api/whatsapp/logout-and-delete-session', { method: 'POST' }); whatsapp(); } };
    document.querySelector('#stop').onclick = async () => { await fetch('http://localhost:3200/api/whatsapp/emergency-stop', { method: 'POST' }); whatsapp(); };
    document.querySelector('#allow').onsubmit = async event => { event.preventDefault(); await fetch('http://localhost:3200/api/whatsapp/authorize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); whatsapp(); };
  };
  try { draw(await getStatus()); } catch { app.innerHTML = shell('<section class="settings"><h2>WhatsApp Experimental</h2><p class="card">O conector local não está iniciado. Execute <code>pnpm connector</code> em outra janela.</p><button class="btn subtle" id="back">Voltar</button></section>', 'WhatsApp Experimental'); bindShell(); document.querySelector('#back').onclick = settings; }
}

token ? boot() : login();
