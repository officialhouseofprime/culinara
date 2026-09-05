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
const db = require('./db');

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

app.set('trust proxy', 1);

// ---- Security headers ----
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

// ---- CORS ----
const allowedOrigins = (process.env.CORS_ORIGIN || process.env.SITE_URL || 'http://localhost:4000')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- Rate limiting ----
app.use('/api', apiLimiter);

// ---- API routes ----
app.use('/api/auth', authRoutes);
app.use('/api/chefs', chefRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/bookings', bookingsRoutes);

// ---- Public portfolio media ----
app.use('/uploads/media', express.static(path.join(db.uploadsDir, 'media'), {
  maxAge: '30d',
  immutable: true,
}));

// ---- Founder dashboard ----
const dashboardDir = path.join(__dirname, '..', 'public');
app.get(['/dashboard', '/dashboard/'], (req, res) => {
  res.sendFile(path.join(dashboardDir, 'dashboard.html'));
});
app.use('/dashboard', express.static(dashboardDir));

// ---- Frontend site ----
const frontendRoot = path.join(__dirname, '..', '..');
app.use(express.static(frontendRoot, {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---- SEO & Robots ----
app.get('/robots.txt', (req, res) => {
  res.status(200).header('Content-Type', 'text/plain');
  res.send(`User-agent: *\nAllow: /\nDisallow: /account.html\nDisallow: /api/\n\nSitemap: https://culinara-e3wq.onrender.com/sitemap.xml`);
});

// ---- 404s ----
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(frontendRoot, '404.html'));
});

// ---- Error handler ----
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'This origin is not allowed to access the API.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

const PORT = process.env.PORT || 4000;

const http = require('node:http');
const httpServer = http.createServer(app);
messagesRoutes.attachMessagingSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`\nCULINARA server running at http://localhost:${PORT}`);
  console.log(`  Site:      http://localhost:${PORT}/`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`  Realtime:  ws://localhost:${PORT}/ws\n`);
});