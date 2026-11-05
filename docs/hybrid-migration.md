# PostgreSQL no Supabase + conector local

## Estado desta etapa

- Backup local criado antes de qualquer alteração: `backups/central-atendimento-20261104-213131.db`.
- O SQLite original permanece intacto como referência; os registros antigos não serão importados.
- O backend novo está em `apps/web/src/server.pg.mjs`, com consultas parametrizadas em `persistence.mjs`.
- As migrations `001_foundation.sql`, `002_hybrid_supabase.sql`, `003_clean_saas.sql` e `004_flow_runs.sql` compõem o schema limpo. Devem ser aplicadas em ordem em `Central-atendimento`.
- Nenhuma migration foi executada remotamente: não há credenciais Supabase configuradas neste workspace.

## Variáveis necessárias (somente no Render ou no ambiente local seguro)

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (apenas para clientes autorizados, se necessário)
- `SUPABASE_SERVICE_ROLE_KEY` (somente no backend; nunca no navegador, Git ou logs)
- `DATABASE_URL` (URI PostgreSQL do projeto; somente no backend)
- `WHATSAPP_CONNECTOR_TOKEN` e `WHATSAPP_COMPANY_ID` (mesmos valores no backend e no conector local)

O conector local continuará guardando as credenciais Baileys apenas em `apps/connector/sessions/`. O backend deverá aceitar eventos do conector somente com uma credencial exclusiva e revogável por empresa.

## Ordem segura de execução

1. Configurar as quatro variáveis Supabase/PostgreSQL fora do repositório.
2. Verificar que a conexão aponta para o projeto `Central-atendimento`.
3. Aplicar as quatro migrations em ordem e, opcionalmente, `packages/database/seeds/demo.sql`.
4. Configurar `DEMO_ADMIN_EMAIL` e `DEMO_ADMIN_PASSWORD` fora do Git e executar `node scripts/provision-admin.mjs` para criar o primeiro login no Supabase Auth.
5. Rodar testes de isolamento e de fluxo completo antes do deploy no Render.
6. Configurar as mesmas variáveis privadas no Render e conferir `/health`.

O backend instala apenas `pg`. As dependências Baileys e QR Code ficam fixadas em `apps/connector`, instaladas separadamente. A sessão local em `apps/connector/sessions/` não é modificada por essa instalação.

Nenhuma etapa acima deve desconectar o WhatsApp ou excluir a sessão local existente.
