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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // prefer the AI Studio key; otherwise use the Google Cloud API key (the one starting with AQ.)
  var key = process.env.GEMINI_API_KEY || process.env.GOOGLE_CLOUD_API_KEY;
  if (!key) { res.status(500).json({ error: 'نه GEMINI_API_KEY و نه GOOGLE_CLOUD_API_KEY تنظیم شده' }); return; }

  var body = req.body || {};
  var model = String(body.model || 'gemini-3.1-flash-image');
  var prompt = String(body.prompt || '').trim();
  if (ALLOWED.indexOf(model) === -1) { res.status(400).json({ error: 'مدل تصویر نامعتبر' }); return; }
  if (!prompt) { res.status(400).json({ error: 'توضیح تصویر خالی است' }); return; }
  if (prompt.length > 4000) { res.status(400).json({ error: 'توضیح تصویر خیلی بلند است' }); return; }

  try {
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
