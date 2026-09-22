export const config = { maxDuration: 300 };

export default async function handler(req, res) {
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

  function send(obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }

  if (model.startsWith('pplx:')) {
    var pplxModel = model.slice(5);
    var lastMsg = messages[messages.length-1] || {};
    var input = String(lastMsg.content || '');
    var inputArr = messages.map(function(m){
      return {role: m.role==='assistant'?'assistant':'user', content: String(m.content||'')};
    });
    var chromeH = {
      'Authorization': 'Bearer '+PERPLEXITY_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Origin': 'https://www.perplexity.ai',
      'Referer': 'https://www.perplexity.ai/',
      'sec-ch-ua': '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin'
    };
    var pRes = await fetch('https://api.perplexity.ai/v1/agent', {
      method:'POST', headers:chromeH,
      body:JSON.stringify({model:pplxModel, input:inputArr, stream:true})
    });
    if (!pRes.ok && pRes.status===400) {
      pRes = await fetch('https://api.perplexity.ai/v1/agent', {
        method:'POST', headers:chromeH,
        body:JSON.stringify({model:pplxModel, input:input, stream:true})
      });
    }
    if (!pRes.ok) { send({error:'Perplexity '+pRes.status}); res.end(); return; }

    var reader = pRes.body.getReader();
    var dec = new TextDecoder();
    var buf = '';
    while(true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, {stream:true});
      var lines = buf.split('\n');
      buf = lines.pop() || '';
      for (var i=0;i<lines.length;i++) {
        var line = lines[i];
        if (line.indexOf('data: ')!==0) continue;
        var d = line.slice(6).trim();
        if (!d||d==='[DONE]') continue;
        try {
          var obj = JSON.parse(d);
          if (obj.type==='response.output_text.delta'&&obj.delta) send({delta:obj.delta});
        } catch(e) {}
      }
    }
    send({done:true});
    res.end();
    return;
  }

  // DeepSeek با thinking
  var sys = {role:'system', content:'شما یک دستیار هوشمند و دقیق هستید. همیشه به زبان فارسی توضیح بده ولی کدها رو به انگلیسی بنویس.'};
  var msgs = [sys].concat(messages);
  var dsRes = await fetch('https://api.deepseek.com/chat/completions', {
    method:'POST',
    headers:{'Authorization':'Bearer '+DEEPSEEK_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({model:model, messages:msgs, stream:true, max_tokens:16384, reasoning_effort:'high'})
  });
  if (!dsRes.ok) { send({error:'DeepSeek '+dsRes.status}); res.end(); return; }

  var dsReader = dsRes.body.getReader();
  var dsDec = new TextDecoder();
  var dsBuf = '';
  while(true) {
    var dsChunk = await dsReader.read();
    if (dsChunk.done) break;
    dsBuf += dsDec.decode(dsChunk.value, {stream:true});
    var dsLines = dsBuf.split('\n');
    dsBuf = dsLines.pop() || '';
    for (var j=0;j<dsLines.length;j++) {
      var dsLine = dsLines[j];
      if (dsLine.indexOf('data: ')!==0) continue;
      var dsD = dsLine.slice(6).trim();
      if (!dsD||dsD==='[DONE]') continue;
      try {
        var dsObj = JSON.parse(dsD);
        var deltaObj = dsObj.choices&&dsObj.choices[0]&&dsObj.choices[0].delta;
        if (deltaObj&&deltaObj.reasoning_content) send({thinking:deltaObj.reasoning_content});
        if (deltaObj&&deltaObj.content) send({delta:deltaObj.content});
      } catch(e) {}
    }
  }
  send({done:true});
  res.end();
}
