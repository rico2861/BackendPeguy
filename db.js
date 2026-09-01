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
      CREATE TABLE IF NOT EXISTS audit_logs (id text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS admin_notifications (id text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS cross_platform_payments (id text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
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

// Audit logs are append-only and can grow fast — unlike the tables above,
// this one gets a single targeted INSERT per write instead of a full
// rewrite, and reads are capped instead of pulling every row.
async function appendAuditLog(entry) {
  await ensureSchema();
  await pool.query('INSERT INTO audit_logs (id, data) VALUES ($1, $2::jsonb)', [entry.id, JSON.stringify(entry)]);
}

async function readAuditLogs({ limit = 200 } = {}) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT data FROM audit_logs ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows.map((r) => r.data);
}

async function appendAdminNotification(entry) {
  await ensureSchema();
  await pool.query('INSERT INTO admin_notifications (id, data) VALUES ($1, $2::jsonb)', [entry.id, JSON.stringify(entry)]);
}

async function readAdminNotifications({ limit = 30 } = {}) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT data FROM admin_notifications ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows.map((r) => r.data);
}

// Generic key/value config store — currently only holds the editable VIP
// plan prices (services/plans.js), but any single-row admin-editable
// setting can reuse this instead of getting its own table.
async function readSetting(key) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT data FROM settings WHERE key = $1', [key]);
  return rows[0]?.data ?? null;
}

async function writeSetting(key, value) {
  await ensureSchema();
  await pool.query(
    'INSERT INTO settings (key, data) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET data = $2::jsonb',
    [key, JSON.stringify(value)]
  );
}

// Append-only log of payment events received FROM other platforms we
// operate (currently just DealPam) — never mutated locally, read-only
// display in the admin "Transactions croisées" page. Same shape as
// audit_logs/admin_notifications above: single targeted INSERT, capped
// DESC read.
async function appendCrossPlatformPayment(entry) {
  await ensureSchema();
  await pool.query('INSERT INTO cross_platform_payments (id, data) VALUES ($1, $2::jsonb)', [entry.id, JSON.stringify(entry)]);
}

async function readCrossPlatformPayments({ limit = 500 } = {}) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT data FROM cross_platform_payments ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows.map((r) => r.data);
}

module.exports = {
  ensureSchema,
  readSetting,
  writeSetting,
  readUsers: () => readTable('users'),
  writeUsers: (data) => writeTable('users', data),
  readPredictions: () => readTable('predictions'),
  writePredictions: (data) => writeTable('predictions', data),
  readPayments: () => readTable('payments'),
  writePayments: (data) => writeTable('payments', data),
  appendAuditLog,
  readAuditLogs,
  appendAdminNotification,
  readAdminNotifications,
  appendCrossPlatformPayment,
  readCrossPlatformPayments,
};
