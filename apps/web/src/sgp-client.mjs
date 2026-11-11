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
      services: (c.servicos || []).map(s => ({ id: s.id, type: s.tipo, plan: s.plano?.descricao || null,
        online: null, rxDbm: signal(s.onu?.rx), txDbm: signal(s.onu?.tx),
        // The API does not provide a measurement timestamp. Do not call it live telemetry.
        signalMeasuredAt: null, source: 'SGP — último sinal armazenado' })) }))
  };
}
export function createSgpClient({ env = process.env, fetcher = fetch, clock = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  let active = 0;
  async function request(path, values, json = false) {
    const base = new URL(env.SGP_BASE_URL);
    if (base.protocol !== 'https:' || base.username || base.password) throw Error('Configuração SGP inválida.');
    const headers = { Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(env.SGP_USERNAME + ':' + env.SGP_PASSWORD).toString('base64') };
    if (json) headers['Content-Type'] = 'application/json';
    const response = await fetcher(new URL(path, base), { method: 'POST', headers,
      body: json ? JSON.stringify(values) : new URLSearchParams(values), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Consulta SGP recusada (HTTP ' + response.status + ').');
    try { return await response.json(); } catch { throw Error('O SGP retornou uma resposta inválida.'); }
  }
  async function load(phone) {
    const payload = await request('/api/ura/clientes/', { telefone: phone, limit: '20', exibir_conexao: 'true' });
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
          const radius = await request('/ws/radius/radacct/list/all/', { username: service.login, last_session: true, limit: 1 }, true);
          const row = radius.result?.find(r => r.pppoe_login === service.login);
          summary.online = typeof row?.online === 'boolean' ? row.online : null;
        } catch { summary.connectionError = 'Estado de conexão indisponível.'; }
      }
    }
    return { status: 'found', customer: result, checkedAt: new Date(clock()).toISOString() };
  }
  return { async lookup(companyId, value) {
    // A global integration belongs exclusively to its explicitly configured tenant.
    if (!env.SGP_COMPANY_ID || companyId !== env.SGP_COMPANY_ID) return { status: 'not_configured' };
    if (!env.SGP_BASE_URL || !env.SGP_USERNAME || !env.SGP_PASSWORD) return { status: 'not_configured' };
    const phone = nationalPhone(value);
    if (!phone) return { status: 'invalid_phone' };
    const key = companyId + ':' + phone, cached = cache.get(key);
    if (cached && cached.until > clock()) return cached.value;
    if (pending.has(key)) return pending.get(key);
    if (active >= 4) return { status: 'unavailable', message: 'Consultas SGP ocupadas. Tente novamente em instantes.' };
    active++;
    const job = load(phone).catch(error => ({ status: 'unavailable', message: /^Consulta SGP recusada/.test(error.message) ? error.message : 'Não foi possível consultar o SGP agora.' })).then(value => {
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      cache.set(key, { value, until: clock() + (value.status === 'unavailable' ? 10000 : 60000) });
      return value;
    }).finally(() => { pending.delete(key); active--; });
    pending.set(key, job);
    return job;
  } };
}
