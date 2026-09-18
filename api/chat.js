export const config = { runtime: 'edge' };

var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonR(obj, status) {
  var h = {'Content-Type':'application/json;charset=utf-8'};
  for (var k in CORS) h[k] = CORS[k];
  return new Response(JSON.stringify(obj), {status: status||200, headers: h});
}

function getSystemPrompt() {
  return 'شما یک دستیار هوشمند و دقیق هستید. به زبان فارسی پاسخ دهید مگر اینکه کاربر زبان دیگری مشخص کرده باشد.';
}

async function streamPerplexityAgent(model, messages) {
  var key = process.env.PERPLEXITY_API_KEY||'';
  if (!key) return jsonR({error:'PERPLEXITY_API_KEY not set'},500);
  var lastMsg = messages[messages.length-1]||{};
  var input = String(lastMsg.content||'');
  var inputArr = messages.map(function(m){
    return {role: m.role==='assistant'?'assistant':'user', content: String(m.content||'')};
  });
  var chromeHeaders = {
    'Authorization': 'Bearer '+key,
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
  var res = await fetch('https://api.perplexity.ai/v1/agent', {
    method:'POST', headers:chromeHeaders,
    body:JSON.stringify({model:model, input:inputArr})
  });
  if (!res.ok && res.status===400) {
    res = await fetch('https://api.perplexity.ai/v1/agent', {
      method:'POST', headers:chromeHeaders,
      body:JSON.stringify({model:model, input:input})
    });
  }
  if (!res.ok) return jsonR({error:'Perplexity '+res.status},502);
  var data = await res.json().catch(function(){return null;});
  if (!data) return jsonR({error:'invalid response'},502);
  var text = '';
  var output = data.output||[];
  for (var i=0;i<output.length;i++) {
    if (output[i].type==='message') {
      var content = output[i].content||[];
      for (var j=0;j<content.length;j++) {
        if (content[j].type==='output_text') text += content[j].text||'';
      }
    }
  }
  if (!text) return jsonR({error:'no text'},502);
  var NL = '\n';
  var enc = new TextEncoder();
  var stream = new ReadableStream({start:function(ctrl){
    ctrl.enqueue(enc.encode('data: '+JSON.stringify({delta:text})+NL+NL));
    ctrl.enqueue(enc.encode('data: '+JSON.stringify({done:true})+NL+NL));
    ctrl.close();
  }});
  var h={'Content-Type':'text/event-stream;charset=utf-8','Cache-Control':'no-cache'};
  for(var k in CORS)h[k]=CORS[k];
  return new Response(stream,{headers:h});
}

async function streamDeepSeek(model, messages) {
  var key = process.env.DEEPSEEK_API_KEY||'';
  if (!key) return jsonR({error:'DEEPSEEK_API_KEY not set'},500);
  var sys = {role:'system', content:getSystemPrompt()};
  var msgs = [sys].concat(messages);
  var res = await fetch('https://api.deepseek.com/chat/completions', {
    method:'POST',
    headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({model:model, messages:msgs, stream:true, max_tokens:4096})
  });
  if (!res.ok) return jsonR({error:'DeepSeek '+res.status},502);
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
        var data=line.slice(6).trim();
        if(!data||data==='[DONE]')continue;
        try{
          var obj=JSON.parse(data);
          var delta=obj.choices&&obj.choices[0]&&obj.choices[0].delta&&obj.choices[0].delta.content;
          if(delta)ctrl.enqueue(enc.encode('data: '+JSON.stringify({delta:delta})+NL+NL));
        }catch(e){}
      }
    },
    flush:function(ctrl){
      ctrl.enqueue(new TextEncoder().encode('data: '+JSON.stringify({done:true})+NL+NL));
    }
  });
  res.body.pipeTo(ts.writable).catch(function(){});
  var h={'Content-Type':'text/event-stream;charset=utf-8','Cache-Control':'no-cache'};
  for(var k in CORS)h[k]=CORS[k];
  return new Response(ts.readable,{headers:h});
}

export default async function handler(req) {
  if (req.method==='OPTIONS') return new Response(null,{headers:CORS});

  var body = await req.json().catch(function(){return {};});
  var accessCode = process.env.ACCESS_CODE||'';
  if (accessCode && body.access_code !== accessCode) return jsonR({error:'Invalid access code'},401);

  var model = body.model||'deepseek-flash';
  var messages = body.messages||[];

  if (model.startsWith('pplx:')) return streamPerplexityAgent(model.slice(5), messages);
  return streamDeepSeek(model, messages);
}
