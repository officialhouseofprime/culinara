const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { sendEmail, templates } = require('../mailer');
const { authLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// ---- File upload config ----
const docStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = file.fieldname === 'cv' ? 'cv' : 'cover-letters';
    cb(null, path.join(db.uploadsDir, dir));
  },
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`),
});
const uploadDocs = multer({
  storage: docStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = /pdf|msword|officedocument/.test(file.mimetype);
    cb(ok ? null : new Error('CV and cover letter must be a PDF or Word document.'), ok);
  },
});

const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(db.uploadsDir, 'media')),
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`),
});
const uploadMedia = multer({
  storage: mediaStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB (video)
  fileFilter: (req, file, cb) => {
    const ok = /^image\/|^video\//.test(file.mimetype);
    cb(ok ? null : new Error('Only image or video files are allowed.'), ok);
  },
});

// ---- POST /api/chefs/apply ----
// Rate-limited: account creation is a prime spam target.
router.post('/apply', authLimiter, uploadDocs.fields([{ name: 'cv', maxCount: 1 }, { name: 'coverLetter', maxCount: 1 }]), async (req, res) => {
  try {
    const { fullName, email, phone, chefType, why, password } = req.body;

    if (!fullName || !email || !why || !password) {
      return res.status(400).json({ error: 'Full name, email, your reason for joining, and a password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (!req.files || !req.files.cv || !req.files.coverLetter) {
      return res.status(400).json({ error: 'Please upload both a CV/résumé and a cover letter.' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existing = db.prepare('SELECT id FROM chefs WHERE email = ?').get(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: 'An application with this email already exists. Try logging in instead.' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const cvPath = path.join('cv', req.files.cv[0].filename);
    const coverPath = path.join('cover-letters', req.files.coverLetter[0].filename);

    const result = db.prepare(`
      INSERT INTO chefs (full_name, email, phone, chef_type, why_join, cv_path, cover_letter_path, password_hash, verification_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fullName, normalizedEmail, phone || null, chefType || null, why, cvPath, coverPath, passwordHash, verificationToken);

    const verifyLink = `${process.env.APP_URL || ''}/api/auth/verify?token=${verificationToken}&role=chef`;

    try {
      await sendEmail({ to: normalizedEmail, subject: 'Verify your email — CULINARA', html: templates.verifyEmail(fullName, verifyLink) });
      await sendEmail({ to: normalizedEmail, subject: 'We got your application — CULINARA', html: templates.chefApplicationReceived(fullName) });
    } catch (err) {
      console.error('[chefs/apply] email error:', err.message);
    }

    res.status(201).json({ message: 'Application received. Check your email to verify your address.', id: result.lastInsertRowid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong submitting your application.' });
  }
});

// ---- GET /api/chefs/me ----
router.get('/me', requireRole('chef'), (req, res) => {
  const row = db.prepare('SELECT id, full_name, email, phone, chef_type, why_join, price_note, payment_method_type, payment_method_value, status, email_verified, created_at FROM chefs WHERE id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'Profile not found.' });
  const media = db.prepare('SELECT id, media_type, file_path, caption, created_at FROM chef_media WHERE chef_id = ? ORDER BY created_at DESC').all(req.user.id);
  const menu = db.prepare('SELECT id, name, description, price FROM chef_menu_items WHERE chef_id = ? ORDER BY created_at ASC').all(req.user.id);
  res.json({ profile: toProfile(row), media: media.map(toMedia), menu });
});

// ---- PUT /api/chefs/me ----
router.put('/me', requireRole('chef'), (req, res) => {
  const { phone, chefType, priceNote, paymentMethodType, paymentMethodValue } = req.body;
  if (paymentMethodType && !['paypal', 'mpesa'].includes(paymentMethodType)) {
    return res.status(400).json({ error: 'Payment method must be paypal or mpesa.' });
  }
  db.prepare('UPDATE chefs SET phone = ?, chef_type = ?, price_note = ?, payment_method_type = ?, payment_method_value = ? WHERE id = ?')
    .run(phone || null, chefType || null, priceNote || null, paymentMethodType || null, paymentMethodValue || null, req.user.id);
  res.json({ message: 'Profile updated.' });
});

// ---- Menu items (chef's own — create/delete) ----
router.post('/me/menu', requireRole('chef'), (req, res) => {
  const { name, description, price } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Dish name is required.' });
  const info = db.prepare('INSERT INTO chef_menu_items (chef_id, name, description, price) VALUES (?, ?, ?, ?)')
    .run(req.user.id, name.trim(), (description || '').trim() || null, (price || '').trim() || null);
  res.status(201).json({ id: info.lastInsertRowid, name: name.trim(), description: description || null, price: price || null });
});

router.delete('/me/menu/:id', requireRole('chef'), (req, res) => {
  const row = db.prepare('SELECT * FROM chef_menu_items WHERE id = ? AND chef_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Menu item not found.' });
  db.prepare('DELETE FROM chef_menu_items WHERE id = ?').run(req.params.id);
  res.json({ message: 'Removed.' });
});

// ---- GET /api/chefs/:id/menu (public) ----
router.get('/:id/menu', (req, res) => {
  const chef = db.prepare(`SELECT id FROM chefs WHERE id = ? AND status = 'approved'`).get(req.params.id);
  if (!chef) return res.status(404).json({ error: 'Chef not found.' });
  const menu = db.prepare('SELECT id, name, description, price FROM chef_menu_items WHERE chef_id = ? ORDER BY created_at ASC').all(req.params.id);
  res.json(menu);
});

// ---- POST /api/chefs/me/media ----
// After a successful upload, photos are automatically compressed/resized
// server-side (sharp) before being stored — an unedited phone photo can be
// 5-8MB, which is slow to load on a chef's public listing; this brings it
// down to a web-appropriate size without a visible quality loss. Videos are
// stored as-is (video compression is a much heavier operation and out of
// scope here — keep uploaded videos reasonably short/compressed on the
// phone before posting, for now).
router.post('/me/media', requireRole('chef'), (req, res) => {
  uploadMedia.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'photo';
    let filePath = path.join('media', req.file.filename);
    const caption = req.body.caption || null;

    if (mediaType === 'photo') {
      try {
        const fullPath = path.join(db.uploadsDir, filePath);
        const beforeSize = fs.statSync(fullPath).size;
        // Resize to a max of 1600px on the long edge (plenty for any layout
        // this site uses) and re-encode at quality 80 — well past the point
        // of visible difference for a photo, but a large real-world size cut.
        const buffer = await sharp(fullPath)
          .rotate() // respects the phone's EXIF orientation instead of saving sideways
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80, mozjpeg: true })
          .toBuffer();
        const compressedFilename = req.file.filename.replace(/\.[^.]+$/, '.jpg');
        const compressedPath = path.join(db.uploadsDir, 'media', compressedFilename);
        fs.writeFileSync(compressedPath, buffer);
        if (compressedFilename !== req.file.filename) fs.unlinkSync(fullPath); // remove the original if the extension changed
        filePath = path.join('media', compressedFilename);
        console.log(`[media] compressed ${req.file.filename}: ${(beforeSize / 1024).toFixed(0)}KB -> ${(buffer.length / 1024).toFixed(0)}KB`);
      } catch (compressErr) {
        // If compression fails for any reason (corrupt file, unsupported
        // format), fall back to the original upload rather than losing it.
        console.error('[media] compression failed, keeping original:', compressErr.message);
      }
    }

    const result = db.prepare('INSERT INTO chef_media (chef_id, media_type, file_path, caption) VALUES (?, ?, ?, ?)')
      .run(req.user.id, mediaType, filePath, caption);

    res.status(201).json(toMedia({ id: result.lastInsertRowid, media_type: mediaType, file_path: filePath, caption }));
  });
});

// ---- DELETE /api/chefs/me/media/:id ----
router.delete('/me/media/:id', requireRole('chef'), (req, res) => {
  const row = db.prepare('SELECT * FROM chef_media WHERE id = ? AND chef_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Media not found.' });
  db.prepare('DELETE FROM chef_media WHERE id = ?').run(req.params.id);
  res.json({ message: 'Removed.' });
});

// ---- GET /api/chefs (public — approved chefs only) ----
// Supports ?q= (matches name or chef type) and ?type= (exact-ish chef type
// filter) so the client dashboard can search/filter the roster.
router.get('/', (req, res) => {
  const { q, type } = req.query;
  let sql = `SELECT id, full_name, chef_type, price_note, created_at FROM chefs WHERE status = 'approved' AND email_verified = 1`;
  const params = [];

  if (q) {
    sql += ` AND (full_name LIKE ? OR chef_type LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`);
  }
  if (type) {
    sql += ` AND chef_type LIKE ?`;
    params.push(`%${type}%`);
  }
  sql += ' ORDER BY created_at DESC';

  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(r => ({ id: r.id, fullName: r.full_name, chefType: r.chef_type, priceNote: r.price_note })));
});

router.get('/:id/media', (req, res) => {
  const chef = db.prepare(`SELECT id FROM chefs WHERE id = ? AND status = 'approved'`).get(req.params.id);
  if (!chef) return res.status(404).json({ error: 'Chef not found.' });
  const media = db.prepare('SELECT id, media_type, file_path, caption FROM chef_media WHERE chef_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json(media.map(toMedia));
});

// ---- GET /api/chefs/:id (public profile — one chef, for the client-facing detail view) ----
router.get('/:id', (req, res) => {
  const row = db.prepare(`SELECT id, full_name, chef_type, price_note FROM chefs WHERE id = ? AND status = 'approved' AND email_verified = 1`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chef not found.' });
  res.json({ id: row.id, fullName: row.full_name, chefType: row.chef_type, priceNote: row.price_note });
});

function toProfile(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    chefType: row.chef_type,
    whyJoin: row.why_join,
    priceNote: row.price_note,
    paymentMethodType: row.payment_method_type,
    paymentMethodValue: row.payment_method_value,
    status: row.status,
    emailVerified: !!row.email_verified,
    createdAt: row.created_at,
  };
}

function toMedia(row) {
  return {
    id: row.id,
    type: row.media_type,
    url: `/uploads/${row.file_path.replace(/\\/g, '/')}`,
    caption: row.caption,
  };
}

module.exports = router;
