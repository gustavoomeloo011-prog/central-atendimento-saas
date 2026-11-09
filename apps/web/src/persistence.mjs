import pg from 'pg';
import { readFileSync } from 'node:fs';

export function createPersistence(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL é obrigatória para iniciar a central.');
  const rejectUnauthorized = process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false';
  const caPath = process.env.PGSSL_ROOT_CERT;
  const caInline = process.env.PGSSL_CA;
  let ca;
  if (caInline) ca = caInline.replace(/\\n/g, '\n');
  else if (caPath) ca = readFileSync(caPath, 'utf8');
  const ssl = connectionString.includes('localhost') ? false : { rejectUnauthorized, ...(ca ? { ca } : {}) };
  const pool = new pg.Pool({ connectionString, max: 10, ssl });
  const query = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const one = async (sql, values = []) => (await query(sql, values))[0] || null;
  const transaction = async work => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const tx = { query: async (sql, values = []) => (await client.query(sql, values)).rows,
        one: async (sql, values = []) => (await client.query(sql, values)).rows[0] || null };
      const result = await work(tx);
      await client.query('commit');
      return result;
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  };
  return { query, one, transaction, close: () => pool.end() };
}
