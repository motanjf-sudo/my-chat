import { requireAuth } from '../lib/auth.js';
import crypto from 'node:crypto';

export const config = { maxDuration: 300 };

// ===== helpers: convert our internal message format to each provider's shape =====
// internal content is either:
//   a string, OR
//   an array of parts: { type:'text', text } | { type:'image', mimeType, data(base64 no prefix) }

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(function (p) { return p && p.type === 'text'; })
      .map(function (p) { return p.text || ''; })
      .join('\n');
  }
  return '';
}

function toPerplexityMsg(m) {
  var role = m.role === 'assistant' ? 'assistant' : 'user';
  var content;
  if (Array.isArray(m.content)) {
    content = m.content.map(function (p) {
      if (p.type === 'image') {
        return { type: 'input_image', image_url: 'data:' + (p.mimeType || 'image/png') + ';base64,' + p.data };
      }
      return { type: 'input_text', text: String(p.text || '') };
    });
  } else {
    content = String(m.content || '');
  }
  return { type: 'message', role: role, content: content };
}

function toOpenAIMsg(m) {
  var role = m.role === 'assistant' ? 'assistant' : 'user';
  var content;
  if (Array.isArray(m.content)) {
    content = m.content.map(function (p) {
      if (p.type === 'image') {
        return { type: 'image_url', image_url: { url: 'data:' + (p.mimeType || 'image/png') + ';base64,' + p.data } };
      }
      return { type: 'text', text: String(p.text || '') };
    });
  } else {
    content = String(m.content || '');
  }
  return { role: role, content: content };
}

function toGeminiParts(content) {
  if (Array.isArray(content)) {
    return content.map(function (p) {
      if (p.type === 'image') {
        return { type: 'image', data: p.data, mime_type: p.mimeType || 'image/png' };
      }
      return { type: 'text', text: String(p.text || '') };
    });
  }
  return [{ type: 'text', text: String(content || '') }];
}


// ===== web search helpers =====
function sourcesMd(list) {
  var seen = {}, out = [];
  (list || []).forEach(function (s) {
    if (!s || !s.url || seen[s.url]) return;
    seen[s.url] = true;
    out.push((out.length + 1) + '. [' + String(s.title || s.url).replace(/[\[\]\n]/g, ' ').slice(0, 120) + '](' + s.url + ')');
  });
  return out.length ? '\n\n---\n**منابع:**\n' + out.join('\n') : '';
}

// Perplexity Search API: real web results that we hand to models that have no search of their own
async function pplxSearch(apiKey, query) {
  var r = await fetch('https://api.perplexity.ai/search', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: String(query).slice(0, 400), max_results: 5 })
  });
  if (!r.ok) {
    var t = await r.text().catch(function () { return ''; });
    throw new Error('Perplexity Search ' + r.status + (t ? ': ' + t.slice(0, 150) : ''));
  }
  var j = await r.json();
  return (j.results || []).map(function (x) {
    return { title: x.title || x.url, url: x.url, snippet: String(x.snippet || '').slice(0, 700) };
  });
}

function searchContextText(results) {
  var today = new Date().toISOString().slice(0, 10);
  return '\n\nنتایج جستجوی وب (تاریخ امروز ' + today + '). در صورت ربط داشتن از آن‌ها استفاده کن و با شماره‌ی [n] به منبع ارجاع بده:\n' +
    results.map(function (x, i) { return '[' + (i + 1) + '] ' + x.title + ' — ' + x.url + '\n' + x.snippet; }).join('\n\n');
}

// streams an OpenAI-compatible chat/completions endpoint; returns { sources } or null after sending an error
async function streamOpenAI(url, apiKey, payload, label, send, quiet) {
  var res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    var et = await res.text().catch(function () { return ''; });
    if (!quiet) send({ error: label + ' ' + res.status + (et ? ': ' + et.slice(0, 200) : '') });
    return null;
  }
  var reader = res.body.getReader();
  var dec = new TextDecoder();
  var buf = '';
  var sources = [];
  var finish = '';
  var text = '';
  while (true) {
    var chunk = await reader.read();
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    var lines = buf.split('\n');
    buf = lines.pop() || '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('data: ') !== 0) continue;
      var d = line.slice(6).trim();
      if (!d || d === '[DONE]') continue;
      try {
        var o = JSON.parse(d);
        var delta = o.choices && o.choices[0] && o.choices[0].delta;
        if (delta && delta.reasoning_content) send({ thinking: delta.reasoning_content });
        if (delta && delta.content) { text += delta.content; send({ delta: delta.content }); }
        if (o.choices && o.choices[0] && o.choices[0].finish_reason) finish = o.choices[0].finish_reason;
        if (Array.isArray(o.search_results)) {
          o.search_results.forEach(function (s) { if (s && s.url) sources.push({ title: s.title, url: s.url }); });
        } else if (Array.isArray(o.citations)) {
          o.citations.forEach(function (u) { if (typeof u === 'string') sources.push({ title: u, url: u }); });
        }
      } catch (e) {}
    }
  }
  return { sources: sources, finish: finish, text: text };
}

// ===== Google Cloud (Vertex AI): service-account JSON -> OAuth token, then streamGenerateContent =====
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
var gcpToken = { token: null, exp: 0 };
async function getGcpToken(sa) {
  var now = Math.floor(Date.now() / 1000);
  if (gcpToken.token && gcpToken.exp - 60 > now) return gcpToken.token;
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
  gcpToken = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return gcpToken.token;
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
function vertexStreamUrl(project, location, model) {
  var host = location === 'global' ? 'aiplatform.googleapis.com' : location + '-aiplatform.googleapis.com';
  return 'https://' + host + '/v1/projects/' + project + '/locations/' + location +
         '/publishers/google/models/' + model + ':streamGenerateContent?alt=sse';
}
function toVertexContents(messages) {
  return messages.map(function (m) {
    var parts;
    if (Array.isArray(m.content)) {
      parts = m.content.map(function (p) {
        if (p.type === 'image') return { inlineData: { mimeType: p.mimeType || 'image/png', data: p.data } };
        return { text: String(p.text || '') };
      });
    } else {
      parts = [{ text: String(m.content || '') }];
    }
    if (!parts.length) parts = [{ text: '' }];
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: parts };
  });
}
// streams a Gemini answer through Vertex AI (billed on the Google Cloud project)
async function streamVertexGemini(sa, model, messages, search, send, system) {
  var token = await getGcpToken(sa);
  var locations = process.env.GOOGLE_CLOUD_LOCATION ? [process.env.GOOGLE_CLOUD_LOCATION] : ['global', 'us-central1'];
  var reqObj = {
    contents: toVertexContents(messages),
    generationConfig: { thinkingConfig: { includeThoughts: true } }
  };
  if (system) { // code view: instructions + room for long programs
    reqObj.systemInstruction = { role: 'system', parts: [{ text: system }] };
    reqObj.generationConfig.maxOutputTokens = 32768;
  }
  if (search) reqObj.tools = [{ googleSearch: {} }]; // Grounding with Google Search
  var baseContents = reqObj.contents;
  var webSources = [];
  var produced = '';
  var MAX_ROUNDS = 7; // first answer + up to 6 automatic continuations

  for (var round = 0; round < MAX_ROUNDS; round++) {
    if (round > 0) {
      reqObj.contents = baseContents.concat([
        { role: 'model', parts: [{ text: produced }] },
        { role: 'user', parts: [{ text: 'Your previous message was cut off before it was finished. Continue EXACTLY from the last character you wrote: do not repeat anything, do not add any introduction or apology, and do not open a new code fence if you are already inside one. Finish the program completely and then close the code block with ``` .' }] }
      ]);
    }
    var reqBody = JSON.stringify(reqObj);
    var gRes = null, lastErr = '';
    for (var li = 0; li < locations.length; li++) {
      gRes = await fetch(vertexStreamUrl(sa.project_id, locations[li], model), {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: reqBody
      });
      if (gRes.ok) break;
      var t = await gRes.text().catch(function () { return ''; });
      lastErr = 'Vertex AI ' + gRes.status + ' (' + locations[li] + '): ' + t.slice(0, 300);
      if (gRes.status !== 404) break; // 404 = model not in this location -> try the next one
    }
    if (!gRes || !gRes.ok) {
      if (round === 0) { send({ error: lastErr }); return; }
      break; // a continuation failed: keep what we already streamed
    }

    var finish = '';
    var roundText = '';
    var reader = gRes.body.getReader();
    var dec = new TextDecoder();
    var buf = '';
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      var lines = buf.split('\n');
      buf = lines.pop() || '';
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('data: ') !== 0) continue;
        var d = line.slice(6).trim();
        if (!d || d === '[DONE]') continue;
        try {
          var o = JSON.parse(d);
          var cand = o.candidates && o.candidates[0];
          var fr = cand && (cand.finishReason || cand.finish_reason);
          if (fr) finish = fr;
          var gm = cand && (cand.groundingMetadata || cand.grounding_metadata);
          var gch = gm && (gm.groundingChunks || gm.grounding_chunks);
          if (gch) {
            for (var gj = 0; gj < gch.length; gj++) {
              if (gch[gj] && gch[gj].web && gch[gj].web.uri) webSources.push({ title: gch[gj].web.title || gch[gj].web.uri, url: gch[gj].web.uri });
            }
          }
          var parts = cand && cand.content && cand.content.parts;
          if (parts) {
            for (var k = 0; k < parts.length; k++) {
              if (typeof parts[k].text !== 'string' || !parts[k].text) continue;
              if (parts[k].thought) send({ thinking: parts[k].text });
              else { roundText += parts[k].text; send({ delta: parts[k].text }); }
            }
          }
        } catch (e) {}
      }
    }
    produced += roundText;

    // continue when the model hit its output limit, or (code view) stopped with an unfinished code block
    var cutOff = finish === 'MAX_TOKENS';
    var openFence = !!system && ((produced.match(/```/g) || []).length % 2 === 1);
    if (!roundText || !(cutOff || openFence)) break;
  }
  var srcMd = search ? sourcesMd(webSources) : '';
  if (srcMd) send({ delta: srcMd });
  send({ done: true });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (!requireAuth(req, res)) return;

  var PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
  var DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
  var GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

  var body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }

  var model = body.model || 'deepseek-flash';
  var messages = body.messages || [];
  var search = body.search || false;
  // custom assistants send their own instructions as `persona`; every provider path reads it through body.system
  var personaText = (typeof body.persona === 'string') ? body.persona.trim().slice(0, 4000) : '';
  if (personaText && !(typeof body.system === 'string' && body.system.trim())) body.system = personaText;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  function send(obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }

  // ===== PERPLEXITY AGENT API =====
  if (model.startsWith('pplx:')) {
    var pplxModel = model.slice(5); // e.g. "sonar", "openai/gpt-4.1", "__preset__fast"

    // code view sends its own instructions. They are put in front of the first user message
    // (the separate "instructions" field made some models answer nothing)
    var pplxMessages = messages;
    var pplxSys = (typeof body.systemShort === 'string' && body.systemShort.trim()) ? body.systemShort.slice(0, 1500) : ((typeof body.system === 'string' && body.system.trim()) ? body.system.slice(0, 4000) : '');
    if (pplxSys && messages.length && messages[0].role !== 'assistant') {
      var intro = 'Follow these instructions for the whole conversation:\n' + pplxSys + '\n\n---\nUser request:\n';
      var first = messages[0];
      var firstNew = Array.isArray(first.content)
        ? { role: first.role, content: [{ type: 'text', text: intro }].concat(first.content) }
        : { role: first.role, content: intro + String(first.content || '') };
      pplxMessages = [firstNew].concat(messages.slice(1));
    }
    var inputArr = pplxMessages.map(toPerplexityMsg);
    var lastInput = extractText((pplxMessages[pplxMessages.length - 1] || {}).content);

    // only the headers the official docs require. The old fake browser headers
    // (User-Agent/Origin/Referer/sec-*) were removed; see git history to restore.
    var chromeH = {
      'Authorization': 'Bearer ' + PERPLEXITY_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    };

    var stage = '', stalled = false, stallTimer = null, hb = null, gotText = false;
    try {
      // build request body
      var pplxBody;
      var tools = search ? [{ type: 'web_search' }] : undefined;

      if (pplxModel.startsWith('__preset__')) {
        var preset = pplxModel.slice(10);
        pplxBody = { preset: preset, input: inputArr, stream: true };
        if (tools) pplxBody.tools = tools;
      } else if (pplxModel.startsWith('anthropic/')) {
        pplxBody = { model: pplxModel, input: inputArr, stream: true, max_output_tokens: (typeof body.system === 'string' && body.system) ? 32000 : 8192 };
        if (tools) pplxBody.tools = tools;
      } else {
        pplxBody = { model: pplxModel, input: inputArr, stream: true };
        if (tools) pplxBody.tools = tools;
      }

      // GLM Flash "thinks" silently for minutes on bigger tasks (nothing is streamed, it looks frozen).
      // Measured: a calculator took 7 s with low reasoning effort and never finished without it.
      if (/glm-[0-9.]+-flash/.test(pplxModel)) pplxBody.reasoning = { effort: 'low' };

      stage = 'waiting for response headers';
      var t0 = Date.now();
      var ac = new AbortController();
      // big prompts make the model think silently for minutes: wait up to 240 s without data (the function limit is 300 s)
      var STALL_MS = 240000;
      stallTimer = setTimeout(function () { stalled = true; ac.abort(); }, STALL_MS);
      function bump() { clearTimeout(stallTimer); stallTimer = setTimeout(function () { stalled = true; ac.abort(); }, STALL_MS); }
      // while nothing is written yet, tell the page every few seconds that the model is still working
      hb = setInterval(function () {
        if (gotText || res.writableEnded || res.destroyed) { clearInterval(hb); return; }
        try { send({ thinking: '.' }); } catch (e) { clearInterval(hb); }
      }, 6000);
      var pRes = await fetch('https://api.perplexity.ai/v1/agent', {
        method: 'POST',
        headers: chromeH,
        body: JSON.stringify(pplxBody),
        signal: ac.signal
      });
      stage = 'headers received (' + pRes.status + ') after ' + Math.round((Date.now() - t0) / 1000) + 's, waiting for events';
      bump();

      // fallback: if structured input failed, try plain string (no images in this path)
      // 1st fallback: the API did not accept the reasoning option -> same request without it
      if (!pRes.ok && pRes.status === 400 && pplxBody.reasoning) {
        delete pplxBody.reasoning;
        pRes = await fetch('https://api.perplexity.ai/v1/agent', {
          method: 'POST', headers: chromeH, body: JSON.stringify(pplxBody), signal: ac.signal
        });
        bump();
      }
      if (!pRes.ok && pRes.status === 400) {
        var fb = Object.assign({}, pplxBody, { input: lastInput });
        pRes = await fetch('https://api.perplexity.ai/v1/agent', {
          method: 'POST', headers: chromeH, body: JSON.stringify(fb), signal: ac.signal
        });
        bump();
      }

      if (!pRes.ok) {
        var errTxt = await pRes.text().catch(function () { return ''; });
        send({ error: 'Perplexity ' + pRes.status + ': ' + errTxt.slice(0, 200) });
        res.end();
        return;
      }

      var reader = pRes.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      var pplxFail = '', seenTypes = {};
      // text of a finished response (used when no streaming deltas arrived)
      function finalText(resp) {
        var out = '';
        var items = (resp && resp.output) || [];
        for (var a = 0; a < items.length; a++) {
          var cs = items[a] && items[a].content;
          if (!Array.isArray(cs)) continue;
          for (var b = 0; b < cs.length; b++) if (cs[b] && typeof cs[b].text === 'string') out += cs[b].text;
        }
        return out || (resp && typeof resp.output_text === 'string' ? resp.output_text : '');
      }
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        bump();
        stage = 'streaming';
        buf += dec.decode(chunk.value, { stream: true });
        var lines = buf.split('\n');
        buf = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf('data: ') !== 0) continue;
          var d = line.slice(6).trim();
          if (!d || d === '[DONE]') continue;
          try {
            var obj = JSON.parse(d);
            if (obj.type) seenTypes[obj.type] = true;
            // typed SSE events from Agent API
            if (obj.type === 'response.output_text.delta' && obj.delta) {
              gotText = true;
              send({ delta: obj.delta });
            } else if ((obj.type === 'response.reasoning.delta' || obj.type === 'response.reasoning_text.delta' || obj.type === 'response.reasoning_summary_text.delta') && obj.delta) {
              send({ thinking: obj.delta });
            } else if (obj.type === 'response.completed' && !gotText) {
              var ft = finalText(obj.response);
              if (ft) { gotText = true; send({ delta: ft }); }
            } else if (obj.type === 'response.failed' || obj.type === 'error') {
              var em = (obj.response && obj.response.error && obj.response.error.message) || (obj.error && (obj.error.message || obj.error)) || obj.message || '';
              pplxFail = String(em || 'خطای نامشخص').slice(0, 300);
            }
          } catch (e) {}
        }
      }
      clearTimeout(stallTimer); clearInterval(hb);
      if (pplxFail) { send({ error: 'Perplexity: ' + pplxFail }); res.end(); return; }
      if (!gotText) {
        send({ error: 'Perplexity پاسخی نداد (' + pplxModel + '). رویدادهای دریافتی: ' + (Object.keys(seenTypes).join(', ') || 'هیچ') });
        res.end();
        return;
      }
      send({ done: true });
      res.end();
      return;
    } catch (e) {
      try { clearTimeout(stallTimer); clearInterval(hb); } catch (x) {}
      console.error('pplx error', pplxModel, stage, e && e.message);
      send({ error: stalled
        ? 'Perplexity بعد از ۴ دقیقه هیچ داده‌ای نفرستاد (مدل ' + pplxModel + '، مرحله: ' + stage + '). مدل دیگه‌ای انتخاب کن.'
        : 'Perplexity: ' + (e && e.message ? e.message : 'خطای ناشناخته') });
      res.end();
      return;
    }
  }

  // ===== GEMINI (DIRECT GOOGLE API) =====
  if (model.startsWith('gemini:')) {
    var geminiModel = model.slice(7); // e.g. "gemini-3.8-flash"

    // preferred: Google Cloud (Vertex AI) with the service-account JSON
    try {
      var gSA = loadServiceAccount();
      if (gSA) {
        await streamVertexGemini(gSA, geminiModel, messages, !!search, send, (typeof body.system === 'string' && body.system.trim()) ? body.system.slice(0, 6000) : '');
        res.end();
        return;
      }
    } catch (e) {
      send({ error: 'Gemini (Google Cloud): ' + (e && e.message ? e.message : 'خطای ناشناخته') });
      res.end();
      return;
    }

    // fallback: Gemini API with an API key
    if (!GEMINI_API_KEY) {
      send({ error: 'نه GOOGLE_SERVICE_ACCOUNT_JSON و نه GEMINI_API_KEY تنظیم شده' });
      res.end();
      return;
    }

    try {
      // flatten prior turns into plain text context (Interactions API's `input`
      // is a single-turn content array, not a full role-tagged history), then
      // attach the current turn's parts (including any image) as-is.
      var historyText = (typeof body.system === 'string' && body.system.trim()) ? 'Instructions: ' + body.system.slice(0, 6000) + '\n\n' : '';
      for (var gi = 0; gi < messages.length - 1; gi++) {
        var gm = messages[gi];
        var roleLabel = gm.role === 'assistant' ? 'Assistant' : 'User';
        historyText += roleLabel + ': ' + extractText(gm.content) + '\n\n';
      }
      var lastMsg = messages[messages.length - 1] || {};
      var lastParts = toGeminiParts(lastMsg.content);

      var geminiInput = [];
      if (historyText) geminiInput.push({ type: 'text', text: historyText.trim() + '\n\nUser:' });
      geminiInput = geminiInput.concat(lastParts);

      var gRes = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse', {
        method: 'POST',
        headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: geminiModel, input: geminiInput, stream: true })
      });

      if (!gRes.ok) {
        var gErrTxt = await gRes.text().catch(function () { return ''; });
        send({ error: 'Gemini ' + gRes.status + ': ' + gErrTxt.slice(0, 200) });
        res.end();
        return;
      }

      var gReader = gRes.body.getReader();
      var gDec = new TextDecoder();
      var gBuf = '';
      while (true) {
        var gChunk = await gReader.read();
        if (gChunk.done) break;
        gBuf += gDec.decode(gChunk.value, { stream: true });
        var gLines = gBuf.split('\n');
        gBuf = gLines.pop() || '';
        for (var gk = 0; gk < gLines.length; gk++) {
          var gLine = gLines[gk];
          if (gLine.indexOf('data: ') !== 0) continue;
          var gd = gLine.slice(6).trim();
          if (!gd || gd === '[DONE]') continue;
          try {
            var gObj = JSON.parse(gd);
            var evType = gObj.event_type || gObj.type;
            if (evType === 'step.delta' && gObj.delta) {
              if (gObj.delta.type === 'text' && gObj.delta.text) {
                send({ delta: gObj.delta.text });
              } else if (gObj.delta.type === 'thought_summary') {
                send({ thinking: gObj.delta.text || gObj.delta.summary || '' });
              }
            } else if (evType === 'error') {
              send({ error: String(gObj.message || gObj.error || 'Gemini error') });
            } else if (typeof gObj.text === 'string') {
              // best-effort fallback for a simpler delta shape
              send({ delta: gObj.text });
            }
          } catch (e) {}
        }
      }
      send({ done: true });
      res.end();
      return;
    } catch (e) {
      send({ error: 'Gemini: ' + (e && e.message ? e.message : 'خطای ناشناخته') });
      res.end();
      return;
    }
  }

  // ===== SONAR (Perplexity Sonar API: always searches the web) =====
  if (model.startsWith('sonar:')) {
    try {
      var sonarRes = await streamOpenAI('https://api.perplexity.ai/v1/sonar', PERPLEXITY_API_KEY,
        { model: model.slice(6), messages: ((typeof body.system === 'string' && body.system.trim()) ? [{ role: 'system', content: body.system.slice(0, 4000) }] : []).concat(messages.map(toOpenAIMsg)), stream: true }, 'Sonar', send);
      if (sonarRes) {
        var sMd = sourcesMd(sonarRes.sources);
        if (sMd) send({ delta: sMd });
        send({ done: true });
      }
    } catch (e) {
      send({ error: 'Sonar: ' + (e && e.message ? e.message : 'خطای ناشناخته') });
    }
    res.end();
    return;
  }

  // ===== DEEPSEEK: OpenAI-compatible; web search via Perplexity Search API =====
  try {
    var sys = { role: 'system', content: 'شما یک دستیار هوشمند و دقیق هستید. همیشه به زبان فارسی توضیح بده ولی کدها رو به انگلیسی بنویس.' };
    // the Code page sends its own instructions (language, output format)
    if (typeof body.system === 'string' && body.system.trim()) sys.content = body.system.slice(0, 6000);
    var sources = [];
    if (search) {
      if (!PERPLEXITY_API_KEY) {
        send({ delta: '⚠️ سرچ کار نکرد: PERPLEXITY_API_KEY تنظیم نشده.\n\n' });
      } else {
        try {
          var found = await pplxSearch(PERPLEXITY_API_KEY, extractText((messages[messages.length - 1] || {}).content));
          if (found.length) { sys.content += searchContextText(found); sources = found; }
        } catch (se) {
          send({ delta: '⚠️ سرچ کار نکرد (' + (se && se.message ? se.message : 'خطا') + ')\n\n' });
        }
      }
    }
    var msgs = [sys].concat(messages.map(toOpenAIMsg));

    var url = 'https://api.deepseek.com/chat/completions';
    var key = DEEPSEEK_API_KEY;
    var label = 'DeepSeek';
    var payload = { model: model, messages: msgs, stream: true, max_tokens: model === 'deepseek-chat' ? 8192 : 16384 };
    // V4 models think by default and reasoning eats the token budget; the code view asks for no thinking
    if (body.think === false && (model === 'deepseek-flash' || model === 'deepseek-v4-pro')) payload.thinking = { type: 'disabled' }; // deepseek-chat (V3) allows at most 8192

    var oaRes = await streamOpenAI(url, key, payload, label, send);
    // the model stopped because of the token cap (long code, long answers): keep going automatically
    var produced = oaRes ? oaRes.text : '';
    for (var round = 0; oaRes && oaRes.finish === 'length' && produced && round < 6; round++) {
      var base = msgs.slice();
      var next = await streamOpenAI('https://api.deepseek.com/beta/chat/completions', key,
        { model: model, messages: base.concat([{ role: 'assistant', content: produced, prefix: true }]), stream: true, max_tokens: payload.max_tokens },
        label, send, true);
      if (!next) {
        // prefix mode unavailable: ask the model to carry on instead
        next = await streamOpenAI(url, key,
          { model: model, messages: base.concat([{ role: 'assistant', content: produced }, { role: 'user', content: 'Your previous message was cut off by the length limit. Continue EXACTLY from the last character you wrote. Do not repeat anything, do not add any intro, and do not start a new code fence unless you were outside one.' }]), stream: true, max_tokens: payload.max_tokens },
          label, send);
        if (!next) { oaRes = null; break; }
      }
      produced += next.text;
      oaRes.finish = next.finish;
    }
    if (oaRes) {
      var srcMd = sourcesMd(sources);
      if (srcMd) send({ delta: srcMd });
      send({ done: true });
    }
    res.end();
  } catch (e) {
    send({ error: 'مدل: ' + (e && e.message ? e.message : 'خطای ناشناخته') });
    res.end();
  }
}
