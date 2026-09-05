require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('node:path');

const authRoutes = require('./routes/auth');
const chefRoutes = require('./routes/chefs');
const clientRoutes = require('./routes/clients');
const adminRoutes = require('./routes/admin');
const messagesRoutes = require('./routes/messages');
const bookingsRoutes = require('./routes/bookings');
const { apiLimiter } = require('./middleware/rateLimiter');
const db = require('./db'); // importing this here (not just in routes) ensures the DATA_DIR-aware uploads folder exists before the static file server below tries to serve from it

if (!process.env.JWT_SECRET) {
  console.error('Missing JWT_SECRET in .env — copy .env.example to .env and set one before starting the server.');
  process.exit(1);
}

if (process.env.BREVO_API_KEY) {
  if (!process.env.BREVO_SENDER_EMAIL) {
    console.warn('\n⚠️  BREVO_API_KEY is set but BREVO_SENDER_EMAIL is missing — Brevo will reject every send with');
    console.warn('   "valid sender email required" until you set BREVO_SENDER_EMAIL to the exact address you');
    console.warn('   verified under Brevo\'s Senders & IPs page.\n');
  }
} else if (!process.env.SMTP_HOST) {
  console.warn('\n⚠️  No BREVO_API_KEY or SMTP_HOST set — CULINARA is running in EMAIL DEV MODE.');
  console.warn('   Verification, welcome, and reset emails will only be printed to this console,');
  console.warn('   they will NOT be delivered to real inboxes. Set BREVO_API_KEY + BREVO_SENDER_EMAIL');
  console.warn('   (recommended — works on free hosting tiers that block SMTP), or SMTP_HOST/SMTP_USER/');
  console.warn('   SMTP_PASS, in .env before going live.\n');
}

const app = express();

// Render (and most PaaS hosts) sit behind a reverse proxy, so every request
// arrives with an X-Forwarded-For header. Without telling Express to trust
// that proxy, express-rate-limit throws a ValidationError on every single
// request instead of correctly identifying each visitor's real IP — this
// setting fixes that. `1` means "trust exactly one hop" (the platform's own
// proxy), which is the correct, safe setting for Render/Railway/Fly/Heroku.
app.set('trust proxy', 1);

// ---- Security headers ----
// Sensible defaults (X-Frame-Options, X-Content-Type-Options, HSTS on HTTPS,
// a conservative CSP, etc). crossOriginResourcePolicy is relaxed to
// cross-origin so chef photos/videos under /uploads/media can still be
// embedded from the frontend origin.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false, // the static site loads Google Fonts + inline styles; enable/tune this once asset origins are finalized
}));

// ---- CORS ----
// Locked to the configured site origin(s) instead of allowing any origin.
// Set CORS_ORIGIN in .env to a comma-separated list for multiple origins
// (e.g. your production domain + a staging domain).
const allowedOrigins = (process.env.CORS_ORIGIN || process.env.SITE_URL || 'http://localhost:4000')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Allow same-origin / non-browser requests (no Origin header) through.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- Rate limiting ----
// Applied to every /api/* route as a baseline; individual auth-sensitive
// routes (login, signup, apply, admin login) layer a stricter limiter on
// top of this one — see middleware/rateLimiter.js.
app.use('/api', apiLimiter);

// ---- API routes ----
app.use('/api/auth', authRoutes);
app.use('/api/chefs', chefRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/bookings', bookingsRoutes);

// ---- Public portfolio media (photos/videos chefs post) ----
// Note: CVs and cover letters are intentionally NOT under this static folder —
// they're only reachable through the authenticated /api/admin/files route.
// maxAge sets a long browser cache lifetime: each uploaded file gets a fresh
// random UUID filename (see multer config above), so the URL itself changes
// whenever a chef replaces a photo — safe to cache aggressively since the
// same URL will only ever point at the same unchanging file.
app.use('/uploads/media', express.static(path.join(db.uploadsDir, 'media'), {
  maxAge: '30d',
  immutable: true,
}));

// ---- Founder dashboard (static admin UI) ----
// dashboard.html (not index.html) is the entry point, so /dashboard and
// /dashboard/ are pointed at it explicitly before falling back to the
// static folder for dashboard.css / dashboard.js.
const dashboardDir = path.join(__dirname, '..', 'public');
app.get(['/dashboard', '/dashboard/'], (req, res) => {
  res.sendFile(path.join(dashboardDir, 'dashboard.html'));
});
app.use('/dashboard', express.static(dashboardDir));

// ---- Frontend site (index.html, account.html, css/, js/) ----
// A short cache lifetime on the site's own CSS/JS (not the long one used
// for uploads above) — long enough to avoid re-downloading on every single
// page navigation within a visit, short enough that a code update (like
// this one) reaches visitors within an hour without needing cache-busting
// filenames.
const frontendRoot = path.join(__dirname, '..', '..');
app.use(express.static(frontendRoot, {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    // HTML pages themselves should never be cached — always fetch the
    // latest markup, only the CSS/JS/image assets they reference benefit
    // from the maxAge above.
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---- 404s ----
// API requests get a plain JSON 404 (no HTML page makes sense for a JSON
// client). Everything else falls back to the branded 404.html page.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(frontendRoot, '404.html'));
});

// ---- Error handler ----
// Catches thrown/forwarded errors (including the CORS rejection above) so
// they return a clean JSON response instead of leaking a stack trace.
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'This origin is not allowed to access the API.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

const PORT = process.env.PORT || 4000;

// Use a raw HTTP server (instead of app.listen shorthand) so the WebSocket
// hub for real-time messaging can attach to the same server on the /ws path.
const http = require('node:http');
const httpServer = http.createServer(app);
messagesRoutes.attachMessagingSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`\nCULINARA server running at http://localhost:${PORT}`);
  console.log(`  Site:      http://localhost:${PORT}/`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`  Realtime:  ws://localhost:${PORT}/ws\n`);
});
const express = require('express');
const app = express();

// Standard middleware
app.use(express.json());

// --- PLACE IT HERE (BEFORE FRONTEND/404 ROUTES) ---
app.get('/robots.txt', (req, res) => {
  res.status(200).header('Content-Type', 'text/plain');
  res.send(`User-agent: *\nAllow: /\nDisallow: /account.html\nDisallow: /api/\n\nSitemap: https://culinara-e3wq.onrender.com/sitemap.xml`);
});

// API Routes
app.use('/api', apiRoutes);

// Frontend static pages or catch-all 404 handler (MUST BE AT THE BOTTOM)
app.use((req, res) => {
  res.status(404).render('404'); // or res.sendFile(...)
});

app.listen(3000, () => console.log('Server running...'));
