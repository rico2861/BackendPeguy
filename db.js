// Postgres-backed data store (Supabase). Each entity type keeps the same
// shape as before (an array of plain objects) — reads pull every row's
// `data` column, writes replace the whole table in one transaction — so
// the models above didn't need to change their read-all/mutate/write-all
// logic, only await it. At this app's scale (a handful of moderators'
// worth of predictions/users/payments) a full-table rewrite per write is
// simple and safe; if that ever becomes a bottleneck, switch the affected
// write to a targeted UPSERT/DELETE instead of rewriting the whole table.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase's pooler terminates TLS with a cert that isn't in Node's
  // default trust store; this matches Supabase's own connection docs.
  ssl: { rejectUnauthorized: false },
});

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS predictions (id text PRIMARY KEY, data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS payments (id text PRIMARY KEY, data jsonb NOT NULL);
    `);
  }
  return schemaReady;
}

async function readTable(table) {
  await ensureSchema();
  const { rows } = await pool.query(`SELECT data FROM ${table}`);
  return rows.map((r) => r.data);
}

async function writeTable(table, data) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${table}`);
    for (const item of data) {
      await client.query(`INSERT INTO ${table} (id, data) VALUES ($1, $2::jsonb)`, [item.id, JSON.stringify(item)]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  ensureSchema,
  readUsers: () => readTable('users'),
  writeUsers: (data) => writeTable('users', data),
  readPredictions: () => readTable('predictions'),
  writePredictions: (data) => writeTable('predictions', data),
  readPayments: () => readTable('payments'),
  writePayments: (data) => writeTable('payments', data),
};
