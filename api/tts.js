import crypto from 'node:crypto';

export const config = { maxDuration: 120 };

var MODELS = [
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-tts',
  'gemini-2.5-flash-lite-preview-tts',
  'gemini-2.5-pro-tts'
];
var VOICES = ['Achernar','Achird','Algenib','Algieba','Alnilam','Aoede','Autonoe','Callirrhoe','Charon','Despina','Enceladus','Erinome','Fenrir','Gacrux','Iapetus','Kore','Laomedeia','Leda','Orus','Pulcherrima','Puck','Rasalgethi','Sadachbia','Sadaltager','Schedar','Sulafat','Umbriel','Vindemiatrix','Zephyr','Zubenelgenubi'];
var LANGS = ['fa-IR', 'en-US', 'ar-XA', 'tr-TR', 'de-DE', 'fr-FR', 'es-US'];

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// service-account JSON -> OAuth access token (no extra library needed)
var cached = { token: null, exp: 0 };
async function getAccessToken(sa) {
  var now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.exp - 60 > now) return cached.token;

  var header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
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
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON تنظیم نشده');
  var sa;
  try { sa = JSON.parse(raw); } catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON یک JSON معتبر نیست'); }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON کامل نیست (client_email / private_key)');
  // Vercel sometimes stores the key with literal \n
  if (sa.private_key.indexOf('\\n') !== -1) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  var body = req.body || {};
  var model = String(body.model || MODELS[0]);
  var voice = String(body.voice || 'Kore');
  var lang = String(body.lang || 'fa-IR');
  var text = String(body.text || '').trim();
  var style = String(body.style || '').trim();

  if (MODELS.indexOf(model) === -1) { res.status(400).json({ error: 'مدل صدا نامعتبر' }); return; }
  if (VOICES.indexOf(voice) === -1) { res.status(400).json({ error: 'صدا نامعتبر' }); return; }
  if (LANGS.indexOf(lang) === -1) { res.status(400).json({ error: 'زبان نامعتبر' }); return; }
  if (!text) { res.status(400).json({ error: 'متن خالی است' }); return; }
  if (Buffer.byteLength(text, 'utf8') > 4000) { res.status(400).json({ error: 'متن خیلی بلند است (حداکثر ۴۰۰۰ بایت، حدود ۲۰۰۰ حرف فارسی)' }); return; }

  try {
    var sa = loadServiceAccount();
    var token = await getAccessToken(sa);

    var input = { text: text };
    if (style) input.prompt = style.slice(0, 1000);

    var r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'x-goog-user-project': sa.project_id || '',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input: input,
        voice: { languageCode: lang, name: voice, model_name: model },
        audioConfig: { audioEncoding: 'MP3' }
      })
    });
    var raw = await r.text();
    if (!r.ok) { res.status(502).json({ error: 'Google ' + r.status + ': ' + raw.slice(0, 300) }); return; }
    var j;
    try { j = JSON.parse(raw); } catch (e) { res.status(502).json({ error: 'پاسخ نامعتبر از Google' }); return; }
    if (!j.audioContent) { res.status(502).json({ error: 'صدایی برنگشت' }); return; }
    res.status(200).json({ audio: j.audioContent, mimeType: 'audio/mpeg', model: model, voice: voice });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
