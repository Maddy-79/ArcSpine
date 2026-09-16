const SERVICE_UUID="4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHAR_UUID="beb5483e-36e1-4688-b7f5-ea07361b26a8";
const CMD_UUID="7b9e1001-4b8a-4c18-9f21-0c2e8a8c1001";
const DEVICE_NAME="Arc-Spine-Wearable";

const $=id=>document.getElementById(id);
let bleDevice=null, characteristic=null, cmdCharacteristic=null, ws=null;
let connected=false, transport="—", lastSlouch=false, slouchStart=null, lastTick=Date.now();
let history=[], historySigned=[], events=[], sessionStart=null, samples=0, totalCorrect=0, totalIncorrect=0, currentGood=0, longestGood=0, alertCount=0, baseline=null;
// slouchState is the current confirmed posture-bad state. It flips instantly (no time delay) —
// the safe zone (hysteresis) alone is what prevents flicker right at the threshold.
let slouchState=false;
let settings=JSON.parse(localStorage.getItem("Arc-Spine_settings")||'{"angle":15,"buzzDuration":5,"safeZone":4,"notify":true,"sound":false,"buzzer":true}');
if(settings.buzzDuration==null){settings.buzzDuration=settings.delay||5;delete settings.delay;}
let sessions=JSON.parse(localStorage.getItem("Arc-Spine_sessions")||"[]");

function init(){
  $("angleRange").value=settings.angle; $("delayRange").value=settings.buzzDuration; $("safeZoneRange").value=settings.safeZone;
  $("angleOut").textContent=settings.angle+"°"; $("delayOut").textContent=settings.buzzDuration+" s"; $("safeZoneOut").textContent="±"+settings.safeZone+"°";
  $("notifyToggle").checked=settings.notify; $("soundToggle").checked=settings.sound; $("buzzerToggle").checked=settings.buzzer;
  $("wsUrl").value=localStorage.getItem("Arc-Spine_ws")||"ws://192.168.4.1:81";
  document.querySelectorAll(".nav-btn").forEach(b=>b.onclick=()=>showView(b.dataset.view));
  $("connectBtn").onclick=connectWiFi; $("deviceConnect").onclick=connectWiFi;
  $("calibrateBtn").onclick=calibrate; $("calibrateDevice").onclick=calibrate;
  $("wsConnect").onclick=connectWiFi; $("clearEvents").onclick=()=>{events=[];renderEvents()};
  $("resetData").onclick=()=>{if(confirm("Delete saved Arc-Spine history and reset analytics?")){sessions=[];localStorage.removeItem("Arc-Spine_sessions");renderHistory();renderWeek();toast("Local history deleted")}};
  $("angleRange").oninput=e=>{settings.angle=+e.target.value;saveSettings();$("angleOut").textContent=settings.angle+"°"};
  $("delayRange").oninput=e=>{settings.buzzDuration=+e.target.value;saveSettings();$("delayOut").textContent=settings.buzzDuration+" s"};
  $("safeZoneRange").oninput=e=>{settings.safeZone=+e.target.value;saveSettings();$("safeZoneOut").textContent="±"+settings.safeZone+"°"};
  $("notifyToggle").onchange=e=>{settings.notify=e.target.checked;saveSettings();if(settings.notify)requestNotifyPermission()};
  $("soundToggle").onchange=e=>{settings.sound=e.target.checked;saveSettings();if(settings.sound)beep()};
  $("buzzerToggle").onchange=e=>{settings.buzzer=e.target.checked;saveSettings();toast(settings.buzzer?"Vibration motor enabled":"Vibration motor disabled — reminders will be silent")};
  $("menuBtn").onclick=()=>$("sidebar").classList.toggle("open");
  document.addEventListener("pointerdown",ensureAudio,{once:true});
  if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
  renderHistory();renderWeek();drawAll();setInterval(tick,1000);
}
function saveSettings(){
  localStorage.setItem("Arc-Spine_settings",JSON.stringify(settings));
  syncSettingsToDevice();
}
function syncSettingsToDevice(){
  // angle/safeZone let the ESP32 apply the same hysteresis for its own instantaneous slouch
  // detection, so the physical vibration and the on-screen status never disagree. buzzDuration
  // is how long a single buzz pulses for. buzzerEnabled is a hard on/off for the motor only —
  // browser notifications keep working even when this is off.
  sendCommand({cmd:"settings",angle:settings.angle,buzzDuration:settings.buzzDuration,safeZone:settings.safeZone,buzzerEnabled:settings.buzzer});
}
function showView(id){
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===id));
  document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.view===id));
  $("pageTitle").textContent=id[0].toUpperCase()+id.slice(1);
  $("sidebar").classList.remove("open");
  if(id==="history")renderHistory(); if(id==="analytics"){drawWeek();updateStats()}
}
async function connectBLE(){
  ensureAudio();if(settings.notify)requestNotifyPermission();
  if(!navigator.bluetooth){toast("Web Bluetooth is unavailable here. Use Chrome on Android or desktop.");return}
  try{
    bleDevice=await navigator.bluetooth.requestDevice({filters:[{name:DEVICE_NAME},{services:[SERVICE_UUID]}],optionalServices:[SERVICE_UUID]});
    bleDevice.addEventListener("gattserverdisconnected",()=>{connected=false;setConnection(false);finishSession();renderHistory();renderWeek();});
    const server=await bleDevice.gatt.connect(), service=await server.getPrimaryService(SERVICE_UUID);
    characteristic=await service.getCharacteristic(CHAR_UUID);
    try{cmdCharacteristic=await service.getCharacteristic(CMD_UUID)}catch(e){cmdCharacteristic=null}
    await characteristic.startNotifications();
    characteristic.addEventListener("characteristicvaluechanged",onBLEData);
    connected=true;transport="BLE";setConnection(true);startSession();syncSettingsToDevice();
    toast("Arc-Spine connected over Bluetooth");
  }catch(e){console.error(e);toast("Bluetooth connection failed: "+e.message)}
}
function setConnection(on){
  $("connectBtn").textContent=on?"Connected":"Connect device";
  $("deviceConnect").textContent=on?"Connected":"Connect with Bluetooth";
  $("connectionLine").textContent=on?`Connected via ${transport}`:"Device not connected";
  $("deviceState").textContent=on?"Connected and monitoring":"Not connected";
  $("transport").textContent=transport;
  $("telemetry").textContent=on?"Listening":"Waiting";
  $("connectBtn").classList.toggle("connected",on);
  $("deviceName").textContent=bleDevice?.name||DEVICE_NAME;
}
function onBLEData(e){const raw=new TextDecoder().decode(e.target.value);handlePayload(raw)}
function handlePayload(raw){
  let data;
  try{data=JSON.parse(raw)}catch(_){data={event:raw.trim()}};
  if(data.dev==null && data.pitch==null && data.event){
    const dev=history.at(-1)||0;
    if(data.event==="SLOUCH_DETECTED") evaluateSlouch(true,dev);
    if(data.event==="POSTURE_OK") evaluateSlouch(false,dev);
    return;
  }
  const dev=Math.abs(Number(data.dev ?? data.deviation ?? 0));
  // signedDev keeps the direction (which way you're leaning) for the chart; fall back to the
  // unsigned magnitude for devices/firmware that don't send it, so the chart still works.
  const devSigned=data.signedDev!=null?Number(data.signedDev):dev;
  history.push(dev); if(history.length>600)history.shift();
  historySigned.push(devSigned); if(historySigned.length>600)historySigned.shift();
  samples++;
  // Pass the device's own (already hardware-debounced) slouch flag through when present; otherwise
  // fall back to computing it here from the raw angle.
  evaluateSlouch(data.slouch==null?null:Boolean(data.slouch),dev);
  updateStats(); drawAngle();
}
// --- Safe zone (hysteresis), instantaneous reaction ---
// settings.safeZone is a +/- tolerance band around the warning angle. Small, natural sway inside
// that band never flips the state: once you're "OK" you must exceed angle+safeZone to be flagged,
// and once you're "slouching" you must drop back below angle-safeZone to be cleared. This is what
// stops the status from chattering when the live deviation is sitting right on the threshold —
// with no added waiting period, the status still flips the instant that band is crossed.
function rawSlouchFromAngle(dev){
  const lo=Math.max(0,settings.angle-settings.safeZone), hi=settings.angle+settings.safeZone;
  return slouchState ? dev>lo : dev>hi;
}
function evaluateSlouch(deviceSlouch,dev){
  slouchState = deviceSlouch==null ? rawSlouchFromAngle(dev) : deviceSlouch;
  handlePosture(slouchState,dev);
}
function startSession(){
  resetSessionState();
}
function resetSessionState(){
  history=[]; historySigned=[]; events=[]; samples=0;
  totalCorrect=0; totalIncorrect=0; currentGood=0; longestGood=0; alertCount=0;
  lastSlouch=false; slouchStart=null; lastTick=Date.now(); sessionStart=Date.now();
  slouchState=false;
  renderEvents();
}
function handlePosture(slouch,dev){
  const now=Date.now();
  const sec=lastTick?Math.min(2,(now-lastTick)/1000):0;
  if(lastSlouch){
    totalIncorrect+=sec;
    currentGood=0;
  } else {
    totalCorrect+=sec;
    currentGood+=sec;
    if(currentGood>longestGood)longestGood=currentGood;
  }
  lastTick=now;
  if(slouch&&!lastSlouch){
    slouchStart=now; alertCount++; addEvent("warning","Posture strain detected",`${dev.toFixed(1)}° deviation`);
    notifyUser("Posture reminder","Please straighten your back.");
  }
  if(!slouch&&lastSlouch){
    addEvent("good","Posture restored",`Back within your personal baseline`);
  }
  lastSlouch=slouch;
  renderStatus(slouch,dev); updateStats();
}
function renderStatus(slouch,dev){
  $("statusCard").className="hero-status "+(slouch?"bad":"good");
  $("statusText").textContent=slouch?"POSTURE STRAIN DETECTED":"POSTURE OPTIMAL";
  $("statusHint").textContent=slouch?"Straighten gently and hold your upright position.":"Keep your shoulders relaxed and your spine comfortably upright.";
  $("ringValue").textContent=dev.toFixed(1)+"°";
  $("ring").style.setProperty("--p",Math.min(100,dev/Math.max(1,settings.angle)*100)+"%");
}
function tick(){
  if(!connected)return;
  const now=Date.now(),sec=Math.min(1.2,(now-lastTick)/1000);lastTick=now;
  if(lastSlouch){
    totalIncorrect+=sec;
    currentGood=0;
  } else {
    totalCorrect+=sec;
    currentGood+=sec;
    if(currentGood>longestGood)longestGood=currentGood;
  }
  updateStats();
}
function updateStats(){
  const total=totalCorrect+totalIncorrect, score=total?Math.round(totalCorrect/total*100):null;
  $("correct").textContent=formatSec(totalCorrect);$("incorrect").textContent=formatSec(totalIncorrect);
  $("alerts").textContent=alertCount;$("streak").textContent=formatSec(longestGood);
  $("score").textContent=score==null?"—":score+"%";$("todayScore").textContent=score==null?"—":score+"%";
  $("correctPct").textContent=total?Math.round(totalCorrect/total*100)+"%":"0%";
  $("badPct").textContent=total?Math.round(totalIncorrect/total*100)+"%":"0%";
  const avg=history.length?history.reduce((a,b)=>a+b,0)/history.length:0, s=[...history].sort((a,b)=>a-b);
  const med=s.length?(s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2):0;
  $("avg").textContent=avg.toFixed(1)+"°";$("median").textContent=med.toFixed(1)+"°";$("maxDev").textContent=(Math.max(0,...history)).toFixed(1)+"°";$("samples").textContent=samples;
  $("dev").textContent=(history.at(-1)||0).toFixed(1)+"°";
  $("insight").textContent=score==null?"Connect the wearable and complete a session to generate insights.":score>=90?"Excellent consistency. Your next goal is to maintain this level for longer sessions.":score>=75?"Good progress. Focus on reducing the duration of sustained slouch periods.":"Use the haptic reminders as prompts to reset your posture and build longer comfortable upright periods.";
  drawTime();
}
function formatSec(x){x=Math.round(x);const m=Math.floor(x/60),s=x%60;return m?`${m}m ${s}s`:`${s}s`}
function addEvent(type,title,detail){events.unshift({type,title,detail,time:new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})});events=events.slice(0,12);renderEvents()}
function renderEvents(){
  $("events").classList.toggle("empty",!events.length);
  $("events").innerHTML=events.length?events.map(e=>`<div class="event ${e.type}"><span>${e.type==="good"?"✓":"!"}</span><div><b>${e.title}</b><small>${e.detail} • ${e.time}</small></div></div>`).join(""):"No events yet.";
}
// --- Audio unlock ---
// Browsers require a real user gesture before an AudioContext will actually produce sound;
// creating a brand-new one on every alert (as before) meant it was almost always silent because
// it never got past the "suspended" state. We create ONE context lazily on first interaction
// (any click/tap, or Connect) and just resume() it from then on.
let audioCtx=null;
function ensureAudio(){
  if(!audioCtx){try{audioCtx=new (window.AudioContext||window.webkitAudioContext)()}catch(_){return null}}
  if(audioCtx.state==="suspended")audioCtx.resume().catch(()=>{});
  return audioCtx;
}
function beep(){
  const ctx=ensureAudio();if(!ctx)return;
  try{const o=ctx.createOscillator(),g=ctx.createGain();o.frequency.value=720;g.gain.value=.04;o.connect(g);g.connect(ctx.destination);o.start();o.stop(ctx.currentTime+.16)}catch(_){}
}
// --- Notification permission ---
// Request once (guarded), ideally from a real click, and always tell the user what happened —
// silently calling requestPermission() on every posture event (as before) could spam/ignore the
// prompt and gave no feedback at all when it was blocked.
let notifyPermissionRequested=false;
function requestNotifyPermission(){
  if(!("Notification" in window))return;
  if(Notification.permission==="default" && !notifyPermissionRequested){
    notifyPermissionRequested=true;
    Notification.requestPermission().then(perm=>{
      if(perm==="granted")toast("Notifications enabled");
      else toast("Notifications blocked — enable them in your browser's site settings to get slouch alerts.");
    }).catch(()=>{});
  }
}
function notifyUser(title,body){
  if(settings.notify && "Notification" in window){
    if(Notification.permission==="granted")new Notification(title,{body});
    else requestNotifyPermission();
  }
  if(settings.sound)beep();
}
async function calibrate(){
  if(!connected){toast("Connect the wearable first.");return}
  $("calStatus").textContent="Hold an upright, comfortable posture for 3 seconds…";
  $("calibrateBtn").disabled=true;$("calibrateDevice").disabled=true;
  sendCommand({cmd:"calibrate"});
  let n=3;while(n){$("calStatus").textContent=`Calibrating… ${n}`;await new Promise(r=>setTimeout(r,1000));n--}
  baseline="ESP32 calibration requested";$("baseline").textContent="Baseline: set by device";$("calStatus").textContent="Calibration complete";
  $("calibrateBtn").disabled=false;$("calibrateDevice").disabled=false;toast("Calibration complete");
}
async function sendCommand(obj){
  const msg=JSON.stringify(obj);
  if(ws && ws.readyState===WebSocket.OPEN){ws.send(msg);return}
  if(cmdCharacteristic){try{await cmdCharacteristic.writeValue(new TextEncoder().encode(msg));}catch(e){console.warn(e)}}
}
function connectWiFi(){
  ensureAudio();if(settings.notify)requestNotifyPermission();
  const url=$("wsUrl").value.trim();if(!url)return toast("Enter a WebSocket URL.");
  localStorage.setItem("Arc-Spine_ws",url);
  try{
    ws=new WebSocket(url);
    ws.onopen=()=>{connected=true;transport="Wi‑Fi";setConnection(true);startSession();syncSettingsToDevice();toast("Arc-Spine connected over Wi‑Fi")};
    ws.onmessage=e=>handlePayload(e.data);
    ws.onclose=()=>{connected=false;setConnection(false);finishSession();renderHistory();renderWeek();toast("Wi‑Fi connection closed")};
    ws.onerror=()=>toast("Could not connect to the ESP32 WebSocket.");
  }catch(e){toast("Invalid WebSocket URL")}
}
function finishSession(){
  if(!sessionStart)return;
  const total=totalCorrect+totalIncorrect;if(total<5)return;
  const score=Math.round(totalCorrect/total*100);
  sessions.unshift({date:new Date().toISOString(),duration:Math.round(total),score,alerts:alertCount,avg:history.length?history.reduce((a,b)=>a+b,0)/history.length:0});
  sessions=sessions.slice(0,30);localStorage.setItem("Arc-Spine_sessions",JSON.stringify(sessions));
}
window.addEventListener("beforeunload",finishSession);
function renderHistory(){
  $("historyList").innerHTML=sessions.length?sessions.map(s=>`<div class="history-row"><div><b>${new Date(s.date).toLocaleDateString()}</b><small>${new Date(s.date).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})} • ${formatSec(s.duration)} • ${s.alerts} alerts</small></div><strong>${s.score}%</strong></div>`).join(""):"<div class='empty'>No completed sessions yet.</div>";
}
function renderWeek(){drawWeek()}
function setupCanvas(c){const d=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight||c.height;c.width=w*d;c.height=h*d;const x=c.getContext("2d");x.scale(d,d);return [x,w,h]}
function drawAngle(){
  const c=$("angleChart"),[x,w,h]=setupCanvas(c);x.clearRect(0,0,w,h);grid(x,w,h);
  if(historySigned.length<2)return;
  // Center line = your calibrated baseline (0°). Deviation is plotted with its real sign, so
  // leaning one way draws above the line and leaning the other way draws below it, instead of
  // both directions being folded into the same upward-only magnitude.
  const pad=20, centerY=h/2, halfH=h/2-pad;
  const recentMaxAbs=historySigned.reduce((m,v)=>Math.abs(v)>m?Math.abs(v):m,0);
  const scaleMax=Math.max(settings.angle*1.3,recentMaxAbs*1.15,5);
  const yFor=v=>centerY-Math.max(-halfH,Math.min(halfH,v/scaleMax*halfH));
  // Baseline (0°) reference line.
  x.strokeStyle="rgba(148,163,184,.35)";x.lineWidth=1;x.beginPath();x.moveTo(0,centerY);x.lineTo(w,centerY);x.stroke();
  // The live deviation trace.
  x.beginPath();historySigned.forEach((v,i)=>{const px=i/(historySigned.length-1)*w,py=yFor(v);i?x.lineTo(px,py):x.moveTo(px,py)});x.strokeStyle="#6ea8fe";x.lineWidth=2;x.stroke();
  // Warning-angle lines, one on each side of the baseline — you can slouch forward or backward.
  x.setLineDash([6,5]);x.strokeStyle="#f59e0b";
  x.beginPath();x.moveTo(0,yFor(settings.angle));x.lineTo(w,yFor(settings.angle));x.stroke();
  x.beginPath();x.moveTo(0,yFor(-settings.angle));x.lineTo(w,yFor(-settings.angle));x.stroke();
  x.setLineDash([]);
}
function grid(x,w,h){x.strokeStyle="rgba(148,163,184,.13)";x.lineWidth=1;for(let i=1;i<5;i++){const y=i*h/5;x.beginPath();x.moveTo(0,y);x.lineTo(w,y);x.stroke()}}
function drawTime(){
  const c=$("timeChart"),[x,w,h]=setupCanvas(c);const r=Math.min(w,h)/2-8,total=totalCorrect+totalIncorrect||1;x.clearRect(0,0,w,h);x.lineWidth=18;x.beginPath();x.arc(w/2,h/2,r,-Math.PI/2,Math.PI*1.5);x.strokeStyle="#24324a";x.stroke();x.beginPath();x.arc(w/2,h/2,r,-Math.PI/2,-Math.PI/2+Math.PI*2*totalCorrect/total);x.strokeStyle="#34d399";x.stroke();
}
function drawWeek(){
  const c=$("weekChart"),[x,w,h]=setupCanvas(c);x.clearRect(0,0,w,h);grid(x,w,h);
  const vals=Array(7).fill(null);sessions.forEach(s=>{const d=new Date(s.date),idx=Math.floor((Date.now()-d.getTime())/86400000);if(idx>=0&&idx<7)vals[6-idx]=s.score});
  const bw=w/9;x.font="12px system-ui";x.textAlign="center";
  vals.forEach((v,i)=>{const bh=v==null?4:(h-55)*v/100; x.fillStyle=v==null?"#334155":"#6ea8fe";x.fillRect((i+1)*bw,h-30-bh,bw*.55,bh);x.fillStyle="#94a3b8";x.fillText(["M","T","W","T","F","S","S"][i],(i+1.28)*bw,h-10);if(v!=null)x.fillText(v+"%",(i+1.28)*bw,h-38-bh)});
}
function drawAll(){drawAngle();drawTime();drawWeek();renderEvents();updateStats()}
function toast(msg){const t=$("toast");t.textContent=msg;t.classList.add("show");clearTimeout(toast.t);toast.t=setTimeout(()=>t.classList.remove("show"),2800)}
window.addEventListener("resize",drawAll);
init();