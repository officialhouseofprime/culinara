// Messaging between chefs and clients.
//
// Two pieces work together:
//  1. REST endpoints (below) — send a message, fetch conversation history,
//     list a user's conversation threads. These always work, even if a
//     socket connection drops, and are what persists everything to the
//     database.
//  2. A WebSocket hub (attachMessagingSocket, wired up in server.js) — the
//     "real-time" part. When someone sends a message via the REST endpoint,
//     it's also pushed instantly over the socket to the other person if
//     they're online, so neither side has to refresh or poll to see it.
//
// A conversation is identified by the (chef_id, client_id) pair — there's
// exactly one thread between any given chef and client.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Populated by attachMessagingSocket() in server.js — maps `${role}:${id}`
// to the live WebSocket connection for that user, if they're online.
const liveConnections = new Map();

function connectionKey(role, id) {
  return `${role}:${id}`;
}

function pushToUser(role, id, payload) {
  const ws = liveConnections.get(connectionKey(role, id));
  if (ws && ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(payload));
  }
}

function counterpartRole(role) {
  return role === 'chef' ? 'client' : 'chef';
}

function chefName(id) {
  const row = db.prepare('SELECT full_name FROM chefs WHERE id = ?').get(id);
  return row ? row.full_name : 'A chef';
}
function clientName(id) {
  const row = db.prepare('SELECT full_name FROM clients WHERE id = ?').get(id);
  return row ? row.full_name : 'A client';
}

// ---- GET /api/messages/threads ----
// Every conversation the logged-in user is part of, most recent first,
// with a preview of the last message and an unread count.
router.get('/threads', requireAuth, (req, res) => {
  const { role, id } = req.user;
  const counterpartCol = role === 'chef' ? 'client_id' : 'chef_id';
  const selfCol = role === 'chef' ? 'chef_id' : 'client_id';

  const partnerIds = db.prepare(
    `SELECT DISTINCT ${counterpartCol} AS pid FROM messages WHERE ${selfCol} = ? ORDER BY pid`
  ).all(id).map(r => r.pid);

  const threads = partnerIds.map(pid => {
    const chefId = role === 'chef' ? id : pid;
    const clientId = role === 'chef' ? pid : id;

    const last = db.prepare(
      `SELECT body, sender_role, created_at FROM messages WHERE chef_id = ? AND client_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(chefId, clientId);

    const unread = db.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE chef_id = ? AND client_id = ? AND sender_role = ? AND read_at IS NULL`
    ).get(chefId, clientId, counterpartRole(role)).n;

    return {
      counterpartId: pid,
      counterpartName: role === 'chef' ? clientName(pid) : chefName(pid),
      lastMessage: last ? last.body : '',
      lastAt: last ? last.created_at : null,
      unread,
    };
  }).sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));

  res.json(threads);
});

// ---- GET /api/messages/thread/:counterpartId ----
// Full history with one specific counterpart, and marks their messages read.
router.get('/thread/:counterpartId', requireAuth, (req, res) => {
  const { role, id } = req.user;
  const counterpartId = Number(req.params.counterpartId);
  const chefId = role === 'chef' ? id : counterpartId;
  const clientId = role === 'chef' ? counterpartId : id;

  const rows = db.prepare(
    `SELECT id, sender_role, body, booking_id, created_at FROM messages WHERE chef_id = ? AND client_id = ? ORDER BY created_at ASC`
  ).all(chefId, clientId);

  db.prepare(
    `UPDATE messages SET read_at = datetime('now') WHERE chef_id = ? AND client_id = ? AND sender_role = ? AND read_at IS NULL`
  ).run(chefId, clientId, counterpartRole(role));

  res.json(rows);
});

// ---- POST /api/messages ----
// Send a message. { counterpartId, body }
router.post('/', requireAuth, (req, res) => {
  const { role, id } = req.user;
  const { counterpartId, body } = req.body;
  const text = (body || '').trim();
  if (!counterpartId || !text) return res.status(400).json({ error: 'Message body and recipient are required.' });
  if (text.length > 4000) return res.status(400).json({ error: 'Message is too long.' });

  const chefId = role === 'chef' ? id : Number(counterpartId);
  const clientId = role === 'chef' ? Number(counterpartId) : id;

  // Make sure both accounts actually exist before creating a thread.
  const chefExists = db.prepare('SELECT id FROM chefs WHERE id = ?').get(chefId);
  const clientExists = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!chefExists || !clientExists) return res.status(404).json({ error: 'That user does not exist.' });

  const info = db.prepare(
    `INSERT INTO messages (chef_id, client_id, sender_role, body) VALUES (?, ?, ?, ?)`
  ).run(chefId, clientId, role, text);

  const message = { id: info.lastInsertRowid, senderRole: role, body: text, createdAt: new Date().toISOString() };

  // Push live to the other side if they're connected right now.
  pushToUser(counterpartRole(role), Number(counterpartId), { type: 'message', from: id, ...message });

  res.status(201).json(message);
});

// ---- WebSocket hub ----
// Called once from server.js with the raw HTTP server to attach a
// WebSocket endpoint at /ws. Auth happens via a short-lived token passed
// as a query param (?token=...) since WebSocket handshakes can't carry
// custom Authorization headers from a browser.
function attachMessagingSocket(httpServer) {
  const { WebSocketServer } = require('ws');
  const jwt = require('jsonwebtoken');
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      ws.close(4001, 'Invalid or expired token');
      return;
    }

    const key = connectionKey(payload.role, payload.id);
    liveConnections.set(key, ws);

    ws.on('close', () => {
      if (liveConnections.get(key) === ws) liveConnections.delete(key);
    });
  });

  return wss;
}

module.exports = router;
module.exports.attachMessagingSocket = attachMessagingSocket;
module.exports.pushToUser = pushToUser;
