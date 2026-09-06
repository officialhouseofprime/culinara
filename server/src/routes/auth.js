const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { sign } = require('../middleware/auth');
const { sendEmail, templates } = require('../mailer');
const { authLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Every route in this file is auth-sensitive (login, password reset) —
// apply the tight rate limiter across the whole router rather than
// per-route, so nothing here is accidentally left unprotected.
router.use(authLimiter);

function tableFor(role) {
  if (role === 'chef') return 'chefs';
  if (role === 'client') return 'clients';
  throw new Error('Unknown role');
}

// ---- GET /api/auth/verify?token=...&role=chef|client ----
// Clicked from the verification email. Marks the account verified, then
// redirects straight into the site with a short-lived, single-use
// "exchange" token so the person lands already logged in on their profile
// instead of a dead-end confirmation page they'd have to log in again from.
router.get('/verify', (req, res) => {
  const { token, role } = req.query;
  if (!token || !['chef', 'client'].includes(role)) {
    return res.status(400).send(resultPage('That verification link looks invalid.', false));
  }

  const table = tableFor(role);
  const row = db.prepare(`SELECT id, full_name, email FROM ${table} WHERE verification_token = ?`).get(token);

  if (!row) {
    return res.status(400).send(resultPage('That verification link is invalid or has already been used.', false));
  }

  db.prepare(`UPDATE ${table} SET email_verified = 1, verification_token = NULL WHERE id = ?`).run(row.id);

  // For chefs, kick off the "we'll be in touch to schedule an interview"
  // email right away. There's no job scheduler here to send it exactly at
  // the 2-day mark, so it goes out immediately and sets the expectation —
  // if you add a queue (BullMQ, a cron job, etc.) later, this is the spot
  // to delay it instead.
  if (role === 'chef') {
    db.prepare(`UPDATE chefs SET interview_email_sent_at = datetime('now') WHERE id = ?`).run(row.id);
    sendEmail({
      to: row.email,
      subject: "You're verified — next, a quick interview — CULINARA",
      html: templates.chefInterviewInvite(row.full_name),
    }).catch(err => console.error('[auth/verify] interview email error:', err.message));
  }

  const exchangeToken = jwt.sign({ id: row.id, role, purpose: 'verify-login' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const siteUrl = process.env.SITE_URL || '';
  return res.redirect(`${siteUrl}/account.html?verified=1&role=${role}&vtoken=${exchangeToken}`);
});

// ---- POST /api/auth/exchange ----
// Trades the short-lived "vtoken" from the verify-email redirect for a
// normal session token, so the frontend can log the person straight in
// without asking them to type their password again right after verifying.
// Single-purpose and short-lived (10 min) — it cannot be used for anything
// other than this one handoff.
router.post('/exchange', (req, res) => {
  const { vtoken } = req.body;
  if (!vtoken) return res.status(400).json({ error: 'Missing token.' });

  let payload;
  try {
    payload = jwt.verify(vtoken, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'This link has expired. Please log in with your email and password instead.' });
  }
  if (payload.purpose !== 'verify-login' || !['chef', 'client'].includes(payload.role)) {
    return res.status(400).json({ error: 'Invalid token.' });
  }

  const table = tableFor(payload.role);
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(payload.id);
  if (!row) return res.status(404).json({ error: 'Account not found.' });

  const token = sign({ id: row.id, email: row.email, role: payload.role });
  const profile = { id: row.id, fullName: row.full_name, email: row.email };
  if (payload.role === 'chef') profile.status = row.status;

  res.json({ token, role: payload.role, profile });
});

// ---- POST /api/auth/login ----
router.post('/login', (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password || !['chef', 'client'].includes(role)) {
    return res.status(400).json({ error: 'Email, password, and role are required.' });
  }

  const table = tableFor(role);
  const row = db.prepare(`SELECT * FROM ${table} WHERE email = ?`).get(String(email).toLowerCase().trim());

  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  if (!row.email_verified) {
    return res.status(403).json({ error: 'Please verify your email before logging in. Check your inbox for the verification link.' });
  }

  const token = sign({ id: row.id, email: row.email, role });

  const profile = { id: row.id, fullName: row.full_name, email: row.email };
  if (role === 'chef') profile.status = row.status;

  res.json({ token, role, profile });
});

// ---- POST /api/auth/forgot-password ----
router.post('/forgot-password', async (req, res) => {
  const { email, role } = req.body;
  if (!email || !['chef', 'client'].includes(role)) {
    return res.status(400).json({ error: 'Email and role are required.' });
  }

  const table = tableFor(role);
  const row = db.prepare(`SELECT * FROM ${table} WHERE email = ?`).get(String(email).toLowerCase().trim());

  // Always respond the same way, whether or not the account exists —
  // this avoids leaking which emails are registered.
  const genericResponse = { message: "If that email is registered, we've sent a password reset link." };

  if (!row) return res.json(genericResponse);

  const resetToken = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 60 * 60 * 1000; // 1 hour

  db.prepare(`UPDATE ${table} SET reset_token = ?, reset_token_expires = ? WHERE id = ?`)
    .run(resetToken, expires, row.id);

  const link = `${process.env.SITE_URL || ''}/account.html?mode=reset&role=${role}&token=${resetToken}`;

  try {
    await sendEmail({
      to: row.email,
      subject: 'Reset your CULINARA password',
      html: templates.passwordReset(row.full_name, link),
    });
  } catch (err) {
    console.error('[auth] Failed to send reset email:', err.message);
  }

  res.json(genericResponse);
});

// ---- POST /api/auth/reset-password ----
router.post('/reset-password', (req, res) => {
  const { token, role, newPassword } = req.body;
  if (!token || !['chef', 'client'].includes(role) || !newPassword) {
    return res.status(400).json({ error: 'Missing token, role, or new password.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const table = tableFor(role);
  const row = db.prepare(`SELECT * FROM ${table} WHERE reset_token = ?`).get(token);

  if (!row || !row.reset_token_expires || row.reset_token_expires < Date.now()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  }

  const passwordHash = bcrypt.hashSync(newPassword, 10);
  db.prepare(`UPDATE ${table} SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?`)
    .run(passwordHash, row.id);

  res.json({ message: 'Password updated. You can now log in with your new password.' });
});

function resultPage(message, ok, link) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>CULINARA</title>
<style>
  body{font-family:Georgia,serif;background:#1B1712;color:#F1E7D4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}
  .card{background:#F1E7D4;color:#2B2117;max-width:420px;padding:36px 32px;border-radius:4px;text-align:center;}
  .brand{color:#B5502E;letter-spacing:0.04em;margin-bottom:20px;}
  a{display:inline-block;margin-top:20px;background:#C99A3D;color:#201804;padding:12px 22px;border-radius:4px;text-decoration:none;font-weight:bold;font-family:sans-serif;font-size:14px;}
  .icon{font-size:32px;margin-bottom:12px;}
</style></head>
<body><div class="card">
  <p class="brand">CULINARA</p>
  <div class="icon">${ok ? '✓' : '✕'}</div>
  <p>${escapeHtml(message)}</p>
  ${link ? `<a href="${link}">Continue to log in</a>` : ''}
</div></body></html>`;
}

function escapeHtml(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = router;
