// Rate limiting for CULINARA's API.
//
// This is what stands between the API and someone hammering it with a
// script — spamming signups, brute-forcing logins/passwords, or just
// hitting endpoints in a tight loop to run up load. Every limiter here is
// keyed by IP address and returns a plain JSON 429 response.
//
// Three tiers:
//   apiLimiter      - generous, applied to every /api/* request
//   authLimiter      - tight, applied to login/signup/apply/reset endpoints
//   adminLoginLimiter - tightest, applied only to the founder admin login
//
// All limits are configurable via .env so they can be tuned per-deployment
// without touching code.

const rateLimit = require('express-rate-limit');

function envInt(name, fallback) {
  const val = Number(process.env[name]);
  return Number.isFinite(val) && val > 0 ? val : fallback;
}

const jsonHandler = (req, res) => {
  res.status(429).json({
    error: 'Too many requests. Please slow down and try again shortly.',
  });
};

// General ceiling on every API call (protects against scripted abuse /
// scraping / accidental infinite-retry loops from the frontend).
const apiLimiter = rateLimit({
  windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60 * 1000), // 1 minute
  max: envInt('RATE_LIMIT_MAX', 120), // 120 req/min/IP across the whole API
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonHandler,
});

// Tighter limit for auth-sensitive endpoints: login, signup, apply,
// forgot/reset password. These are the endpoints someone would target to
// brute-force credentials or spam-create accounts, so the ceiling is much
// lower and the window longer.
const authLimiter = rateLimit({
  windowMs: envInt('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000), // 15 minutes
  max: envInt('AUTH_RATE_LIMIT_MAX', 10), // 10 attempts / 15 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  handler: jsonHandler,
});

// The single admin/founder account is the highest-value target in the
// system, so it gets its own, even stricter limiter independent of the
// general auth one.
const adminLoginLimiter = rateLimit({
  windowMs: envInt('ADMIN_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000), // 15 minutes
  max: envInt('ADMIN_RATE_LIMIT_MAX', 5), // 5 attempts / 15 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonHandler,
});

module.exports = { apiLimiter, authLimiter, adminLoginLimiter };
