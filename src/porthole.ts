export interface InputEvent {
  t: "down" | "up" | "move" | "wheel" | "key";
  x?: number;
  y?: number;
  button?: number;
  dx?: number;
  dy?: number;
  key?: string;
}

/** A source of JPEG frames, shared by the WebSocket porthole and the recorder. */
export interface FrameSource {
  get(): Buffer | null;
  subscribe(cb: (frame: Buffer) => void): () => void;
}

/**
 * The porthole page: a canvas fed JPEG frames over a WebSocket (`./ws`), with
 * mouse/keyboard sent back over the same socket. Identical for every backend —
 * the frames come from the session's CDP screencast. WebSocket transport is used
 * (not MJPEG-over-HTTP) because it survives reverse proxies / tunnels cleanly.
 * Relative URLs (`./ws` from `…/view/`) so it nests under any proxy path.
 */
export function portholeHtml(viewport: { width: number; height: number }): string {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#111}canvas{display:block;width:100vw;height:100vh;object-fit:contain;touch-action:none}</style>
<canvas id=c width=${viewport.width} height=${viewport.height}></canvas><script>
const VW=${viewport.width},VH=${viewport.height};
const cv=document.getElementById('c'),ctx=cv.getContext('2d');
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
const c=e=>{const r=cv.getBoundingClientRect();return{x:Math.round((e.clientX-r.left)/r.width*VW),y:Math.round((e.clientY-r.top)/r.height*VH)}};
cv.addEventListener('mousedown',e=>{e.preventDefault();send({t:'down',...c(e),button:e.button})});
cv.addEventListener('mouseup',e=>{e.preventDefault();send({t:'up',...c(e),button:e.button})});
cv.addEventListener('mousemove',e=>send({t:'move',...c(e)}));
cv.addEventListener('wheel',e=>{e.preventDefault();send({t:'wheel',...c(e),dx:e.deltaX,dy:e.deltaY})},{passive:false});
cv.addEventListener('contextmenu',e=>e.preventDefault());
window.addEventListener('keydown',e=>{e.preventDefault();send({t:'key',key:e.key})});
</script>`;
}
