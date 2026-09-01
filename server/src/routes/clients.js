const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { sendEmail, templates } = require('../mailer');
const { authLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// ---- POST /api/clients/signup ----
// Rate-limited: account creation is a prime spam target.
router.post('/signup', authLimiter, async (req, res) => {
  try {
    const { fullName, email, phone, occasion, password } = req.body;

    if (!fullName || !email || !phone || !password) {
      return res.status(400).json({ error: 'Full name, email, phone, and a password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existing = db.prepare('SELECT id FROM clients WHERE email = ?').get(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    const result = db.prepare(`
      INSERT INTO clients (full_name, email, phone, occasion, password_hash, verification_token)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(fullName, normalizedEmail, phone, occasion || null, passwordHash, verificationToken);

    const verifyLink = `${process.env.APP_URL || ''}/api/auth/verify?token=${verificationToken}&role=client`;

    try {
      await sendEmail({ to: normalizedEmail, subject: 'Verify your email — CULINARA', html: templates.verifyEmail(fullName, verifyLink) });
    } catch (err) {
      console.error('[clients/signup] email error:', err.message);
    }

    res.status(201).json({ message: 'Account created. Check your email to verify your address.', id: result.lastInsertRowid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong creating your account.' });
  }
});

// ---- GET /api/clients/me ----
router.get('/me', requireRole('client'), (req, res) => {
  const row = db.prepare('SELECT id, full_name, email, phone, occasion, payment_method_type, payment_method_value, email_verified, created_at FROM clients WHERE id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'Profile not found.' });
  res.json({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    occasion: row.occasion,
    paymentMethodType: row.payment_method_type,
    paymentMethodValue: row.payment_method_value,
    emailVerified: !!row.email_verified,
    createdAt: row.created_at,
  });
});

// ---- PUT /api/clients/me ----
router.put('/me', requireRole('client'), (req, res) => {
  const { phone, occasion, paymentMethodType, paymentMethodValue } = req.body;
  if (paymentMethodType && !['paypal', 'mpesa'].includes(paymentMethodType)) {
    return res.status(400).json({ error: 'Payment method must be paypal or mpesa.' });
  }
  db.prepare('UPDATE clients SET phone = ?, occasion = ?, payment_method_type = ?, payment_method_value = ? WHERE id = ?')
    .run(phone || null, occasion || null, paymentMethodType || null, paymentMethodValue || null, req.user.id);
  res.json({ message: 'Profile updated.' });
});

module.exports = router;
