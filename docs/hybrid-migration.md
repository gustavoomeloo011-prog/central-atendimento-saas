# Migração híbrida: SQLite + Supabase + conector local

## Estado desta etapa

- Backup local criado antes de qualquer alteração: `backups/central-atendimento-20261104-213131.db`.
- O SQLite original permanece intacto e continua sendo o banco usado pela aplicação local.
- As migrations `001_foundation.sql` e `002_hybrid_supabase.sql` preparam o schema PostgreSQL preservando os IDs textuais do SQLite.
- A migration ainda não foi executada em um projeto Supabase: não há credenciais Supabase configuradas neste workspace.

## Variáveis necessárias (somente no Render ou no ambiente local seguro)

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (apenas para clientes autorizados, se necessário)
- `SUPABASE_SERVICE_ROLE_KEY` (somente no backend; nunca no navegador, Git ou logs)

O conector local continuará guardando as credenciais Baileys apenas em `apps/connector/sessions/`. O backend deverá aceitar eventos do conector somente com uma credencial exclusiva e revogável por empresa.

## Ordem segura de execução

1. Criar/configurar o projeto Supabase e definir as variáveis fora do repositório.
2. Aplicar as migrations em uma base vazia ou em uma cópia de validação.
3. Importar os dados do backup mantendo os IDs e validar contagens e vínculos.
4. Executar os testes de isolamento por `company_id`.
5. Trocar a persistência do backend para Supabase com fallback controlado, sem apagar o SQLite.
6. Migrar o transporte do conector para WebSocket de saída autenticado, com fila persistente e idempotência.

Nenhuma etapa acima deve desconectar o WhatsApp ou excluir a sessão local existente.
