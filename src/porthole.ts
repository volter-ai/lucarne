export interface InputEvent {
  t: "down" | "up" | "move" | "wheel" | "keydown" | "keyup";
  x?: number;
  y?: number;
  /** which button changed (0 left / 1 middle / 2 right) */
  button?: number;
  /** DOM `buttons` bitmask of held buttons (for drags) */
  buttons?: number;
  /** click count (1/2/3) for double/triple-click selection */
  clickCount?: number;
  dx?: number;
  dy?: number;
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
<style>html,body{margin:0;height:100%;background:#111}canvas{display:block;width:100vw;height:100vh;object-fit:contain;touch-action:none;outline:none}</style>
<canvas id=c tabindex=0 width=${viewport.width} height=${viewport.height}></canvas><script>
const VW=${viewport.width},VH=${viewport.height};
const cv=document.getElementById('c'),ctx=cv.getContext('2d');
cv.focus();
const wsUrl=(location.protocol==='https:'?'wss':'ws')+'://'+location.host+location.pathname.replace(/\\/$/,'')+'/ws'+location.search;
let ws;
function connect(){
  ws=new WebSocket(wsUrl);ws.binaryType='blob';
  ws.onmessage=async ev=>{if(typeof ev.data==='string')return;const bmp=await createImageBitmap(ev.data);ctx.drawImage(bmp,0,0,VW,VH);bmp.close&&bmp.close();};
  ws.onclose=()=>setTimeout(connect,1000);
  ws.onerror=()=>{try{ws.close()}catch(e){}};
}
connect();
const send=o=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify(o))};
const mod=e=>((e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0));
const c=e=>{const r=cv.getBoundingClientRect();return{x:Math.round((e.clientX-r.left)/r.width*VW),y:Math.round((e.clientY-r.top)/r.height*VH)}};
cv.addEventListener('mousedown',e=>{e.preventDefault();cv.focus();send({t:'down',...c(e),button:e.button,buttons:e.buttons,clickCount:e.detail||1,mod:mod(e)})});
cv.addEventListener('mouseup',e=>{e.preventDefault();send({t:'up',...c(e),button:e.button,buttons:e.buttons,clickCount:e.detail||1,mod:mod(e)})});
cv.addEventListener('mousemove',e=>send({t:'move',...c(e),buttons:e.buttons,mod:mod(e)}));
cv.addEventListener('wheel',e=>{e.preventDefault();send({t:'wheel',...c(e),dx:e.deltaX,dy:e.deltaY,mod:mod(e)})},{passive:false});
cv.addEventListener('contextmenu',e=>e.preventDefault());
cv.addEventListener('keydown',e=>{e.preventDefault();send({t:'keydown',key:e.key,code:e.code,repeat:e.repeat,mod:mod(e)})});
cv.addEventListener('keyup',e=>{e.preventDefault();send({t:'keyup',key:e.key,code:e.code,mod:mod(e)})});
</script>`;
}
