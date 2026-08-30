// Minimal file-based data store so the app runs with zero external
// database setup. Swap this module for a real Postgres/Mongo client in
// production — every function keeps the same shape (sync, plain objects
// / arrays) so the rest of the app doesn't need to change.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PREDICTIONS_FILE = path.join(DATA_DIR, 'predictions.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf-8');
  if (!fs.existsSync(PREDICTIONS_FILE)) fs.writeFileSync(PREDICTIONS_FILE, '[]', 'utf-8');
  if (!fs.existsSync(PAYMENTS_FILE)) fs.writeFileSync(PAYMENTS_FILE, '[]', 'utf-8');
}

function readJson(file) {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8') || '[]');
  } catch {
    return [];
  }
}

function writeJson(file, data) {
  ensureStore();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

module.exports = {
  ensureStore,
  readUsers: () => readJson(USERS_FILE),
  writeUsers: (data) => writeJson(USERS_FILE, data),
  readPredictions: () => readJson(PREDICTIONS_FILE),
  writePredictions: (data) => writeJson(PREDICTIONS_FILE, data),
  readPayments: () => readJson(PAYMENTS_FILE),
  writePayments: (data) => writeJson(PAYMENTS_FILE, data),
};
