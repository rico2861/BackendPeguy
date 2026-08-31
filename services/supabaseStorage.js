// Image uploads (logos, avatars, payment screenshots) go to Supabase
// Storage — a separate Supabase project/bucket from the Postgres database
// used for app data (see db.js), configured independently on purpose so
// either can be swapped without touching the other.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'peguytbn';

let client = null;
function isConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getClient() {
  if (!client) {
    // service_role bypasses Row Level Security — this file only ever runs
    // server-side (never bundled to the frontend), which is what makes
    // that safe here.
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return client;
}

// `folder` groups uploads by purpose (e.g. 'avatars', 'logos', 'payments')
// so they're easy to browse/clean up in the Supabase dashboard.
async function uploadImage({ buffer, mimetype, originalName, folder = 'misc' }) {
  const ext = (originalName.split('.').pop() || 'bin').toLowerCase();
  const path = `${folder}/${crypto.randomUUID()}.${ext}`;

  const { error } = await getClient()
    .storage.from(BUCKET)
    .upload(path, buffer, { contentType: mimetype, upsert: false });
  if (error) throw new Error(error.message);

  const { data } = getClient().storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

module.exports = { isConfigured, uploadImage };
