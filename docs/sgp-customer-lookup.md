# Consulta SGP na Central

Implementação baseada em sgfibra/app/sgp.py (SG Fibra Técnico).

## Configuração no backend
SGP_BASE_URL: URL HTTPS do SGP.
SGP_COMPANY_ID: ID da empresa autorizada na Central.
SGP_USERNAME e SGP_PASSWORD: credenciais da conta de consulta. Nunca são expostas ao frontend.

O app/token MONITOR retornou HTTP 403 em /api/ura/clientes/ no teste de 10/11/2026. A autenticação Basic da conta autorizada retornou HTTP 200, como no projeto técnico. Não depende do token recusado.

## Consultas somente de leitura
POST /api/ura/clientes/ com telefone nacional, limit=20, exibir_conexao=true. O telefone também é conferido nos contatos retornados; não acrescentamos nono dígito. Múltiplos cadastros não são associados automaticamente.
POST /ws/radius/radacct/list/all/ por login PPPoE de cada serviço internet, last_session=true e limit=1. Status administrativo não é usado como estado online.

A API retorna ONU rx/tx sem data da medição: o painel informa último sinal armazenado, sem afirmar leitura em tempo real. Faturas abertas são filtradas por status aberto. Senhas de contratos, ONU, Wi-Fi e PPPoE são descartadas pelo mapeamento explícito.

GET /api/conversations/:id/sgp exige autenticação, conversa da empresa autenticada e SGP_COMPANY_ID correspondente. Não recebe telefone arbitrário do navegador. Cache em memória por empresa/telefone de 60s; falhas 10s, limite de 500 entradas e quatro consultas concorrentes. Cache não é armazenamento definitivo e pode ser reconstruído após reinício. Limite de 15s por requisição.

Consulta ocorre ao abrir a conversa e renova enquanto o painel está visível. Falhas não são classificadas como nova contratação. Não altera nem envia mensagens pelo WhatsApp.

## Validação
Teste real: telefone de exemplo encontrou cliente 131, contratos 97/148/157, serviço 97 online e 148 offline; sinal RX -21.55 e TX 2.27 dBm; uma fatura aberta.
Testes automatizados usam exclusivamente clientes fictícios e cobrem isolamento, cache, concorrência, campos permitidos, ambiguidades e HTML escapado.
