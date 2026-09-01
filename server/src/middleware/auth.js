const jwt = require('jsonwebtoken');

function sign(payload, expiresIn = '30d') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

function getToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  // Fallback for plain browser links (e.g. downloading a CV in a new tab),
  // which can't set an Authorization header. Only used for GET requests.
  if (req.method === 'GET' && req.query && req.query.token) return req.query.token;
  return null;
}

// Allows only requests carrying a valid token whose role is in `roles`.
function requireRole(...roles) {
  return (req, res, next) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Not logged in.' });
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (!roles.includes(payload.role)) {
        return res.status(403).json({ error: 'Not allowed.' });
      }
      req.user = payload;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
    }
  };
}

// Allows any logged-in chef or client (used by shared features like
// messaging and bookings, where either role can be the caller).
const requireAuth = requireRole('chef', 'client');

module.exports = { sign, requireRole, requireAuth };
