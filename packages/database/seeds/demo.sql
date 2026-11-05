-- Dados fictícios novos. A conta de login é criada separadamente pelo Supabase Auth.
insert into public.companies(id,name,kind) values
 ('demo-isp','SG Fibra Demo','isp'),('demo-store','Loja Demo','general')
on conflict(id) do nothing;
insert into public.departments(id,company_id,name) values
 ('demo-support','demo-isp','Suporte'),('demo-billing','demo-isp','Financeiro'),('demo-sales','demo-store','Vendas')
on conflict(id) do nothing;
insert into public.automation_settings(company_id,welcome_message,fallback_message,max_attempts) values
 ('demo-isp','Olá! Como podemos ajudar?','Vou encaminhar você para nossa equipe.',2),
 ('demo-store','Olá! Como podemos ajudar?','Vou encaminhar você para nossa equipe.',2)
on conflict(company_id) do nothing;
insert into public.quick_replies(id,company_id,department_id,shortcut,body) values
 ('demo-qr-1','demo-isp','demo-support','/suporte','Vou verificar sua solicitação.'),
 ('demo-qr-2','demo-isp','demo-billing','/financeiro','Vou encaminhar para o financeiro.')
on conflict(id) do nothing;
insert into public.conversations(id,company_id,department_id,contact_name,contact_phone,subject,status,priority,queue_type,protocol) values
 ('demo-conversation-1','demo-isp','demo-support','Cliente de demonstração','5511000000000','Teste da central','waiting','normal','support',public.next_protocol('demo-isp'))
on conflict(id) do nothing;
insert into public.messages(id,company_id,conversation_id,body,direction) values
 ('demo-message-1','demo-isp','demo-conversation-1','Olá! Esta é uma mensagem fictícia de teste.','inbound')
on conflict(id) do nothing;
