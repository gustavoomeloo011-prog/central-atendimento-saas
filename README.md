# Central de Atendimento Inteligente

Primeira versão navegável de uma central SaaS multiempresa. Inclui duas empresas fictícias isoladas, equipes, departamentos, fila, conversas, mensagens, transferência, encerramento e registro de auditoria.

## Executar

\`\`\`powershell
cd C:\\Users\\USER\\Documents\\ChatGPT\\app\\central-atendimento-saas
npm run dev
\`\`\`

Abra http://localhost:3100. Na entrada há dois atalhos de demonstração. A senha é \`demo\`.

## Estado atual

O banco local usa SQLite nativo para desenvolvimento. A migration PostgreSQL em \`packages/database/migrations\` prepara a ida ao Supabase com RLS. WhatsApp Cloud API, Supabase Auth, worker, editor visual, integração real SGP e publicação ainda não foram conectados. O canal atual é um simulador persistente e usa somente dados fictícios.

Não envie tokens Meta, SGP, senhas ou dados reais de clientes para este repositório.
# Central de Atendimento

## Webhook da Meta WhatsApp Cloud API

Endpoint público: `https://central-atendimento-demo.onrender.com/api/webhooks/meta/whatsapp`

Configure no Render, sem commitar valores:

- `META_WEBHOOK_VERIFY_TOKEN`: segredo arbitrário usado apenas na verificação `hub.challenge`.
- `META_APP_SECRET`: App Secret da aplicação Meta; usado para validar `X-Hub-Signature-256`.
- `META_WABA_ID`: ID da WABA autorizada (`2307523413124176` neste ambiente de teste).
- `WHATSAPP_COMPANY_ID`: empresa correspondente no SaaS.

Na Meta, informe a URL acima e o mesmo `META_WEBHOOK_VERIFY_TOKEN`. Depois assine o campo `messages` e inscreva a WABA no aplicativo. O endpoint rejeita assinaturas inválidas, valida a WABA, registra eventos em `connector_events` e ignora mensagens/status duplicados por identificador do provedor.
