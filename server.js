require('dotenv').config();

// On some corporate networks, outbound HTTPS is intercepted by a proxy
// whose root certificate is trusted by Windows but not by Node's own
// bundled CA store — every fetch() to an external API then fails with
// "unable to get local issuer certificate". NODE_EXTRA_CA_CERTS doesn't
// reliably apply once Node has already booted, so instead we point
// fetch's global dispatcher (undici) at a local export of the Windows
// trust store, if present. Harmless no-op on machines/hosts (Render,
// etc.) that don't have this file — see PowerShell export command in
// README for how to regenerate it locally.
const fs = require('fs');
const path = require('path');
const { Agent, setGlobalDispatcher } = require('undici');
const winCaBundle = path.join(__dirname, 'windows-root-ca.pem');
if (fs.existsSync(winCaBundle)) {
  setGlobalDispatcher(new Agent({ connect: { ca: fs.readFileSync(winCaBundle, 'utf8') } }));
  console.log('[tls] Using local Windows CA bundle for outbound HTTPS (corporate proxy workaround).');
}

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const User = require('./models/User');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const predictionRoutes = require('./routes/predictions');
const liveRoutes = require('./routes/live');
const paymentRoutes = require('./routes/payments');
const uploadRoutes = require('./routes/uploads');
const pushRoutes = require('./routes/push');
const adminRoutes = require('./routes/admin');
const { syncPredictionsWithLiveResults } = require('./services/predictionSync');
const { sweepPendingPayments } = require('./services/paymentSync');
const { checkAndSendReminders } = require('./services/subscriptionReminders');

const app = express();
const PORT = process.env.PORT || 5000;

if (!process.env.JWT_SECRET) {
  console.warn('[WARN] JWT_SECRET is not set — copy .env.example to .env and set a real secret.');
}

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'peguytbn-backend' }));
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api', predictionRoutes);
app.use('/api', liveRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/admin', adminRoutes);

app.use((req, res) => res.status(404).json({ error: 'Route introuvable.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur interne du serveur.' });
});

async function bootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || 'Admin';
  if (!email || !password) return;
  if (await User.findByEmail(email)) return;
  await User.create({ name, email, password, role: 'admin' });
  console.log(`[seed] Compte admin créé : ${email}`);
}

async function start() {
  await bootstrapAdmin();
  app.listen(PORT, () => {
    console.log(`PeguyTbn backend (Node/Express) listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('[startup] failed to start server:', err.message);
  process.exit(1);
});

// Belt-and-braces: predictions also get synced on-demand (see
// routes/predictions.js), but this catches settlement even when nobody
// is browsing the app right when a match ends.
setInterval(() => {
  syncPredictionsWithLiveResults().catch(() => {});
}, 60_000);

// Grants VIP access automatically as soon as a payment provider confirms
// it — even if the customer never gets redirected back (crypto
// confirmations can take a while) and even if webhooks aren't reachable
// yet (no public URL configured). See services/paymentSync.js.
setInterval(() => {
  sweepPendingPayments().catch(() => {});
}, 120_000);
sweepPendingPayments().catch(() => {});

// VIP expiry reminders (7/3/1/0 days out) — hourly is frequent enough for
// a daily-granularity reminder and cheap even at this app's scale.
setInterval(() => {
  checkAndSendReminders().catch((err) => console.error('[reminders] failed:', err.message));
}, 3_600_000);
checkAndSendReminders().catch((err) => console.error('[reminders] failed:', err.message));
