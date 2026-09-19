export const config = { runtime: 'edge' };

export default async function handler(req) {
  var CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (req.method === 'OPTIONS') return new Response(null, {headers: CORS});

  var PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
  var DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

  var body = await req.json().catch(function(){return {};});
  var model = body.model || 'deepseek-flash';
  var messages = body.messages || [];

  var h = {'Content-Type':'text/event-stream;charset=utf-8','Cache-Control':'no-cache'};
  for(var k in CORS) h[k] = CORS[k];

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
    var pRes = await fetch('https://api.perplexity.ai/v1/agent', {
      method:'POST', headers:chromeH,
      body:JSON.stringify({model:pplxModel, input:inputArr})
    });
    if (!pRes.ok && pRes.status===400) {
      pRes = await fetch('https://api.perplexity.ai/v1/agent', {
        method:'POST', headers:chromeH,
        body:JSON.stringify({model:pplxModel, input:input})
      });
    }
    if (!pRes.ok) {
      var enc0 = new TextEncoder();
      var s0 = new ReadableStream({start:function(c){c.enqueue(enc0.encode('data: '+JSON.stringify({error:'Perplexity '+pRes.status})+'\n\n'));c.close();}});
      return new Response(s0, {headers:h});
    }
    var data = await pRes.json().catch(function(){return null;});
    var text = '';
    if (data && data.output) {
      for (var i=0;i<data.output.length;i++) {
        if (data.output[i].type==='message') {
          var cont = data.output[i].content||[];
          for (var j=0;j<cont.length;j++) {
            if (cont[j].type==='output_text') text += cont[j].text||'';
          }
        }
      }
    }
    var enc1 = new TextEncoder();
    var s1 = new ReadableStream({start:function(c){
      c.enqueue(enc1.encode('data: '+JSON.stringify({delta:text||''})+'\n\n'));
      c.enqueue(enc1.encode('data: '+JSON.stringify({done:true})+'\n\n'));
      c.close();
    }});
    return new Response(s1, {headers:h});
  }

  // DeepSeek
  var sys = {role:'system', content:'شما یک دستیار هوشمند و دقیق هستید. به زبان فارسی پاسخ دهید مگر اینکه کاربر زبان دیگری مشخص کرده باشد.'};
  var msgs = [sys].concat(messages);
  var dsRes = await fetch('https://api.deepseek.com/chat/completions', {
    method:'POST',
    headers:{'Authorization':'Bearer '+DEEPSEEK_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({model:model, messages:msgs, stream:true, max_tokens:4096})
  });
  if (!dsRes.ok) {
    var enc2 = new TextEncoder();
    var s2 = new ReadableStream({start:function(c){c.enqueue(enc2.encode('data: '+JSON.stringify({error:'DeepSeek '+dsRes.status})+'\n\n'));c.close();}});
    return new Response(s2, {headers:h});
  }
  var NL = '\n';
  var ts = new TransformStream({
    start:function(){this._buf='';this._dec=new TextDecoder();},
    transform:function(chunk,ctrl){
      this._buf+=this._dec.decode(chunk,{stream:true});
      var lines=this._buf.split(NL);
      this._buf=lines.pop()||'';
      var enc=new TextEncoder();
      for(var i=0;i<lines.length;i++){
        var line=lines[i];
        if(line.indexOf('data: ')!==0)continue;
        var d=line.slice(6).trim();
        if(!d||d==='[DONE]')continue;
        try{
          var obj=JSON.parse(d);
          var delta=obj.choices&&obj.choices[0]&&obj.choices[0].delta&&obj.choices[0].delta.content;
          if(delta)ctrl.enqueue(enc.encode('data: '+JSON.stringify({delta:delta})+NL+NL));
        }catch(e){}
      }
    },
    flush:function(ctrl){
      ctrl.enqueue(new TextEncoder().encode('data: '+JSON.stringify({done:true})+NL+NL));
    }
  });
  dsRes.body.pipeTo(ts.writable).catch(function(){});
  return new Response(ts.readable, {headers:h});
}
