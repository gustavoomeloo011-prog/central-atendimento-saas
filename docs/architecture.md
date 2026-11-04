# Arquitetura inicial

O simulador local é o canal ativo nesta fase. Adaptadores de canais receberão eventos e gravarão dados idempotentes no banco. Workers executarão fluxos, fila e notificações. PostgreSQL com Supabase será a fonte de verdade em produção, com RLS baseado na empresa do JWT. Credenciais Meta e SGP ficarão apenas no backend, criptografadas e separadas por empresa.

O supervisor administra atendentes, filas e mensagens. Cada conversa aponta para uma fila e um responsável. O robô usa mensagem inicial, limite de tentativas e mensagem de encaminhamento, todos por empresa. A próxima etapa transforma estas regras configuradas no motor de fluxo que receberá eventos dos adaptadores.
