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

function sendWelcomeEmail(user) {
  return sendMail({
    to: user.email,
    subject: 'Bienvenue sur PeguyTbn',
    html: `<p>Bonjour ${user.name},</p><p>Ton compte PeguyTbn est créé. Retrouve les pronostics du jour et les paris combinés sur l'application.</p>`,
  });
}

function sendPasswordResetEmail(user, resetLink) {
  return sendMail({
    to: user.email,
    subject: 'Réinitialisation de ton mot de passe PeguyTbn',
    html: `<p>Bonjour ${user.name},</p><p>Clique sur ce lien pour choisir un nouveau mot de passe (valable 1 heure) :</p><p><a href="${resetLink}">${resetLink}</a></p><p>Si tu n'es pas à l'origine de cette demande, ignore cet email.</p>`,
  });
}

function sendPaymentConfirmationEmail(user, payment) {
  return sendMail({
    to: user.email,
    subject: 'Paiement confirmé — Bienvenue en Premium PeguyTbn',
    html: `<p>Bonjour ${user.name},</p><p>Ton paiement de ${payment.amountUsd} $ a été confirmé. Ton accès Premium est actif pour ${payment.planType === 'vip' ? '30' : ''} jours.</p>`,
  });
}

module.exports = { isConfigured, sendMail, sendWelcomeEmail, sendPasswordResetEmail, sendPaymentConfirmationEmail };
