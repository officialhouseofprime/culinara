// Bookings — the calendar/booking layer between clients and chefs, plus
// CULINARA's earnings tracking on top of it.
//
// A client requests a date with a chef and states the amount they've
// agreed with the chef for the service; CULINARA calculates its commission
// and client service fee on top of that using the platform's current
// settings (admin-configurable — see /api/admin/settings), and snapshots
// the breakdown onto the booking so a later rate change never retroactively
// alters an already-agreed booking.
//
// IMPORTANT — this does NOT move any real money. There is no live payment
// processor connected yet (no Stripe Connect / M-Pesa Daraja business
// account set up). Money changes hands off-platform (e.g. the client pays
// the chef's M-Pesa Till directly, or CULINARA's own Till if collecting
// the commission upfront), and the admin marks payment_status manually
// from the dashboard once it's confirmed. This is the standard early-stage
// approach until a real payment integration is wired in.

const express = require('express');
const db = require('../db');
const { requireRole, requireAuth } = require('../middleware/auth');
const { pushToUser } = require('./messages');

const router = express.Router();

function toBooking(row) {
  return {
    id: row.id,
    chefId: row.chef_id,
    clientId: row.client_id,
    eventDate: row.event_date,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    chefName: row.chef_name,
    clientName: row.client_name,
    // Earnings breakdown — snapshotted at booking time.
    agreedAmount: row.agreed_amount,
    commissionRate: row.commission_rate,
    commissionAmount: row.commission_amount,
    clientFeeAmount: row.client_fee_amount,
    totalClientCharge: row.total_client_charge,
    chefPayoutAmount: row.chef_payout_amount,
    paymentStatus: row.payment_status,
    paymentReference: row.payment_reference,
    paidAt: row.paid_at,
    releasedAt: row.released_at,
  };
}

// ---- POST /api/bookings ----
// Client books a chef for a specific date, stating the amount agreed with
// the chef. { chefId, eventDate, note, agreedAmount }
router.post('/', requireRole('client'), (req, res) => {
  const { chefId, eventDate, note, agreedAmount } = req.body;
  if (!chefId || !eventDate) return res.status(400).json({ error: 'A chef and event date are required.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return res.status(400).json({ error: 'Event date must be in YYYY-MM-DD format.' });

  const amount = Number(agreedAmount);
  if (!agreedAmount || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'A valid agreed amount (what you and the chef agreed the service costs) is required.' });
  }

  const chef = db.prepare(`SELECT id, full_name FROM chefs WHERE id = ? AND status = 'approved'`).get(chefId);
  if (!chef) return res.status(404).json({ error: 'Chef not found.' });

  const client = db.prepare('SELECT full_name FROM clients WHERE id = ?').get(req.user.id);

  const existing = db.prepare(
    `SELECT id FROM bookings WHERE chef_id = ? AND event_date = ? AND status IN ('pending','confirmed')`
  ).get(chefId, eventDate);
  if (existing) return res.status(409).json({ error: 'That date is already booked or pending for this chef. Try another date.' });

  const fin = db.calculateBookingFinancials(amount);

  const info = db.prepare(`
    INSERT INTO bookings (
      chef_id, client_id, event_date, note,
      agreed_amount, commission_rate, commission_amount,
      client_fee_amount, total_client_charge, chef_payout_amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chefId, req.user.id, eventDate, note || null,
    amount, fin.commissionRate, fin.commissionAmount,
    fin.clientFeeAmount, fin.totalClientCharge, fin.chefPayoutAmount
  );

  const bookingId = info.lastInsertRowid;
  const currency = db.getSetting('currency', 'KES');

  // Drop a system message into the thread with the booking + payment
  // breakdown, so the chef sees exactly what they'll be paid right where
  // they already check messages (instant delivery if they're online).
  const messageBody = `📅 New booking request from ${client.full_name}\nDate: ${eventDate}${note ? `\nDetails: ${note}` : ''}\nAgreed amount: ${currency} ${amount.toFixed(2)}\nYour payout after CULINARA's ${fin.commissionRate}% commission: ${currency} ${fin.chefPayoutAmount.toFixed(2)}`;
  db.prepare(
    `INSERT INTO messages (chef_id, client_id, sender_role, body, booking_id) VALUES (?, ?, 'system', ?, ?)`
  ).run(chefId, req.user.id, messageBody, bookingId);

  pushToUser('chef', chefId, {
    type: 'message',
    from: req.user.id,
    body: messageBody,
    senderRole: 'system',
    bookingId,
    createdAt: new Date().toISOString(),
  });

  res.status(201).json({
    message: 'Booking requested — the chef has been notified in Messages.',
    bookingId,
    totalClientCharge: fin.totalClientCharge,
    chefPayoutAmount: fin.chefPayoutAmount,
  });
});

// ---- GET /api/bookings/mine ----
// The logged-in chef or client's own bookings.
router.get('/mine', requireAuth, (req, res) => {
  const { role, id } = req.user;
  const sql = role === 'chef'
    ? `SELECT b.*, c.full_name AS client_name, ch.full_name AS chef_name FROM bookings b
       JOIN clients c ON c.id = b.client_id JOIN chefs ch ON ch.id = b.chef_id
       WHERE b.chef_id = ? ORDER BY b.event_date ASC`
    : `SELECT b.*, c.full_name AS client_name, ch.full_name AS chef_name FROM bookings b
       JOIN clients c ON c.id = b.client_id JOIN chefs ch ON ch.id = b.chef_id
       WHERE b.client_id = ? ORDER BY b.event_date ASC`;
  const rows = db.prepare(sql).all(id);
  res.json(rows.map(toBooking));
});

// ---- PUT /api/bookings/:id/status ----
// Chef confirms/declines; client can cancel their own pending request.
router.put('/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  const { role, id } = req.user;
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const allowedByChef = role === 'chef' && booking.chef_id === id && ['confirmed', 'declined'].includes(status);
  const allowedByClient = role === 'client' && booking.client_id === id && status === 'cancelled';
  if (!allowedByChef && !allowedByClient) return res.status(403).json({ error: 'Not allowed to make that change.' });

  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, booking.id);

  const chefRow = db.prepare('SELECT full_name FROM chefs WHERE id = ?').get(booking.chef_id);
  const statusLabel = { confirmed: 'confirmed ✅', declined: 'declined', cancelled: 'cancelled' }[status] || status;
  const messageBody = `Booking for ${booking.event_date} was ${statusLabel} by the ${role}.`;
  db.prepare(`INSERT INTO messages (chef_id, client_id, sender_role, body, booking_id) VALUES (?, ?, 'system', ?, ?)`)
    .run(booking.chef_id, booking.client_id, messageBody, booking.id);

  const notifyRole = role === 'chef' ? 'client' : 'chef';
  const notifyId = role === 'chef' ? booking.client_id : booking.chef_id;
  pushToUser(notifyRole, notifyId, { type: 'message', body: messageBody, senderRole: 'system', bookingId: booking.id, createdAt: new Date().toISOString() });

  res.json({ message: 'Booking updated.' });
});

// ---- GET /api/bookings/platform-fees (public) ----
// Lets the booking UI show clients the current commission/fee structure
// before they submit, without needing admin access.
router.get('/platform-fees', (req, res) => {
  res.json({
    commissionRate: Number(db.getSetting('commission_rate', '20')),
    clientFeeType: db.getSetting('client_fee_type', 'percent'),
    clientFeeValue: Number(db.getSetting('client_fee_value', '5')),
    currency: db.getSetting('currency', 'KES'),
  });
});

// ---- GET /api/bookings/chef/:chefId/dates ----
// Public: which dates are already pending/confirmed for a given approved
// chef, so a client's calendar can gray them out before they even try.
router.get('/chef/:chefId/dates', (req, res) => {
  const chef = db.prepare(`SELECT id FROM chefs WHERE id = ? AND status = 'approved'`).get(req.params.chefId);
  if (!chef) return res.status(404).json({ error: 'Chef not found.' });
  const rows = db.prepare(
    `SELECT event_date, status FROM bookings WHERE chef_id = ? AND status IN ('pending','confirmed')`
  ).all(req.params.chefId);
  res.json(rows.map(r => ({ date: r.event_date, status: r.status })));
});

// ---- PUT /api/bookings/:id/payment (admin only) ----
// Manual settlement tracking — since there's no live payment processor
// connected, the admin marks this by hand once money has actually changed
// hands off-platform (e.g. confirmed an M-Pesa transaction code from the
// client, then later confirmed they paid the chef their payout share).
// { paymentStatus: 'paid_to_platform' | 'released_to_chef' | 'refunded' | 'unpaid', reference }
router.put('/:id/payment', requireRole('admin'), (req, res) => {
  const { paymentStatus, reference } = req.body;
  const allowed = ['unpaid', 'paid_to_platform', 'released_to_chef', 'refunded'];
  if (!allowed.includes(paymentStatus)) {
    return res.status(400).json({ error: `paymentStatus must be one of: ${allowed.join(', ')}` });
  }

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const now = new Date().toISOString();
  const paidAt = paymentStatus === 'paid_to_platform' ? now : booking.paid_at;
  const releasedAt = paymentStatus === 'released_to_chef' ? now : booking.released_at;

  db.prepare(`
    UPDATE bookings
    SET payment_status = ?, payment_reference = ?, paid_at = ?, released_at = ?
    WHERE id = ?
  `).run(paymentStatus, reference || booking.payment_reference, paidAt, releasedAt, booking.id);

  res.json({ message: 'Payment status updated.' });
});

module.exports = router;
