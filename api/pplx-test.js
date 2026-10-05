import { requireAuth } from '../lib/auth.js';

// Diagnostic page: sends one request to the Perplexity Agent API and reports what came back and when.
// Open it while logged in, e.g.  /api/pplx-test?model=perplexity/glm-5.3-flash&mode=chat
//   mode=chat  -> the plain message the normal chat sends
//   mode=code  -> the same message with the Code view's short instructions in front
export const config = { maxDuration: 120 };

var CODE_INTRO = 'Follow these instructions for the whole conversation:\n' +
  'You write code in HTML. Reply format: line 1 exactly "TITLE: <1-3 word English name>", then one short Persian sentence, then ONE fenced code block (```html) with the COMPLETE working program (no placeholders), then nothing else.\n' +
  'The code must be bug-free: no syntax or runtime errors.\n\n---\nUser request:\n';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  var q = req.query || {};
  var url = new URL(req.url, 'http://x');
  var model = String(q.model || url.searchParams.get('model') || 'perplexity/glm-5.3-flash');
  var mode = String(q.mode || url.searchParams.get('mode') || 'chat');
  var prompt = String(q.prompt || url.searchParams.get('prompt') || (mode === 'code' ? 'یک ماشین حساب بساز' : 'سلام'));
  var limitSec = Math.min(100, Math.max(5, Number(q.limit || url.searchParams.get('limit') || 60)));
  var key = process.env.PERPLEXITY_API_KEY || '';
  if (!key) { res.status(200).end(JSON.stringify({ error: 'PERPLEXITY_API_KEY is not set' }, null, 2)); return; }

  var content = (mode === 'code' ? CODE_INTRO : '') + prompt;
  var t0 = Date.now();
  var sec = function () { return Math.round((Date.now() - t0) / 100) / 10; };
  var report = { model: model, mode: mode, prompt: prompt, limitSeconds: limitSec, events: {}, firstEventAt: null, firstTextAt: null, headersAt: null, status: null, endedAt: null, outcome: '', textLength: 0, textStart: '', note: '' };

  var ac = new AbortController();
  var timer = setTimeout(function () { report.outcome = 'stopped by this test after ' + limitSec + 's (still running)'; ac.abort(); }, limitSec * 1000);
  try {
    var r = await fetch('https://api.perplexity.ai/v1/agent', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ model: model, input: [{ type: 'message', role: 'user', content: content }], stream: true }),
      signal: ac.signal
    });
    report.headersAt = sec(); report.status = r.status;
    if (!r.ok) { report.outcome = 'HTTP error'; report.note = (await r.text().catch(function () { return ''; })).slice(0, 400); }
    else {
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '', text = '';
      while (true) {
        var c = await reader.read();
        if (c.done) { if (!report.outcome) report.outcome = 'finished normally'; break; }
        buf += dec.decode(c.value, { stream: true });
        var lines = buf.split('\n'); buf = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].indexOf('data: ') !== 0) continue;
          var d = lines[i].slice(6).trim(); if (!d || d === '[DONE]') continue;
          try {
            var o = JSON.parse(d);
            if (report.firstEventAt === null) report.firstEventAt = sec();
            var t = o.type || '(no type)';
            if (!report.events[t]) report.events[t] = { count: 0, firstAt: sec() };
            report.events[t].count++;
            if (t === 'response.output_text.delta' && o.delta) { if (report.firstTextAt === null) report.firstTextAt = sec(); text += o.delta; }
            if ((t === 'response.failed' || t === 'error') && !report.note) report.note = JSON.stringify(o).slice(0, 400);
          } catch (e) {}
        }
      }
      report.textLength = text.length; report.textStart = text.slice(0, 300);
    }
  } catch (e) {
    if (!report.outcome) report.outcome = 'error: ' + (e && e.message ? e.message : e);
  }
  clearTimeout(timer);
  report.endedAt = sec();
  res.status(200).end(JSON.stringify(report, null, 2));
}
