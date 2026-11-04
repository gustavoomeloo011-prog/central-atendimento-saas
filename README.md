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
