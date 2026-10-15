/* Upstream OpenBot Web Controller with servo/lights accessory controls. */
import {Connection} from './websocket/connection.js'
import {Keyboard} from './keyboardHandlers/keyboard.js'
import {BotMessageHandler} from './keyboardHandlers/bot-message-handler'
import {Commands} from './keyboardHandlers/commands'
import {RemoteKeyboard} from './keyboardHandlers/remote_keyboard'
const connection = new Connection()
const SESSION_KEY = 'openbotSession'
function readSession() { try { const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); return s && s.token && s.expiresAt > Date.now() ? s : null } catch (_) { return null } }
export let signedInUser = readSession()
let connectedToSignaling = false
let stopActiveTouchDrive = () => {}
const accessoryState = { front: false, rear: false, hazard: false, angle: 90 }
const motorTuningState = { maxPwm: 180, minStartPwm: 0, sensitivity: 100, timeoutMs: 2000 }
function syncAccessoryControls() {
  const setToggle = (id, on) => { const b = document.getElementById(id); if (!b) return; b.textContent = on ? 'ON' : 'OFF'; b.setAttribute('aria-pressed', String(on)); b.classList.toggle('is-on', on) }
  setToggle('front-light-toggle', accessoryState.front); setToggle('rear-light-toggle', accessoryState.rear); setToggle('hazard-toggle', accessoryState.hazard)
  const angle = document.getElementById('servo-angle'), output = document.getElementById('servo-angle-value')
  if (angle) angle.value = String(accessoryState.angle); if (output) output.textContent = accessoryState.angle + '°'
}
function syncMotorTuningControls() {
  const pairs = [['motor-max-pwm','motor-max-pwm-value','maxPwm',''],['motor-min-pwm','motor-min-pwm-value','minStartPwm',''],['motor-sensitivity','motor-sensitivity-value','sensitivity','%'],['motor-timeout','motor-timeout-value','timeoutMs',' ms']]
  for (const [inputId, outputId, key, suffix] of pairs) {
    const input=document.getElementById(inputId), output=document.getElementById(outputId)
    if(input)input.value=String(motorTuningState[key]); if(output)output.textContent=String(motorTuningState[key])+suffix
  }
}
function initMotorTuning() {
  const pairs=[['motor-max-pwm','maxPwm','motor-max-pwm-value',''],['motor-min-pwm','minStartPwm','motor-min-pwm-value',''],['motor-sensitivity','sensitivity','motor-sensitivity-value','%'],['motor-timeout','timeoutMs','motor-timeout-value',' ms']]
  for (const [id,key,outId,suffix] of pairs) document.getElementById(id)?.addEventListener('input',e=>{motorTuningState[key]=Number(e.target.value);const out=document.getElementById(outId);if(out)out.textContent=String(motorTuningState[key])+suffix})
  document.getElementById('apply-motor-tuning')?.addEventListener('click',()=>sendAuxCommand('MOTOR_TUNING',{...motorTuningState}))
  syncMotorTuningControls()
}

function setAccessoryStatus(text, good=false) { const el=document.getElementById('accessory-status'); if(el){el.textContent=text;el.classList.toggle('is-connected',good)} }
function sendAuxCommand(command, values={}) {
  if(!signedInUser?.roomId || !signedInUser?.token){setAccessoryStatus('Sign in with the configured OpenBot username first.');return}
  if(!connectedToSignaling){setAccessoryStatus('Signaling server unavailable; command not sent.');return}
  connection.send(JSON.stringify({command,...values,roomId:signedInUser.roomId}))
  setAccessoryStatus('Sent '+command.replaceAll('_',' ').toLowerCase()+'. Waiting for Robot response.',true)
}
function initTouchControls(sendToBot){
 const speed=document.getElementById('drive-speed'), speedValue=document.getElementById('drive-speed-value')
 const buttons=Array.from(document.querySelectorAll('[data-drive-l][data-drive-r]'))
 let activeButton=null, repeatTimer=null
 const sendStop=()=>sendToBot(JSON.stringify({driveCmd:{l:0,r:0}}))
 const sendDirection=button=>{
   if(!button)return
   const scale=Math.max(0.1,Math.min(1,(Number(speed?.value)||40)/100))
   const l=Math.max(-1,Math.min(1,Number(button.dataset.driveL)*scale))
   const r=Math.max(-1,Math.min(1,Number(button.dataset.driveR)*scale))
   sendToBot(JSON.stringify({driveCmd:{l,r}}))
 }
 const stop=()=>{
   if(repeatTimer!==null){clearInterval(repeatTimer);repeatTimer=null}
   if(activeButton){activeButton.classList.remove('pressed');activeButton=null;sendStop()}
 }
 speed?.addEventListener('input',()=>{if(speedValue)speedValue.textContent=speed.value+'%';if(activeButton)sendDirection(activeButton)})
 buttons.forEach(button=>{
   button.addEventListener('pointerdown',event=>{
     if(event.button!==undefined&&event.button!==0)return
     event.preventDefault()
     stop()
     activeButton=button;button.classList.add('pressed')
     try{button.setPointerCapture(event.pointerId)}catch(_){}
     sendDirection(button)
     repeatTimer=setInterval(()=>sendDirection(activeButton),120)
   })
   button.addEventListener('pointerup',stop)
   button.addEventListener('pointercancel',stop)
   button.addEventListener('lostpointercapture',stop)
   button.addEventListener('contextmenu',event=>event.preventDefault())
 })
 stopActiveTouchDrive=stop
 window.addEventListener('blur',stop)
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stop()})
}

function initAccessories(){
 const angle=document.getElementById('servo-angle'), angleValue=document.getElementById('servo-angle-value')
 const sendAngle=()=>{const deg=Math.max(20,Math.min(160,Number(angle.value)||90));accessoryState.angle=deg;angle.value=String(deg);angleValue.textContent=deg+'°';sendAuxCommand('SERVO_ANGLE',{angle:deg})}
 angle?.addEventListener('input',()=>{angleValue.textContent=angle.value+'°'})
 angle?.addEventListener('change',sendAngle)
 document.getElementById('servo-left')?.addEventListener('click',()=>{angle.value=String(Math.max(20,Number(angle.value)-10));sendAngle()})
 document.getElementById('servo-center')?.addEventListener('click',()=>{angle.value='90';sendAngle()})
 document.getElementById('servo-right')?.addEventListener('click',()=>{angle.value=String(Math.min(160,Number(angle.value)+10));sendAngle()})
 const sendLightState=()=>sendAuxCommand('LIGHTS',{front:accessoryState.front,rear:accessoryState.rear})
 document.getElementById('front-light-toggle')?.addEventListener('click',()=>{accessoryState.front=!accessoryState.front;syncAccessoryControls();sendLightState()})
 document.getElementById('rear-light-toggle')?.addEventListener('click',()=>{accessoryState.rear=!accessoryState.rear;syncAccessoryControls();sendLightState()})
 document.getElementById('hazard-toggle')?.addEventListener('click',()=>{accessoryState.hazard=!accessoryState.hazard;syncAccessoryControls();sendAuxCommand('HAZARD',{enabled:accessoryState.hazard})})
 // Avoid a keydown that begins while focus is inside the angle slider or buttons
 // from also driving the vehicle via the global keyboard handler.
 document.querySelectorAll('.accessory-card, .drive-card, .motor-tuning-card').forEach(card => card.addEventListener('keydown', e => {
   if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','Escape','w','a','s','d'].includes(e.key)) e.stopPropagation()
 }))
}
(async()=>{
 const keyboard=new Keyboard(), botMessageHandler=new BotMessageHandler(connection)
 const onData=data=>{let msg;try{msg=JSON.parse(data)}catch(e){console.warn('Invalid message',e);return}if(msg.command==='CONNECTED'){setAccessoryStatus('Robot phone connected; negotiating video.',true);accessoryState.front=false;accessoryState.rear=false;accessoryState.hazard=false;accessoryState.angle=90;syncAccessoryControls();sendAuxCommand('LIGHTS',{front:false,rear:false});sendAuxCommand('HAZARD',{enabled:false});sendAuxCommand('SERVO_ANGLE',{angle:90})}if(msg.command==='DISCONNECTED'){stopActiveTouchDrive();setAccessoryStatus('Robot/controller connection lost. Drive should stop.',false)}const status=msg.status??msg;if(status.SERVO_ANGLE!==undefined){accessoryState.angle=Math.max(20,Math.min(160,Number(status.SERVO_ANGLE)||90));syncAccessoryControls();setAccessoryStatus('Servo angle: '+accessoryState.angle+'°',true)}if(status.HAZARD!==undefined){accessoryState.hazard=String(status.HAZARD).toLowerCase()==='true';syncAccessoryControls();setAccessoryStatus('Hazards '+(accessoryState.hazard?'on':'off')+'.',true)}if(status.LIGHTS!==undefined){const parts=String(status.LIGHTS).split(',');if(parts.length===2){accessoryState.front=parts[0]==='1';accessoryState.rear=parts[1]==='1';syncAccessoryControls()}setAccessoryStatus('Light command acknowledged.',true)}if(status.MOTOR_TUNING!==undefined){const v=String(status.MOTOR_TUNING).split(',').map(Number);if(v.length===4&&v.every(Number.isFinite)){motorTuningState.maxPwm=Math.max(50,Math.min(255,v[0]));motorTuningState.minStartPwm=Math.max(0,Math.min(100,v[1]));motorTuningState.sensitivity=Math.max(50,Math.min(200,v[2]));motorTuningState.timeoutMs=Math.max(1000,Math.min(10000,v[3]));syncMotorTuningControls();setAccessoryStatus('Motor tuning synced with ESP32.',true)}}botMessageHandler.handle(status)}
 const onQuit=()=>{stopActiveTouchDrive();connection.stop();connectedToSignaling=false}
 const sendToBot=key=>{if(!signedInUser?.roomId || !signedInUser?.token){console.error('Sign in with the configured OpenBot username first.');return}let msg;try{msg=JSON.parse(key)}catch(e){console.error('Invalid command',e);return}connection.send(JSON.stringify({...msg,roomId:signedInUser.roomId}))}
 const command=new Commands(sendToBot), remoteKeyboard=new RemoteKeyboard(command.getCommandHandler())
 keyboard.start(key=>remoteKeyboard.processKey(key),onQuit)
 initTouchControls(sendToBot)
 try{await connection.start(onData,()=>{connectedToSignaling=true;if(signedInUser?.roomId)sendId()});connectedToSignaling=true;setAccessoryStatus('Signaling connected; waiting for Robot phone.',true)}catch(e){setAccessoryStatus('Signaling connection failed. Check server URL.');console.error('WebSocket connection failed',e)}
})()
const signInButton=document.getElementsByClassName('google-sign-in-button')[0]
const loginDialog=document.getElementById('login-dialog')
const loginForm=document.getElementById('login-form')
const loginError=document.getElementById('login-error')
const updateSignInButton=()=>{if(signInButton)signInButton.textContent=signedInUser?`Signed in: ${signedInUser.username}`:'Sign in'}
signInButton?.addEventListener('click',()=>{if(signedInUser){document.querySelector('.logout-wrapper')?.classList.add('is-open');const exp=document.querySelector('.plan-expiration-model');if(exp)exp.style.display='none'}else if(loginDialog?.showModal)loginDialog.showModal();else loginDialog?.setAttribute('open','')})
document.getElementById('login-cancel-button')?.addEventListener('click',()=>loginDialog?.close())
loginForm?.addEventListener('submit',async event=>{
 event.preventDefault(); if(loginError)loginError.textContent=''
 const username=String(document.getElementById('login-username')?.value||'').trim()
 const password=String(document.getElementById('login-password')?.value||'')
 const submit=loginForm.querySelector('[type="submit"]'); if(submit)submit.disabled=true
 try {
   const response=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password,clientType:'browser'})})
   const result=await response.json().catch(()=>({}))
   if(!response.ok)throw new Error(result.error||'Sign-in failed')
   signedInUser=result; sessionStorage.setItem(SESSION_KEY,JSON.stringify(result)); updateSignInButton(); loginDialog?.close();
   if(connectedToSignaling)sendId()
   setAccessoryStatus('Signed in; waiting for Robot phone.',true)
 } catch(error) { if(loginError)loginError.textContent=error.message||'Unable to sign in'; else setAccessoryStatus(error.message||'Unable to sign in') }
 finally { if(submit)submit.disabled=false }
})
const logoutWrapper=document.querySelector('.logout-wrapper')
logoutWrapper?.addEventListener('click',e=>{if(e.target===logoutWrapper)hideLogoutWrapper()})
document.getElementById('logout-cancel-button')?.addEventListener('click',e=>{e.stopPropagation();hideLogoutWrapper()})
document.getElementById('logout-ok-button')?.addEventListener('click',e=>{e.stopPropagation();hideLogoutWrapper();signOut()})
document.getElementById('subscribe-button')?.addEventListener('click',handleSubscription)
initAccessories();syncAccessoryControls();initMotorTuning(); updateSignInButton()
async function sendId(){
 if(!signedInUser?.roomId || !signedInUser?.token || !connectedToSignaling) return
 connection.send(JSON.stringify({roomId:signedInUser.roomId,clientType:'browser',authToken:signedInUser.token}))
}
function signOut(){
 stopActiveTouchDrive()
 if(connection.send&&signedInUser?.roomId){connection.send(JSON.stringify({command:'LIGHTS',front:false,rear:false,roomId:signedInUser.roomId}));connection.send(JSON.stringify({command:'HAZARD',enabled:false,roomId:signedInUser.roomId}));connection.send(JSON.stringify({driveCmd:{l:0,r:0},roomId:signedInUser.roomId}))}
 signedInUser=null; sessionStorage.removeItem(SESSION_KEY); connectedToSignaling=false; updateSignInButton(); setAccessoryStatus('Signed out.')
 setTimeout(()=>{connection.stop();window.location.reload()},150)
}
function hideLogoutWrapper(){document.querySelector('.logout-wrapper')?.classList.remove('is-open')}
function handleSubscription(){console.log('Navigate to subscription page')}
