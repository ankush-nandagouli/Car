'use strict';
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const GROQ_TTS_MODEL = process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english';
const AI_SYSTEM = 'You are a tiny remote robot assistant. Be concise, witty, optionally friendly-sarcastic, and transparent about uncertainty. Never claim you physically saw something unless an image was supplied. Do not issue raw motor commands or claim movement is safe. If asked to patrol, explain that the controller handles a short, low-speed, camera-gated patrol and that camera object detection is not collision avoidance.';

const PORT = Number(process.env.PORT || 10000);
const ROOM_ID = process.env.ROOM_ID || '';
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(x=>x.trim()).filter(Boolean));
const TOKENS = {
  robot: process.env.ROBOT_TOKEN || '',
  controller: process.env.CONTROLLER_TOKEN || '',
  esp32: process.env.ESP32_TOKEN || ''
};
for (const [role, token] of Object.entries(TOKENS)) {
  if (token.length < 32) throw new Error(`${role.toUpperCase()}_TOKEN must be at least 32 characters`);
}
if (ROOM_ID.length < 16) throw new Error('ROOM_ID must be at least 16 characters');
if (!ALLOWED_ORIGINS.size || [...ALLOWED_ORIGINS].some(o=>!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(o))) {
  throw new Error('ALLOWED_ORIGINS must contain exact https:// origins, comma-separated');
}
function safeEqual(a,b) {
  const aa=Buffer.from(String(a)); const bb=Buffer.from(String(b));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}
function sendHttp(res,status,body,type='application/json',origin='') { const h={'content-type':type,'cache-control':'no-store','vary':'Origin'}; if(origin&&ALLOWED_ORIGINS.has(origin))h['access-control-allow-origin']=origin; res.writeHead(status,h); res.end(type==='application/json'?JSON.stringify(body):body); }
function apiGate(req,res){const origin=req.headers.origin||'';if(!ALLOWED_ORIGINS.has(origin)){sendHttp(res,403,{error:'Origin not allowed'},'application/json',origin);return false;}const auth=String(req.headers.authorization||'');const token=auth.startsWith('Bearer ')?auth.slice(7):'';if(!safeEqual(token,TOKENS.controller)||!safeEqual(String(req.headers['x-room-id']||''),ROOM_ID)){sendHttp(res,401,{error:'Controller authentication failed'},'application/json',origin);return false;}return true;}
async function readBody(req,limit=6*1024*1024){const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>limit)throw new Error('Request too large');chunks.push(c)}return Buffer.concat(chunks)}
async function callGemini({messages,imageBase64,mimeType='image/jpeg',personality='witty',sarcasm=60,apiKey=''}){
 const key=String(apiKey||GEMINI_API_KEY||''); if(!key)throw new Error('Gemini key not configured in controller or server environment');
 const history=(messages||[]).slice(-12);const lastUser=[...history].map((m,i)=>m.role==='user'?i:-1).filter(i=>i>=0).pop();const contents=[]; history.forEach((m,i)=>{const parts=[{text:String(m.content||'').slice(0,4000)}];if(i===lastUser&&imageBase64)parts.push({inlineData:{mimeType:mimeType,data:imageBase64}});contents.push({role:m.role==='assistant'?'model':'user',parts});});
 if(!contents.length)contents.push({role:'user',parts:[{text:'Hello!'}]});
 const prompt=AI_SYSTEM+`\nPersonality: ${String(personality).slice(0,30)}. Wit/sarcasm intensity: ${Math.max(0,Math.min(100,Number(sarcasm)||0))}/100. Keep replies short.`;
 const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:prompt}]},contents,generationConfig:{temperature:0.85,maxOutputTokens:300}})});
 const j=await r.json();if(!r.ok)throw new Error(j?.error?.message||`Gemini HTTP ${r.status}`);return j?.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join(' ').trim()||'I have nothing useful to say. Disturbing.';
}
async function callGroq({messages,imageBase64,mimeType='image/jpeg',personality='witty',sarcasm=60,apiKey=''}){
 const key=String(apiKey||GROQ_API_KEY||''); if(!key)throw new Error('Groq key not configured in controller or server environment');
 const system=AI_SYSTEM+`\nPersonality: ${String(personality).slice(0,30)}. Wit/sarcasm intensity: ${Math.max(0,Math.min(100,Number(sarcasm)||0))}/100. Keep replies short.`;
 const msgs=[{role:'system',content:system},...(messages||[]).slice(-12).map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content||'').slice(0,4000)}))];
 if(imageBase64){let i=msgs.length-1;if(i<1)msgs.push({role:'user',content:'Describe this camera frame.'}),i=msgs.length-1;const old=typeof msgs[i].content==='string'?msgs[i].content:'Describe this camera frame.';msgs[i].content=[{type:'text',text:old},{type:'image_url',image_url:{url:`data:${mimeType};base64,${imageBase64}`}}];}
 const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model:GROQ_MODEL,messages:msgs,temperature:0.8,max_tokens:300})});const j=await r.json();if(!r.ok)throw new Error(j?.error?.message||`Groq HTTP ${r.status}`);return j?.choices?.[0]?.message?.content||'My witty module appears to have left the room.';
}
const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){const origin=req.headers.origin||'';if(!ALLOWED_ORIGINS.has(origin)){res.writeHead(403);return res.end()}res.writeHead(204,{'access-control-allow-origin':origin,'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type,authorization,x-room-id,x-gemini-key,x-groq-key','access-control-max-age':'600','vary':'Origin'});return res.end();}
  if(req.url==='/api/assistant'&&req.method==='POST'){
    if(!apiGate(req,res))return;
    try{const b=JSON.parse((await readBody(req)).toString());const args={messages:Array.isArray(b.messages)?b.messages:[],imageBase64:typeof b.imageBase64==='string'?b.imageBase64.replace(/^data:[^,]+,/, '').slice(0,4*1024*1024):'',mimeType:String(b.mimeType||'image/jpeg'),personality:b.personality,sarcasm:b.sarcasm,apiKey:String(req.headers['x-gemini-key']||'')};let answer,provider='';const pref=['groq','gemini'].includes(b.provider)?b.provider:'auto';const order=pref==='auto'?['gemini','groq']:[pref];let errors=[];for(const x of order){try{answer=x==='gemini'?await callGemini(args):await callGroq({...args,apiKey:String(req.headers['x-groq-key']||'')});provider=x;break}catch(e){errors.push(`${x}: ${e.message}`)}}if(!answer)return sendHttp(res,503,{error:'AI providers unavailable',details:errors},'application/json',req.headers.origin||'');return sendHttp(res,200,{answer,provider,usedFallback:pref==='auto'&&provider==='groq'},'application/json',req.headers.origin||'');}catch(e){return sendHttp(res,e.message==='Request too large'?413:400,{error:e.message||'Bad request'},'application/json',req.headers.origin||'');}
  }
  if(req.url==='/api/transcribe'&&req.method==='POST'){
    if(!apiGate(req,res))return;
    try{const groqKey=String(req.headers['x-groq-key']||GROQ_API_KEY||'');if(!groqKey)return sendHttp(res,503,{error:'Enter a Groq API key in controller settings or configure GROQ_API_KEY on server'},'application/json',req.headers.origin||'');const b=JSON.parse((await readBody(req,12*1024*1024)).toString());const buf=Buffer.from(String(b.audioBase64||'').replace(/^data:[^,]+,/,''),'base64');if(!buf.length||buf.length>10*1024*1024)return sendHttp(res,400,{error:'Audio missing or too large'},'application/json',req.headers.origin||'');const form=new FormData();form.append('file',new Blob([buf],{type:b.mimeType||'audio/webm'}),'speech.webm');form.append('model',GROQ_STT_MODEL);form.append('response_format','json');const r=await fetch('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',headers:{authorization:`Bearer ${groqKey}`},body:form});const j=await r.json();if(!r.ok)return sendHttp(res,502,{error:j?.error?.message||'Groq transcription failed'},'application/json',req.headers.origin||'');return sendHttp(res,200,{text:j.text||''},'application/json',req.headers.origin||'');}catch(e){return sendHttp(res,400,{error:e.message||'Transcription failed'},'application/json',req.headers.origin||'');}
  }
  if(req.url==='/api/speech'&&req.method==='POST'){
    if(!apiGate(req,res))return;
    try{const groqKey=String(req.headers['x-groq-key']||GROQ_API_KEY||'');if(!groqKey)return sendHttp(res,503,{error:'Enter a Groq API key in controller settings or configure GROQ_API_KEY on server'},'application/json',req.headers.origin||'');const b=JSON.parse((await readBody(req,256*1024)).toString());const text=String(b.text||'').slice(0,200);if(!text)return sendHttp(res,400,{error:'Text required'},'application/json',req.headers.origin||'');const r=await fetch('https://api.groq.com/openai/v1/audio/speech',{method:'POST',headers:{authorization:`Bearer ${groqKey}`,'content-type':'application/json'},body:JSON.stringify({model:GROQ_TTS_MODEL,input:text,voice:'troy',response_format:'wav'})});if(!r.ok){const t=await r.text();return sendHttp(res,502,{error:t.slice(0,500)||'Groq speech generation failed'},'application/json',req.headers.origin||'');}const audio=Buffer.from(await r.arrayBuffer());const h={'content-type':r.headers.get('content-type')||'audio/wav','cache-control':'no-store','vary':'Origin'};if(ALLOWED_ORIGINS.has(req.headers.origin||''))h['access-control-allow-origin']=req.headers.origin;res.writeHead(200,h);return res.end(audio);}catch(e){return sendHttp(res,400,{error:e.message||'Speech generation failed'},'application/json',req.headers.origin||'');}
  }
  if(req.url==='/api/live-token'&&req.method==='POST'){
    if(!apiGate(req,res))return;
    try{
      const b=JSON.parse((await readBody(req,64*1024)).toString());
      const key=String(req.headers['x-gemini-key']||GEMINI_API_KEY||'');
      if(!key)return sendHttp(res,503,{error:'Enter a Gemini API key in controller settings or configure GEMINI_API_KEY on server'},'application/json',req.headers.origin||'');
      const requested=String(b.model||GEMINI_LIVE_MODEL).trim().replace(/^models\//,'');
      if(!/^[A-Za-z0-9._-]{3,100}$/.test(requested))return sendHttp(res,400,{error:'Invalid Gemini Live model ID'},'application/json',req.headers.origin||'');
      const expireTime=new Date(Date.now()+30*60*1000).toISOString();
      const prompt='You are Buddy, a real-time talking robot assistant. Be concise, witty, optionally friendly-sarcastic, and helpful. Be honest about uncertainty. Do not claim you can see the robot camera unless visual input is actually provided. Never initiate physical movement by yourself. If asked to drive or patrol, explain that driving is handled by explicit controller safety controls.';
      const r=await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens',{method:'POST',headers:{'x-goog-api-key':key,'content-type':'application/json'},body:JSON.stringify({uses:1,expireTime,newSessionExpireTime:new Date(Date.now()+60*1000).toISOString(),liveConnectConstraints:{model:requested.startsWith('models/')?requested:`models/${requested}`,config:{responseModalities:['AUDIO'],systemInstruction:{parts:[{text:prompt}]},sessionResumption:{}}}})});
      const j=await r.json();if(!r.ok)return sendHttp(res,502,{error:j?.error?.message||`Gemini Live token request failed (${r.status})`},'application/json',req.headers.origin||'');
      return sendHttp(res,200,{token:j.name,model:requested,expireTime:j.expireTime||expireTime},'application/json',req.headers.origin||'');
    }catch(e){return sendHttp(res,400,{error:e.message||'Could not create Gemini Live token'},'application/json',req.headers.origin||'');}
  }
  if(req.url==='/health'){
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify({ok:true}));
  }
  res.writeHead(404,{'content-type':'text/plain'});res.end('Not found');
});
const wss=new WebSocket.Server({
  server,
  path:'/ws',
  maxPayload:65536,
  perMessageDeflate:false,
  verifyClient:(info,done)=>{
    const origin=info.origin;
    // Browser clients must have an explicitly allowed origin. ESP32 clients typically send no Origin.
    if(origin && !ALLOWED_ORIGINS.has(origin)) return done(false,403,'Origin not allowed');
    done(true);
  }
});
const peers={robot:null,controller:null,esp32:null};
const limits=new WeakMap();
function send(ws,obj){if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));}
function dropRole(ws){
  const wasCurrent = !!ws.role && peers[ws.role]===ws;
  if(wasCurrent) {
    peers[ws.role]=null;
    for(const p of Object.values(peers)) send(p,{type:'peer-status',role:ws.role,online:false});
    if(ws.role==='controller' && peers.esp32) send(peers.esp32,{type:'stop'});
  }
}
function close(ws,code=1008,reason='Policy violation'){try{ws.close(code,reason)}catch{}}
function validInt(n){return Number.isInteger(n)&&n>=-255&&n<=255;}
function rateOk(ws,limit=35){
  const now=Date.now();let v=limits.get(ws);
  if(!v||now-v.start>=1000){v={start:now,count:0};limits.set(ws,v);}
  v.count++;return v.count<=limit;
}
function relay(to,msg){send(to,msg);}
wss.on('connection',ws=>{
  ws.authenticated=false;ws.role=null;ws.lastDriveAt=0;
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw.toString())}catch{return close(ws,1007,'Invalid JSON')}
    if(!m||typeof m.type!=='string')return close(ws,1007,'Invalid message');
    if(!ws.authenticated){
      if(m.type!=='auth'||!['robot','controller','esp32'].includes(m.role)||m.room!==ROOM_ID||!safeEqual(m.token,TOKENS[m.role])){
        return close(ws,1008,'Authentication failed');
      }
      // Only one active controller at a time; a new authenticated session replaces old.
      if(m.role==='controller'&&peers.controller&&peers.controller!==ws)close(peers.controller,4001,'Controller replaced');
      if(m.role==='robot'&&peers.robot&&peers.robot!==ws)close(peers.robot,4001,'Robot phone replaced');
      if(m.role==='esp32'&&peers.esp32&&peers.esp32!==ws)close(peers.esp32,4001,'ESP32 replaced');
      ws.authenticated=true;ws.role=m.role;peers[m.role]=ws;
      send(ws,{type:'authenticated',role:m.role});
      for(const [role,p] of Object.entries(peers))if(role!==m.role)send(ws,{type:'peer-status',role,online:!!p&&p.readyState===WebSocket.OPEN});
      for(const p of Object.values(peers))if(p&&p!==ws)send(p,{type:'peer-status',role:m.role,online:true});
      return;
    }
    if(!rateOk(ws,ws.role==='controller'?35:80))return close(ws,1008,'Rate limit exceeded');
    if(m.type==='ping'){send(ws,{type:'pong',ts:Date.now()});return;}
    if(ws.role==='controller'){
      if(m.type==='control'){
        if(!validInt(m.left)||!validInt(m.right))return close(ws,1008,'Invalid motor values');
        const now=Date.now();if(now-ws.lastDriveAt<12)return;ws.lastDriveAt=now;
        relay(peers.esp32,{type:'control',left:m.left,right:m.right,seq:Number.isSafeInteger(m.seq)?m.seq:0});
        return;
      }
      if(m.type==='stop'){relay(peers.esp32,{type:'stop'});return;}
      if(m.type==='servo'){if(!Number.isInteger(m.angle)||m.angle<10||m.angle>170)return close(ws,1008,'Invalid servo angle');relay(peers.esp32,{type:'servo',angle:m.angle});return;}
      if(['answer','ice','audio-offer','audio-ice'].includes(m.type)){ 
        if(!peers.robot)return send(ws,{type:'error',message:'Robot phone offline'});
        relay(peers.robot,m);return;
      }
      if(m.type==='robot-live-token'){
        if(!peers.robot)return send(ws,{type:'error',message:'Robot phone offline'});
        const token=String(m.token||'');const model=String(m.model||'gemini-3.8-live');
        if(token.length<20||token.length>4096||!/^[A-Za-z0-9._-]{3,100}$/.test(model.replace(/^models\//,'')))return close(ws,1008,'Invalid robot Live token/model');
        const personality=['witty','sarcastic','helpful','robot'].includes(m.personality)?m.personality:'witty';
        const sarcasm=Math.max(0,Math.min(100,Number.isFinite(Number(m.sarcasm))?Number(m.sarcasm):65));
        relay(peers.robot,{type:'robot-live-token',token,model:model.replace(/^models\//,''),personality,sarcasm});send(ws,{type:'robot-live-command-sent',action:'start'});return;
      }
      if(m.type==='robot-live-stop'){if(!peers.robot)return send(ws,{type:'error',message:'Robot phone offline'});relay(peers.robot,{type:'robot-live-stop'});send(ws,{type:'robot-live-command-sent',action:'stop'});return;}
      return close(ws,1008,'Controller message not allowed');
    }
    if(ws.role==='robot'){
      if(['offer','ice','audio-answer','audio-ice'].includes(m.type)){ 
        if(!peers.controller)return;
        relay(peers.controller,m);return;
      }
      if(m.type==='robot-status'){relay(peers.controller,{type:'robot-status',status:String(m.status||'')});return;}
      if(m.type==='robot-live-status'){relay(peers.controller,{type:'robot-live-status',status:String(m.status||'').slice(0,160)});return;}
      if(m.type==='robot-live-transcript'){relay(peers.controller,{type:'robot-live-transcript',kind:m.kind==='user'?'user':'assistant',text:String(m.text||'').slice(0,400)});return;}
      if(m.type==='robot-live-stop-ack'){relay(peers.controller,{type:'robot-live-status',status:'Robot AI stopped from robot phone'});return;}
      return close(ws,1008,'Robot phone message not allowed');
    }
    if(ws.role==='esp32'){
      if(m.type==='status'){
        relay(peers.controller,{type:'telemetry',left:validInt(m.left)?m.left:0,right:validInt(m.right)?m.right:0,wifi:!!m.wifi,ip:String(m.ip||'')});
        return;
      }
      if(m.type==='ready'){send(ws,{type:'server-ready'});relay(peers.controller,{type:'esp32-ready'});return;}
      return close(ws,1008,'ESP32 message not allowed');
    }
  });
  ws.on('close',()=>dropRole(ws));
  ws.on('error',()=>dropRole(ws));
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Secure signaling listening on ${PORT}; allowed origins: ${[...ALLOWED_ORIGINS].join(', ')}`));
