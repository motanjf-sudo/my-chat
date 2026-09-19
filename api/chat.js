export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
  var DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

  var body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }

  var model = body.model || 'deepseek-flash';
  var messages = body.messages || [];

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (model.startsWith('pplx:')) {
    var pplxModel = model.slice(5);
    var lastMsg = messages[messages.length-1] || {};
    var input = String(lastMsg.content || '');
    var inputArr = messages.map(function(m) {
      return {role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '')};
    });
    var chromeHeaders = {
      'Authorization': 'Bearer ' + PERPLEXITY_API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Origin': 'https://www.perplexity.ai',
      'Referer': 'https://www.perplexity.ai/',
      'sec-ch-ua': '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin'
    };
    var pplxRes = await fetch('https://api.perplexity.ai/v1/agent', {
      method: 'POST', headers: chromeHeaders,
      body: JSON.stringify({model: pplxModel, input: inputArr})
    });
    if (!pplxRes.ok && pplxRes.status === 400) {
      pplxRes = await fetch('https://api.perplexity.ai/v1/agent', {
        method: 'POST', headers: chromeHeaders,
        body: JSON.stringify({model: pplxModel, input: input})
      });
    }
    if (!pplxRes.ok) {
      res.write('data: ' + JSON.stringify({error: 'Perplexity ' + pplxRes.status}) + '\n\n');
      res.end(); return;
    }
    var data = await pplxRes.json().catch(function(){return null;});
    var text = '';
    if (data && data.output) {
      for (var i=0; i<data.output.length; i++) {
        if (data.output[i].type === 'message') {
          var content = data.output[i].content || [];
          for (var j=0; j<content.length; j++) {
            if (content[j].type === 'output_text') text += content[j].text || '';
          }
        }
      }
    }
    if (!text) { res.write('data: ' + JSON.stringify({error: 'no text'}) + '\n\n'); res.end(); return; }
    res.write('data: ' + JSON.stringify({delta: text}) + '\n\n');
    res.write('data: ' + JSON.stringify({done: true}) + '\n\n');
    res.end();
    return;
  }

  // DeepSeek streaming
  var sys = {role: 'system', content: 'شما یک دستیار هوشمند و دقیق هستید. به زبان فارسی پاسخ دهید مگر اینکه کاربر زبان دیگری مشخص کرده باشد.'};
  var msgs = [sys].concat(messages);
  var dsRes = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {'Authorization': 'Bearer ' + DEEPSEEK_API_KEY, 'Content-Type': 'application/json'},
    body: JSON.stringify({model: model, messages: msgs, stream: true, max_tokens: 4096})
  });
  if (!dsRes.ok) { res.write('data: ' + JSON.stringify({error: 'DeepSeek ' + dsRes.status}) + '\n\n'); res.end(); return; }

  var reader = dsRes.body.getReader();
  var decoder = new TextDecoder();
  var buf = '';
  while (true) {
    var chunk = await reader.read();
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, {stream: true});
    var lines = buf.split('\n');
    buf = lines.pop() || '';
    for (var i=0; i<lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('data: ') !== 0) continue;
      var d = line.slice(6).trim();
      if (!d || d === '[DONE]') continue;
      try {
        var obj = JSON.parse(d);
        var delta = obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content;
        if (delta) res.write('data: ' + JSON.stringify({delta: delta}) + '\n\n');
      } catch(e) {}
    }
  }
  res.write('data: ' + JSON.stringify({done: true}) + '\n\n');
  res.end();
}
