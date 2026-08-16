export interface InputEvent {
  t: "down" | "up" | "move" | "wheel" | "keydown" | "keyup" | "paste" | "touch" | "nav" | "ime";
  x?: number;
  y?: number;
  /** phase for a `touch` event (phone gestures) or `ime` (`compose` | `commit`) */
  phase?: "start" | "move" | "end" | "compose" | "commit";
  /** nav action for a `nav` event (showControls chrome) */
  action?: "go" | "back" | "forward" | "reload";
  /** target url for a `nav` `go` */
  url?: string;
  /** clipboard text for `paste` (clipboard sync into the focused field) */
  text?: string;
  /** which button changed (0 left / 1 middle / 2 right) */
  button?: number;
  /** DOM `buttons` bitmask of held buttons (for drags) */
  buttons?: number;
  /** click count (1/2/3) for double/triple-click selection */
  clickCount?: number;
  dx?: number;
  dy?: number;
  /** Dimensions of the rendered source frame used to derive x/y. */
  frameHeight?: number;
  frameWidth?: number;
  key?: string;
  code?: string;
  repeat?: boolean;
  /** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8 */
  mod?: number;
}

/** A source of JPEG frames, shared by the WebSocket porthole and the recorder. */
export interface FrameSource {
  get(): Buffer | null;
  subscribe(cb: (frame: Buffer) => void): () => void;
}

/**
 * The porthole page: a canvas fed JPEG frames over a WebSocket, with FULL input
 * (modifiers, key codes, drag button-state, multi-click, right-click, scroll)
 * captured from real DOM events and sent back over the same socket. Identical for
 * every backend. WebSocket transport survives reverse proxies / tunnels (unlike
 * MJPEG); relative URLs (`./ws`) so it nests under any proxy path.
 */
export function portholeHtml(viewport: { width: number; height: number }): string {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#111}canvas{display:block;width:100vw;height:100vh;object-fit:contain;touch-action:none;outline:none}
#bar{display:none;align-items:center;gap:6px;height:36px;padding:0 8px;background:#222;font:13px system-ui}
#bar button{background:#333;color:#ddd;border:0;border-radius:4px;height:24px;width:28px;cursor:pointer}
#bar input{flex:1;height:24px;border:0;border-radius:4px;padding:0 8px;background:#111;color:#ddd}
.controls #bar{display:flex}.controls #c{height:calc(100vh - 36px)}
#feedback-toggle{align-items:center;background:rgba(17,24,39,.82);border:1px solid rgba(255,255,255,.28);border-radius:7px;color:#fff;cursor:pointer;display:none;height:30px;justify-content:center;padding:0;position:fixed;right:9px;top:9px;width:30px;z-index:3}
.feedback-available #feedback-toggle{display:flex}.controls #feedback-toggle{top:45px}#feedback-toggle svg{height:16px;width:16px}
#feedback-pointer{border:2px solid #fff;border-radius:50%;box-shadow:0 1px 5px rgba(0,0,0,.8);height:18px;opacity:0;pointer-events:none;position:fixed;transform:translate(-50%,-50%);transition:opacity .16s;width:18px;z-index:2}
#feedback-pointer.visible{opacity:1}#feedback-pointer.dragging{border-color:#67e8f9;box-shadow:0 0 0 4px rgba(103,232,249,.2)}
#feedback-click{border:3px solid #67e8f9;border-radius:50%;height:18px;opacity:0;pointer-events:none;position:fixed;transform:translate(-50%,-50%) scale(.45);width:18px;z-index:2}
#feedback-click.pulse{animation:feedback-click .45s ease-out}@keyframes feedback-click{0%{opacity:1;transform:translate(-50%,-50%) scale(.45)}100%{opacity:0;transform:translate(-50%,-50%) scale(2.25)}}
#feedback-key{background:rgba(17,24,39,.9);border:1px solid rgba(255,255,255,.3);border-radius:7px;bottom:10px;color:#fff;font:600 13px system-ui;left:50%;max-width:calc(100vw - 24px);opacity:0;overflow:hidden;padding:6px 10px;pointer-events:none;position:fixed;text-overflow:ellipsis;transform:translate(-50%,8px);transition:opacity .15s,transform .15s;white-space:nowrap;z-index:2}
#feedback-key.visible{opacity:1;transform:translate(-50%,0)}</style>
<div id=bar><button id=bk title=Back>◀</button><button id=fw title=Forward>▶</button><button id=rl title=Reload>⟳</button><input id=ub placeholder="url… (Enter)"></div>
<canvas aria-label="Remote browser input" id=c role=application tabindex=0 width=${viewport.width} height=${viewport.height}></canvas>
<button aria-label="Hide input feedback" id=feedback-toggle title="Hide input feedback"><svg aria-hidden=true viewBox="0 0 24 24"><path d="M5 3l14 9-6 2-3 6L5 3z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="2"/></svg></button>
<div aria-hidden=true id=feedback-pointer></div><div aria-hidden=true id=feedback-click></div><div aria-hidden=true id=feedback-key></div><script>
const VW=${viewport.width},VH=${viewport.height};
const cv=document.getElementById('c'),ctx=cv.getContext('2d');
let FW=VW,FH=VH;
cv.focus();
const wsUrl=(location.protocol==='https:'?'wss':'ws')+'://'+location.host+location.pathname.replace(/\\/$/,'')+'/ws'+location.search;
let ws;
const params=new URLSearchParams(location.search),feedbackAvailable=params.has('feedback');
let feedbackEnabled=feedbackAvailable&&params.get('feedback')!=='0',pointerTimer,keyTimer;
const feedbackToggle=document.getElementById('feedback-toggle'),feedbackPointer=document.getElementById('feedback-pointer'),feedbackClick=document.getElementById('feedback-click'),feedbackKey=document.getElementById('feedback-key');
if(feedbackAvailable)document.documentElement.classList.add('feedback-available');
const renderedPoint=p=>{const r=cv.getBoundingClientRect(),s=Math.min(r.width/FW,r.height/FH),w=FW*s,h=FH*s;return{x:r.left+(r.width-w)/2+p.x*s,y:r.top+(r.height-h)/2+p.y*s}};
const place=(el,p)=>{const q=renderedPoint(p);el.style.left=q.x+'px';el.style.top=q.y+'px'};
const keyLabel=e=>e.label||(e.kind==='paste'?'Pasted':e.kind==='typing'?'Typing':'');
const showFeedback=e=>{if(!feedbackEnabled)return;if(e.x!==undefined&&e.y!==undefined){place(feedbackPointer,e);feedbackPointer.classList.toggle('dragging',!!e.buttons);feedbackPointer.classList.add('visible');clearTimeout(pointerTimer);pointerTimer=setTimeout(()=>feedbackPointer.classList.remove('visible'),1400)}if(e.kind==='down'){place(feedbackClick,e);feedbackClick.classList.remove('pulse');void feedbackClick.offsetWidth;feedbackClick.classList.add('pulse')}const label=keyLabel(e);if(label){feedbackKey.textContent=label;feedbackKey.classList.add('visible');clearTimeout(keyTimer);keyTimer=setTimeout(()=>feedbackKey.classList.remove('visible'),900)}};
feedbackToggle.onclick=()=>{feedbackEnabled=!feedbackEnabled;feedbackToggle.setAttribute('aria-label',feedbackEnabled?'Hide input feedback':'Show input feedback');feedbackToggle.title=feedbackEnabled?'Hide input feedback':'Show input feedback';if(!feedbackEnabled){feedbackPointer.classList.remove('visible');feedbackKey.classList.remove('visible')}};
function connect(){
  ws=new WebSocket(wsUrl);ws.binaryType='blob';
  let announcedFrame=false;
  ws.onmessage=async ev=>{if(typeof ev.data==='string'){try{const message=JSON.parse(ev.data);if(message.t==='input-feedback')showFeedback(message.event)}catch{}return}const bmp=await createImageBitmap(ev.data);if(bmp.width!==FW||bmp.height!==FH){FW=bmp.width;FH=bmp.height;cv.width=FW;cv.height=FH}ctx.drawImage(bmp,0,0,FW,FH);bmp.close&&bmp.close();if(!announcedFrame){announcedFrame=true;window.parent.postMessage({type:'lucarne:porthole-frame',version:1},'*')}};
  ws.onclose=()=>setTimeout(connect,1000);
  ws.onerror=()=>{try{ws.close()}catch(e){}};
}
connect();
const send=o=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify(o))};
const mod=e=>((e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0));
const heldButton=buttons=>(buttons&1)?0:(buttons&4)?1:(buttons&2)?2:0;
const c=(e,clamp=false)=>{const r=cv.getBoundingClientRect(),s=Math.min(r.width/FW,r.height/FH),w=FW*s,h=FH*s,l=r.left+(r.width-w)/2,t=r.top+(r.height-h)/2,x=(e.clientX-l)/s,y=(e.clientY-t)/s;if(!clamp&&(x<0||x>=FW||y<0||y>=FH))return null;return{frameHeight:FH,frameWidth:FW,x:Math.max(0,Math.min(FW-1,Math.round(x))),y:Math.max(0,Math.min(FH-1,Math.round(y)))}};
cv.addEventListener('mousedown',e=>{e.preventDefault();cv.focus();const p=c(e);if(p)send({t:'down',...p,button:e.button,buttons:e.buttons,clickCount:e.detail||1,mod:mod(e)})});
cv.addEventListener('mouseup',e=>{e.preventDefault();const p=c(e,true);if(p)send({t:'up',...p,button:e.button,buttons:e.buttons,clickCount:e.detail||1,mod:mod(e)})});
cv.addEventListener('mousemove',e=>{const p=c(e,e.buttons!==0);if(p)send({t:'move',...p,button:heldButton(e.buttons),buttons:e.buttons,mod:mod(e)})});
cv.addEventListener('wheel',e=>{e.preventDefault();const p=c(e);if(p)send({t:'wheel',...p,dx:e.deltaX,dy:e.deltaY,mod:mod(e)})},{passive:false});
cv.addEventListener('contextmenu',e=>e.preventDefault());
cv.addEventListener('keydown',e=>{e.preventDefault();send({t:'keydown',key:e.key,code:e.code,repeat:e.repeat,mod:mod(e)})});
cv.addEventListener('keyup',e=>{e.preventDefault();send({t:'keyup',key:e.key,code:e.code,mod:mod(e)})});
cv.addEventListener('paste',e=>{e.preventDefault();const t=(e.clipboardData||window.clipboardData).getData('text');if(t)send({t:'paste',text:t})});
cv.addEventListener('touchstart',e=>{e.preventDefault();const p=c(e.changedTouches[0]);if(p)send({t:'touch',phase:'start',...p})},{passive:false});
cv.addEventListener('touchmove',e=>{e.preventDefault();const p=c(e.changedTouches[0],true);if(p)send({t:'touch',phase:'move',...p})},{passive:false});
cv.addEventListener('touchend',e=>{e.preventDefault();const p=c(e.changedTouches[0],true);if(p)send({t:'touch',phase:'end',...p})},{passive:false});
cv.addEventListener('compositionupdate',e=>send({t:'ime',phase:'compose',text:e.data||''}));
cv.addEventListener('compositionend',e=>send({t:'ime',phase:'commit',text:e.data||''}));
{const th=new URLSearchParams(location.search).get('theme');if(th==='light'){document.body.style.background='#f4f4f4'}}
if(new URLSearchParams(location.search).get('controls')==='1'){
  document.documentElement.classList.add('controls');
  document.getElementById('bk').onclick=()=>send({t:'nav',action:'back'});
  document.getElementById('fw').onclick=()=>send({t:'nav',action:'forward'});
  document.getElementById('rl').onclick=()=>send({t:'nav',action:'reload'});
  document.getElementById('ub').addEventListener('keydown',e=>{if(e.key==='Enter'){let u=e.target.value.trim();if(u&&!/:\\/\\//.test(u))u='https://'+u;if(u)send({t:'nav',action:'go',url:u})}});
}
</script>`;
}
