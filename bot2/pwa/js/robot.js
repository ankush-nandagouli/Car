'use strict';
const $=id=>document.getElementById(id);
let signal=null, camera=null, wakeLock=null, pc=null, remoteIceQueue=[], audioPc=null, audioIceQueue=[];
let robotLiveWs=null, robotLiveContext=null, robotLiveSource=null, robotLiveProcessor=null, robotLivePlayAt=0, robotLiveMuteNode=null;
const setStatus=s=>{$('status').textContent=s};
const send=(obj)=>{if(signal&&signal.readyState===WebSocket.OPEN)signal.send(JSON.stringify(obj))};
function auth(){return {type:'auth',role:'robot',room:$('roomId').value.trim(),token:$('token').value}}
$('connect').onclick=()=>{
 const url=$('signalUrl').value.trim();
 if(!url.startsWith('wss://'))return setStatus('Use a wss:// signaling URL');
 if(!$('roomId').value.trim()||$('token').value.length<32)return setStatus('Enter the configured room ID and robot token');
 signal=new WebSocket(url);
 signal.onopen=()=>signal.send(JSON.stringify(auth()));
 signal.onmessage=async e=>{
  let m;try{m=JSON.parse(e.data)}catch{return}
  if(m.type==='authenticated'){setStatus('Robot phone authenticated securely');if(camera){send({type:'robot-status',status:'camera-ready'});sendOffer();}}
  if(m.type==='error')setStatus('Server error: '+m.message);
  if(m.type==='peer-status'){setStatus(m.role+': '+(m.online?'online':'offline'));if(m.role==='controller'&&m.online&&camera){send({type:'robot-status',status:'camera-ready'});sendOffer();}}
  if(m.type==='telemetry')$('telemetry').textContent=JSON.stringify(m);
  if(m.type==='offer')await answerOffer(m);
  if(m.type==='answer'&&pc) {
    try { await pc.setRemoteDescription(m.sdp); for(const c of remoteIceQueue.splice(0)){try{await pc.addIceCandidate(c)}catch{}} setStatus('WebRTC answer received'); }
    catch(err) { setStatus('WebRTC answer error: '+err.message); }
  }
  if(m.type==='ice'&&m.candidate)await addRemoteIce(m.candidate);
  if(m.type==='audio-offer')await answerAudioOffer(m);
  if(m.type==='audio-ice'&&m.candidate)await addAudioIce(m.candidate);
  if(m.type==='robot-live-token')await startRobotLive(m);
  if(m.type==='robot-live-stop')stopRobotLive('Stopped from controller');
 };
 signal.onclose=()=>{setStatus('Signaling disconnected');stopRobotLive('Signaling disconnected; robot AI stopped')};
 signal.onerror=()=>setStatus('WSS error. Check URL, server, token and origin settings');
};
async function requestWakeLock(){
 try{if('wakeLock'in navigator){wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>setStatus('Wake Lock released'));setStatus('Screen awake while page visible');}
 else setStatus('Wake Lock unsupported in this browser');}catch(e){setStatus('Wake Lock failed: '+e.message)}
}
$('startCamera').onclick=async()=>{
 try{
  camera=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:640},height:{ideal:360},frameRate:{ideal:24,max:30}},audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  $('localVideo').srcObject=camera;await requestWakeLock();try{if(!robotLiveContext)robotLiveContext=new (window.AudioContext||window.webkitAudioContext)();await robotLiveContext.resume()}catch(e){console.warn('Audio context unlock failed',e)}try{await $('controllerAudio').play()}catch{}
  if(signal&&signal.readyState===WebSocket.OPEN){send({type:'robot-status',status:'camera-ready'});sendOffer();}
 }catch(e){setStatus('Camera/Wake Lock error: '+e.message)}
};
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){if(camera)requestWakeLock();if(camera&&signal&&signal.readyState===WebSocket.OPEN)sendOffer()}});
async function addRemoteIce(candidate){if(!pc||!pc.remoteDescription){remoteIceQueue.push(candidate);return}try{await pc.addIceCandidate(candidate)}catch(e){console.warn('ICE candidate rejected',e)}}
async function sendOffer(){
 if(!camera||!signal||signal.readyState!==WebSocket.OPEN)return;
 if(pc)pc.close();
 remoteIceQueue=[];
 pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
 camera.getVideoTracks().forEach(t=>pc.addTrack(t,camera));
 pc.onicecandidate=e=>{if(e.candidate)send({type:'ice',candidate:e.candidate})};
 pc.onconnectionstatechange=()=>setStatus('WebRTC camera: '+pc.connectionState);
 const offer=await pc.createOffer();await pc.setLocalDescription(offer);send({type:'offer',sdp:pc.localDescription});
}
async function answerOffer(m){
 if(!camera){setStatus('Start camera before connecting remote video');return}
 if(pc)pc.close();
 remoteIceQueue=[];
 pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
 camera.getVideoTracks().forEach(t=>pc.addTrack(t,camera));
 pc.onicecandidate=e=>{if(e.candidate)send({type:'ice',candidate:e.candidate})};
 pc.onconnectionstatechange=()=>setStatus('WebRTC camera: '+pc.connectionState);
 await pc.setRemoteDescription(m.sdp);
 for(const c of remoteIceQueue.splice(0)){try{await pc.addIceCandidate(c)}catch{}}
 const answer=await pc.createAnswer();await pc.setLocalDescription(answer);send({type:'answer',sdp:pc.localDescription});
}
$('stop').onclick=()=>{send({type:'robot-status',status:'stop-requested'});setStatus('Use controller STOP or power off motor supply for emergency stop')};
async function addAudioIce(candidate){if(!audioPc||!audioPc.remoteDescription){audioIceQueue.push(candidate);return}try{await audioPc.addIceCandidate(candidate)}catch(e){console.warn('Audio ICE candidate rejected',e)}}
async function answerAudioOffer(m){
 if(!camera||!camera.getAudioTracks().length){$('audioStatus').textContent='Allow microphone permission by starting the camera first.';return}
 try{
  if(audioPc)audioPc.close();audioIceQueue=[];audioPc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
  audioPc.onicecandidate=e=>{if(e.candidate)send({type:'audio-ice',candidate:e.candidate})};
  audioPc.onconnectionstatechange=()=>{$('audioStatus').textContent='Intercom: '+audioPc.connectionState};
  audioPc.ontrack=e=>{const a=$('controllerAudio');a.srcObject=e.streams[0]||new MediaStream([e.track]);a.play().catch(()=>{$('audioStatus').textContent='Controller audio received; browser may require one tap to enable speaker playback.'})};
  await audioPc.setRemoteDescription(m.sdp);
  const tr=audioPc.getTransceivers().find(t=>t.receiver.track.kind==='audio');
  if(tr){tr.direction='sendrecv';await tr.sender.replaceTrack(camera.getAudioTracks()[0])}else audioPc.addTrack(camera.getAudioTracks()[0],new MediaStream([camera.getAudioTracks()[0]]));
  for(const c of audioIceQueue.splice(0)){try{await audioPc.addIceCandidate(c)}catch{}}
  const answer=await audioPc.createAnswer();await audioPc.setLocalDescription(answer);send({type:'audio-answer',sdp:audioPc.localDescription});$('audioStatus').textContent='Intercom audio connected; robot microphone is relaying.';
 }catch(e){$('audioStatus').textContent='Intercom error: '+e.message}
}

// Robot-side Gemini Live voice: token is minted by the backend and relayed by the authenticated controller.
function robotB64(bytes){let bin='';for(let i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);return btoa(bin)}
function robotPcm16Base64(floatSamples){const pcm=new Int16Array(floatSamples.length);for(let i=0;i<floatSamples.length;i++){const v=Math.max(-1,Math.min(1,floatSamples[i]));pcm[i]=v<0?v*32768:v*32767}return robotB64(new Uint8Array(pcm.buffer))}
function robotDownsample16(input,fromRate){if(fromRate===16000)return input;const ratio=fromRate/16000,n=Math.floor(input.length/ratio),out=new Float32Array(n);for(let i=0;i<n;i++){const a=Math.floor(i*ratio),b=Math.min(input.length,Math.floor((i+1)*ratio));let sum=0,count=0;for(let j=a;j<b;j++){sum+=input[j];count++}out[i]=count?sum/count:0}return out}
function robotPlayPcm(base64){if(!robotLiveContext)return;const bin=atob(base64),n=Math.floor(bin.length/2),samples=new Float32Array(n);for(let i=0;i<n;i++){let v=bin.charCodeAt(i*2)|(bin.charCodeAt(i*2+1)<<8);if(v&0x8000)v-=0x10000;samples[i]=v/32768}const buffer=robotLiveContext.createBuffer(1,n,24000);buffer.copyToChannel(samples,0);const src=robotLiveContext.createBufferSource();src.buffer=buffer;src.connect(robotLiveContext.destination);robotLivePlayAt=Math.max(robotLivePlayAt,robotLiveContext.currentTime+0.035);src.start(robotLivePlayAt);robotLivePlayAt+=buffer.duration}
function robotLiveStatus(s){const el=$('robotAiStatus');if(el)el.textContent=s;send({type:'robot-live-status',status:s.slice(0,160)})}
async function startRobotLive(m){
 try{
  if(!camera||!camera.getAudioTracks().some(t=>t.readyState==='live'))throw new Error('Start camera and grant microphone permission on the robot phone first.');
  if(!m.token||typeof m.token!=='string')throw new Error('No short-lived Gemini token received.');
  stopRobotLive('Replacing previous AI session',true);
  if(!robotLiveContext)robotLiveContext=new (window.AudioContext||window.webkitAudioContext)();await robotLiveContext.resume();robotLivePlayAt=robotLiveContext.currentTime;
  robotLiveWs=new WebSocket('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token='+encodeURIComponent(m.token));
  robotLiveWs.onopen=()=>{
   const personality=String(m.personality||'witty'),sarcasm=Math.max(0,Math.min(100,Number(m.sarcasm)||65));
   robotLiveWs.send(JSON.stringify({setup:{model:String(m.model||'gemini-3.8-live').startsWith('models/')?String(m.model||'gemini-3.8-live'):'models/'+String(m.model||'gemini-3.8-live'),responseModalities:['AUDIO'],systemInstruction:{parts:[{text:`You are Buddy, a small robot phone's real-time voice assistant. Personality: ${personality}. Friendly wit/sarcasm: ${sarcasm}/100. Talk naturally and concisely. You are listening to someone physically near the robot phone. Do not claim to see objects unless camera frames are actually provided. You cannot directly control motors; all movement requires explicit controller safety logic. Never imply the camera proves a route is clear.`}]},inputAudioTranscription:{},outputAudioTranscription:{}}}));
   robotLiveStatus('Connecting Gemini Live on robot phone…');
  };
  robotLiveWs.onmessage=ev=>{let data;try{data=JSON.parse(ev.data)}catch{return}if(data.setupComplete){robotLiveStatus('Robot AI is listening and can speak. Keep this page visible.');startRobotLiveMic().catch(e=>robotLiveStatus('Microphone stream failed: '+e.message))}if(data.serverContent){for(const part of (data.serverContent.modelTurn?.parts||[])){if(part.inlineData?.data&&String(part.inlineData.mimeType||'').includes('audio/pcm'))robotPlayPcm(part.inlineData.data);if(part.text)send({type:'robot-live-transcript',kind:'assistant',text:String(part.text).slice(0,400)})}if(data.serverContent.inputTranscription?.text)send({type:'robot-live-transcript',kind:'user',text:String(data.serverContent.inputTranscription.text).slice(0,400)});if(data.serverContent.outputTranscription?.text)send({type:'robot-live-transcript',kind:'assistant',text:String(data.serverContent.outputTranscription.text).slice(0,400)});if(data.serverContent.interrupted)robotLivePlayAt=robotLiveContext?.currentTime||0}if(data.error)robotLiveStatus('Gemini Live error: '+(data.error.message||'Unknown error'))};
  robotLiveWs.onerror=()=>robotLiveStatus('Gemini Live connection error. Check key/model access and internet.');
  robotLiveWs.onclose=()=>{robotLiveWs=null;stopRobotLive('Robot AI session closed',false)};
  const stopBtn=$('robotAiStop');if(stopBtn)stopBtn.disabled=false;
 }catch(e){robotLiveStatus('Could not start robot AI: '+e.message);stopRobotLive('Robot AI failed',false)}
}
async function startRobotLiveMic(){
 if(!camera||!robotLiveContext||!robotLiveWs||robotLiveWs.readyState!==WebSocket.OPEN)return;
 const mic=new MediaStream(camera.getAudioTracks());robotLiveSource=robotLiveContext.createMediaStreamSource(mic);robotLiveMuteNode=robotLiveContext.createGain();robotLiveMuteNode.gain.value=0;
 const sendSamples=input=>{if(!robotLiveWs||robotLiveWs.readyState!==WebSocket.OPEN)return;const samples=robotDownsample16(input,robotLiveContext.sampleRate);if(samples.length)robotLiveWs.send(JSON.stringify({realtimeInput:{audio:{data:robotPcm16Base64(samples),mimeType:'audio/pcm;rate=16000'}}}))};
 if(robotLiveContext.audioWorklet&&window.AudioWorkletNode){const src='class BuddyCapture extends AudioWorkletProcessor { process(inputs) { const c=inputs[0]&&inputs[0][0]; if(c) this.port.postMessage(c.slice()); return true; } } registerProcessor("buddy-capture",BuddyCapture);';const blob=URL.createObjectURL(new Blob([src],{type:'application/javascript'}));try{await robotLiveContext.audioWorklet.addModule(blob)}finally{URL.revokeObjectURL(blob)}robotLiveProcessor=new AudioWorkletNode(robotLiveContext,'buddy-capture');robotLiveProcessor.port.onmessage=e=>sendSamples(e.data);robotLiveSource.connect(robotLiveProcessor);robotLiveProcessor.connect(robotLiveMuteNode);robotLiveMuteNode.connect(robotLiveContext.destination)}else{robotLiveProcessor=robotLiveContext.createScriptProcessor(4096,1,1);robotLiveProcessor.onaudioprocess=e=>sendSamples(e.inputBuffer.getChannelData(0));robotLiveSource.connect(robotLiveProcessor);robotLiveProcessor.connect(robotLiveMuteNode);robotLiveMuteNode.connect(robotLiveContext.destination)}
}
function stopRobotLive(message='Robot AI stopped',closeSocket=true){try{if(robotLiveProcessor){robotLiveProcessor.disconnect();robotLiveProcessor.onaudioprocess=null;if(robotLiveProcessor.port)robotLiveProcessor.port.onmessage=null;robotLiveProcessor=null}if(robotLiveSource){robotLiveSource.disconnect();robotLiveSource=null}if(robotLiveMuteNode){robotLiveMuteNode.disconnect();robotLiveMuteNode=null}if(closeSocket&&robotLiveWs){const w=robotLiveWs;robotLiveWs=null;w.close()}}catch{}const b=$('robotAiStop');if(b)b.disabled=true;if(message)robotLiveStatus(message)}
$('robotAiStop').onclick=()=>{stopRobotLive('Stopped from robot phone');send({type:'robot-live-stop-ack'})};

window.addEventListener('beforeunload',()=>{try{stopRobotLive('Robot page closed');camera?.getTracks().forEach(t=>t.stop());pc?.close();audioPc?.close();robotLiveContext?.close().catch(()=>{});signal?.close()}catch{}});
