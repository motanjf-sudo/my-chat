export const config = { runtime: 'edge', maxDuration: 60 };

var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, {headers: CORS});

  var PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
  var DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

  var body = await req.json().catch(function(){return {};});
  var model = body.model || 'deepseek-flash';
  var messages = body.messages || [];

  var h = {'Content-Type':'text/event-stream;charset=utf-8','Cache-Control':'no-cache'};
  for(var k in CORS) h[k] = CORS[k];

  // DeepSeek
  if (!model.startsWith('pplx:')) {
    var sys = {role:'system', content:'شما یک دستیار هوشمند و دقیق هستید. به زبان فارسی پاسخ دهید مگر اینکه کاربر زبان دیگری مشخص کرده باشد.'};
    var msgs = [sys].concat(messages);
    var dsRes = await fetch('https://api.deepseek.com/chat/completions', {
      method:'POST',
      headers:{'Authorization':'Bearer '+DEEPSEEK_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({model:model, messages:msgs, stream:true, max_tokens:16384})
    });
    if (!dsRes.ok) {
      return new Response('data: '+JSON.stringify({error:'DeepSeek '+dsRes.status})+'\n\n', {headers:h});
    }
    var reader = dsRes.body.getReader();
    var stream = new ReadableStream({
      start: async function(ctrl) {
        var dec = new TextDecoder();
        var enc = new TextEncoder();
        var buf = '';
        while(true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += dec.decode(chunk.value, {stream:true});
          var lines = buf.split('\n');
          buf = lines.pop() || '';
          for (var i=0;i<lines.length;i++) {
            var line = lines[i];
            if (line.indexOf('data: ') !== 0) continue;
            var d = line.slice(6).trim();
            if (!d || d === '[DONE]') continue;
            try {
              var obj = JSON.parse(d);
              var delta = obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content;
              if (delta) ctrl.enqueue(enc.encode('data: '+JSON.stringify({delta:delta})+'\n\n'));
            } catch(e) {}
          }
        }
        ctrl.enqueue(new TextEncoder().encode('data: '+JSON.stringify({done:true})+'\n\n'));
        ctrl.close();
      }
    });
    return new Response(stream, {headers:h});
  }

  // Perplexity
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
  if (!pRes.ok && pRes.status === 400) {
    pRes = await fetch('https://api.perplexity.ai/v1/agent', {
      method:'POST', headers:chromeH,
      body:JSON.stringify({model:pplxModel, input:input, stream:true})
    });
  }
  if (!pRes.ok) {
    return new Response('data: '+JSON.stringify({error:'Perplexity '+pRes.status})+'\n\n', {headers:h});
  }

  var pReader = pRes.body.getReader();
  var pStream = new ReadableStream({
    start: async function(ctrl) {
      var dec = new TextDecoder();
      var enc = new TextEncoder();
      var buf = '';
      while(true) {
        var chunk = await pReader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, {stream:true});
        var lines = buf.split('\n');
        buf = lines.pop() || '';
        for (var i=0;i<lines.length;i++) {
          var line = lines[i];
          if (line.indexOf('data: ') !== 0) continue;
          var d = line.slice(6).trim();
          if (!d || d === '[DONE]') continue;
          try {
            var obj = JSON.parse(d);
            if (obj.type === 'response.output_text.delta' && obj.delta) {
              ctrl.enqueue(enc.encode('data: '+JSON.stringify({delta:obj.delta})+'\n\n'));
            }
          } catch(e) {}
        }
      }
      ctrl.enqueue(new TextEncoder().encode('data: '+JSON.stringify({done:true})+'\n\n'));
      ctrl.close();
    }
  });
  return new Response(pStream, {headers:h});
}
