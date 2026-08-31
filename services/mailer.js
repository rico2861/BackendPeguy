// Transactional emails. Deliberately reuses the DealPam SMTP account per
// explicit instruction. Every send is best-effort: a caller never lets a
// mail failure fail the request it's attached to (register, reset,
// payment confirmation all still succeed even if the email doesn't go out
// — see the try/catch at each call site).
const nodemailer = require('nodemailer');

let transporter = null;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, html }) {
  if (!isConfigured()) return;
  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    html,
  });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Table-based layout with inline styles — the only markup that renders
// consistently across Gmail/Outlook/Apple Mail. A dark header band with
// the PeguyTbn wordmark (matches the app's sidebar), a light content card
// for readability regardless of the client's own dark mode, and an
// optional gold CTA button — same visual language as the app itself
// (see frontend tailwind.config.js: base #0A0D13, gold #E8A33D).
function renderEmail({ preheader = '', heading, bodyHtml, ctaText, ctaUrl, footerNote }) {
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PeguyTbn</title>
  </head>
  <body style="margin:0;padding:0;background:#0A0D13;font-family:Helvetica,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0A0D13;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
            <tr>
              <td align="center" style="padding-bottom:20px;">
                <span style="display:inline-block;width:36px;height:36px;border-radius:10px;background:linear-gradient(180deg,#F4C578,#E8A33D);color:#221503;font-weight:700;font-size:18px;line-height:36px;text-align:center;font-family:Georgia,serif;">P</span>
                <div style="color:#F1F4F9;font-weight:700;font-size:16px;letter-spacing:-0.02em;margin-top:8px;">PeguyTbn</div>
                <div style="color:#8892A6;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;">Predictions Terminal</div>
              </td>
            </tr>
            <tr>
              <td style="background:#ffffff;border-radius:14px;padding:32px 28px;">
                <h1 style="margin:0 0 16px;color:#11151F;font-size:19px;font-weight:700;">${escapeHtml(heading)}</h1>
                <div style="color:#3A4356;font-size:14px;line-height:1.6;">${bodyHtml}</div>
                ${
                  ctaText && ctaUrl
                    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px;">
                        <tr>
                          <td style="border-radius:10px;background:linear-gradient(180deg,#F4C578,#E8A33D);">
                            <a href="${ctaUrl}" style="display:inline-block;padding:12px 22px;color:#221503;font-weight:700;font-size:14px;text-decoration:none;">${escapeHtml(ctaText)}</a>
                          </td>
                        </tr>
                      </table>`
                    : ''
                }
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-top:20px;color:#8892A6;font-size:11px;line-height:1.6;">
                ${footerNote ? escapeHtml(footerNote) + '<br/>' : ''}
                PeguyTbn — Pronostics football, cotes et probabilités en temps réel.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function sendWelcomeEmail(user) {
  const name = escapeHtml(user.name);
  return sendMail({
    to: user.email,
    subject: 'Bienvenue sur PeguyTbn',
    html: renderEmail({
      preheader: 'Ton compte PeguyTbn est prêt.',
      heading: `Bienvenue, ${name} 👋`,
      bodyHtml: `<p style="margin:0 0 12px;">Ton compte PeguyTbn est créé. Retrouve chaque jour :</p>
        <ul style="margin:0 0 12px;padding-left:18px;">
          <li>Les pronostics du jour avec probabilité et cote</li>
          <li>Les combinés « Prudent » et « Risqué » de nos pronostiqueurs</li>
          <li>Le monitoring des matchs en direct</li>
        </ul>
        <p style="margin:0;">Bonne chance pour tes paris — et joue toujours de façon responsable.</p>`,
      ctaText: 'Voir les pronostics du jour',
      ctaUrl: process.env.PUBLIC_APP_URL || 'http://localhost:5173',
    }),
  });
}

function sendPasswordResetEmail(user, resetLink) {
  const name = escapeHtml(user.name);
  return sendMail({
    to: user.email,
    subject: 'Réinitialisation de ton mot de passe PeguyTbn',
    html: renderEmail({
      preheader: 'Réinitialise ton mot de passe (lien valable 1 heure).',
      heading: `Réinitialisation du mot de passe`,
      bodyHtml: `<p style="margin:0 0 12px;">Bonjour ${name},</p>
        <p style="margin:0 0 12px;">Clique sur le bouton ci-dessous pour choisir un nouveau mot de passe. Ce lien est valable <strong>1 heure</strong>.</p>
        <p style="margin:0;color:#8892A6;font-size:12px;">Si tu n'es pas à l'origine de cette demande, ignore simplement cet email — ton mot de passe actuel reste inchangé.</p>`,
      ctaText: 'Choisir un nouveau mot de passe',
      ctaUrl: resetLink,
    }),
  });
}

function sendPaymentConfirmationEmail(user, payment) {
  const name = escapeHtml(user.name);
  const days = payment.planType === 'vip' ? '30' : '';
  return sendMail({
    to: user.email,
    subject: 'Paiement confirmé — Bienvenue en Premium PeguyTbn',
    html: renderEmail({
      preheader: 'Ton accès Premium PeguyTbn est actif.',
      heading: `Paiement confirmé 🎉`,
      bodyHtml: `<p style="margin:0 0 12px;">Bonjour ${name},</p>
        <p style="margin:0 0 12px;">Ton paiement de <strong>${payment.amountUsd} $</strong> a été confirmé. Ton accès <strong>Premium</strong> est actif${days ? ` pour ${days} jours` : ''}.</p>
        <p style="margin:0;">Tu as maintenant accès aux cotes en direct, aux value bets et aux pronostics VIP.</p>`,
      ctaText: 'Découvrir le Monitoring en direct',
      ctaUrl: `${process.env.PUBLIC_APP_URL || 'http://localhost:5173'}/monitoring`,
    }),
  });
}

module.exports = { isConfigured, sendMail, sendWelcomeEmail, sendPasswordResetEmail, sendPaymentConfirmationEmail };
