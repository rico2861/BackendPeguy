// Transactional emails via Resend (HTTPS API, not SMTP). Direct SMTP to
// Hostinger timed out systematically from Render — ports 465/587 are
// blocked on Render's outbound IPs. Resend sends over HTTPS (443), which
// is never blocked. Every send is best-effort: a caller never lets a
// mail failure fail the request it's attached to (register, reset,
// payment confirmation all still succeed even if the email doesn't go out
// — see the try/catch at each call site, and the internal catch below).
const { Resend } = require('resend');

let resend = null;

// Two sending identities: "client" for user-facing mail (welcome, reset,
// payment, VIP reminders — everything today), "admin" reserved for future
// internal alerts. Both fall back to a sane default so a missing env var
// degrades gracefully instead of crashing.
const ACCOUNTS = {
  client: () => process.env.MAIL_FROM_CLIENT || 'PeguyTbn <no-reply@peguytbn.com>',
  admin: () => process.env.MAIL_FROM_ADMIN || 'PeguyTbn Équipe <no-reply@peguytbn.com>',
};

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

function getClient() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

async function sendMail({ to, subject, html, as = 'client' }) {
  if (!isConfigured()) return;
  try {
    const { error } = await getClient().emails.send({
      from: ACCOUNTS[as] ? ACCOUNTS[as]() : ACCOUNTS.client(),
      to,
      subject,
      html,
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(`[mailer] Resend send failed (to=${to}): ${err.message}`);
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Per-category accent — same palette the app already uses (see frontend
// tailwind.config.js) so "compte"/"sécurité"/"paiement" read as distinct
// at a glance, the way Stripe/Linear-style transactional emails do.
const ACCENTS = {
  account: { soft: '#F4C578', mid: '#E8A33D', dim: '#3A2E14', label: 'COMPTE', icon: '👤' },
  security: { soft: '#60A5FA', mid: '#3B82F6', dim: '#132038', label: 'SÉCURITÉ', icon: '🔒' },
  payment: { soft: '#37D999', mid: '#1FAE7A', dim: '#123B2C', label: 'PAIEMENT', icon: '⚡' },
};

// Table-based layout with inline styles — the only markup that renders
// consistently across Gmail/Outlook/Apple Mail. A full-bleed dark hero
// with the PeguyTbn wordmark, a white content card that overlaps it
// slightly (depth without relying on box-shadow, which most clients
// strip), a category eyebrow + colored accent bar, and a pill CTA.
//
// "Interactive" bits (real :hover on the CTA/links, applied via a <style>
// block) render in the clients that support embedded CSS — Apple Mail,
// Outlook desktop, most webmail — and degrade to the inline-style fallback
// everywhere else, so nothing ever looks broken.
//
// Optional `stats`: [{ label, value }] renders a small metric row (used
// for payment confirmations — amount / plan / duration at a glance, like
// an invoice). Optional `highlights`: [{ icon, text }] renders an icon
// checklist instead of a plain <ul> (used for the welcome email).
function renderEmail({
  preheader = '',
  category = 'account',
  kicker,
  heading,
  bodyHtml,
  stats,
  highlights,
  ctaText,
  ctaUrl,
  secondaryText,
  footerNote,
}) {
  const accent = ACCENTS[category] || ACCENTS.account;
  const kickerLabel = kicker || accent.label;

  const statsHtml =
    Array.isArray(stats) && stats.length
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;background:#F8F9FB;border:1px solid #ECEEF2;border-radius:12px;">
          <tr>
            ${stats
              .map(
                (s, i) => `<td align="center" style="padding:16px 8px;${i > 0 ? 'border-left:1px solid #ECEEF2;' : ''}">
                  <div style="color:#9AA1B2;font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:5px;">${escapeHtml(s.label)}</div>
                  <div style="color:#11151F;font-size:16px;font-weight:800;">${escapeHtml(s.value)}</div>
                </td>`
              )
              .join('')}
          </tr>
        </table>`
      : '';

  const highlightsHtml =
    Array.isArray(highlights) && highlights.length
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 4px;">
          ${highlights
            .map(
              (h) => `<tr>
                <td style="padding:6px 0;vertical-align:top;width:26px;">
                  <span style="display:inline-block;width:20px;height:20px;border-radius:6px;background:${accent.dim};color:${accent.soft};font-size:11px;text-align:center;line-height:20px;">${escapeHtml(h.icon || '✓')}</span>
                </td>
                <td style="padding:6px 0 6px 4px;color:#3A4256;font-size:14px;line-height:1.5;">${escapeHtml(h.text)}</td>
              </tr>`
            )
            .join('')}
        </table>`
      : '';

  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>PeguyTbn</title>
    <style>
      .pg-cta:hover { filter: brightness(1.06); box-shadow: 0 6px 18px -4px rgba(232,163,61,0.55); }
      .pg-link:hover { text-decoration: underline !important; }
      @media (max-width: 480px) {
        .pg-card-pad { padding: 26px 20px 22px !important; }
        .pg-heading { font-size: 18px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#F3F4F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F7;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">

            <!-- Hero -->
            <tr>
              <td style="background:#0A0D13;background-image:radial-gradient(circle at 15% 15%, rgba(232,163,61,0.16), transparent 55%);border-radius:18px 18px 0 0;padding:32px 28px 56px;" align="center">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="width:38px;height:38px;border-radius:11px;background:linear-gradient(180deg,#F4C578,#E8A33D);text-align:center;vertical-align:middle;">
                      <span style="color:#221503;font-weight:800;font-size:19px;font-family:Georgia,serif;line-height:38px;">P</span>
                    </td>
                    <td style="padding-left:11px;text-align:left;">
                      <div style="color:#F1F4F9;font-weight:700;font-size:16px;letter-spacing:-0.01em;">PeguyTbn</div>
                      <div style="color:#6B7386;font-size:9px;font-weight:700;letter-spacing:0.14em;">LIFE IS GOOD</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Card (pulled up over the hero) -->
            <tr>
              <td style="padding:0 12px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;margin-top:-40px;border:1px solid #E7E9EF;box-shadow:0 20px 44px -24px rgba(10,13,19,0.35);">
                  <tr>
                    <td style="height:4px;background:linear-gradient(90deg,${accent.mid},${accent.soft});border-radius:18px 18px 0 0;font-size:0;line-height:0;">&nbsp;</td>
                  </tr>
                  <tr>
                    <td class="pg-card-pad" style="padding:32px 28px 28px;">
                      <span style="display:inline-flex;align-items:center;gap:6px;background:${accent.dim};color:${accent.soft};font-size:10px;font-weight:800;letter-spacing:0.1em;padding:5px 11px 5px 9px;border-radius:999px;margin-bottom:14px;">
                        <span style="font-size:11px;">${accent.icon}</span>${escapeHtml(kickerLabel)}
                      </span>
                      <h1 class="pg-heading" style="margin:8px 0 16px;color:#11151F;font-size:21px;font-weight:800;line-height:1.3;letter-spacing:-0.01em;">${escapeHtml(heading)}</h1>
                      <div style="color:#4B5468;font-size:14px;line-height:1.65;">${bodyHtml}</div>
                      ${highlightsHtml}
                      ${statsHtml}
                      ${
                        ctaText && ctaUrl
                          ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:26px;">
                              <tr>
                                <td style="border-radius:999px;background:linear-gradient(180deg,#F4C578,#E8A33D);">
                                  <a href="${ctaUrl}" class="pg-cta" style="display:inline-block;padding:13px 28px;color:#221503;font-weight:700;font-size:14px;text-decoration:none;border-radius:999px;transition:filter .15s ease;">${escapeHtml(ctaText)} →</a>
                                </td>
                              </tr>
                            </table>`
                          : ''
                      }
                      ${
                        secondaryText
                          ? `<p style="margin:16px 0 0;color:#9AA1B2;font-size:12px;line-height:1.6;">${secondaryText}</p>`
                          : ''
                      }
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td align="center" style="padding:26px 16px 8px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:0 10px;">
                      <a href="${process.env.PUBLIC_APP_URL || 'https://peguytbn.com'}" class="pg-link" style="color:#6B7386;font-size:11px;font-weight:600;text-decoration:none;">Site web</a>
                    </td>
                    <td style="color:#3A4256;font-size:11px;">•</td>
                    <td style="padding:0 10px;">
                      <a href="mailto:${process.env.MAIL_FROM_CLIENT ? String(process.env.MAIL_FROM_CLIENT).match(/<(.+)>/)?.[1] || 'support@peguytbn.com' : 'support@peguytbn.com'}" class="pg-link" style="color:#6B7386;font-size:11px;font-weight:600;text-decoration:none;">Support</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 16px 36px;color:#9AA1B2;font-size:11px;line-height:1.7;">
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
      bodyHtml: `<p style="margin:0;">Ton compte PeguyTbn est créé. Retrouve chaque jour :</p>`,
      highlights: [
        { icon: '⚽', text: 'Les pronostics du jour avec probabilité et cote' },
        { icon: '🎟️', text: 'Les combinés « Prudent » et « Risqué » de nos pronostiqueurs' },
        { icon: '📡', text: 'Le monitoring des matchs en direct' },
      ],
      ctaText: 'Voir les pronostics du jour',
      ctaUrl: process.env.PUBLIC_APP_URL || 'http://localhost:5173',
      secondaryText: 'Bonne chance pour tes paris — et joue toujours de façon responsable.',
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
      bodyHtml: `<p style="margin:0;">Bonjour ${name}, clique sur le bouton ci-dessous pour choisir un nouveau mot de passe. Ce lien est valable <strong>1 heure</strong>.</p>`,
      ctaText: 'Choisir un nouveau mot de passe',
      ctaUrl: resetLink,
      secondaryText: "Si tu n'es pas à l'origine de cette demande, ignore simplement cet email — ton mot de passe actuel reste inchangé.",
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
      bodyHtml: `<p style="margin:0;">Bonjour ${name}, ton paiement a été confirmé et ton accès <strong>Premium</strong> est actif. Tu as maintenant accès aux cotes en direct, aux value bets et aux pronostics VIP.</p>`,
      stats: [
        { label: 'Montant', value: `${payment.amountUsd} $` },
        { label: 'Plan', value: 'Premium' },
        { label: 'Durée', value: days ? `${days} jours` : '—' },
      ],
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

function sendOtpEmail(user, otp) {
  const name = escapeHtml(user.name);
  return sendMail({
    to: user.email,
    subject: `${otp} — Code de réinitialisation PeguyTbn`,
    html: renderEmail({
      preheader: `Ton code: ${otp} (valable 10 minutes).`,
      category: 'security',
      kicker: 'SÉCURITÉ',
      heading: 'Code de réinitialisation',
      bodyHtml: `<p style="margin:0;">Bonjour ${name}, voici ton code pour réinitialiser ton mot de passe :</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 4px;">
          <tr>
            <td align="center" style="background:linear-gradient(180deg,#F8F9FB,#F0F2F6);border:1px solid #ECEEF2;border-radius:12px;padding:18px;">
              <span style="font-family:'JetBrains Mono',Consolas,monospace;font-size:34px;font-weight:800;letter-spacing:0.2em;color:#11151F;">${escapeHtml(otp)}</span>
            </td>
          </tr>
        </table>`,
      secondaryText: 'Ce code est valable <strong>10 minutes</strong>. Si tu n\'es pas à l\'origine de cette demande, ignore cet e-mail.',
    }),
  });
}

function sendNewPicksEmail(user, { message } = {}) {
  const name = escapeHtml(user.name);
  return sendMail({
    to: user.email,
    subject: 'Nouveaux pronostics VIP disponibles sur PeguyTbn',
    html: renderEmail({
      preheader: 'De nouveaux pronostics VIP viennent d\'être publiés.',
      category: 'payment',
      kicker: 'VIP',
      heading: `De nouveaux pronostics t'attendent, ${name}`,
      bodyHtml: `<p style="margin:0 0 12px;">${
        message ? escapeHtml(message) : "Nos pronostiqueurs viennent de publier de nouvelles sélections VIP — jette-y un œil avant le coup d'envoi."
      }</p>`,
      ctaText: 'Voir les pronostics VIP',
      ctaUrl: `${process.env.PUBLIC_APP_URL || 'http://localhost:5173'}/pronostics-vip`,
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
  sendNewPicksEmail,
  sendOtpEmail,
};
