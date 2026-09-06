const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { sign, requireRole } = require('../middleware/auth');
const { sendEmail, templates } = require('../mailer');
const { adminLoginLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// ---- POST /api/admin/login ----
// There is a single founder account, configured entirely through .env
// (ADMIN_EMAIL / ADMIN_PASSWORD_HASH) — no admin row lives in the database.
// This is the highest-value target in the system, so it gets the tightest
// rate limit in the app (5 attempts / 15 min / IP).
router.post('/login', adminLoginLimiter, (req, res) => {
  const { email, password } = req.body;

  if (!process.env.ADMIN_PASSWORD_HASH) {
    return res.status(500).json({ error: 'Admin login is not configured yet. Run "npm run hash-admin-password -- yourpassword" and set ADMIN_EMAIL / ADMIN_PASSWORD_HASH in .env.' });
  }

  const emailMatches = String(email).toLowerCase().trim() === String(process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const passwordMatches = bcrypt.compareSync(password || '', process.env.ADMIN_PASSWORD_HASH);

  if (!emailMatches || !passwordMatches) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  const token = sign({ id: 0, email, role: 'admin' }, '12h');
  res.json({ token, role: 'admin' });
});

router.use(requireRole('admin'));

// ---- GET /api/admin/stats ----
router.get('/stats', (req, res) => {
  const chefCounts = db.prepare(`
    SELECT status, COUNT(*) as count FROM chefs GROUP BY status
  `).all();
  const clientCount = db.prepare('SELECT COUNT(*) as count FROM clients').get().count;
  const mediaCount = db.prepare('SELECT COUNT(*) as count FROM chef_media').get().count;
  const bookingCounts = db.prepare(`SELECT status, COUNT(*) as count FROM bookings GROUP BY status`).all();
  const messageCount = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE sender_role != 'system'`).get().count;

  const stats = { pending: 0, approved: 0, rejected: 0 };
  chefCounts.forEach(row => { stats[row.status] = row.count; });

  const bStats = { pending: 0, confirmed: 0, declined: 0, cancelled: 0 };
  bookingCounts.forEach(row => { bStats[row.status] = row.count; });

  res.json({
    chefsPending: stats.pending,
    chefsApproved: stats.approved,
    chefsRejected: stats.rejected,
    clients: clientCount,
    mediaPosts: mediaCount,
    bookingsPending: bStats.pending,
    bookingsConfirmed: bStats.confirmed,
    bookingsTotal: bookingCounts.reduce((sum, r) => sum + r.count, 0),
    messagesTotal: messageCount,
  });
});

// ---- GET /api/admin/chefs ----
router.get('/chefs', (req, res) => {
  const rows = db.prepare(`
    SELECT id, full_name, email, phone, chef_type, why_join, status, email_verified, created_at
    FROM chefs ORDER BY created_at DESC
  `).all();
  res.json(rows.map(toChefAdminView));
});

// ---- GET /api/admin/chefs/:id ----
router.get('/chefs/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM chefs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chef not found.' });
  const media = db.prepare('SELECT id, media_type, file_path, caption, created_at FROM chef_media WHERE chef_id = ?').all(req.params.id);
  res.json({
    ...toChefAdminView(row),
    cvUrl: `/api/admin/files/${encodeURIComponent(row.cv_path)}`,
    coverLetterUrl: `/api/admin/files/${encodeURIComponent(row.cover_letter_path)}`,
    media: media.map(m => ({ id: m.id, type: m.media_type, url: `/uploads/${m.file_path.replace(/\\/g, '/')}`, caption: m.caption })),
  });
});

// ---- PUT /api/admin/chefs/:id/status ----
router.put('/chefs/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be pending, approved, or rejected.' });
  }

  const row = db.prepare('SELECT * FROM chefs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chef not found.' });

  db.prepare('UPDATE chefs SET status = ? WHERE id = ?').run(status, req.params.id);

  try {
    if (status === 'approved') {
      const loginLink = `${process.env.SITE_URL || ''}/account.html?role=chef`;
      await sendEmail({ to: row.email, subject: "You're approved — CULINARA", html: templates.chefApproved(row.full_name, loginLink) });
    } else if (status === 'rejected') {
      await sendEmail({ to: row.email, subject: 'About your CULINARA application', html: templates.chefRejected(row.full_name) });
    }
  } catch (err) {
    console.error('[admin] status email error:', err.message);
  }

  res.json({ message: `Status updated to ${status}.` });
});

// ---- DELETE /api/admin/chefs/:id ----
router.delete('/chefs/:id', (req, res) => {
  db.prepare('DELETE FROM chefs WHERE id = ?').run(req.params.id);
  res.json({ message: 'Chef removed.' });
});

// ---- GET /api/admin/clients ----
router.get('/clients', (req, res) => {
  const rows = db.prepare('SELECT id, full_name, email, phone, occasion, email_verified, created_at FROM clients ORDER BY created_at DESC').all();
  res.json(rows.map(r => ({
    id: r.id, fullName: r.full_name, email: r.email, phone: r.phone,
    occasion: r.occasion, emailVerified: !!r.email_verified, createdAt: r.created_at,
  })));
});

// ---- DELETE /api/admin/clients/:id ----
router.delete('/clients/:id', (req, res) => {
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ message: 'Client removed.' });
});

// ---- GET /api/admin/bookings ----
// Every booking on the platform, most recent first, with chef/client names
// joined in — this is the "what's actually happening" view for the founder
// dashboard, alongside the chefs/clients tables.
router.get('/bookings', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*,
           ch.full_name AS chef_name, ch.email AS chef_email,
           cl.full_name AS client_name, cl.email AS client_email
    FROM bookings b
    JOIN chefs ch ON ch.id = b.chef_id
    JOIN clients cl ON cl.id = b.client_id
    ORDER BY b.created_at DESC
  `).all();
  res.json(rows.map(r => ({
    id: r.id,
    eventDate: r.event_date,
    note: r.note,
    status: r.status,
    createdAt: r.created_at,
    chefName: r.chef_name,
    chefEmail: r.chef_email,
    clientName: r.client_name,
    clientEmail: r.client_email,
    agreedAmount: r.agreed_amount,
    commissionRate: r.commission_rate,
    commissionAmount: r.commission_amount,
    clientFeeAmount: r.client_fee_amount,
    totalClientCharge: r.total_client_charge,
    chefPayoutAmount: r.chef_payout_amount,
    paymentStatus: r.payment_status,
    paymentReference: r.payment_reference,
    paidAt: r.paid_at,
    releasedAt: r.released_at,
  })));
});

// ---- GET /api/admin/settings ----
// Platform-wide commission rate and client service fee, editable from the
// dashboard without a redeploy. New bookings snapshot these values at the
// moment they're created, so changing a setting never retroactively alters
// an already-agreed booking.
router.get('/settings', (req, res) => {
  res.json({
    commissionRate: Number(db.getSetting('commission_rate', '20')),
    clientFeeType: db.getSetting('client_fee_type', 'percent'),
    clientFeeValue: Number(db.getSetting('client_fee_value', '5')),
    currency: db.getSetting('currency', 'KES'),
  });
});

router.put('/settings', (req, res) => {
  const { commissionRate, clientFeeType, clientFeeValue, currency } = req.body;

  if (commissionRate !== undefined) {
    const rate = Number(commissionRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return res.status(400).json({ error: 'commissionRate must be a number between 0 and 100.' });
    }
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(rate), 'commission_rate');
  }
  if (clientFeeType !== undefined) {
    if (!['percent', 'flat'].includes(clientFeeType)) {
      return res.status(400).json({ error: 'clientFeeType must be "percent" or "flat".' });
    }
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(clientFeeType, 'client_fee_type');
  }
  if (clientFeeValue !== undefined) {
    const val = Number(clientFeeValue);
    if (!Number.isFinite(val) || val < 0) {
      return res.status(400).json({ error: 'clientFeeValue must be a non-negative number.' });
    }
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(val), 'client_fee_value');
  }
  if (currency !== undefined) {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(currency).toUpperCase(), 'currency');
  }

  res.json({ message: 'Settings updated.' });
});

// ---- GET /api/admin/earnings ----
// Summary totals for the platform's revenue — what's been collected vs.
// still owed, and what's been paid out to chefs vs. still held.
router.get('/earnings', (req, res) => {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(commission_amount), 0) AS total_commission,
      COALESCE(SUM(client_fee_amount), 0) AS total_client_fees,
      COALESCE(SUM(CASE WHEN payment_status IN ('paid_to_platform','released_to_chef') THEN commission_amount + client_fee_amount ELSE 0 END), 0) AS collected_revenue,
      COALESCE(SUM(CASE WHEN payment_status = 'paid_to_platform' THEN chef_payout_amount ELSE 0 END), 0) AS owed_to_chefs,
      COALESCE(SUM(CASE WHEN payment_status = 'released_to_chef' THEN chef_payout_amount ELSE 0 END), 0) AS paid_to_chefs,
      COUNT(CASE WHEN payment_status = 'unpaid' THEN 1 END) AS unpaid_count,
      COUNT(CASE WHEN payment_status = 'paid_to_platform' THEN 1 END) AS awaiting_payout_count
    FROM bookings
    WHERE status = 'confirmed'
  `).get();

  res.json({
    currency: db.getSetting('currency', 'KES'),
    totalCommissionEarned: totals.total_commission,
    totalClientFeesEarned: totals.total_client_fees,
    totalRevenueCollected: totals.collected_revenue,
    owedToChefs: totals.owed_to_chefs,
    paidToChefs: totals.paid_to_chefs,
    unpaidBookingsCount: totals.unpaid_count,
    awaitingPayoutCount: totals.awaiting_payout_count,
  });
});

// ---- GET /api/admin/activity ----
// A merged, most-recent-first feed of everything happening on the platform:
// new chef applications, new client signups, bookings, and messages sent.
// Powers the dashboard's Overview activity feed.
router.get('/activity', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 40, 200);

  const chefSignups = db.prepare(`SELECT id, full_name, created_at FROM chefs ORDER BY created_at DESC LIMIT ?`).all(limit)
    .map(r => ({ type: 'chef_applied', at: r.created_at, label: `${r.full_name} applied to be a chef` }));

  const clientSignups = db.prepare(`SELECT id, full_name, created_at FROM clients ORDER BY created_at DESC LIMIT ?`).all(limit)
    .map(r => ({ type: 'client_signup', at: r.created_at, label: `${r.full_name} signed up as a client` }));

  const bookings = db.prepare(`
    SELECT b.id, b.event_date, b.status, b.created_at, ch.full_name AS chef_name, cl.full_name AS client_name
    FROM bookings b JOIN chefs ch ON ch.id = b.chef_id JOIN clients cl ON cl.id = b.client_id
    ORDER BY b.created_at DESC LIMIT ?
  `).all(limit).map(r => ({ type: 'booking', at: r.created_at, label: `${r.client_name} booked ${r.chef_name} for ${r.event_date} (${r.status})` }));

  const messages = db.prepare(`
    SELECT m.id, m.sender_role, m.created_at, ch.full_name AS chef_name, cl.full_name AS client_name
    FROM messages m JOIN chefs ch ON ch.id = m.chef_id JOIN clients cl ON cl.id = m.client_id
    WHERE m.sender_role != 'system'
    ORDER BY m.created_at DESC LIMIT ?
  `).all(limit).map(r => ({ type: 'message', at: r.created_at, label: `${r.sender_role === 'chef' ? r.chef_name : r.client_name} sent a message (${r.chef_name} ↔ ${r.client_name})` }));

  const merged = [...chefSignups, ...clientSignups, ...bookings, ...messages]
    .sort((a, b) => new Date(b.at.replace(' ', 'T') + 'Z') - new Date(a.at.replace(' ', 'T') + 'Z'))
    .slice(0, limit);

  res.json(merged);
});

// ---- GET /api/admin/files/:relPath — secure download of CVs & cover letters ----
// These are never served as plain static files (see server.js), only through
// this authenticated route, since they're private documents per the privacy policy.
router.get('/files/:relPath', (req, res) => {
  const relPath = decodeURIComponent(req.params.relPath);
  const uploadsRoot = db.uploadsDir;
  const fullPath = path.normalize(path.join(uploadsRoot, relPath));

  if (!fullPath.startsWith(uploadsRoot)) {
    return res.status(400).json({ error: 'Invalid file path.' });
  }
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found.' });
  }
  res.sendFile(fullPath);
});

function toChefAdminView(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    chefType: row.chef_type,
    whyJoin: row.why_join,
    priceNote: row.price_note,
    status: row.status,
    emailVerified: !!row.email_verified,
    createdAt: row.created_at,
  };
}

module.exports = router;
