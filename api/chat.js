// Cloudflare Worker - DeepSeek + Perplexity + Vertex AI Image
// Env: DEEPSEEK_API_KEY, PERPLEXITY_API_KEY, GEMINI_SERVICE_ACCOUNT

var DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
var PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
var PERPLEXITY_AGENT_URL = 'https://api.perplexity.ai/v1/agent';
var TOKEN_URL = 'https://oauth2.googleapis.com/token';
var SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

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

function normMsgs(body) {
  var msgs = Array.isArray(body.messages) ? body.messages : [];
  var out = [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i]||{};
    var role = m.role==='assistant'?'assistant':(m.role==='system'?'system':'user');
    var content = typeof m.content==='string' ? m.content : String(m.content||'');
    if (content) out.push({role:role, content:content});
  }
  return out.slice(-10);
}

function getSystemPrompt() {
  var L = String.fromCharCode(10);
  var lines = [
    'شما یک دستیار هوشمند و دقیق هستید.',
    'به زبان فارسی پاسخ دهید مگر اینکه کاربر زبان دیگری مشخص کرده باشد.',
    'پاسخ‌ها را کامل، دقیق و مفید ارائه دهید.'
  ];
  return {role: 'system', content: lines.join(L)};
}

// ===== JWT برای Vertex AI =====
function b64u(buf) {
  var b = new Uint8Array(buf), s = '';
  for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function pemBuf(pem) {
  var body = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  var bin = atob(body), b = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b.buffer;
}

var TC = {t:'', e:0};
async function getToken(env) {
  var now = Math.floor(Date.now()/1000);
  if (TC.t && TC.e-60 > now) return TC.t;

  var sa = JSON.parse(env.GEMINI_SERVICE_ACCOUNT);

  var enc = new TextEncoder();
  var hdr = {alg:'RS256',typ:'JWT'};
  var clm = {iss:sa.client_email, scope:SCOPE, aud:TOKEN_URL, exp:now+3600, iat:now};
  var si = b64u(enc.encode(JSON.stringify(hdr)))+'.'+b64u(enc.encode(JSON.stringify(clm)));
  var key = await crypto.subtle.importKey('pkcs8', pemBuf(sa.private_key), {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'}, false, ['sign']);
  var sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(si));
  var jwt = si+'.'+b64u(sig);

  var res = await fetch(TOKEN_URL, {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:'grant_type='+encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')+'&assertion='+encodeURIComponent(jwt)
  });
  var d = await res.json();
  TC = {t:d.access_token, e:now+(d.expires_in||3600)};
  return TC.t;
}

// ===== ترجمه پرامپت =====
async function translatePrompt(prompt, env) {
  if (!env.DEEPSEEK_API_KEY) return prompt;
  var sys = {
    role: 'system',
    content: 'You are a professional translator for AI image generation prompts. Translate the Persian text to detailed English. Output ONLY the English translation.'
  };
  var res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {'Content-Type':'application/json','Authorization':'Bearer '+env.DEEPSEEK_API_KEY},
    body: JSON.stringify({model:'deepseek-flash', messages:[sys, {role:'user', content:prompt}], stream:false, temperature:0.3})
  });
  var d = await res.json().catch(function(){return null;});
  if (!res.ok || !d) return prompt;
  var msg = (d.choices && d.choices[0] && d.choices[0].message) || {};
  return (msg.content || prompt).trim();
}

// ===== تولید تصویر با Vertex AI =====
async function generateImage(prompt, env) {
  if (!env.GEMINI_SERVICE_ACCOUNT) {
    return jsonR({error:'GEMINI_SERVICE_ACCOUNT not set'},500);
  }

  try {
    var englishPrompt = await translatePrompt(prompt, env);
    var sa = JSON.parse(env.GEMINI_SERVICE_ACCOUNT);
    var token = await getToken(env);

    var projectId = sa.project_id || 'my-assistant-505014';
    var model = 'gemini-3.1-flash-image';
    var imageUrl = 'https://aiplatform.googleapis.com/v1/projects/'+projectId+'/locations/global/publishers/google/models/'+model+':generateContent';

    var res = await fetch(imageUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer '+token
      },
      body: JSON.stringify({
        contents: [{role:'user', parts:[{text: 'Generate exactly ONE single image (not a collage, not side by side, not multiple panels): ' + englishPrompt}]}],
        generationConfig: {responseModalities: ['IMAGE', 'TEXT']}
      })
    });

    var d = await res.json().catch(function(){return null;});

    if (!res.ok || !d) {
      var errMsg = 'Vertex error ' + res.status;
      if (d && d.error && d.error.message) errMsg = d.error.message;
      return jsonR({error: errMsg}, 502);
    }

    var parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    for (var i = 0; i < parts.length; i++) {
      var inl = parts[i].inlineData || parts[i].inline_data;
      if (inl && inl.data) {
        return jsonR({image: inl.data, mime: inl.mimeType || 'image/png', prompt: prompt, englishPrompt: englishPrompt});
      }
    }
    return jsonR({error:'No image returned'}, 502);
  } catch(e) {
    return jsonR({error:'Image exception: ' + e.message}, 500);
  }
}

// ===== HTML =====

var LOGIN_HTML = (function(){
var h = [];
h.push('<!DOCTYPE html>');
h.push('<html lang="fa" dir="rtl">');
h.push('<head>');
h.push('<meta charset="UTF-8">');
h.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
h.push('<title>\u0648\u0631\u0648\u062f<\/title>');
h.push('<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700&display=swap" rel="stylesheet">');
h.push('<style>');
h.push('*{margin:0;padding:0;box-sizing:border-box}');
h.push('body{font-family:Vazirmatn,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;align-items:center;justify-content:center}');
h.push('.box{background:#fff;border-radius:20px;padding:40px;width:90%;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,.2);text-align:center}');
h.push('.logo{font-size:48px;margin-bottom:16px}');
h.push('h1{font-size:22px;font-weight:700;color:#1a1d2e;margin-bottom:8px}');
h.push('p{font-size:13px;color:#8890aa;margin-bottom:28px}');
h.push('input{width:100%;padding:14px 16px;border:1.5px solid #e8eaf2;border-radius:12px;font-size:15px;font-family:inherit;outline:none;text-align:center;letter-spacing:4px;color:#1a1d2e;transition:border-color .2s}');
h.push('input:focus{border-color:#6366f1}');
h.push('button{width:100%;margin-top:14px;padding:14px;background:linear-gradient(135deg,#6366f1,#818cf8);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;transition:opacity .2s}');
h.push('button:hover{opacity:.9}');
h.push('.err{color:#ef4444;font-size:13px;margin-top:12px;display:none}');
h.push('<\/style><\/head><body>');
h.push('<div class="box">');
h.push('<div class="logo">\u{1F511}<\/div>');
h.push('<h1>\u062f\u0633\u062a\u0631\u0633\u06cc \u0645\u062d\u062f\u0648\u062f<\/h1>');
h.push('<p>\u06a9\u062f \u062f\u0633\u062a\u0631\u0633\u06cc \u0631\u0627 \u0648\u0627\u0631\u062f \u06a9\u0646<\/p>');
h.push('<input type="password" id="code" placeholder="\u06a9\u062f \u0631\u0627 \u0648\u0627\u0631\u062f \u06a9\u0646..." autocomplete="off">');
h.push('<button onclick="check()">\u0648\u0631\u0648\u062f<\/button>');
h.push('<div class="err" id="err">\u06a9\u062f \u0627\u0634\u062a\u0628\u0627\u0647 \u0627\u0633\u062a<\/div>');
h.push('<\/div>');
h.push('<script>');
h.push('document.getElementById("code").addEventListener("keydown",function(e){if(e.key==="Enter")check();});');
h.push('function check(){');
h.push('  var code=document.getElementById("code").value.trim();');
h.push('  if(!code)return;');
h.push('  fetch("/api/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:code})})');
h.push('  .then(function(r){return r.json();})');
h.push('  .then(function(d){');
h.push('    if(d.ok){window.location.href="/";}');
h.push('    else{var e=document.getElementById("err");e.style.display="block";document.getElementById("code").value="";}');
h.push('  });');
h.push('}');
h.push('<\/script><\/body><\/html>');
return h.join("\n");
})();

var CHAT_HTML = '<!DOCTYPE html>' +
'<html lang="fa" dir="rtl">' +
'<head>' +
'<meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>دستیار هوشمند</title>' +
'<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700&display=swap" rel="stylesheet">' +
'<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>' +
'<style>' +
'*{margin:0;padding:0;box-sizing:border-box}' +
':root{--bg:#f7f8fc;--white:#fff;--line:#e6e9f2;--txt:#1a1d2e;--dim:#8b92a8;--accent:#6366f1;--a2:#818cf8;--err:#ef4444;--shadow:0 2px 12px rgba(99,102,241,.08)}' +
'html,body{height:100%;background:var(--bg)}' +
'body{font-family:Vazirmatn,system-ui,sans-serif;font-size:15px;color:var(--txt);display:flex;flex-direction:column;overflow:hidden}' +
'header{flex:none;background:var(--white);border-bottom:1px solid var(--line);padding:0 18px;height:56px;display:flex;align-items:center;gap:12px;box-shadow:var(--shadow);z-index:10}' +
'.logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--a2));display:flex;align-items:center;justify-content:center;font-size:17px;flex:none}' +
'.htitle{font-size:15px;font-weight:700;flex:1}' +
'.hsub{font-size:11px;color:var(--dim);font-weight:500}' +
'.codeBtn{flex:none;display:inline-flex;align-items:center;gap:6px;padding:8px 14px;background:var(--bg);border:1.5px solid var(--line);color:var(--txt);border-radius:10px;text-decoration:none;font-family:inherit;font-size:12.5px;font-weight:600;transition:all .2s}' +
'.codeBtn:hover{border-color:var(--accent);color:var(--accent);background:#f0f1fd}' +
'.tbar{flex:none;background:var(--white);border-bottom:1px solid var(--line);padding:8px 18px;display:flex;align-items:center;gap:10px}' +
'.tog{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;padding:6px 12px;border-radius:10px;transition:background .15s}' +
'.tog:hover{background:var(--bg)}' +
'.tr{width:38px;height:22px;background:#d4d8e3;border-radius:999px;position:relative;transition:background .25s;flex:none}' +
'.tr.on{background:linear-gradient(135deg,var(--accent),var(--a2))}' +
'.tr::after{content:"";position:absolute;top:2px;right:2px;width:18px;height:18px;background:#fff;border-radius:50%;transition:transform .25s;box-shadow:0 1px 4px rgba(0,0,0,.15)}' +
'.tr.on::after{transform:translateX(-16px)}' +
'.tlb{font-size:12.5px;font-weight:600;color:var(--dim);transition:color .2s}' +
'.tr.on ~ .tlb{color:var(--accent)}' +
'#chat{flex:1;overflow-y:auto;padding:24px 18px 12px;display:flex;flex-direction:column;gap:16px;scroll-behavior:smooth}' +
'#chat::-webkit-scrollbar{width:8px}' +
'#chat::-webkit-scrollbar-track{background:transparent}' +
'#chat::-webkit-scrollbar-thumb{background:#d4d8e3;border-radius:4px}' +
'.welcome{margin:auto;text-align:center;padding:30px 20px;max-width:400px}' +
'.welcome .wi{font-size:52px;margin-bottom:14px;animation:float 3s ease-in-out infinite}' +
'@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}' +
'.welcome h2{font-size:19px;font-weight:700;margin-bottom:8px;color:var(--txt)}' +
'.welcome p{font-size:13.5px;color:var(--dim);line-height:1.8}' +
'.msg{display:flex;gap:10px;max-width:780px;width:100%;align-self:center;animation:fadeIn .3s ease}' +
'@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}' +
'.msg.user{flex-direction:row-reverse}' +
'.av{width:32px;height:32px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:14px;margin-top:2px}' +
'.msg.user .av{background:linear-gradient(135deg,var(--accent),var(--a2));color:#fff}' +
'.msg.bot .av{background:var(--white);border:1.5px solid var(--line);box-shadow:var(--shadow)}' +
'.msg.err .av{background:#fee2e2}' +
'.bwrap{display:flex;flex-direction:column;max-width:calc(100% - 54px);min-width:0}' +
'.msg.user .bwrap{align-items:flex-end}' +
'.who{font-size:11px;color:var(--dim);font-weight:600;margin-bottom:5px;padding:0 4px}' +
'.bub{padding:10px 14px;border-radius:14px;font-size:14.5px;line-height:1.75;word-break:break-word;overflow-wrap:anywhere;max-width:100%}' +
'.msg.user .bub{background:linear-gradient(135deg,var(--accent),var(--a2));color:#fff;border-bottom-left-radius:4px;white-space:pre-wrap;box-shadow:0 2px 8px rgba(99,102,241,.25)}' +
'.msg.bot .bub{background:var(--white);border:1px solid var(--line);border-bottom-right-radius:4px;box-shadow:var(--shadow)}' +
'.msg.err .bub{background:#fef2f2;border:1px solid #fecaca;color:var(--err);border-radius:12px}' +
'.bub p{margin:6px 0;direction:rtl;text-align:right;unicode-bidi:plaintext}' +
'.bub p:first-child{margin-top:0}' +
'.bub p:last-child{margin-bottom:0}' +
'.bub ul,.bub ol{padding-inline-start:22px;padding-inline-end:0;direction:rtl;text-align:right;margin:8px 0}' +
'.bub li{margin-bottom:4px;direction:rtl;text-align:right}' +
'.bub h1,.bub h2,.bub h3,.bub h4{margin:14px 0 6px;font-weight:700;direction:rtl;text-align:right}' +
'.bub h1{font-size:1.3em;border-bottom:2px solid var(--line);padding-bottom:6px}' +
'.bub h2{font-size:1.18em}' +
'.bub h3{font-size:1.08em}' +
'.bub strong{font-weight:700;color:var(--txt)}' +
'.bub em{font-style:italic;color:var(--dim)}' +
'.bub pre{background:#1e1e2e;color:#cdd6f4;padding:12px 14px;border-radius:10px;overflow-x:auto;direction:ltr;text-align:left;margin:10px 0;font-size:13px;line-height:1.55}' +
'.bub pre code{background:none;color:inherit;padding:0;font-family:"Consolas","Monaco",monospace}' +
'.bub code{background:#eef0f8;color:#c0392b;padding:2px 6px;border-radius:5px;direction:ltr;display:inline-block;font-size:13px;font-family:"Consolas","Monaco",monospace;unicode-bidi:embed}' +
'.bub table{border-collapse:collapse;width:100%;margin:10px 0;direction:rtl;text-align:right;font-size:14px}' +
'.bub th,.bub td{border:1px solid var(--line);padding:7px 10px;text-align:right;direction:rtl}' +
'.bub th{background:var(--bg);font-weight:700}' +
'.bub blockquote{border-right:3px solid var(--accent);border-left:none;padding:6px 12px 6px 0;margin:8px 0;color:var(--dim);background:#f8f9ff;border-radius:0 6px 6px 0;direction:rtl;text-align:right}' +
'.bub a{color:var(--accent);text-decoration:none;border-bottom:1px dashed var(--accent)}' +
'.bub hr{border:none;border-top:1px solid var(--line);margin:12px 0}' +
'.msg.user .bub code{background:rgba(255,255,255,.25);color:#fff}' +
'.msg.user .bub pre{background:rgba(0,0,0,.28);color:#fff}' +
'.bub img.gen{max-width:100%;border-radius:12px;margin-top:8px;display:block;box-shadow:0 4px 16px rgba(0,0,0,.1)}' +
'.cursor{display:inline-block;width:7px;height:16px;background:var(--accent);margin-inline-start:2px;vertical-align:middle;animation:blink .8s infinite;border-radius:2px}' +
'@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}' +
'.srcBtn{margin-top:10px;display:inline-flex;align-items:center;gap:6px;background:var(--bg);border:1.5px solid var(--line);border-radius:10px;padding:7px 14px;font-family:inherit;font-size:12.5px;font-weight:600;color:var(--dim);cursor:pointer;transition:all .2s}' +
'.srcBtn:hover{border-color:var(--accent);color:var(--accent);background:#f0f1fd}' +
'.srcBtn.active{border-color:var(--accent);color:var(--accent);background:#eef0fd}' +
'.srcBtn .arrow{transition:transform .2s;font-size:10px}' +
'.srcBtn.active .arrow{transform:rotate(180deg)}' +
'.srcList{margin-top:8px;padding:10px 12px;background:var(--bg);border:1px solid var(--line);border-radius:10px;display:none;animation:fadeIn .2s ease}' +
'.srcList.show{display:block}' +
'.srcList ol{padding-inline-start:20px;margin:0;direction:rtl;text-align:right}' +
'.srcList li{margin-bottom:6px;word-break:break-all;font-size:12.5px;line-height:1.6}' +
'.srcList li a{color:var(--accent);text-decoration:none;border-bottom:1px dashed var(--accent)}' +
'.srcList li a:hover{border-bottom-style:solid}' +
'.foot{flex:none;background:var(--white);border-top:1px solid var(--line);padding:12px 18px 10px}' +
'.comp{display:flex;gap:8px;align-items:flex-end;max-width:780px;margin:0 auto;background:var(--bg);border:1.5px solid var(--line);border-radius:14px;padding:6px 6px 6px 14px;transition:border-color .2s, box-shadow .2s}' +
'.comp:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px rgba(99,102,241,.1)}' +
'#inp{flex:1;background:transparent;border:none;outline:none;font-family:inherit;font-size:14.5px;color:var(--txt);resize:none;max-height:110px;line-height:1.65;direction:rtl;padding:6px 0}' +
'#inp::placeholder{color:var(--dim)}' +
'#sbtn{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--accent),var(--a2));border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none;transition:transform .15s,opacity .15s}' +
'#sbtn:hover:not(:disabled){transform:scale(1.05)}' +
'#sbtn:disabled{opacity:.4;cursor:not-allowed}' +
'.hint{text-align:center;font-size:11px;color:var(--dim);margin-top:8px}' +
'@media(max-width:600px){' +
'header{padding:0 10px;gap:6px;height:50px}' +
'.logo{width:28px;height:28px;font-size:14px}' +
'.htitle{font-size:13px}' +
'#mSel{max-width:120px;font-size:10px;padding:4px 6px}' +
'.codeBtn{padding:5px 8px;font-size:11px}' +
'#chat{padding:12px 10px}' +
'.msg{max-width:100%}' +
'.bub{font-size:13.5px;padding:9px 12px}' +
'.foot{padding:8px 10px}' +
'.comp{padding:6px 6px 6px 12px}' +
'#inp{font-size:14px}' +
'.sbtn{width:36px;height:36px}' +
'.tbar{padding:6px 10px}' +
'}' +
'</style>' +
'</head>' +
'<body>' +
'<header>' +
'<div class="logo">🤖</div>' +
'<div style="flex:1;min-width:0"><div class="htitle">دستیار هوشمند</div></div>' +
'<select id="mSel" style="background:var(--bg,#f7f8fc);border:1.5px solid var(--line,#e8eaf2);border-radius:10px;padding:5px 8px;font-size:11px;font-family:inherit;color:var(--txt,#1a1d2e);outline:none;cursor:pointer;max-width:160px">' +
'<optgroup label="DeepSeek">' +
'<option value="deepseek-flash">DeepSeek V4.1 Flash ✨<\/option>' +
'<option value="deepseek-v4-pro">DeepSeek V4 Pro<\/option>' +
'<option value="deepseek-v4-flash">DeepSeek V4 Flash<\/option>' +
'<option value="deepseek-chat">DeepSeek V3<\/option>' +
'<option value="deepseek-reasoner">DeepSeek R1<\/option>' +
'<\/optgroup>' +
'<optgroup label="Anthropic (via Perplexity)">' +
'<option value="pplx:anthropic/claude-fable-5">Claude Fable 5<\/option>' +
'<option value="pplx:anthropic/claude-fable-5-1">Claude Fable 5.1<\/option>' +
'<option value="pplx:anthropic/claude-opus-5">Claude Opus 5<\/option>' +
'<option value="pplx:anthropic/claude-sonnet-5">Claude Sonnet 5<\/option>' +
'<option value="pplx:anthropic/claude-sonnet-4-6">Claude Sonnet 4.6<\/option>' +
'<option value="pplx:anthropic/claude-haiku-4-5">Claude Haiku 4.5<\/option>' +
'<\/optgroup>' +
'<optgroup label="OpenAI (via Perplexity)">' +
'<option value="pplx:openai/gpt-6-astra">GPT-6 Astra<\/option>' +
'<option value="pplx:openai/gpt-5.6-sol">GPT-5.6 Sol<\/option>' +
'<option value="pplx:openai/gpt-5.6-luna">GPT-5.6 Luna (ارزان)<\/option>' +
'<option value="pplx:openai/gpt-5.4">GPT-5.4<\/option>' +
'<option value="pplx:openai/gpt-5.4-mini">GPT-5.4 Mini<\/option>' +
'<option value="pplx:openai/gpt-5-mini">GPT-5 Mini<\/option>' +
'<\/optgroup>' +
'<optgroup label="Google (via Perplexity)">' +
'<option value="pplx:google/gemini-3.1-pro-preview">Gemini 3.1 Pro<\/option>' +
'<option value="pplx:google/gemini-3.8-flash">Gemini 3.8 Flash<\/option>' +
'<option value="pplx:google/gemini-3.7-flash">Gemini 3.7 Flash<\/option>' +
'<option value="pplx:google/gemini-3.1-flash-lite">Gemini 3.1 Flash Lite<\/option>' +
'<\/optgroup>' +
'<optgroup label="xAI (via Perplexity)">' +
'<option value="pplx:xai/grok-4.6">Grok 4.6<\/option>' +
'<option value="pplx:xai/grok-4.3">Grok 4.3<\/option>' +
'<\/optgroup>' +
'<optgroup label="Z.AI GLM (via Perplexity)">' +
'<option value="pplx:perplexity/glm-5.3">GLM 5.3<\/option>' +
'<option value="pplx:perplexity/glm-5.3-flash">GLM 5.3 Flash (ارزان)<\/option>' +
'<option value="pplx:perplexity/glm-5.2">GLM 5.2<\/option>' +
'<\/optgroup>' +
'<optgroup label="Moonshot Kimi (via Perplexity)">' +
'<option value="pplx:perplexity/kimi-k3">Kimi K3<\/option>' +
'<option value="pplx:perplexity/kimi-k2.7-code">Kimi K2.7 Code<\/option>' +
'<\/optgroup>' +
'<optgroup label="NVIDIA (via Perplexity)">' +
'<option value="pplx:perplexity/nemotron-3.5-lightning-30b-a3b">Nemotron Lightning ⚡<\/option>' +
'<option value="pplx:perplexity/nemotron-3-ultra-550b-a55b">Nemotron Ultra 550B<\/option>' +
'<\/optgroup>' +
'<optgroup label="DeepSeek (via Perplexity)">' +
'<option value="pplx:perplexity/deepseek-v4-flash-0731">DeepSeek V4 Flash (Perplexity)<\/option>' +
'<\/optgroup>' +
'<\/select>' +
'<a href="/code" class="codeBtn" title="دستیار کدنویسی">💻 Code</a>' +
'</header>' +
'<div class="tbar">' +
'<div class="tog" id="srTog"><div class="tr" id="srTr"></div><span class="tlb">🔍 جستجوی اینترنتی</span></div>' +
'</div>' +
'<div id="chat"><div class="welcome"><div class="wi">✨</div><h2>سلام! چطور میتونم کمکت کنم؟</h2><p>سوالت رو بنویس، یا درخواست تصویر بده (مثلاً: «یه تصویر از گربه بساز»).</p></div></div>' +
'<div class="foot">' +
'<div class="comp"><textarea id="inp" rows="1" placeholder="پیامت را بنویس..."></textarea>' +
'<button id="sbtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg></button></div>' +
'<div class="hint">Enter = ارسال | Shift+Enter = خط جدید</div>' +
'</div>' +
'<script>' +
'(function(){' +
'"use strict";' +
'var hist=[], busy=false, searchOn=false;' +
'var chat=document.getElementById("chat");' +
'var inp=document.getElementById("inp");' +
'var sbtn=document.getElementById("sbtn");' +
'var srTog=document.getElementById("srTog"),srTr=document.getElementById("srTr");' +
'var modeEl=document.getElementById("mode");' +
'if(typeof marked !== "undefined"){marked.setOptions({breaks:true,gfm:true,headerIds:false,mangle:false});}' +
'function trim(s){' +
'var str=String(s||"");var a=0,b=str.length;' +
'while(a<b){var c=str.charCodeAt(a);if(c===32||c===9||c===10||c===13)a++;else break;}' +
'while(b>a){var c2=str.charCodeAt(b-1);if(c2===32||c2===9||c2===10||c2===13)b--;else break;}' +
'return str.substring(a,b);' +
'}' +
'function scrollB(smooth){if(smooth){chat.scrollTo({top:chat.scrollHeight,behavior:"smooth"});}else{chat.scrollTop=chat.scrollHeight;}}' +
'function rmW(){var w=chat.querySelector(".welcome");if(w)w.remove();}' +
'function escHtml(s){return String(s).split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split(\'"\').join("&quot;");}' +
'function mdRender(text){' +
'if(typeof marked === "undefined"){return escHtml(text).split(String.fromCharCode(10)).join("<br>");}' +
'try{' +
'var mathBlocks=[];var codeBlocks=[];' +
'var RND=Math.random().toString(36).slice(2,8);' +
'var MATH_PH="MPH"+RND+"X";' +
'var CODE_PH="CPH"+RND+"X";' +
'var str=String(text||"");' +
'str=str.replace(/(\\$\\$[\\s\\S]*?\\$\\$|\\\\\\[[\\s\\S]*?\\\\\\])/g,function(m){mathBlocks.push(m);return MATH_PH+(mathBlocks.length-1)+"EX";});' +
'str=str.replace(/(\\$[^\\$\\n]+?\\$|\\\\\\([\\s\\S]*?\\\\\\))/g,function(m){mathBlocks.push(m);return MATH_PH+(mathBlocks.length-1)+"EX";});' +
'var BT=String.fromCharCode(96);var BT3=BT+BT+BT;' +
'var codeRe=new RegExp("("+BT3+"[\\\\s\\\\S]*?"+BT3+"|"+BT+"[^"+BT+"\\\\n]+?"+BT+")","g");' +
'str=str.replace(codeRe,function(m){codeBlocks.push(m);return CODE_PH+(codeBlocks.length-1)+"EX";});' +
'var rendered=marked.parse(str);' +
'var codeRe2=new RegExp(CODE_PH+"(\\\\d+)EX","g");' +
'rendered=rendered.replace(codeRe2,function(m,i){' +
'var code=codeBlocks[+i]||"";' +
'if(code.indexOf(BT3)===0){var inner=code.slice(3,-3);var fl=inner.indexOf(String.fromCharCode(10));if(fl>-1)inner=inner.slice(fl+1);return "<pre><code>"+escHtml(inner)+"</code></pre>";}' +
'else{var ic=code.slice(1,-1);return "<code>"+escHtml(ic)+"</code>";}' +
'});' +
'var mathRe=new RegExp(MATH_PH+"(\\\\d+)EX","g");' +
'rendered=rendered.replace(mathRe,function(m,i){return mathBlocks[+i]||m;});' +
'return rendered;' +
'}catch(e){return escHtml(text).split(String.fromCharCode(10)).join("<br>");}' +
'}' +
'function isImgReq(text){' +
'var t=String(text||"").toLowerCase();' +
'var kws=["تصویر بساز","عکس بساز","نقاشی کن","بکش","رسم کن","تصویر ایجاد","عکس ایجاد","تصویر تولید","عکس تولید","یه تصویر","یه عکس","یک تصویر","یک عکس","generate image","create image","draw","make an image","make a picture","picture of","image of"];' +
'for(var i=0;i<kws.length;i++){if(t.indexOf(kws[i])>-1)return true;}' +
'return false;' +
'}' +
'function addUserMsg(text){' +
'rmW();' +
'var w=document.createElement("div");w.className="msg user";' +
'var av=document.createElement("div");av.className="av";av.textContent="👤";' +
'var bw=document.createElement("div");bw.className="bwrap";' +
'var b=document.createElement("div");b.className="bub";b.textContent=text;' +
'bw.appendChild(b);w.appendChild(bw);w.appendChild(av);' +
'chat.appendChild(w);scrollB();' +
'}' +
'function addBotMsg(label){' +
'rmW();' +
'var w=document.createElement("div");w.className="msg bot";' +
'var av=document.createElement("div");av.className="av";av.textContent="🤖";' +
'var bw=document.createElement("div");bw.className="bwrap";' +
'if(label){var wh=document.createElement("div");wh.className="who";wh.textContent=label;bw.appendChild(wh);}' +
'var b=document.createElement("div");b.className="bub";' +
'var body=document.createElement("div");' +
'body.innerHTML=\'<span class="cursor"></span>\';' +
'b.appendChild(body);' +
'bw.appendChild(b);w.appendChild(av);w.appendChild(bw);' +
'chat.appendChild(w);scrollB();' +
'return {wrap:w,body:body,bub:b,bwrap:bw,srcEl:null,srcBtn:null};' +
'}' +
'function addErrMsg(text){' +
'rmW();' +
'var w=document.createElement("div");w.className="msg err";' +
'var av=document.createElement("div");av.className="av";av.textContent="⚠️";' +
'var bw=document.createElement("div");bw.className="bwrap";' +
'var b=document.createElement("div");b.className="bub";b.textContent=text;' +
'bw.appendChild(b);w.appendChild(av);w.appendChild(bw);' +
'chat.appendChild(w);scrollB();' +
'}' +
'function renderSources(ui, sources){' +
'if(ui.srcBtn){ui.srcBtn.remove();}' +
'if(ui.srcEl){ui.srcEl.remove();}' +
'var btn=document.createElement("button");' +
'btn.className="srcBtn";' +
'btn.innerHTML=\'📚 منابع <span class="arrow">▼</span>\';' +
'btn.addEventListener("click",function(){' +
'btn.classList.toggle("active");' +
'ui.srcEl.classList.toggle("show");' +
'});' +
'ui.bwrap.appendChild(btn);' +
'var list=document.createElement("div");' +
'list.className="srcList";' +
'var ol=document.createElement("ol");' +
'for(var i=0;i<sources.length;i++){' +
'var li=document.createElement("li");' +
'var a=document.createElement("a");' +
'a.href=sources[i];' +
'a.target="_blank";' +
'a.rel="noopener noreferrer";' +
'a.textContent=sources[i];' +
'li.appendChild(a);' +
'ol.appendChild(li);' +
'}' +
'list.appendChild(ol);' +
'ui.bwrap.appendChild(list);' +
'ui.srcBtn=btn;' +
'ui.srcEl=list;' +
'scrollB(true);' +
'}' +
'function autoSz(){inp.style.height="auto";inp.style.height=Math.min(inp.scrollHeight,110)+"px";}' +
'function updateMode(){if(modeEl)modeEl.textContent=searchOn?"Perplexity Sonar":(mSel?mSel.options[mSel.selectedIndex].text:"DeepSeek");}' +
'function send(){' +
'var text=trim(inp.value);if(!text||busy)return;' +
'hist.push({role:"user",content:text});' +
'addUserMsg(text);' +
'inp.value="";autoSz();' +
'busy=true;sbtn.disabled=true;' +
'var isImage=isImgReq(text);' +
'if(isImage){' +
'var label="🎨 Vertex AI (Nano Banana Lite)";' +
'var ui=addBotMsg(label);' +
'ui.body.innerHTML="⏳ در حال ترجمه و ساخت تصویر...";' +
'fetch("/api/image",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:text})})' +
'.then(function(r){return r.json();})' +
'.then(function(d){' +
'if(d.error){ui.wrap.remove();addErrMsg("خطا: "+d.error);return;}' +
'if(d.image){' +
'var img=document.createElement("img");' +
'img.className="gen";' +
'img.src="data:"+(d.mime||"image/png")+";base64,"+d.image;' +
'ui.body.innerHTML="";' +
'ui.body.appendChild(img);' +
'var a=document.createElement("a");' +
'a.href=img.src;' +
'a.download="generated-image.png";' +
'a.textContent="📥 دانلود تصویر";' +
'a.style.cssText="display:inline-block;margin-top:10px;padding:8px 16px;background:#6366f1;color:#fff;border-radius:10px;text-decoration:none;font-size:13px;font-weight:600";' +
'ui.bwrap.appendChild(a);' +
'scrollB(true);' +
'hist.push({role:"assistant",content:"[تصویر تولید شد]"});' +
'}' +
'})' +
'.catch(function(e){ui.wrap.remove();addErrMsg("خطا: "+e.message);})' +
'.then(function(){busy=false;sbtn.disabled=false;inp.focus();});' +
'return;' +
'}' +
'var label=searchOn?"🔍 Perplexity Sonar":(mSel.options[mSel.selectedIndex]?mSel.options[mSel.selectedIndex].text:"🟣 DeepSeek V4.1 Flash");' +
'var ui=addBotMsg(label);' +
'var fullText="";' +
'var renderTimer=null;' +
'var lastRender=0;' +
'var pendingSources=null;' +
'function renderNow(){' +
'ui.body.innerHTML=mdRender(fullText)+\'<span class="cursor"></span>\';' +
'scrollB(true);' +
'lastRender=Date.now();' +
'}' +
'fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:hist.slice(-10).map(function(m){return{role:m.role,content:m.content};}),search:searchOn,model:document.getElementById("mSel").value})})' +
'.then(function(r){' +
'if(!r.ok){return r.json().then(function(e){throw new Error(e.error||"HTTP "+r.status);});}' +
'var reader=r.body.getReader();var decoder=new TextDecoder();' +
'var buf="";' +
'function pump(){' +
'return reader.read().then(function(res){' +
'if(res.done){' +
'ui.body.innerHTML=mdRender(fullText);' +
'if(pendingSources&&pendingSources.length){renderSources(ui,pendingSources);}' +
'scrollB();' +
'if(fullText){hist.push({role:"assistant",content:fullText});}' +
'return;' +
'}' +
'buf+=decoder.decode(res.value,{stream:true});' +
'var lines=buf.split(String.fromCharCode(10));' +
'buf=lines.pop()||"";' +
'for(var i=0;i<lines.length;i++){' +
'var line=lines[i];' +
'if(line.indexOf("data: ")!==0)continue;' +
'var data=line.slice(6).trim();' +
'if(data==="[DONE]")continue;' +
'try{' +
'var obj=JSON.parse(data);' +
'if(obj.error){throw new Error(obj.error);}' +
'if(obj.delta){fullText+=obj.delta;}' +
'if(obj.sources&&obj.sources.length){pendingSources=obj.sources;}' +
'}catch(e){}' +
'}' +
'var now=Date.now();' +
'if(now-lastRender>100){renderNow();}' +
'else{' +
'if(renderTimer)clearTimeout(renderTimer);' +
'renderTimer=setTimeout(renderNow,100);' +
'}' +
'return pump();' +
'});' +
'}' +
'return pump();' +
'})' +
'.catch(function(e){' +
'ui.wrap.remove();' +
'addErrMsg("خطا: "+e.message);' +
'})' +
'.then(function(){busy=false;sbtn.disabled=false;inp.focus();});' +
'}' +
'sbtn.addEventListener("click",send);' +
'inp.addEventListener("input",autoSz);' +
'inp.addEventListener("keydown",function(e){' +
'if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}' +
'});' +
'srTog.addEventListener("click",function(){searchOn=!searchOn;srTr.classList.toggle("on",searchOn);updateMode();});' +
'autoSz();inp.focus();updateMode();' +
'})();' +
'<\/script>' +
'</body></html>';


var CODE_HTML = (function(){
var h = [];
h.push('<!DOCTYPE html>');
h.push('<html lang="fa" dir="rtl">');
h.push('<head>');
h.push('<meta charset="UTF-8">');
h.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
h.push('<title>Code Assistant<\/title>');
h.push('<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700&display=swap" rel="stylesheet">');
h.push('<style>');
h.push('*{margin:0;padding:0;box-sizing:border-box}');
h.push(':root{--bg:#f5f7ff;--white:#fff;--line:#e2e5f0;--txt:#1a1d2e;--dim:#8890aa;--accent:#6366f1;--a2:#818cf8;--err:#ef4444;--sh:0 2px 20px rgba(99,102,241,.1)}');
h.push('html,body{height:100%;background:var(--bg);font-family:Vazirmatn,system-ui,sans-serif;color:var(--txt);overflow:hidden}');
h.push('.app{display:flex;flex-direction:column;height:100vh}');
h.push('header{flex:none;background:var(--white);border-bottom:1px solid var(--line);padding:0 20px;height:56px;display:flex;align-items:center;gap:12px;box-shadow:var(--sh)}');
h.push('.logo{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--a2));display:flex;align-items:center;justify-content:center;font-size:16px;flex:none}');
h.push('.htitle{font-size:15px;font-weight:700;flex:1}');
h.push('.msel{background:var(--bg);border:1.5px solid var(--line);border-radius:9px;padding:6px 10px;font-size:12px;font-family:inherit;color:var(--txt);outline:none;cursor:pointer}');
h.push('.back-btn{display:inline-flex;align-items:center;gap:5px;padding:7px 13px;background:var(--bg);border:1.5px solid var(--line);color:var(--txt);border-radius:9px;text-decoration:none;font-size:12px;font-weight:600}');
h.push('.back-btn:hover{border-color:var(--accent);color:var(--accent)}');
h.push('.main{flex:1;display:flex;overflow:hidden;min-height:0}');
h.push('.preview-panel{flex:1;display:flex;flex-direction:column;border-left:1px solid var(--line);min-width:0;background:var(--white)}');
h.push('.panel-hdr{flex:none;padding:10px 16px;background:var(--bg);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--dim)}');
h.push('.dot{width:10px;height:10px;border-radius:50%}.dot.r{background:#ef4444}.dot.y{background:#f59e0b}.dot.g{background:#22c55e}');
h.push('.preview-empty{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:var(--dim);background:var(--bg)}');
h.push('.preview-empty p{font-size:13px}');
h.push('#preview{flex:1;border:none;width:100%;display:none;background:#fff}');
h.push('.chat-panel{width:400px;flex:none;display:flex;flex-direction:column;background:var(--white);min-height:0}');
h.push('.cards{flex:1;min-height:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}');
h.push('.welcome-msg{flex:none;text-align:center;padding:32px 20px;color:var(--dim)}');
h.push('.welcome-msg h3{font-size:14px;font-weight:700;color:var(--txt);margin-bottom:6px}');
h.push('.welcome-msg p{font-size:12px;line-height:1.8}');
h.push('.card{flex:none;border-radius:14px;overflow:hidden;cursor:pointer;transition:all .2s;border:1.5px solid var(--line);background:var(--white)}');
h.push('.card:hover{border-color:var(--accent);box-shadow:0 4px 16px rgba(99,102,241,.1)}');
h.push('.card.active{border-color:var(--accent);box-shadow:0 4px 20px rgba(99,102,241,.15)}');
h.push('.card.err-card{border-color:#fecaca;background:#fef2f2;color:var(--err);cursor:default}');
h.push('.card-head{padding:11px 14px;display:flex;align-items:center;gap:8px}');
h.push('.card-icon{font-size:15px}.card-title{font-size:13px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}');
h.push('.card-badge{font-size:10px;background:linear-gradient(135deg,var(--accent),var(--a2));color:#fff;padding:2px 8px;border-radius:999px;font-weight:700}');
h.push('.card-sub{padding:0 14px 11px;font-size:11px;color:var(--dim);line-height:1.6;word-break:break-word}');
h.push('.user-card{background:linear-gradient(135deg,rgba(99,102,241,.06),rgba(129,140,248,.04));border-color:rgba(99,102,241,.25)}');
h.push('.code-prev{margin:0 14px 11px;background:#f8f9ff;border:1px solid var(--line);border-radius:9px;padding:8px 10px;font-size:10.5px;font-family:monospace;color:#374151;line-height:1.5;max-height:60px;overflow:hidden;position:relative;direction:ltr;text-align:left;white-space:pre-wrap}');
h.push('.code-prev::after{content:"";position:absolute;bottom:0;left:0;right:0;height:24px;background:linear-gradient(transparent,#f8f9ff)}');
h.push('.typing-card{flex:none;border-radius:14px;border:1.5px solid var(--line);background:var(--white);padding:12px 14px;display:flex;align-items:center;gap:10px}');
h.push('.tdots{display:flex;gap:4px}.tdots span{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:bnc 1.2s infinite}');
h.push('.tdots span:nth-child(2){animation-delay:.2s}.tdots span:nth-child(3){animation-delay:.4s}');
h.push('@keyframes bnc{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}');
h.push('.input-area{flex:none;padding:14px;border-top:1px solid var(--line);background:var(--bg)}');
h.push('.inp-wrap{background:var(--white);border:1.5px solid var(--line);border-radius:14px;display:flex;align-items:center;gap:8px;padding:8px 8px 8px 14px;transition:border-color .2s;box-shadow:var(--sh)}');
h.push('.inp-wrap:focus-within{border-color:var(--accent)}');
h.push('#inp{flex:1;background:transparent;border:none;outline:none;font-family:inherit;font-size:13.5px;color:var(--txt);resize:none;line-height:1.5;direction:rtl;max-height:80px}');
h.push('#inp::placeholder{color:var(--dim)}');
h.push('.inp-hint{text-align:center;font-size:10.5px;color:var(--dim);margin-top:8px}');
h.push('#sbtn{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--a2));border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none;box-shadow:0 3px 10px rgba(99,102,241,.3)}');
h.push('#sbtn:disabled{opacity:.4;cursor:not-allowed}');
h.push('<\/style><\/head><body>');
h.push('<div class="app">');
h.push('<header><div class="logo">&#x1F4BB;<\/div><div class="htitle">Code Assistant<\/div>');
h.push('<select class="msel" id="mSel"><option value="deepseek-flash">V4.1 Flash<\/option><option value="deepseek-v4-pro">V4 Pro<\/option><option value="deepseek-v4-flash">V4 Flash<\/option><option value="deepseek-chat">V3<\/option><option value="deepseek-reasoner">R1<\/option><\/select>');
h.push('<a href="/" class="back-btn">&#x2190; &#x628;&#x627;&#x632;&#x6AF;&#x634;&#x62A;<\/a><\/header>');
h.push('<div class="main">');
h.push('<div class="preview-panel"><div class="panel-hdr"><div class="dot r"><\/div><div class="dot y"><\/div><div class="dot g"><\/div><span id="pvTitle">&#x67E;&#x6CC;&#x634;&#x200C;&#x646;&#x645;&#x627;&#x6CC;&#x634;<\/span><\/div>');
h.push('<div class="preview-empty" id="pvEmpty"><p>&#x631;&#x648;&#x6CC; &#x6A9;&#x627;&#x631;&#x62A; &#x6A9;&#x644;&#x6CC;&#x6A9; &#x6A9;&#x646;<\/p><\/div>');
h.push('<iframe id="preview" sandbox="allow-scripts allow-forms allow-modals allow-popups"><\/iframe><\/div>');
h.push('<div class="chat-panel"><div class="cards" id="cards">');
h.push('<div class="welcome-msg"><h3>Code Assistant<\/h3><p>&#x628;&#x6AF;&#x648; &#x686;&#x6CC; &#x628;&#x633;&#x627;&#x632;&#x645;!<br>&#x645;&#x62B;&#x644;&#x627;&#x64B;: &#x644;&#x646;&#x62F;&#x6CC;&#x646;&#x6AF; &#x67E;&#x6CC;&#x62C; &#x645;&#x62F;&#x631;&#x646;<\/p><\/div>');
h.push('<\/div>');
h.push('<div class="input-area"><div class="inp-wrap">');
h.push('<textarea id="inp" rows="1" placeholder="&#x686;&#x6CC; &#x628;&#x633;&#x627;&#x632;&#x645; &#x628;&#x631;&#x627;&#x62A;&#x61F;"><\/textarea>');
h.push('<button id="sbtn" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"><\/line><polygon points="22 2 15 22 11 13 2 9 22 2"><\/polygon><\/svg><\/button>');
h.push('<\/div><div class="inp-hint">Enter = &#x627;&#x631;&#x633;&#x627;&#x644; | Shift+Enter = &#x62E;&#x637; &#x62C;&#x62F;&#x6CC;&#x62F;<\/div><\/div><\/div><\/div><\/div>');
h.push('<script>(function(){');
h.push('"use strict";');
h.push('var NL=String.fromCharCode(10);');
h.push('var BT=String.fromCharCode(96);');
h.push('var FENCE=BT+BT+BT;');
h.push('var cards=document.getElementById("cards");');
h.push('var inp=document.getElementById("inp");');
h.push('var sbtn=document.getElementById("sbtn");');
h.push('var mSel=document.getElementById("mSel");');
h.push('var preview=document.getElementById("preview");');
h.push('var pvEmpty=document.getElementById("pvEmpty");');
h.push('var pvTitle=document.getElementById("pvTitle");');
h.push('var busy=false,hist=[],activeCard=null;');
h.push('function autoSz(){inp.style.height="auto";inp.style.height=Math.min(inp.scrollHeight,80)+"px";}');
h.push('function scrollDown(){cards.scrollTop=cards.scrollHeight;}');
// trim: char-code loop, immune to backslash-escape loss inside these string literals
h.push('function trim(s){var str=String(s||"");var a=0,b=str.length;');
h.push('while(a<b){var c=str.charCodeAt(a);if(c===32||c===9||c===10||c===13)a++;else break;}');
h.push('while(b>a){var c2=str.charCodeAt(b-1);if(c2===32||c2===9||c2===10||c2===13)b--;else break;}');
h.push('return str.substring(a,b);}');
h.push('function esc(s){return String(s).split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");}');
// looksHtml / extractHtml / wrapDoc: no regex escapes, so nothing can be eaten by the outer string literal
h.push('function looksHtml(t){var l=String(t||"").toLowerCase();');
h.push('if(l.indexOf("<!doctype")>-1||l.indexOf("<html")>-1)return true;');
h.push('var tags=["<body","<div","<section","<main","<header","<footer","<nav","<article","<h1","<h2","<p>","<p ","<ul","<ol","<table","<form","<button","<span","<img","<svg","<canvas","<style","<scr"+"ipt"];');
h.push('for(var i=0;i<tags.length;i++){if(l.indexOf(tags[i])>-1)return true;}return false;}');
h.push('function extractHtml(text){var t=String(text||"");');
h.push('var i=t.indexOf(FENCE);');
h.push('if(i>-1){var rest=t.slice(i+3);');
h.push('var nl=rest.indexOf(NL);var tag=nl>-1?trim(rest.slice(0,nl)):"";');
h.push('var isTag=tag.length<12&&tag.indexOf("<")===-1&&tag.indexOf(" ")===-1;');
h.push('var body=(nl>-1&&isTag)?rest.slice(nl+1):rest;');
h.push('var j=body.indexOf(FENCE);if(j>-1)body=body.slice(0,j);');
h.push('body=trim(body);if(body&&looksHtml(body))return body;}');
h.push('if(looksHtml(t))return trim(t);');
h.push('return null;}');
h.push('function wrapDoc(html){var l=String(html||"").toLowerCase();');
h.push('if(l.indexOf("<!doctype")>-1||l.indexOf("<html")>-1)return html;');
h.push('return "<!DOCTYPE html><html><head><meta charset=\\"utf-8\\"><meta name=\\"viewport\\" content=\\"width=device-width,initial-scale=1\\"><\/head><body>"+html+"<\/body><\/html>";}');
h.push('function showPreview(html,title){pvEmpty.style.display="none";preview.style.display="block";pvTitle.textContent=title||"Preview";preview.srcdoc=wrapDoc(html);}');
h.push('function addUserCard(text){var el=document.createElement("div");el.className="card user-card";var hd=document.createElement("div");hd.className="card-head";var ic=document.createElement("span");ic.className="card-icon";ic.textContent="\u{1F464}";var ti=document.createElement("span");ti.className="card-title";ti.textContent=text;hd.appendChild(ic);hd.appendChild(ti);el.appendChild(hd);cards.appendChild(el);scrollDown();}');
h.push('function addTypingCard(){var el=document.createElement("div");el.className="typing-card";var td=document.createElement("div");td.className="tdots";td.innerHTML="<span><\/span><span><\/span><span><\/span>";el.appendChild(td);var sp=document.createElement("span");sp.style.cssText="font-size:11px;color:var(--dim);margin-right:8px";sp.textContent="در حال نوشتن...";el.appendChild(sp);cards.appendChild(el);scrollDown();return el;}');
h.push('function addErrCard(msg){var ec=document.createElement("div");ec.className="card err-card";var eh=document.createElement("div");eh.className="card-head";eh.textContent="⚠️ "+msg;ec.appendChild(eh);cards.appendChild(ec);scrollDown();return ec;}');
h.push('function addBotCard(title,fullText,html){');
h.push('var card=document.createElement("div");card.className="card";');
h.push('var head=document.createElement("div");head.className="card-head";');
h.push('var ic=document.createElement("span");ic.className="card-icon";ic.textContent="\u{1F4BB}";');
h.push('var ti=document.createElement("span");ti.className="card-title";ti.textContent=title;');
h.push('head.appendChild(ic);head.appendChild(ti);');
h.push('if(html){var bg=document.createElement("span");bg.className="card-badge";bg.textContent="HTML";head.appendChild(bg);}');
h.push('card.appendChild(head);');
h.push('if(html){');
h.push('var snip=document.createElement("div");snip.className="code-prev";snip.textContent=html.slice(0,300);card.appendChild(snip);');
h.push('card.addEventListener("click",function(){var all=cards.querySelectorAll(".card");for(var k=0;k<all.length;k++){all[k].classList.remove("active");}card.classList.add("active");activeCard=card;showPreview(html,title);});');
h.push('}else{');
h.push('var sub=document.createElement("div");sub.className="card-sub";');
h.push('sub.textContent=fullText?fullText.slice(0,120)+(fullText.length>120?"...":""):"پاسخی دریافت نشد.";');
h.push('card.appendChild(sub);}');
h.push('cards.appendChild(card);scrollDown();');
h.push('if(html){activeCard=card;card.classList.add("active");showPreview(html,title);}');
h.push('return card;}');
h.push('function send(){');
h.push('  var text=trim(inp.value);if(!text||busy)return;');
h.push('  var prompt=text;');
h.push('  hist.push({role:"user",content:prompt});');
h.push('  addUserCard(text);');
h.push('  inp.value="";autoSz();');
h.push('  busy=true;sbtn.disabled=true;');
h.push('  var typingEl=addTypingCard();');
h.push('  var fullText="";var streamErr=null;var finished=false;');
h.push('  function finish(){');
h.push('    if(finished)return;finished=true;');
h.push('    if(typingEl&&typingEl.parentNode)typingEl.remove();');
h.push('    if(streamErr){addErrCard(streamErr);return;}');
h.push('    var html=extractHtml(fullText);');
h.push('    addBotCard(text,fullText,html);');
h.push('    if(fullText)hist.push({role:"assistant",content:fullText});');
h.push('  }');
h.push('  function runStream(msgs,tok){');
h.push('    fetch("/api/code",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:msgs,model:mSel.value,maxTokens:tok})})');
h.push('    .then(function(r){');
h.push('      if(!r.ok)return r.json().catch(function(){return{};}).then(function(e){throw new Error(e.error||"HTTP "+r.status);});');
h.push('      var reader=r.body.getReader();var dec=new TextDecoder();var rbuf="";');
h.push('      function pump(){return reader.read().then(function(res){');
h.push('        if(res.done){rbuf+=dec.decode();var tail=rbuf.split(NL);for(var n=0;n<tail.length;n++)handleLine(tail[n]);rbuf="";finish();return;}');
h.push('        rbuf+=dec.decode(res.value,{stream:true});var rlines=rbuf.split(NL);rbuf=rlines.pop()||"";');
h.push('        for(var i=0;i<rlines.length;i++)handleLine(rlines[i]);return pump();');
h.push('      });}return pump();');
h.push('    })');
h.push('    .catch(function(e){if(finished)return;finished=true;if(typingEl&&typingEl.parentNode)typingEl.remove();addErrCard(e&&e.message?e.message:String(e));busy=false;sbtn.disabled=false;inp.focus();});');
h.push('  }');
h.push('  maxTok=10000;runStream(hist.slice(-2),maxTok);');
h.push('}');
h.push('sbtn.addEventListener("click",function(e){e.preventDefault();send();});');
h.push('inp.addEventListener("keydown",function(e){');
h.push('  var k=e.key||e.keyCode;');
h.push('  if((k==="Enter"||k===13)&&!e.shiftKey&&!e.isComposing){e.preventDefault();e.stopPropagation();send();}');
h.push('});');
h.push('inp.addEventListener("input",autoSz);');
h.push('autoSz();inp.focus();');
h.push('})();<\/script><\/body><\/html>');
return h.join("\n");
})();

async function handleCodeApi(body, env) {
  var msgs = Array.isArray(body.messages)?body.messages:[];
  var model = String(body.model||'deepseek-chat');
  var maxTok = Number(body.maxTokens)||10000;
  if (!env.DEEPSEEK_API_KEY) return jsonR({error:'DEEPSEEK_API_KEY not set'},500);
  var sys = {role:'system',content:'You are a web developer. Return ONLY a complete HTML file with inline CSS and JS inside ```html``` code blocks. Be concise.'};
  var upstream = await fetch(DEEPSEEK_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.DEEPSEEK_API_KEY},body:JSON.stringify({model:model,messages:[sys].concat(msgs),stream:true,max_tokens:maxTok})});
  if (!upstream.ok){var ed=await upstream.json().catch(function(){return{};});return jsonR({error:(ed.error&&ed.error.message)||'Error '+upstream.status},502);}
  var NL=String.fromCharCode(10);
  var stream=new ReadableStream({async start(controller){
    var reader=upstream.body.getReader(),decoder=new TextDecoder(),enc=new TextEncoder(),buf='';
    try{while(true){var r=await reader.read();if(r.done)break;buf+=decoder.decode(r.value,{stream:true});var lines=buf.split(NL);buf=lines.pop()||'';for(var i=0;i<lines.length;i++){var line=lines[i];if(line.indexOf('data: ')!==0)continue;var data=line.slice(6).trim();if(!data||data==='[DONE]')continue;try{var obj=JSON.parse(data);var d=obj.choices&&obj.choices[0]&&obj.choices[0].delta;if(d&&d.content)controller.enqueue(enc.encode('data: '+JSON.stringify({delta:d.content})+NL+NL));}catch(err){}}}}catch(err){try{controller.enqueue(enc.encode('data: '+JSON.stringify({error:err.message})+NL+NL));}catch(e2){}}
    try{controller.enqueue(enc.encode('data: '+JSON.stringify({done:true})+NL+NL));}catch(e3){}
    controller.close();
  }});
  var sh={'Content-Type':'text/event-stream;charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no'};
  for(var k in CORS)sh[k]=CORS[k];
  return new Response(stream,{headers:sh});
}

async function streamDeepSeekDirect(messages, env, model) {
  if (!env.DEEPSEEK_API_KEY) return jsonR({error:'DEEPSEEK_API_KEY not set'},500);
  model = model || 'deepseek-flash';
  var sys = getSystemPrompt();
  var upstream = await fetch(DEEPSEEK_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.DEEPSEEK_API_KEY},body:JSON.stringify({model:model,messages:[sys].concat(messages),stream:true,max_tokens:32000})});
  if (!upstream.ok){var e=await upstream.json().catch(function(){return{};});return jsonR({error:(e.error&&e.error.message)||'DeepSeek '+upstream.status},502);}
  var NL=String.fromCharCode(10);
  var stream=new ReadableStream({async start(controller){
    var reader=upstream.body.getReader(),decoder=new TextDecoder(),enc=new TextEncoder(),buf='';
    try{while(true){var r=await reader.read();if(r.done)break;buf+=decoder.decode(r.value,{stream:true});var lines=buf.split(NL);buf=lines.pop()||'';for(var i=0;i<lines.length;i++){var line=lines[i];if(line.indexOf('data: ')!==0)continue;var data=line.slice(6).trim();if(!data||data==='[DONE]')continue;try{var obj=JSON.parse(data);var d=obj.choices&&obj.choices[0]&&obj.choices[0].delta;if(d&&d.content)controller.enqueue(enc.encode('data: '+JSON.stringify({delta:d.content})+NL+NL));}catch(err){}}}}catch(err){controller.enqueue(enc.encode('data: '+JSON.stringify({error:err.message})+NL+NL));}
    sseSend(controller,{done:true});controller.close();
  }});
  var h={'Content-Type':'text/event-stream;charset=utf-8','Cache-Control':'no-cache'};
  for(var k in CORS)h[k]=CORS[k];
  return new Response(stream,{headers:h});
}


async function streamPerplexityAgent(model, messages, env) {
  if (!env.PERPLEXITY_API_KEY) return jsonR({error:'PERPLEXITY_API_KEY not set'},500);
  var lastMsg = messages[messages.length-1]||{};
  var input = String(lastMsg.content||'');

  var inputArr = [];
  for (var i=0; i<messages.length; i++) {
    inputArr.push({
      role: messages[i].role === 'assistant' ? 'assistant' : 'user',
      content: String(messages[i].content||'')
    });
  }

  var chromeHeaders = {
    'Authorization': 'Bearer '+env.PERPLEXITY_API_KEY,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/event-stream',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.perplexity.ai',
    'Referer': 'https://www.perplexity.ai/',
    'sec-ch-ua': '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'x-api-client': 'web'
  };

  // اول streaming رو امتحان کن
  var bodyObj = {model:model, input:inputArr, stream:true};
  var res = await fetch('https://api.perplexity.ai/v1/agent', {
    method: 'POST',
    headers: chromeHeaders,
    body: JSON.stringify(bodyObj)
  });

  // اگه streaming block شد، بدون stream امتحان کن
  if (!res.ok) {
    chromeHeaders['Accept'] = 'application/json';
    bodyObj = {model:model, input:input};
    res = await fetch('https://api.perplexity.ai/v1/agent', {
      method: 'POST',
      headers: chromeHeaders,
      body: JSON.stringify(bodyObj)
    });
    if (!res.ok) return jsonR({error:'Perplexity '+res.status}, 502);

    var data = await res.json().catch(function(){return null;});
    if (!data) return jsonR({error:'Perplexity: invalid response'}, 502);
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
    if (!text) return jsonR({error:'Perplexity: no text'}, 502);
    var NL2 = String.fromCharCode(10);
    var enc2 = new TextEncoder();
    var stream2 = new ReadableStream({start:function(ctrl){
      ctrl.enqueue(enc2.encode('data: '+JSON.stringify({delta:text})+NL2+NL2));
      ctrl.enqueue(enc2.encode('data: '+JSON.stringify({done:true})+NL2+NL2));
      ctrl.close();
    }});
    var h2={'Content-Type':'text/event-stream;charset=utf-8','Cache-Control':'no-cache'};
    for(var k in CORS)h2[k]=CORS[k];
    return new Response(stream2,{headers:h2});
  }

  // streaming کار کرد - parse کن
  var NL = String.fromCharCode(10);
  var ts = new TransformStream({
    start: function(){this._buf='';this._dec=new TextDecoder();},
    transform: function(chunk, ctrl){
      this._buf += this._dec.decode(chunk,{stream:true});
      var lines = this._buf.split(NL);
      this._buf = lines.pop()||'';
      var enc = new TextEncoder();
      for(var i=0;i<lines.length;i++){
        var line=lines[i];
        if(line.indexOf('data: ')!==0)continue;
        var data=line.slice(6).trim();
        if(!data||data==='[DONE]')continue;
        try{
          var obj=JSON.parse(data);
          var delta=null;
          if(obj.type==='response.output_text.delta'&&obj.delta) delta=obj.delta;
          if(delta) ctrl.enqueue(enc.encode('data: '+JSON.stringify({delta:delta})+NL+NL));
        }catch(e){}
      }
    },
    flush: function(ctrl){
      var enc=new TextEncoder();
      ctrl.enqueue(enc.encode('data: '+JSON.stringify({done:true})+NL+NL));
    }
  });

  res.body.pipeTo(ts.writable).catch(function(){});
  var h={'Content-Type':'text/event-stream;charset=utf-8','Cache-Control':'no-cache'};
  for(var k in CORS)h[k]=CORS[k];
  return new Response(ts.readable,{headers:h});
}

async function tryPerplexity(model, input, sys, env) {
  var bodyObj = {model:model, input:input};
  if(sys && sys.content) bodyObj.instructions = sys.content;
  return await fetch('https://api.perplexity.ai/v1/agent', {
    method: 'POST',
    headers: {'Authorization':'Bearer '+env.PERPLEXITY_API_KEY,'Content-Type':'application/json'},
    body: JSON.stringify(bodyObj)
  });
}

function buildSSE(data) {
  var text = '';
  var output = (data && data.output)||[];
  for (var i=0;i<output.length;i++) {
    if (output[i].type==='message') {
      var content = output[i].content||[];
      for (var j=0;j<content.length;j++) {
        if (content[j].type==='output_text') text += content[j].text||'';
      }
    }
  }
  if (!text) text = 'خطا در دریافت پاسخ';
  var NL = String.fromCharCode(10);
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


export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:CORS});

    // Debug test route
    if (path === '/test-pplx') {
      var key = env.PERPLEXITY_API_KEY||'';
      var chromeH = {
        'Authorization':'Bearer '+key,
        'Content-Type':'application/json',
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'Origin':'https://www.perplexity.ai',
        'Referer':'https://www.perplexity.ai/',
        'sec-ch-ua':'"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
        'sec-ch-ua-mobile':'?0',
        'sec-ch-ua-platform':'"Windows"',
        'sec-fetch-dest':'empty',
        'sec-fetch-mode':'cors',
        'sec-fetch-site':'same-origin'
      };
      var r1 = await fetch('https://api.perplexity.ai/v1/agent',{
        method:'POST',
        headers:chromeH,
        body:JSON.stringify({model:'openai/gpt-5.4-mini',input:'hi'})
      });
      var b1 = await r1.text();
      var model1 = 'unknown';
      try { model1 = JSON.parse(b1).model; } catch(e){}

      var r2 = await fetch('https://api.openai.com/v1/models',{
        headers:{'Authorization':'Bearer test-invalid'}
      });
      var b2 = await r2.text();

      var out = '=== Perplexity ===\n';
      out += 'Status: '+r1.status+'\nCF-Ray: '+(r1.headers.get('cf-ray')||'none')+'\nModel: '+model1+'\n\n';
      out += '=== OpenAI ===\n';
      out += 'Status: '+r2.status+'\n'+b2.slice(0,150);
      return new Response(out, {headers:{'Content-Type':'text/plain'}});
    }

    // Auth check
    var accessCode = env.ACCESS_CODE;
    if (accessCode) {
      if (request.method === 'POST' && path === '/api/auth') {
        var ab = {}; try{ab=await request.json();}catch(e){}
        var ok = String(ab.code||'') === String(accessCode);
        var headers = {'Content-Type':'application/json'};
        for(var k in CORS) headers[k]=CORS[k];
        if (ok) {
          headers['Set-Cookie'] = 'auth='+accessCode+'; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400';
        }
        return new Response(JSON.stringify({ok:ok}), {headers:headers});
      }
      // Check cookie
      var cookie = request.headers.get('cookie')||'';
      var authMatch = cookie.match(/auth=([^;]+)/);
      var authed = authMatch && authMatch[1] === String(accessCode);
      if (!authed) {
        if (path === '/login') return new Response(LOGIN_HTML, {headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'}});
        if (path.indexOf('/api/') === 0) return jsonR({error:'unauthorized'}, 401);
        return new Response(null, {status:302, headers:{...CORS, 'Location':'/login'}});
      }
    }

    if (request.method === 'POST' && path === '/api/chat') {
      var body = {};
      try { body = await request.json(); } catch(e) {}
      var messages = normMsgs(body);
      if (!messages.length) return jsonR({error:'messages required'},400);

      if (body.search === true) {
        return streamPerplexity(messages, env);
      }
      var model = String(body.model || 'deepseek-flash');
      if (model.indexOf('pplx:') === 0) {
        return streamPerplexityAgent(model.slice(5), messages, env);
      }
      return streamDeepSeekDirect(messages, env, model);
    }

    if (request.method === 'POST' && path === '/api/image') {
      var body2 = {};
      try { body2 = await request.json(); } catch(e) {}
      var prompt = String(body2.prompt || '');
      if (!prompt) return jsonR({error:'prompt required'},400);
      return generateImage(prompt, env);
    }

    if (request.method === 'POST' && path === '/api/code') {
      var bodyCode = {}; try{bodyCode=await request.json();}catch(e){}
      return handleCodeApi(bodyCode, env);
    }

    if (request.method === 'POST' && path === '/api/stream') {
      var bodyStream = {}; try{bodyStream=await request.json();}catch(e){}
      var msgsStream = normMsgs(bodyStream);
      return streamDeepSeekDirect(msgsStream, env);
    }

    if (path === '/code') return new Response(CODE_HTML, {
      headers: {'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'}
    });

    return new Response(CHAT_HTML, {
      headers: {'Content-Type':'text/html;charset=utf-8', 'Cache-Control':'no-store'}
    });
  }
};

// ===== Streaming helpers =====
function sseHeaders() {
  var h = {'Content-Type':'text/event-stream;charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no'};
  for (var k in CORS) h[k] = CORS[k];
  return h;
}

function sseSend(controller, obj) {
  var enc = new TextEncoder();
  controller.enqueue(enc.encode('data: ' + JSON.stringify(obj) + String.fromCharCode(10,10)));
}

// ===== DeepSeek Streaming =====
async function streamDeepSeek(messages, env) {
  if (!env.DEEPSEEK_API_KEY) return jsonR({error:'DEEPSEEK_API_KEY not set'},500);

  var sys = getSystemPrompt();
  var all = [sys].concat(messages);
  var upstream = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {'Content-Type':'application/json','Authorization':'Bearer '+env.DEEPSEEK_API_KEY},
    body: JSON.stringify({model:'deepseek-flash', messages:all, stream:true})
  });

  if (!upstream.ok) {
    var e = await upstream.json().catch(function(){return {};});
    return jsonR({error: e.error && e.error.message || ('DeepSeek '+upstream.status)}, 502);
  }

  var NL = String.fromCharCode(10);
  var stream = new ReadableStream({
    async start(controller) {
      var reader = upstream.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      try {
        while (true) {
          var r = await reader.read();
          if (r.done) break;
          buf += decoder.decode(r.value, {stream:true});
          var lines = buf.split(NL);
          buf = lines.pop() || '';
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('data: ') !== 0) continue;
            var data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;
            try {
              var obj = JSON.parse(data);
              var delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
              if (delta && delta.content) {
                sseSend(controller, {delta: delta.content});
              }
            } catch(err) {}
          }
        }
      } catch(err) {
        sseSend(controller, {error: err.message});
      }
      sseSend(controller, {done: true});
      controller.close();
    }
  });

  return new Response(stream, {headers: sseHeaders()});
}

// ===== Perplexity Streaming =====
async function streamPerplexity(messages, env) {
  if (!env.PERPLEXITY_API_KEY) return jsonR({error:'PERPLEXITY_API_KEY not set'},500);

  var sys = getSystemPrompt();
  var all = [sys].concat(messages);
  var upstream = await fetch(PERPLEXITY_URL, {
    method: 'POST',
    headers: {'Content-Type':'application/json','Authorization':'Bearer '+env.PERPLEXITY_API_KEY},
    body: JSON.stringify({model:'sonar', messages:all, stream:true})
  });

  if (!upstream.ok) {
    var e = await upstream.json().catch(function(){return {};});
    return jsonR({error: e.error && e.error.message || ('Perplexity '+upstream.status)}, 502);
  }

  var NL = String.fromCharCode(10);
  var stream = new ReadableStream({
    async start(controller) {
      var reader = upstream.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      var sentSources = false;
      try {
        while (true) {
          var r = await reader.read();
          if (r.done) break;
          buf += decoder.decode(r.value, {stream:true});
          var lines = buf.split(NL);
          buf = lines.pop() || '';
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('data: ') !== 0) continue;
            var data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;
            try {
              var obj = JSON.parse(data);
              var delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
              if (delta && delta.content) {
                sseSend(controller, {delta: delta.content});
              }
              if (!sentSources && obj.citations && obj.citations.length) {
                sseSend(controller, {sources: obj.citations});
                sentSources = true;
              }
            } catch(err) {}
          }
        }
      } catch(err) {
        sseSend(controller, {error: err.message});
      }
      sseSend(controller, {done: true});
      controller.close();
    }
  });

  return new Response(stream, {headers: sseHeaders()});
}
