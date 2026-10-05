import { requireAuth } from '../lib/auth.js';

// Diagnostic page for the Perplexity Agent API (login required).
//   /api/pplx-test?model=perplexity/glm-5.3-flash&mode=chat&prompt=hello&limit=60   one request, full report
//   /api/pplx-test?mode=matrix                                                       several variants at the same time
export const config = { maxDuration: 300 };

var CODE_INTRO = 'Follow these instructions for the whole conversation:\n' +
  'You write code in HTML. Reply format: line 1 exactly "TITLE: <1-3 word English name>", then one short Persian sentence, then ONE fenced code block (```html) with the COMPLETE working program (no placeholders), then nothing else.\n' +
  'The code must be bug-free: no syntax or runtime errors.\n\n---\nUser request:\n';

// sends one streaming request and reports what came back and when
async function runOne(key, spec, limitSec) {
  var t0 = Date.now();
  var sec = function () { return Math.round((Date.now() - t0) / 100) / 10; };
  var rep = { model: spec.model, prompt: spec.prompt, extra: spec.extra || null, status: null, headersAt: null, firstEventAt: null, firstTextAt: null, endedAt: null, outcome: '', events: {}, textLength: 0, textStart: '', note: '' };
  var ac = new AbortController();
  var timer = setTimeout(function () { rep.outcome = 'no answer yet after ' + limitSec + 's (stopped by the test)'; ac.abort(); }, limitSec * 1000);
  try {
    var body = { model: spec.model, input: [{ type: 'message', role: 'user', content: (spec.intro || '') + spec.prompt }], stream: true };
    if (spec.extra) Object.keys(spec.extra).forEach(function (k) { body[k] = spec.extra[k]; });
    var r = await fetch('https://api.perplexity.ai/v1/agent', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    rep.headersAt = sec(); rep.status = r.status;
    if (!r.ok) { rep.outcome = 'HTTP error'; rep.note = (await r.text().catch(function () { return ''; })).slice(0, 400); }
    else {
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '', text = '';
      while (true) {
        var c = await reader.read();
        if (c.done) { if (!rep.outcome) rep.outcome = 'finished normally'; break; }
        buf += dec.decode(c.value, { stream: true });
        var lines = buf.split('\n'); buf = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].indexOf('data: ') !== 0) continue;
          var d = lines[i].slice(6).trim(); if (!d || d === '[DONE]') continue;
          try {
            var o = JSON.parse(d);
            if (rep.firstEventAt === null) rep.firstEventAt = sec();
            var t = o.type || '(no type)';
            if (!rep.events[t]) rep.events[t] = { count: 0, firstAt: sec() };
            rep.events[t].count++;
            if (t === 'response.output_text.delta' && o.delta) { if (rep.firstTextAt === null) rep.firstTextAt = sec(); text += o.delta; }
            if ((t === 'response.failed' || t === 'error') && !rep.note) rep.note = JSON.stringify(o).slice(0, 400);
          } catch (e) {}
        }
      }
      rep.textLength = text.length; rep.textStart = text.slice(0, 120);
    }
  } catch (e) {
    if (!rep.outcome) rep.outcome = 'error: ' + (e && e.message ? e.message : e);
  }
  clearTimeout(timer);
  rep.endedAt = sec();
  return rep;
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  var url = new URL(req.url, 'http://x');
  var get = function (k, d) { var v = (req.query && req.query[k]) || url.searchParams.get(k); return v == null || v === '' ? d : String(v); };
  var mode = get('mode', 'chat');
  var key = process.env.PERPLEXITY_API_KEY || '';
  if (!key) { res.status(200).end(JSON.stringify({ error: 'PERPLEXITY_API_KEY is not set' }, null, 2)); return; }

  if (mode === 'matrix') {
    var limit = Math.min(240, Math.max(10, Number(get('limit', 150))));
    var FLASH = 'perplexity/glm-5.3-flash';
    var CALC = 'Build an HTML calculator';
    var specs = [
      { id: 'A flash: easy question', model: FLASH, prompt: 'What is 17*23? Answer in one sentence.' },
      { id: 'B flash: tiny code', model: FLASH, prompt: 'Write a JavaScript function add(a,b). Code only.' },
      { id: 'C flash: calculator', model: FLASH, prompt: CALC },
      { id: 'D flash: calculator, low reasoning', model: FLASH, prompt: CALC, extra: { reasoning: { effort: 'low' } } },
      { id: 'E glm-5.3 (not flash): calculator', model: 'perplexity/glm-5.3', prompt: CALC },
      { id: 'F gpt-6-luna: calculator', model: 'openai/gpt-6-luna', prompt: CALC }
    ];
    var results = await Promise.all(specs.map(function (s) { return runOne(key, s, limit); }));
    var table = results.map(function (r, i) {
      return { test: specs[i].id, outcome: r.outcome, firstTextAfterSec: r.firstTextAt, totalSec: r.endedAt, chars: r.textLength, eventTypes: Object.keys(r.events).join(', '), note: r.note || undefined, start: r.textStart || undefined };
    });
    res.status(200).end(JSON.stringify({ mode: 'matrix', limitSeconds: limit, results: table }, null, 2));
    return;
  }

  var model = get('model', 'perplexity/glm-5.3-flash');
  var prompt = get('prompt', mode === 'code' ? 'Build an HTML calculator' : 'hello');
  var limitSec = Math.min(240, Math.max(5, Number(get('limit', 60))));
  var rep = await runOne(key, { model: model, prompt: prompt, intro: mode === 'code' ? CODE_INTRO : '' }, limitSec);
  rep.mode = mode; rep.limitSeconds = limitSec;
  res.status(200).end(JSON.stringify(rep, null, 2));
}
