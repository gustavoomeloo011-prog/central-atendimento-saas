export function conversationTags(conversation,sgp) {
  const tags=[];
  const count=Math.max(0,Number(conversation.weekly_contacts)||0);
  if(count)tags.push({tone:count>4?'frequent':count>2?'occasional':'rare',label:`${count>4?'Muitas vezes':count>2?'Às vezes':'Poucas vezes'} · ${count}x/7 dias`,detail:'Atendimentos distintos com mensagens do cliente nos últimos 7 dias; várias mensagens no mesmo atendimento contam uma vez.'});
  const facts=conversation.robot_facts||{};
  const found=sgp?.status==='found';
  const services=found?(sgp.customer?.contracts||[]).flatMap(c=>c.services||[]).filter(s=>s.type==='internet'):[];
  const offline=found?services.some(s=>s.online===false):facts.internet_online===false;
  const overdue=found?Number(sgp.customer?.invoices?.overdue||0):Number(facts.overdue_invoice_count||0);
  const source=found?'Consulta SGP do painel':'Última consulta SGP feita pelo robô';
  if(offline)tags.push({tone:'offline',label:'Cliente offline',detail:source+' — indica conexão offline, não determina a causa.'});
  if(overdue>0)tags.push({tone:'debt',label:'Pendência financeira',detail:source+' — fatura(s) vencida(s), sem incluir vencimentos futuros.'});
  if(conversation.reported_slow)tags.push({tone:'slow',label:'Lentidão informada',detail:'Cliente informou Internet lenta neste atendimento; não é diagnóstico automático.'});
  return tags;
}
