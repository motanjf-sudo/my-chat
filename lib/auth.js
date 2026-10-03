import crypto from 'node:crypto';

// Signed-cookie login. The access code lives only in the ACCESS_CODE environment variable.
var COOKIE = 'chat_session';
var MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function secret() {
  var code = process.env.ACCESS_CODE || '';
  // changing ACCESS_CODE (or AUTH_SECRET) instantly logs everybody out
  return 'chat-auth-v1|' + (process.env.AUTH_SECRET || '') + '|' + code;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

function safeEqual(a, b) {
  var x = Buffer.from(String(a));
  var y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

export function accessConfigured() {
  return !!(process.env.ACCESS_CODE && process.env.ACCESS_CODE.length >= 1);
}

export function checkCode(code) {
  if (!accessConfigured()) return false;
  // compare hashes so length differences do not leak
  var a = crypto.createHash('sha256').update(String(code || '')).digest();
  var b = crypto.createHash('sha256').update(process.env.ACCESS_CODE).digest();
  return crypto.timingSafeEqual(a, b);
}

export function makeCookie() {
  var exp = String(Math.floor(Date.now() / 1000) + MAX_AGE);
  var value = exp + '.' + sign(exp);
  return COOKIE + '=' + value + '; Path=/; Max-Age=' + MAX_AGE + '; HttpOnly; Secure; SameSite=Strict';
}

export function clearCookie() {
  return COOKIE + '=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict';
}

export function isAuthed(req) {
  if (!accessConfigured()) return false; // fail closed
  var raw = (req.headers && req.headers.cookie) || '';
  var m = raw.split(';').map(function (s) { return s.trim(); }).filter(function (s) { return s.indexOf(COOKIE + '=') === 0; })[0];
  if (!m) return false;
  var val = m.slice(COOKIE.length + 1);
  var dot = val.indexOf('.');
  if (dot < 1) return false;
  var exp = val.slice(0, dot);
  var mac = val.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(mac, sign(exp));
}

// answers 401 and returns false when the request is not logged in
export function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(401).end(JSON.stringify({ error: 'unauthorized' }));
  return false;
}
