// Image uploads (logos, avatars, payment screenshots) via Cloudflare R2
// (S3-compatible). Deliberately reuses the DealPam R2 account/bucket per
// explicit instruction — every key is namespaced under `peguytbn/` so
// nothing collides with DealPam's own objects in the same bucket.
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

function isConfigured() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME &&
    process.env.R2_PUBLIC_URL
  );
}

let client = null;
function getClient() {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

// `folder` groups uploads by purpose (e.g. 'avatars', 'logos', 'payments')
// so they're easy to browse/clean up in the R2 dashboard.
async function uploadImage({ buffer, mimetype, originalName, folder = 'misc' }) {
  const ext = (originalName.split('.').pop() || 'bin').toLowerCase();
  const key = `peguytbn/${folder}/${crypto.randomUUID()}.${ext}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    })
  );

  const base = process.env.R2_PUBLIC_URL.replace(/\/$/, '');
  return `${base}/${key}`;
}

module.exports = { isConfigured, uploadImage };
