const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const field = (label, value) => '<dt>' + label + '</dt><dd>' + esc(value ?? 'Não informado') + '</dd>';
export function renderSgp(data) {
  const heading = '<span class="tag">SGP</span><h3>Dados do cliente</h3>';
  if (!data) return heading + '<p>Consultando SGP…</p>';
  if (data.status !== 'found') {
    const labels = { not_configured: 'Consulta SGP não configurada para esta empresa.', invalid_phone: 'Telefone não identificado. Confirme o número do contato.',
      not_found: 'Nenhum cadastro encontrado para este telefone. Possível nova contratação.', ambiguous: 'Mais de um cadastro encontrado.', unavailable: 'Consulta SGP indisponível.' };
    return heading + '<p class="muted">' + esc(data.message || labels[data.status] || 'Consulta indisponível.') + '</p>' + (data.status === 'not_found' ? '<a class="btn" href="https://cadastro.sgfibra.com.br" target="_blank" rel="noopener">Abrir cadastro SG Fibra</a>' : '');
  }
  const c = data.customer;
  const money = value => value == null ? 'Não informado' : Number(value).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  return heading + '<dl class="clientData">' + field('Nome',c.name) + field('CPF/CNPJ',c.document) + field('ID cliente',c.id) + '</dl>' +
    c.contracts.map(contract => '<section class="sgpContract"><h4>Contrato ' + esc(contract.id) + '</h4>' + contract.services.map(s =>
      '<dl class="clientData">' + field('Serviço',s.type) + field('Plano',s.plan) + (s.type === 'internet' ?
        field('Conexão',s.online === true ? 'Online' : s.online === false ? 'Offline' : 'Indisponível') +
        field('Sinal RX',s.rxDbm == null ? null : s.rxDbm + ' dBm') + field('Sinal TX',s.txDbm == null ? null : s.txDbm + ' dBm') : '') + '</dl>' +
      (s.rxDbm != null ? '<small>Último sinal armazenado no SGP; horário da medição não informado.</small>' : '')).join('') + '</section>').join('') +
    '<h4>Faturas em aberto</h4>' + (c.invoices ? '<p>' + esc(c.invoices.count) + ' aberta(s) · ' + esc(c.invoices.overdue) + ' vencida(s)</p>' + c.invoices.items.map(t =>
      '<p>Contrato ' + esc(t.contractId) + ' · ' + esc(t.dueDate) + ' · ' + esc(money(t.amount)) + '</p>').join('') : '<p>Informação indisponível.</p>') +
    '<small>Consulta: ' + esc(new Date(data.checkedAt).toLocaleString('pt-BR')) + '. Cache de até 60 segundos.</small>';
}
