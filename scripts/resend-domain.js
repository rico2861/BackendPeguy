// One-off CLI to manage the peguytbn.com sending domain in Resend — not
// wired into the API since domain setup/verification is a one-time admin
// task, not something the app itself ever needs to do at runtime.
//
// Usage (from BackendPeguy/, with RESEND_API_KEY set in the environment
// or in .env):
//   node scripts/resend-domain.js add
//   node scripts/resend-domain.js get <domain_id>
//   node scripts/resend-domain.js verify <domain_id>
//   node scripts/resend-domain.js list
//   node scripts/resend-domain.js delete <domain_id>
require('dotenv').config();

// Same corporate-proxy TLS workaround as server.js (see comment there) —
// needed here too since this script talks to api.resend.com directly.
const fs = require('fs');
const path = require('path');
const { Agent, setGlobalDispatcher } = require('undici');
const winCaBundle = path.join(__dirname, '..', 'windows-root-ca.pem');
if (fs.existsSync(winCaBundle)) {
  setGlobalDispatcher(new Agent({ connect: { ca: fs.readFileSync(winCaBundle, 'utf8') } }));
}

const { Resend } = require('resend');

const DOMAIN_NAME = 'peguytbn.com';

async function main() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY is not set (check your .env).');
    process.exit(1);
  }
  const resend = new Resend(apiKey);
  const [command, arg] = process.argv.slice(2);

  switch (command) {
    case 'add': {
      const { data, error } = await resend.domains.create({ name: DOMAIN_NAME });
      if (error) throw new Error(error.message);
      console.log(`Domain added: ${data.id}\n`);
      console.log('Add these DNS records at your registrar, then run:');
      console.log(`  node scripts/resend-domain.js verify ${data.id}\n`);
      console.log(JSON.stringify(data.records, null, 2));
      break;
    }
    case 'get': {
      if (!arg) return console.error('Usage: node scripts/resend-domain.js get <domain_id>');
      const { data, error } = await resend.domains.get(arg);
      if (error) throw new Error(error.message);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'verify': {
      if (!arg) return console.error('Usage: node scripts/resend-domain.js verify <domain_id>');
      const { data, error } = await resend.domains.verify(arg);
      if (error) throw new Error(error.message);
      console.log('Verification requested:', JSON.stringify(data, null, 2));
      break;
    }
    case 'list': {
      const { data, error } = await resend.domains.list();
      if (error) throw new Error(error.message);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'delete': {
      if (!arg) return console.error('Usage: node scripts/resend-domain.js delete <domain_id>');
      const { data, error } = await resend.domains.remove(arg);
      if (error) throw new Error(error.message);
      console.log('Deleted:', JSON.stringify(data, null, 2));
      break;
    }
    default:
      console.log('Usage: node scripts/resend-domain.js <add|get|verify|list|delete> [domain_id]');
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
