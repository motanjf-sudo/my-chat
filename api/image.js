import crypto from 'node:crypto';

export const config = { maxDuration: 120 };

// models the UI is allowed to ask for (anything else is rejected)
var ALLOWED = [
  'gemini-3.1-flash-lite-image',
  'gemini-3.1-flash-image',
  'gemini-3-pro-image',
  'gemini-2.5-flash-image'
];

// find the first { data, mime_type } that looks like an image, anywhere in the JSON reply
function findImage(node) {
  if (!node || typeof node !== 'object') return null;
  var data = node.data || node.bytesBase64Encoded;
  var mime = node.mime_type || node.mimeType;
  if (typeof data === 'string' && data.length > 200 && typeof mime === 'string' && mime.indexOf('image/') === 0) {
    return { data: data, mime: mime };
  }
  var keys = Object.keys(node);
  for (var i = 0; i < keys.length; i++) {
    var f = findImage(node[keys[i]]);
    if (f) return f;
  }
  return null;
}

function findText(node) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.text === 'string' && node.text) return node.text;
  var keys = Object.keys(node);
  for (var i = 0; i < keys.length; i++) {
    var t = findText(node[keys[i]]);
    if (t) return t;
  }
  return '';
}


// ===== Google Cloud (Vertex AI) auth: service-account JSON -> OAuth token =====
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
var cached = { token: null, exp: 0 };
async function getAccessToken(sa) {
  var now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.exp - 60 > now) return cached.token;
  var header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claim = b64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  var signer = crypto.createSign('RSA-SHA256');
  signer.update(header + '.' + claim);
  var sig = signer.sign(sa.private_key).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  var r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
          '&assertion=' + encodeURIComponent(header + '.' + claim + '.' + sig)
  });
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok || !j.access_token) throw new Error('توکن گوگل گرفته نشد: ' + (j.error_description || j.error || r.status));
  cached = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return cached.token;
}
function loadServiceAccount() {
  var raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  var sa;
  try { sa = JSON.parse(raw); } catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON یک JSON معتبر نیست'); }
  if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON کامل نیست');
  if (sa.private_key.indexOf('\\n') !== -1) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}

function vertexUrl(project, location, model) {
  var host = location === 'global' ? 'aiplatform.googleapis.com' : location + '-aiplatform.googleapis.com';
  return 'https://' + host + '/v1/projects/' + project + '/locations/' + location +
         '/publishers/google/models/' + model + ':generateContent';
}

// Vertex AI: billed through the Google Cloud project (no AI Studio prepay credits involved)
async function generateVertex(sa, model, prompt) {
  var token = await getAccessToken(sa);
  var locations = process.env.GOOGLE_CLOUD_LOCATION ? [process.env.GOOGLE_CLOUD_LOCATION] : ['global', 'us-central1'];
  var lastErr = '';
  for (var i = 0; i < locations.length; i++) {
    var r = await fetch(vertexUrl(sa.project_id, locations[i], model), {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      })
    });
    var raw = await r.text();
    if (r.ok) {
      var json;
      try { json = JSON.parse(raw); } catch (e) { throw new Error('پاسخ نامعتبر از Vertex AI'); }
      var found = findImage(json);
      if (found) return found;
      var note = findText(json);
      throw new Error('تصویری برنگشت' + (note ? ': ' + note.slice(0, 200) : ''));
    }
    lastErr = 'Vertex AI ' + r.status + ' (' + locations[i] + '): ' + raw.slice(0, 300);
    if (r.status !== 404) break; // 404 = model not in this location, try the next one; anything else is final
  }
  throw new Error(lastErr);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  var body = req.body || {};
  var model = String(body.model || 'gemini-3.1-flash-image');
  var prompt = String(body.prompt || '').trim();
  if (ALLOWED.indexOf(model) === -1) { res.status(400).json({ error: 'مدل تصویر نامعتبر' }); return; }
  if (!prompt) { res.status(400).json({ error: 'توضیح تصویر خالی است' }); return; }
  if (prompt.length > 4000) { res.status(400).json({ error: 'توضیح تصویر خیلی بلند است' }); return; }

  try {
    // 1) Google Cloud (Vertex AI) when the service-account JSON is set
    var sa = loadServiceAccount();
    if (sa) {
      var v = await generateVertex(sa, model, prompt);
      res.status(200).json({ image: v.data, mimeType: v.mime, model: model, via: 'vertex' });
      return;
    }

    // 2) otherwise the Gemini API with an API key
    var key = process.env.GEMINI_API_KEY || process.env.GOOGLE_CLOUD_API_KEY;
    if (!key) { res.status(500).json({ error: 'نه GOOGLE_SERVICE_ACCOUNT_JSON و نه GEMINI_API_KEY تنظیم شده' }); return; }
    var r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model, input: [{ type: 'text', text: prompt }] })
    });
    var raw = await r.text();
    if (!r.ok) { res.status(502).json({ error: 'Google ' + r.status + ': ' + raw.slice(0, 300) }); return; }

    var json;
    try { json = JSON.parse(raw); } catch (e) { res.status(502).json({ error: 'پاسخ نامعتبر از Google' }); return; }

    var img = (json.interaction && json.interaction.output_image) || json.output_image;
    var found = (img && img.data) ? { data: img.data, mime: img.mime_type || 'image/png' } : findImage(json);
    if (!found) {
      var note = findText(json);
      res.status(502).json({ error: 'تصویری برنگشت' + (note ? ': ' + note.slice(0, 200) : '') });
      return;
    }
    res.status(200).json({ image: found.data, mimeType: found.mime, model: model });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
