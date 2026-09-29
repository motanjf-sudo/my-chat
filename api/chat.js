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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
  var DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
  var GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

  var body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }

  var model = body.model || 'deepseek-flash';
  var messages = body.messages || [];
  var search = body.search || false;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  function send(obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }

  // ===== PERPLEXITY AGENT API =====
  if (model.startsWith('pplx:')) {
    var pplxModel = model.slice(5); // e.g. "sonar", "openai/gpt-4.1", "__preset__fast"

    var inputArr = messages.map(toPerplexityMsg);
    var lastInput = extractText((messages[messages.length - 1] || {}).content);

    // only the headers the official docs require. The old fake browser headers
    // (User-Agent/Origin/Referer/sec-*) were removed; see git history to restore.
    var chromeH = {
      'Authorization': 'Bearer ' + PERPLEXITY_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    };

    try {
      // build request body
      var pplxBody;
      var tools = search ? [{ type: 'web_search' }] : undefined;

      if (pplxModel.startsWith('__preset__')) {
        var preset = pplxModel.slice(10);
        pplxBody = { preset: preset, input: inputArr, stream: true };
        if (tools) pplxBody.tools = tools;
      } else if (pplxModel.startsWith('anthropic/')) {
        pplxBody = { model: pplxModel, input: inputArr, stream: true, max_output_tokens: 8192 };
        if (tools) pplxBody.tools = tools;
      } else {
        pplxBody = { model: pplxModel, input: inputArr, stream: true };
        if (tools) pplxBody.tools = tools;
      }

      var pRes = await fetch('https://api.perplexity.ai/v1/agent', {
        method: 'POST',
        headers: chromeH,
        body: JSON.stringify(pplxBody)
      });

      // fallback: if structured input failed, try plain string (no images in this path)
      if (!pRes.ok && pRes.status === 400) {
        var fb = Object.assign({}, pplxBody, { input: lastInput });
        pRes = await fetch('https://api.perplexity.ai/v1/agent', {
          method: 'POST', headers: chromeH, body: JSON.stringify(fb)
        });
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
            var obj = JSON.parse(d);
            // typed SSE events from Agent API
            if (obj.type === 'response.output_text.delta' && obj.delta) {
              send({ delta: obj.delta });
            } else if (obj.type === 'response.reasoning.delta' && obj.delta) {
              send({ thinking: obj.delta });
            }
          } catch (e) {}
        }
      }
      send({ done: true });
      res.end();
      return;
    } catch (e) {
      send({ error: 'Perplexity: ' + (e && e.message ? e.message : 'خطای ناشناخته') });
      res.end();
      return;
    }
  }

  // ===== GEMINI (DIRECT GOOGLE API) =====
  if (model.startsWith('gemini:')) {
    var geminiModel = model.slice(7); // e.g. "gemini-3.8-flash"

    if (!GEMINI_API_KEY) {
      send({ error: 'GEMINI_API_KEY تنظیم نشده است' });
      res.end();
      return;
    }

    try {
      // flatten prior turns into plain text context (Interactions API's `input`
      // is a single-turn content array, not a full role-tagged history), then
      // attach the current turn's parts (including any image) as-is.
      var historyText = '';
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

  // ===== DEEPSEEK =====
  try {
    var sys = { role: 'system', content: 'شما یک دستیار هوشمند و دقیق هستید. همیشه به زبان فارسی توضیح بده ولی کدها رو به انگلیسی بنویس.' };
    var msgs = [sys].concat(messages.map(toOpenAIMsg));
    var dsRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model, messages: msgs, stream: true, max_tokens: 16384 })
    });
    if (!dsRes.ok) {
      var dsErrTxt = await dsRes.text().catch(function () { return ''; });
      send({ error: 'DeepSeek ' + dsRes.status + (dsErrTxt ? ': ' + dsErrTxt.slice(0, 200) : '') });
      res.end();
      return;
    }

    var dsReader = dsRes.body.getReader();
    var dsDec = new TextDecoder();
    var dsBuf = '';
    while (true) {
      var dsChunk = await dsReader.read();
      if (dsChunk.done) break;
      dsBuf += dsDec.decode(dsChunk.value, { stream: true });
      var dsLines = dsBuf.split('\n');
      dsBuf = dsLines.pop() || '';
      for (var j = 0; j < dsLines.length; j++) {
        var dsLine = dsLines[j];
        if (dsLine.indexOf('data: ') !== 0) continue;
        var dsD = dsLine.slice(6).trim();
        if (!dsD || dsD === '[DONE]') continue;
        try {
          var dsObj = JSON.parse(dsD);
          var deltaObj = dsObj.choices && dsObj.choices[0] && dsObj.choices[0].delta;
          if (deltaObj && deltaObj.reasoning_content) send({ thinking: deltaObj.reasoning_content });
          if (deltaObj && deltaObj.content) send({ delta: deltaObj.content });
        } catch (e) {}
      }
    }
    send({ done: true });
    res.end();
  } catch (e) {
    send({ error: 'DeepSeek: ' + (e && e.message ? e.message : 'خطای ناشناخته') });
    res.end();
  }
}
