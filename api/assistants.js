import crypto from 'node:crypto';
import { requireAuth } from '../lib/auth.js';

// Shared custom assistants, stored in Upstash Redis (REST API, no extra library).
// Vercel -> Storage -> Upstash Redis creates these variables automatically.
export const config = { maxDuration: 30 };

var KEY = 'assistants';
var MAX_ASSISTANTS = 300;
var MAX_NAME = 40;
var MAX_INSTR = 4000;

// models a custom assistant may use (company -> model); anything else is rejected
var ALLOWED = [
  'deepseek-flash', 'deepseek-chat',
  'gemini:gemini-3.8-flash', 'gemini:gemini-3.7-flash', 'gemini:gemini-3.1-pro-preview',
  'sonar:sonar', 'sonar:sonar-pro',
  'pplx:anthropic/claude-sonnet-5-5', 'pplx:anthropic/claude-opus-5-5', 'pplx:anthropic/claude-haiku-4-5', 'pplx:anthropic/claude-fable-5-1',
  'pplx:openai/gpt-6.1-sol', 'pplx:openai/gpt-6-luna', 'pplx:openai/gpt-5.6-terra', 'pplx:openai/gpt-5.5',
  'pplx:xai/grok-4.7',
  'pplx:perplexity/glm-5.3', 'pplx:perplexity/glm-5.3-flash'
];

function redisCfg() {
  var env = process.env;
  var url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '';
  var token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '';
  if (!(url && token)) {
    // a custom prefix was used when connecting the database (e.g. STORAGE_KV_REST_API_URL): find the pair by suffix
    var keys = Object.keys(env);
    for (var i = 0; i < keys.length && !(url && token); i++) {
      var m = keys[i].match(/^(.*?)(UPSTASH_REDIS_REST_URL|KV_REST_API_URL)$/);
      if (!m || !env[keys[i]]) continue;
      var tk = m[1] + (m[2] === 'KV_REST_API_URL' ? 'KV_REST_API_TOKEN' : 'UPSTASH_REDIS_REST_TOKEN');
      if (env[tk]) { url = env[keys[i]]; token = env[tk]; }
    }
  }
  return url && token ? { url: url.replace(/\/+$/, ''), token: token } : null;
}

async function redis(cfg, cmd) {
  var r = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok || j.error) throw new Error(j.error || ('Redis ' + r.status));
  return j.result;
}

// HGETALL answers a flat [field, value, ...] list (or an object, depending on the server)
function pairsToObject(res) {
  if (!res) return {};
  if (!Array.isArray(res)) return res;
  var o = {};
  for (var i = 0; i + 1 < res.length; i += 2) o[res[i]] = res[i + 1];
  return o;
}

function hashPw(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function pwOk(pw, rec) {
  try {
    var a = Buffer.from(hashPw(pw, rec.salt), 'hex');
    var b = Buffer.from(rec.pw, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

function clean(str, max) {
  // drop control characters except tab / newline, trim, cap the length
  return String(str == null ? '' : str).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function publicView(rec) {
  return { id: rec.id, name: rec.name, emoji: rec.emoji, model: rec.model, instruction: rec.instruction, createdAt: rec.createdAt, updatedAt: rec.updatedAt };
}

function validate(b) {
  var name = clean(b.name, MAX_NAME);
  var instruction = clean(b.instruction, MAX_INSTR);
  var emoji = clean(b.emoji, 8) || '🤖';
  var model = String(b.model || '');
  if (!name) return { error: 'اسم دستیار را وارد کن.' };
  if (!instruction) return { error: 'دستورالعمل را بنویس.' };
  if (ALLOWED.indexOf(model) === -1) return { error: 'این مدل مجاز نیست.' };
  return { name: name, instruction: instruction, emoji: emoji, model: model };
}

function reply(res, status, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  var cfg = redisCfg();
  if (!cfg) { reply(res, 200, { configured: false, items: [] }); return; }

  try {
    if (req.method === 'GET') {
      var all = pairsToObject(await redis(cfg, ['HGETALL', KEY]));
      var items = [];
      Object.keys(all).forEach(function (k) {
        try { items.push(publicView(JSON.parse(all[k]))); } catch (e) {}
      });
      items.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      reply(res, 200, { configured: true, items: items });
      return;
    }

    if (req.method !== 'POST') { reply(res, 405, { error: 'method' }); return; }

    var body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    var action = String(body.action || '');
    var now = Date.now();

    if (action === 'create') {
      var v = validate(body);
      if (v.error) { reply(res, 400, { error: v.error }); return; }
      var pw = String(body.password || '');
      if (pw.length < 4 || pw.length > 64) { reply(res, 400, { error: 'رمز ویرایش باید بین ۴ تا ۶۴ حرف باشد.' }); return; }
      var count = Number(await redis(cfg, ['HLEN', KEY])) || 0;
      if (count >= MAX_ASSISTANTS) { reply(res, 400, { error: 'تعداد دستیارها به سقف رسیده است.' }); return; }
      var salt = crypto.randomBytes(16).toString('hex');
      var rec = {
        id: crypto.randomBytes(6).toString('hex'),
        name: v.name, emoji: v.emoji, model: v.model, instruction: v.instruction,
        salt: salt, pw: hashPw(pw, salt), createdAt: now, updatedAt: now
      };
      await redis(cfg, ['HSET', KEY, rec.id, JSON.stringify(rec)]);
      reply(res, 200, { ok: true, item: publicView(rec) });
      return;
    }

    if (action === 'update' || action === 'delete') {
      var id = clean(body.id, 40);
      var raw = id ? await redis(cfg, ['HGET', KEY, id]) : null;
      if (!raw) { reply(res, 404, { error: 'این دستیار پیدا نشد.' }); return; }
      var old = JSON.parse(raw);
      if (!pwOk(body.password, old)) {
        await new Promise(function (r) { setTimeout(r, 700); }); // slow down password guessing
        reply(res, 403, { error: 'رمز ویرایش اشتباه است.' });
        return;
      }
      if (action === 'delete') {
        await redis(cfg, ['HDEL', KEY, id]);
        reply(res, 200, { ok: true });
        return;
      }
      var u = validate(body);
      if (u.error) { reply(res, 400, { error: u.error }); return; }
      old.name = u.name; old.emoji = u.emoji; old.model = u.model; old.instruction = u.instruction; old.updatedAt = now;
      await redis(cfg, ['HSET', KEY, id, JSON.stringify(old)]);
      reply(res, 200, { ok: true, item: publicView(old) });
      return;
    }

    reply(res, 400, { error: 'درخواست نامعتبر.' });
  } catch (e) {
    console.error('assistants error', e && e.message);
    reply(res, 500, { error: 'خطای ذخیره‌سازی: ' + (e && e.message ? e.message : 'نامشخص') });
  }
}
