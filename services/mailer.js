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

// Per-category accent — same palette the app already uses (see frontend
// tailwind.config.js) so "compte"/"sécurité"/"paiement" read as distinct
// at a glance, the way Stripe/Linear-style transactional emails do.
const ACCENTS = {
  account: { soft: '#F4C578', mid: '#E8A33D', dim: '#3A2E14', label: 'COMPTE' },
  security: { soft: '#60A5FA', mid: '#3B82F6', dim: '#132038', label: 'SÉCURITÉ' },
  payment: { soft: '#37D999', mid: '#1FAE7A', dim: '#123B2C', label: 'PAIEMENT' },
};

// Table-based layout with inline styles — the only markup that renders
// consistently across Gmail/Outlook/Apple Mail. A full-bleed dark hero
// with the PeguyTbn wordmark, a white content card that overlaps it
// slightly (depth without relying on box-shadow, which most clients
// strip), a category eyebrow + colored accent bar, and a pill CTA.
function renderEmail({ preheader = '', category = 'account', kicker, heading, bodyHtml, ctaText, ctaUrl, footerNote }) {
  const accent = ACCENTS[category] || ACCENTS.account;
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>PeguyTbn</title>
  </head>
  <body style="margin:0;padding:0;background:#F3F4F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F7;">
      <tr>
        <td align="center" style="padding:0 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">

            <!-- Hero -->
            <tr>
              <td style="background:#0A0D13;border-radius:16px 16px 0 0;padding:36px 28px 56px;" align="center">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="width:38px;height:38px;border-radius:11px;background:linear-gradient(180deg,#F4C578,#E8A33D);text-align:center;vertical-align:middle;">
                      <span style="color:#221503;font-weight:800;font-size:19px;font-family:Georgia,serif;line-height:38px;">P</span>
                    </td>
                    <td style="padding-left:11px;text-align:left;">
                      <div style="color:#F1F4F9;font-weight:700;font-size:16px;letter-spacing:-0.01em;">PeguyTbn</div>
                      <div style="color:#6B7386;font-size:9px;font-weight:700;letter-spacing:0.14em;">PREDICTIONS TERMINAL</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Card (pulled up over the hero) -->
            <tr>
              <td style="padding:0 12px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;margin-top:-40px;border:1px solid #E7E9EF;">
                  <tr>
                    <td style="height:4px;background:linear-gradient(90deg,${accent.mid},${accent.soft});border-radius:16px 16px 0 0;font-size:0;line-height:0;">&nbsp;</td>
                  </tr>
                  <tr>
                    <td style="padding:32px 28px 28px;">
                      ${
                        kicker
                          ? `<span style="display:inline-block;background:${accent.dim};color:${accent.soft};font-size:10px;font-weight:800;letter-spacing:0.1em;padding:4px 10px;border-radius:999px;margin-bottom:14px;">${escapeHtml(kicker)}</span><br/>`
                          : ''
                      }
                      <h1 style="margin:0 0 16px;color:#11151F;font-size:20px;font-weight:700;line-height:1.3;">${escapeHtml(heading)}</h1>
                      <div style="color:#4B5468;font-size:14px;line-height:1.65;">${bodyHtml}</div>
                      ${
                        ctaText && ctaUrl
                          ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:26px;">
                              <tr>
                                <td style="border-radius:999px;background:linear-gradient(180deg,#F4C578,#E8A33D);">
                                  <a href="${ctaUrl}" style="display:inline-block;padding:13px 26px;color:#221503;font-weight:700;font-size:14px;text-decoration:none;border-radius:999px;">${escapeHtml(ctaText)}</a>
                                </td>
                              </tr>
                            </table>`
                          : ''
                      }
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td align="center" style="padding:22px 16px 36px;color:#9AA1B2;font-size:11px;line-height:1.7;">
                ${footerNote ? `${escapeHtml(footerNote)}<br/>` : ''}
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
      category: 'account',
      kicker: 'COMPTE',
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
      category: 'security',
      kicker: 'SÉCURITÉ',
      heading: `Réinitialisation du mot de passe`,
      bodyHtml: `<p style="margin:0 0 12px;">Bonjour ${name},</p>
        <p style="margin:0 0 12px;">Clique sur le bouton ci-dessous pour choisir un nouveau mot de passe. Ce lien est valable <strong>1 heure</strong>.</p>
        <p style="margin:0;color:#9AA1B2;font-size:12px;">Si tu n'es pas à l'origine de cette demande, ignore simplement cet email — ton mot de passe actuel reste inchangé.</p>`,
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
      category: 'payment',
      kicker: 'PAIEMENT',
      heading: `Paiement confirmé 🎉`,
      bodyHtml: `<p style="margin:0 0 12px;">Bonjour ${name},</p>
        <p style="margin:0 0 12px;">Ton paiement de <strong>${payment.amountUsd} $</strong> a été confirmé. Ton accès <strong>Premium</strong> est actif${days ? ` pour ${days} jours` : ''}.</p>
        <p style="margin:0;">Tu as maintenant accès aux cotes en direct, aux value bets et aux pronostics VIP.</p>`,
      ctaText: 'Découvrir le Monitoring en direct',
      ctaUrl: `${process.env.PUBLIC_APP_URL || 'http://localhost:5173'}/monitoring`,
    }),
  });
}

function sendVipExpiringEmail(user, daysRemaining) {
  const name = escapeHtml(user.name);
  const isToday = daysRemaining <= 0;
  const heading = isToday ? 'Ton accès Premium expire aujourd\'hui' : `Ton accès Premium expire dans ${daysRemaining} jour${daysRemaining > 1 ? 's' : ''}`;
  return sendMail({
    to: user.email,
    subject: heading,
    html: renderEmail({
      preheader: heading,
      category: 'payment',
      kicker: 'ABONNEMENT',
      heading,
      bodyHtml: `<p style="margin:0 0 12px;">Bonjour ${name},</p>
        <p style="margin:0 0 12px;">${
          isToday
            ? "Ton accès Premium se termine aujourd'hui. Renouvelle maintenant pour ne pas perdre les cotes en direct, les value bets et les pronostics VIP."
            : `Pense à renouveler pour continuer à profiter des cotes en direct, des value bets et des pronostics VIP sans interruption.`
        }</p>`,
      ctaText: 'Renouveler mon accès Premium',
      ctaUrl: `${process.env.PUBLIC_APP_URL || 'http://localhost:5173'}/premium`,
    }),
  });
}

module.exports = {
  isConfigured,
  sendMail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendPaymentConfirmationEmail,
  sendVipExpiringEmail,
};
