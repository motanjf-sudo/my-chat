import { accessConfigured, checkCode, makeCookie, clearCookie, isAuthed } from '../lib/auth.js';

// best-effort brute-force brake (memory of one warm server instance)
var fails = {};
var LIMIT = 5, LOCK_MS = 10 * 60 * 1000;

function ipOf(req) {
  var f = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return f || (req.socket && req.socket.remoteAddress) || 'x';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'GET') {
    res.status(200).end(JSON.stringify({ ok: isAuthed(req), configured: accessConfigured() }));
    return;
  }
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookie());
    res.status(200).end(JSON.stringify({ ok: false }));
    return;
  }
  if (req.method !== 'POST') { res.status(405).end(JSON.stringify({ error: 'method' })); return; }

  if (!accessConfigured()) {
    res.status(503).end(JSON.stringify({ error: 'not_configured' }));
    return;
  }

  var ip = ipOf(req);
  var rec = fails[ip] || { n: 0, until: 0 };
  var now = Date.now();
  if (rec.until > now) {
    res.status(429).end(JSON.stringify({ error: 'locked', wait: Math.ceil((rec.until - now) / 1000) }));
    return;
  }

  var body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

  if (checkCode(body.code)) {
    delete fails[ip];
    res.setHeader('Set-Cookie', makeCookie());
    res.status(200).end(JSON.stringify({ ok: true }));
    return;
  }

  rec.n += 1;
  if (rec.n >= LIMIT) { rec.n = 0; rec.until = now + LOCK_MS; }
  fails[ip] = rec;
  await new Promise(function (r) { setTimeout(r, 800); }); // slow down guessing
  res.status(401).end(JSON.stringify({ error: 'wrong' }));
}
