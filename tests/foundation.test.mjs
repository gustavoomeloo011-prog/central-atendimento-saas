import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('modelagem multiempresa declara company_id e RLS', async () => {
  const sql = await readFile(new URL('../packages/database/migrations/001_foundation.sql', import.meta.url), 'utf8');
  for (const table of ['profiles', 'departments', 'conversations', 'messages', 'audit_events']) {
    const start = sql.indexOf('create table if not exists ' + table);
    const end = sql.indexOf(');', start);
    assert.ok(start >= 0 && sql.slice(start, end).includes('company_id'));
  }
  assert.match(sql, /enable row level security/);
});
