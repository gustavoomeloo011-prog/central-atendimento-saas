const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const field = (label, value) => '<dt>' + label + '</dt><dd>' + esc(value ?? 'Não informado') + '</dd>';
export function renderSgp(data) {
  const heading = '<div class="sgpHeading"><span class="sgpIcon">S</span><div><h3>Dados do SGP</h3><small>Consulta automática</small></div></div>';
  if (!data) return heading + '<p>Consultando SGP…</p>';
  if (data.status !== 'found') {
    const labels = { not_configured: 'Consulta SGP não configurada para esta empresa.', invalid_phone: 'Telefone não identificado. Confirme o número do contato.',
      not_found: 'Nenhum cadastro encontrado para este telefone. Possível nova contratação.', ambiguous: 'Mais de um cadastro encontrado.', unavailable: 'Consulta SGP indisponível.' };
    return heading + '<p class="muted">' + esc(data.message || labels[data.status] || 'Consulta indisponível.') + '</p>' + (data.status === 'not_found' ? '<a class="btn" href="https://cadastro.sgfibra.com.br" target="_blank" rel="noopener">Abrir cadastro SG Fibra</a>' : '');
  }
  const c = data.customer;
  const money = value => value == null ? 'Não informado' : Number(value).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const dueValue = value => { const raw=String(value||'').trim(),br=raw.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})/),iso=raw.match(/^(\d{4})-(\d{2})-(\d{2})/); return br?new Date(Number(br[3]),Number(br[2])-1,Number(br[1])):iso?new Date(Number(iso[1]),Number(iso[2])-1,Number(iso[3])):null; };
  const today = new Date(); today.setHours(0,0,0,0); const cutoff = new Date(today.getFullYear(),today.getMonth()+2,0,23,59,59,999);
  const financeItems = (c.invoices?.items||[]).filter(item => { const due=dueValue(item.dueDate); return due && (due < today || due <= cutoff); }).sort((a,b)=>dueValue(a.dueDate)-dueValue(b.dueDate));
  const hasOnline=(c.contracts||[]).some(contract=>(contract.services||[]).some(service=>service.online===true));
  const hasOverdue=Number(c.invoices?.overdue||0)>0;
  return heading + '<div class="sgpBadges"><span class="statusChip open">Cliente identificado</span>' + (hasOnline?'<span class="statusChip online">ONU online</span>':'') + (hasOverdue?'<span class="statusChip waiting">Fatura pendente</span>':'') + '</div><section class="sgpSection"><h4>Cadastro</h4><dl class="clientData">' + field('Nome',c.name) + field('CPF/CNPJ',c.document) + field('ID cliente',c.id) + '</dl></section>' +
    c.contracts.map(contract => '<section class="sgpContract sgpSection"><h4>Contrato ' + esc(contract.id) + '</h4>' + contract.services.map(s =>
      '<dl class="clientData">' + field('Serviço',s.type) + field('Plano contratado',s.plan) + (s.type === 'internet' ?
        field('Conexão',s.online === true ? '● Online' : s.online === false ? '● Offline' : 'Indisponível') +
        field('Sinal RX',s.rxDbm == null ? null : s.rxDbm + ' dBm') + field('Sinal TX',s.txDbm == null ? null : s.txDbm + ' dBm') : '') + '</dl>' +
      (s.rxDbm != null ? '<small>Último sinal armazenado no SGP; horário da medição não informado.</small>' : '')).join('') + '</section>').join('') +
    '<section class="sgpSection financeSection"><h4>Financeiro</h4>' + (c.invoices ? '<p class="financeSummary"><b>' + esc(financeItems.length) + '</b> fatura(s) vencida(s) ou próximas de vencer</p><div class="invoiceList">' + financeItems.slice(0,8).map(t =>
      '<p><span>Contrato ' + esc(t.contractId) + '<small>' + esc(t.dueDate) + '</small></span><b>' + esc(money(t.amount)) + '</b><button class="btn invoiceSend" type="button" data-invoice-id="'+esc(t.id)+'" title="Enviar código de barras e link">Enviar fatura</button></p>').join('') + (financeItems.length?'':'<small>Nenhuma fatura vencida ou com vencimento nos próximos 30 dias.</small>') + '</div>' : '<p>Informação indisponível.</p>') + '</section>' +
    '<small class="sgpUpdated">Atualizado em ' + esc(new Date(data.checkedAt).toLocaleString('pt-BR')) + ' · cache de 60s</small>';
}
