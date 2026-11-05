import { readFile } from 'node:fs/promises';
import { createPersistence } from '../apps/web/src/persistence.mjs';

const file = process.argv[2];
if (!file?.startsWith('packages/database/migrations/')) throw new Error('Informe uma migration versionada do projeto.');
const sql = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const db = createPersistence();
try {
  await db.query(sql);
  console.log(`Migration aplicada: ${file}`);
} finally {
  await db.close();
}
