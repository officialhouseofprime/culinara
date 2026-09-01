// Database layer for CULINARA.
//
// Uses Node's built-in `node:sqlite` module — a real SQLite database file
// on disk, with zero extra native dependencies to install or compile.
// It's still marked "experimental" by Node, which just means the API could
// change in a future Node version; the data itself is a normal .db file
// you can open with any SQLite tool (e.g. "DB Browser for SQLite").
//
// If you'd rather use a hosted database (Postgres, MySQL, etc.) later,
// this is the only file you'd need to rewrite — every route talks to the
// database only through the functions exported here.

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// If DATA_DIR is set (e.g. pointed at a mounted persistent disk on Render/
// Railway/Fly), the database file and uploads both live under it, so a
// redeploy never wipes real data. Locally, it falls back to server/data
// exactly as before — nothing changes for local development.
const dataDir = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'data')
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'culinara.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Same DATA_DIR-aware logic for uploaded files (CVs, cover letters, chef
// portfolio media) — exported so every route that reads/writes uploads
// resolves the exact same path instead of each hardcoding its own.
const uploadsDir = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'uploads')
  : path.join(__dirname, '..', 'uploads');
['cv', 'cover-letters', 'media'].forEach(sub => {
  const dir = path.join(uploadsDir, sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
db.uploadsDir = uploadsDir; // convenience: db.uploadsDir alongside the db object below, since every route already imports `db`

db.exec(`
  CREATE TABLE IF NOT EXISTS chefs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name             TEXT NOT NULL,
    email                 TEXT NOT NULL UNIQUE,
    phone                 TEXT,
    chef_type             TEXT,
    why_join              TEXT,
    cv_path               TEXT,
    cover_letter_path     TEXT,
    password_hash         TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
    email_verified        INTEGER NOT NULL DEFAULT 0,
    verification_token    TEXT,
    reset_token           TEXT,
    reset_token_expires   INTEGER,
    created_at             TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clients (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name             TEXT NOT NULL,
    email                 TEXT NOT NULL UNIQUE,
    phone                 TEXT,
    occasion              TEXT,
    password_hash         TEXT NOT NULL,
    email_verified        INTEGER NOT NULL DEFAULT 0,
    verification_token    TEXT,
    reset_token           TEXT,
    reset_token_expires   INTEGER,
    created_at             TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chef_media (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chef_id     INTEGER NOT NULL REFERENCES chefs(id) ON DELETE CASCADE,
    media_type  TEXT NOT NULL,   -- 'photo' | 'video'
    file_path   TEXT NOT NULL,
    caption     TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chef_menu_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chef_id     INTEGER NOT NULL REFERENCES chefs(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    price       TEXT,           -- freeform, e.g. "$28/person"
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chef_id       INTEGER NOT NULL REFERENCES chefs(id) ON DELETE CASCADE,
    client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    event_date    TEXT NOT NULL,     -- YYYY-MM-DD
    note          TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | declined | cancelled
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chef_id         INTEGER NOT NULL REFERENCES chefs(id) ON DELETE CASCADE,
    client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    sender_role     TEXT NOT NULL,      -- 'chef' | 'client' | 'system'
    body            TEXT NOT NULL,
    booking_id      INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
    read_at         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Simple key/value store for platform-wide settings the admin can change
  -- from the dashboard without redeploying (commission rate, client fee,
  -- currency, etc).
  CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
  );
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_chefs_email ON chefs(email);');
db.exec('CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);');
db.exec('CREATE INDEX IF NOT EXISTS idx_chef_media_chef_id ON chef_media(chef_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_chefs_status_email_verified ON chefs(status, email_verified);');
db.exec('CREATE INDEX IF NOT EXISTS idx_menu_items_chef_id ON chef_menu_items(chef_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_bookings_chef_id ON bookings(chef_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_bookings_client_id ON bookings(client_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_bookings_chef_date ON bookings(chef_id, event_date);');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(chef_id, client_id, created_at);');

// ---- Migrations ----
// Lightweight, additive column migrations for databases created before a
// given field existed. Each is wrapped so re-running on a fresh (already
// up-to-date) database is a harmless no-op.
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumnIfMissing('chefs', 'price_note', 'TEXT'); // freeform rate, e.g. "$150/event" or "$40/hr"
addColumnIfMissing('chefs', 'interview_email_sent_at', 'TEXT');
// Payout/payment preference — STORAGE ONLY. No money actually moves through
// these fields yet; that needs a real PayPal/M-Pesa integration (API keys,
// a merchant account, webhook handling) wired in separately.
addColumnIfMissing('chefs', 'payment_method_type', 'TEXT');   // 'paypal' | 'mpesa'
addColumnIfMissing('chefs', 'payment_method_value', 'TEXT');  // PayPal email or M-Pesa phone number
addColumnIfMissing('clients', 'payment_method_type', 'TEXT');
addColumnIfMissing('clients', 'payment_method_value', 'TEXT');

// ---- Earnings / commission tracking on bookings ----
// These snapshot the commission rate and fee *at the time of booking*, so
// a later change to the platform-wide rate (via the settings table below)
// never retroactively changes an already-agreed booking's numbers.
addColumnIfMissing('bookings', 'agreed_amount', 'REAL');        // what the client and chef agreed the service costs, in KES
addColumnIfMissing('bookings', 'commission_rate', 'REAL');      // % snapshot, e.g. 20 for 20%
addColumnIfMissing('bookings', 'commission_amount', 'REAL');    // agreed_amount * commission_rate / 100
addColumnIfMissing('bookings', 'client_fee_amount', 'REAL');    // separate fee charged to the client at checkout
addColumnIfMissing('bookings', 'total_client_charge', 'REAL');  // agreed_amount + client_fee_amount
addColumnIfMissing('bookings', 'chef_payout_amount', 'REAL');   // agreed_amount - commission_amount
// Manual settlement tracking — there's no live payment processor wired in
// yet (no Stripe Connect / M-Pesa Daraja business account set up), so these
// are set by the admin from the dashboard as money changes hands off-platform.
addColumnIfMissing('bookings', 'payment_status', "TEXT NOT NULL DEFAULT 'unpaid'"); // unpaid | paid_to_platform | released_to_chef | refunded
addColumnIfMissing('bookings', 'payment_reference', 'TEXT');    // e.g. an M-Pesa transaction code, admin's note
addColumnIfMissing('bookings', 'paid_at', 'TEXT');
addColumnIfMissing('bookings', 'released_at', 'TEXT');

// Seed default platform settings (only if not already present, so an admin
// change is never overwritten by a restart).
function seedSettingIfMissing(key, value) {
  const exists = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
  if (!exists) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
}
seedSettingIfMissing('commission_rate', '20');       // % taken from the chef's agreed amount, 15-25 is the stated target range
seedSettingIfMissing('client_fee_type', 'percent');  // 'percent' | 'flat'
seedSettingIfMissing('client_fee_value', '5');       // 5% service fee charged to the client, or a flat KES amount if type is 'flat'
seedSettingIfMissing('currency', 'KES');

// Reads a numeric/string platform setting by key, with a fallback if
// somehow missing (defensive — seeding above should always cover this).
db.getSetting = function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
};

// Computes the full money breakdown for a booking given the agreed amount,
// using the CURRENT platform settings. Called once at booking-creation time
// and the result is stored (snapshotted) on the booking row, so later rate
// changes never retroactively alter an already-agreed booking.
db.calculateBookingFinancials = function calculateBookingFinancials(agreedAmount) {
  const commissionRate = Number(db.getSetting('commission_rate', '20'));
  const clientFeeType = db.getSetting('client_fee_type', 'percent');
  const clientFeeValue = Number(db.getSetting('client_fee_value', '5'));

  const commissionAmount = Math.round((agreedAmount * commissionRate) / 100 * 100) / 100;
  const clientFeeAmount = clientFeeType === 'percent'
    ? Math.round((agreedAmount * clientFeeValue) / 100 * 100) / 100
    : clientFeeValue;
  const totalClientCharge = Math.round((agreedAmount + clientFeeAmount) * 100) / 100;
  const chefPayoutAmount = Math.round((agreedAmount - commissionAmount) * 100) / 100;

  return {
    commissionRate,
    commissionAmount,
    clientFeeAmount,
    totalClientCharge,
    chefPayoutAmount,
  };
};

module.exports = db;
