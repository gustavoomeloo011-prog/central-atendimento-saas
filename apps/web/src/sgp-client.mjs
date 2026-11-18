// Read-only adapter based on the working SG Fibra Técnico SGPClient.
// Never return raw SGP payloads: they contain PPPoE, Wi-Fi and ONU passwords.
export function nationalPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const phone = /^55\d{10,11}$/.test(digits) ? digits.slice(2) : digits;
  return /^\d{10,11}$/.test(phone) ? phone : null;
}
const numeric = value => value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const signal = value => { const n = numeric(value); return n !== null && n > -50 && n < 5 ? n : null; };
export function customerSummary(customer) {
  const titles = Array.isArray(customer.titulos) ? customer.titulos : null;
  const isOverdue = value => { const m=String(value||'').match(/(\d{2})[\/-](\d{2})[\/-](\d{4})/); return m ? new Date(Number(m[3]),Number(m[2])-1,Number(m[1])) < new Date() : false; };
  const open = titles?.filter(t => t.status === 'aberto');
  return {
    id: customer.id, name: customer.nome || null, document: customer.cpfcnpj || null,
    invoices: open ? { count: open.length, overdue: open.filter(t => Number(t.diasAtraso) > 0).length,
      items: open.map(t => ({ id: t.id, contractId: t.clientecontrato_id, dueDate: t.dataVencimento,
        overdue: Number(t.diasAtraso)>0 || isOverdue(t.dataVencimento), amount: numeric(t.valorCorrigido ?? t.valor) })) } : null,
    contracts: (customer.contratos || []).map(c => ({ id: c.id, status: c.status,
      services: (c.servicos || []).map(s => ({ id: s.id, onuId: s.onu?.id || s.onu_id || null, type: s.tipo, plan: s.plano?.descricao || null,
        online: null, rxDbm: signal(s.onu?.rx), txDbm: signal(s.onu?.tx),
        // The API does not provide a measurement timestamp. Do not call it live telemetry.
        signalMeasuredAt: null, source: 'SGP — último sinal armazenado' })) }))
  };
}
export function createSgpClient({ env = process.env, fetcher = fetch, clock = Date.now, configProvider = async () => ({}) } = {}) {
  const cache = new Map(), pending = new Map();
  let active = 0;
  async function request(path, values, json = false, cfg = env) {
    const base = new URL(cfg.SGP_BASE_URL);
    if (base.protocol !== 'https:' || base.username || base.password) throw Error('Configuração SGP inválida.');
    const headers = { Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(cfg.SGP_USERNAME + ':' + cfg.SGP_PASSWORD).toString('base64') };
    if (json) headers['Content-Type'] = 'application/json';
    const response = await fetcher(new URL(path, base), { method: 'POST', headers,
      body: json ? JSON.stringify(values) : new URLSearchParams(values), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Consulta SGP recusada (HTTP ' + response.status + ').');
    try { return await response.json(); } catch { throw Error('O SGP retornou uma resposta inválida.'); }
  }
  async function load(phone, cfg) {
    const payload = await request('/api/ura/clientes/', { telefone: phone, limit: '20', exibir_conexao: 'true' }, false, cfg);
    if (!Array.isArray(payload.clientes)) throw Error('O SGP não retornou a lista de clientes esperada.');
    // Verify the phone ourselves, even if the upstream ignores its filter.
    const matches = payload.clientes.filter(c => [...(c.contatos?.telefones || []), ...(c.contatos?.celulares || [])].some(p => nationalPhone(p) === phone));
    if (Number(payload.paginacao?.total || 0) > 20) return { status: 'ambiguous', message: 'Consulta com muitos resultados. Confira o cadastro no SGP.' };
    if (!matches.length && payload.clientes.length) return { status: 'unavailable', message: 'O SGP não confirmou o telefone nos cadastros retornados.' };
    if (!matches.length) return { status: 'not_found' };
    if (matches.length !== 1) return { status: 'ambiguous', message: 'Telefone associado a mais de um cliente. Confira o cadastro no SGP.' };
    const customer = matches[0], result = customerSummary(customer);
    for (const [ci, contract] of (customer.contratos || []).entries()) {
      for (const [si, service] of (contract.servicos || []).entries()) {
        if (service.tipo !== 'internet' || !service.login) continue;
        const summary = result.contracts[ci].services[si];
        try {
          const radius = await request('/ws/radius/radacct/list/all/', { username: service.login, last_session: true, limit: 1 }, true, cfg);
          const row = radius.result?.find(r => r.pppoe_login === service.login);
          summary.online = typeof row?.online === 'boolean' ? row.online : null;
        } catch { summary.connectionError = 'Estado de conexão indisponível.'; }
      }
    }
    return { status: 'found', customer: result, checkedAt: new Date(clock()).toISOString() };
  }
  async function invoiceDocument(invoiceId, cfg) {
    const id=String(invoiceId||'').trim();
    if(!/^\d+$/.test(id))throw Error('Identificador de fatura inválido.');
    const base=new URL(cfg.SGP_BASE_URL),url=new URL('/admin/financeiro/titulo/print/documento/?q='+encodeURIComponent(id),base);
    let response=await fetcher(url,{headers:{Accept:'text/html,application/xhtml+xml',Authorization:'Basic '+Buffer.from(cfg.SGP_USERNAME+':'+cfg.SGP_PASSWORD).toString('base64')},redirect:'follow',signal:AbortSignal.timeout(15000)});
    if(response.ok&&/\/accounts\/login/i.test(response.url)){
      const loginUrl=new URL('/accounts/login/',base),jar=new Map();
      const capture=r=>{for(const value of r.headers.getSetCookie()){const pair=value.split(';')[0],at=pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1));}};
      const cookies=()=>[...jar].map(([key,value])=>key+'='+value).join('; ');
      const login=await fetcher(loginUrl,{redirect:'manual',signal:AbortSignal.timeout(15000)});capture(login);
      const html=await login.text(),csrf=html.match(/name=['"]csrfmiddlewaretoken['"][^>]*value=['"]([^'"]+)/)?.[1]||jar.get('csrftoken');
      if(!csrf)throw Error('Não foi possível iniciar a sessão SGP.');
      const authenticated=await fetcher(loginUrl,{method:'POST',headers:{Cookie:cookies(),Referer:loginUrl.toString(),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cfg.SGP_USERNAME,password:cfg.SGP_PASSWORD,csrfmiddlewaretoken:csrf,next:'/admin/'}),redirect:'manual',signal:AbortSignal.timeout(15000)});capture(authenticated);
      if(![302,303].includes(authenticated.status))throw Error('O SGP recusou o login para consultar o boleto.');
      response=await fetcher(url,{headers:{Cookie:cookies(),Accept:'text/html'},redirect:'manual',signal:AbortSignal.timeout(15000)});
    }
    if(!response.ok||/\/accounts\/login/i.test(response.url))throw Error('O SGP não autorizou a abertura do boleto.');
    const html=await response.text(),plain=html.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' '),candidates=(plain.match(/[\d.\s-]{44,90}/g)||[]).map(value=>({raw:value.trim().replace(/\s+/g,' '),digits:value.replace(/\D/g,'')}));
    const line=candidates.find(item=>item.digits.length===47||item.digits.length===48);
    return {invoiceId:id,barcode:line?.raw||null,link:url.toString()};
  }
  // SGP's admin actions are server-rendered Django forms. Keep this helper private,
  // preserve CSRF/cookies, and never return their HTML or credentials to the caller.
  async function panelSession(cfg) {
    const base=new URL(cfg.SGP_BASE_URL), jar=new Map();
    const capture=response=>{for(const value of response.headers.getSetCookie?.()||[]){const pair=value.split(';')[0],at=pair.indexOf('=');if(at>0)jar.set(pair.slice(0,at),pair.slice(at+1));}};
    const cookies=()=>[...jar].map(([key,value])=>`${key}=${value}`).join('; ');
    const loginUrl=new URL('/accounts/login/',base);
    const login=await fetcher(loginUrl,{redirect:'manual',signal:AbortSignal.timeout(15000)});capture(login);
    const html=await login.text(),csrf=html.match(/name=['"]csrfmiddlewaretoken['"][^>]*value=['"]([^'"]+)/)?.[1]||html.match(/name='csrfmiddlewaretoken' value='([^']+)/)?.[1]||jar.get('csrftoken');
    if(!csrf)throw Error('Não foi possível iniciar a sessão administrativa do SGP.');
    const authenticated=await fetcher(loginUrl,{method:'POST',headers:{Cookie:cookies(),Referer:loginUrl.toString(),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cfg.SGP_USERNAME,password:cfg.SGP_PASSWORD,csrfmiddlewaretoken:csrf,next:'/admin/'}),redirect:'manual',signal:AbortSignal.timeout(15000)});capture(authenticated);
    if(![302,303].includes(authenticated.status))throw Error('O SGP recusou a autenticação administrativa.');
    return {base,cookies};
  }
  async function openOccurrence(payload,cfg) {
    const customerId=String(payload.customerId||''),contractId=String(payload.contractId||''),serviceId=String(payload.serviceId||'');
    if(!/^\d+$/.test(customerId)||!/^\d+$/.test(contractId)||!/^\d+$/.test(serviceId))throw Error('Dados de contrato insuficientes para abrir a solicitação no SGP.');
    const session=await panelSession(cfg),formUrl=new URL(`/admin/atendimento/cliente/${customerId}/ocorrencia/add/`,session.base);
    const form=await fetcher(formUrl,{headers:{Cookie:session.cookies(),Accept:'text/html'},redirect:'manual',signal:AbortSignal.timeout(15000)});
    const html=await form.text();
    if(!form.ok||/id_username|accounts\/login/i.test(html))throw Error('O SGP não autorizou a abertura da solicitação.');
    const csrf=html.match(/name=['"]csrfmiddlewaretoken['"][^>]*value=['"]([^'"]+)/)?.[1]||html.match(/name='csrfmiddlewaretoken' value='([^']+)/)?.[1];
    if(!csrf)throw Error('O formulário de ocorrência do SGP não retornou a proteção necessária.');
    const date=new Date(clock()).toLocaleString('sv-SE',{timeZone:'America/Sao_Paulo'}).replace('T',' ').slice(0,16);
    const values={csrfmiddlewaretoken:csrf,clientecontrato:contractId,servico:serviceId,setor:'1',tipo:'3',metodo:'5',status:'0',conteudo:`Aberto pelo FlowChat/WhatsApp. ${String(payload.description||'Cliente relata lentidão após reinício da ONU.').slice(0,1800)}`,observacoes:'Solicitação registrada automaticamente pelo atendimento via WhatsApp.',data_agendamento:date,os:'on'};
    const saved=await fetcher(formUrl,{method:'POST',headers:{Cookie:session.cookies(),Referer:formUrl.toString(),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(values),redirect:'manual',signal:AbortSignal.timeout(20000)});
    if(![302,303].includes(saved.status))throw Error('O SGP não confirmou a abertura da solicitação.');
    return {opened:true};
  }
  async function createPaymentPromise(payload,cfg) {
    const customerId=String(payload.customerId||''),contractId=String(payload.contractId||'');
    if(!/^\d+$/.test(customerId)||!/^\d+$/.test(contractId))throw Error('Contrato insuficiente para registrar a promessa no SGP.');
    const session=await panelSession(cfg),formUrl=new URL(`/admin/financeiro/promessapagamento/cliente/${customerId}/add/`,session.base);
    const form=await fetcher(formUrl,{headers:{Cookie:session.cookies(),Accept:'text/html'},redirect:'manual',signal:AbortSignal.timeout(15000)}),html=await form.text();
    if(!form.ok||/id_username|accounts\/login/i.test(html))throw Error('O SGP não autorizou a promessa de pagamento.');
    const csrf=html.match(/name=['"]csrfmiddlewaretoken['"][^>]*value=['"]([^'"]+)/)?.[1]||html.match(/name='csrfmiddlewaretoken' value='([^']+)/)?.[1];
    if(!csrf)throw Error('O formulário de promessa do SGP não retornou a proteção necessária.');
    const tomorrow=new Date(clock()+24*60*60*1000),date=[String(tomorrow.getDate()).padStart(2,'0'),String(tomorrow.getMonth()+1).padStart(2,'0'),tomorrow.getFullYear()].join('/');
    const values={csrfmiddlewaretoken:csrf,cobranca:contractId,data_pagamento:date,observacao:'Promessa de pagamento solicitada pelo FlowChat/WhatsApp.',liberarservico:'on'};
    const saved=await fetcher(formUrl,{method:'POST',headers:{Cookie:session.cookies(),Referer:formUrl.toString(),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(values),redirect:'manual',signal:AbortSignal.timeout(20000)});
    if(![302,303].includes(saved.status))throw Error('O SGP não confirmou a promessa de pagamento.');
    return {created:true,paymentDate:date};
  }
  async function resetOnu(onuId,cfg) {
    if(!/^\d+$/.test(String(onuId||'')))throw Error('ONU não identificada no contrato do cliente.');
    const session=await panelSession(cfg),url=new URL(`/admin/network/onu/${onuId}/reset/`,session.base);
    const response=await fetcher(url,{headers:{Cookie:session.cookies(),Referer:new URL(`/admin/network/onu/${onuId}/detail/`,session.base).toString(),Accept:'application/json,text/html'},redirect:'manual',signal:AbortSignal.timeout(20000)});
    const result=await response.text();
    if(!response.ok||/id_username|accounts\/login/i.test(result))throw Error('O SGP não confirmou o reinício da ONU.');
    return {reset:true};
  }
  return { async invoice(companyId, invoiceId) { const cfg={...env,...await configProvider(companyId)}; if (!cfg.SGP_BASE_URL || !cfg.SGP_USERNAME || !cfg.SGP_PASSWORD) throw Error('Consulta SGP não configurada para esta empresa.'); return invoiceDocument(invoiceId,cfg); }, async openSlowConnectionTicket(companyId,payload) { const cfg={...env,...await configProvider(companyId)}; if (!cfg.SGP_BASE_URL || !cfg.SGP_USERNAME || !cfg.SGP_PASSWORD) throw Error('Integração SGP não configurada para abrir solicitação.'); return openOccurrence(payload,cfg); }, async createPaymentPromise(companyId,payload) { const cfg={...env,...await configProvider(companyId)}; if (!cfg.SGP_BASE_URL || !cfg.SGP_USERNAME || !cfg.SGP_PASSWORD) throw Error('Integração SGP não configurada para registrar promessa.'); return createPaymentPromise(payload,cfg); }, async resetOnu(companyId,onuId) { const cfg={...env,...await configProvider(companyId)}; if (!cfg.SGP_BASE_URL || !cfg.SGP_USERNAME || !cfg.SGP_PASSWORD) throw Error('Integração SGP não configurada para reiniciar ONU.'); return resetOnu(onuId,cfg); }, async lookup(companyId, value) {
    // A global integration belongs exclusively to its explicitly configured tenant.
    const custom=await configProvider(companyId),cfg={...env,...custom};
    if (env.SGP_COMPANY_ID && !custom.SGP_BASE_URL && companyId !== env.SGP_COMPANY_ID) return { status: 'not_configured' };
    if (!cfg.SGP_BASE_URL || !cfg.SGP_USERNAME || !cfg.SGP_PASSWORD) return { status: 'not_configured' };
    const phone = nationalPhone(value);
    if (!phone) return { status: 'invalid_phone' };
    const key = companyId + ':' + phone, cached = cache.get(key);
    if (cached && cached.until > clock()) return cached.value;
    if (pending.has(key)) return pending.get(key);
    if (active >= 4) return { status: 'unavailable', message: 'Consultas SGP ocupadas. Tente novamente em instantes.' };
    active++;
    const job = load(phone,cfg).catch(error => ({ status: 'unavailable', message: /^Consulta SGP recusada/.test(error.message) ? error.message : 'Não foi possível consultar o SGP agora.' })).then(value => {
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      cache.set(key, { value, until: clock() + (value.status === 'unavailable' ? 10000 : 60000) });
      return value;
    }).finally(() => { pending.delete(key); active--; });
    pending.set(key, job);
    return job;
  } };
}
