// The INJECTOR — runs in the HOST page context (mounted via the engine's sticky script injection, LS-02's
// `POST /sessions/:id/inject`). Ported from the prior single-app implementation's `widget.ts:34-299`,
// generalized: every page global, the host element id, and the outbound control-plane message key are derived
// from a caller-supplied `ns` (see `ns.ts`) instead of a single hard-coded fixed-prefix family.
//
// Mounts:
//   • a position:fixed shadow-DOM HOST (shields the mount from the page's own CSS)
//   • a SAME-ORIGIN sandboxed <iframe> whose srcdoc is the caller's BUILT bundle (own document/JS/CSS realm —
//     see `build.ts`). NOT string-glue: the iframe is a real, isolated app.
//   • CDP `Page.setBypassCSP` (set by the engine's inject store, not here) defeats the host CSP so this
//     source + the iframe's own script can run.
//   • a re-mount guard keeps it alive across the page's navigations / SPA re-renders.
//
// Two things this source must survive, both called out by LS-02 (the engine's sticky-injection primitive):
//   1. It runs at DOCUMENT-START (`Page.addScriptToEvaluateOnNewDocument`), where `document.body` /
//      `document.documentElement` may not exist yet — `mount()` below no-ops and lets the interval-driven
//      guard (and the engine's separate load-time re-eval) retry once the DOM exists.
//   2. It is idempotent by contract: it re-runs on EVERY navigation/reload and (per the engine's inject store)
//      once more on the page's `load` event — `mount()`'s host guard updates the existing iframe only when the
//      bundle revision changed, while the `!window[GUARD]` guard keeps listeners singleton.
//
// DISPLAY + INTENT only — this source never sends anything anywhere on its own. Intents flow OUT via
// postMessage → the iframe posts to `parent` under the `chromeKey(ns)` marker; a resize/ready/peek/drag message
// is chrome (handled right here); anything else is a NAMED INTENT, queued onto a per-name window global that
// `WidgetHost.onIntent(name, cb)` (host.ts) drains.
import {
  chromeKey,
  dragGlobal,
  glassIds,
  guardGlobal,
  hostElementId,
  iframeGlobal,
  nsPrefix,
  peekElementId,
  posGlobal,
  scrimGlobal,
  themeGlobal,
} from "./ns.js";

export interface InjectorOptions {
  /** The namespace every page global / element id below is derived from. */
  ns: string;
  /** The built, self-contained srcdoc HTML (see `build.ts`) — the iframe's own bundle. */
  html: string;
}

function htmlRevision(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/**
 * Build the injector source for one `ns` + built `html`. The returned string is handed to the engine as a
 * sticky script injection (`bypassCSP: true`) — see `host.ts`'s `WidgetHost.attach`.
 */
export function injectorSource(opts: InjectorOptions): string {
  const { ns, html } = opts;
  const revision = htmlRevision(html);
  const HOST = hostElementId(ns);
  const CHROME = chromeKey(ns);
  const THEME_G = themeGlobal(ns);
  const IFRAME_G = iframeGlobal(ns);
  const POS_G = posGlobal(ns);
  const GUARD_G = guardGlobal(ns);
  const DRAG_G = dragGlobal(ns);
  const SCRIM_G = scrimGlobal(ns);
  const PEEK_ID = peekElementId(ns);
  const GLASS = glassIds(ns);

  // NOTE: everything below is delivered to the page as a STRING (template-literal → `Runtime.evaluate` /
  // `Page.addScriptToEvaluateOnNewDocument`), so — as the prior implementation's own version of this comment
  // warns — any regex backslash-escape (`\d`, `\s`) inside it would be stripped before it ever runs. Keep
  // parsing here backslash-free. For the same reason keep the COMMENTS below backtick-free: a stray backtick
  // (quoting a filename, say) closes the template literal and the file stops parsing.
  return `(function(){
    // addScriptToEvaluateOnNewDocument runs in EVERY frame (main + every child iframe: embeds, ads, quote-posts).
    // Mount ONLY in the top frame, or a busy SPA spawns one widget per iframe as they churn.
    try { if (window.top !== window.self) return; } catch(e) { return; }   // cross-origin access throws → also a subframe → bail
    var HOST=${JSON.stringify(HOST)}, HTML=${JSON.stringify(html)}, REV=${JSON.stringify(revision)}, CHROME=${JSON.stringify(CHROME)};
    // GLASS must adapt to the page: a dark frost over a light page just reads as a dark slab. So we probe the
    // page's background luminance and pick a dark or light frost (the iframe flips its own theme to match). This
    // is what makes it look like real frosted glass on BOTH a dark feed and a white page.
    function pageTheme(){
      try{
        // Sample the element STACK under a real viewport point first: many pages (HN's beige
        // <table>, docs sites with a painted wrapper) leave body/html transparent and paint their
        // background on a container, so probing only body/html reads null on a light page.
        var els=[], hops=0;
        try{ var el=document.elementFromPoint(Math.floor(innerWidth/2), Math.floor(innerHeight/3));
          while(el && hops++<8){ els.push(el); el=el.parentElement; } }catch(_){}
        els.push(document.body, document.documentElement);
        var lum=null;
        for(var i=0;i<els.length;i++){ var e2=els[i]; if(!e2||!e2.nodeType||e2.nodeType!==1) continue;
          var n=(getComputedStyle(e2).backgroundColor||'').replace(/[^0-9.,]/g,'').split(',');
          if(n.length>=3){ var a=(n.length>=4)?parseFloat(n[3]):1; if(a>0.2){ lum=0.2126*+n[0]+0.7152*+n[1]+0.0722*+n[2]; break; } } }
        // Whole stack transparent: mid-load that means "not painted yet" (stay dark; the guard
        // interval re-probes), but on a LOADED document it means the UA's default canvas — white.
        if(lum===null) return document.readyState==='loading' ? 'dark' : 'light';
        return lum>140?'light':'dark';
      }catch(e){ return 'dark'; }
    }
    // Re-probe the page and (re)paint the glass to match. Called at mount AND on the guard interval, so a
    // theme misread during a mount-time race — or the user navigating a tab from light→dark — self-corrects
    // within ~1s. Only the glass props are touched (never position/size), and the iframe is told on change.
    function applyTheme(){
      var host=document.getElementById(HOST); if(!host) return;
      var th=pageTheme();
      if(th===host.getAttribute('data-lw-theme')) return;          // unchanged → nothing to do
      host.setAttribute('data-lw-theme', th); window[${JSON.stringify(THEME_G)}]=th;
      var light = th==='light';
      // ── "Liquid Glass" (iOS-style) ────────────────────────────────────────────────────────────
      // FOUR layers, not just a frost: (1) a GRADIENT tint (lit top-left -> clearer bottom-right) reads as a
      // rounded slab with volume; (2) a SPECULAR RIM from inset box-shadows (bright top edge + faint hairline +
      // dark bottom edge) reads as glass with THICKNESS that catches light; (3) the squircle radius. The 4th layer
      // — REFRACTION (content behind actually BENDS at the rim) — a CSS frost CANNOT fake; it lives in
      // applyRefraction() via an SVG feDisplacementMap backdrop-filter (Chromium-only). Keep this tint LOW so the
      // lensing shows; floor the top alpha ~.14.
      host.style.borderRadius='26px';
      host.style.background = light
        ? 'linear-gradient(150deg, rgba(255,255,255,.34) 0%, rgba(255,255,255,.12) 100%)'
        : 'linear-gradient(150deg, rgba(58,60,68,.26) 0%, rgba(28,30,36,.10) 100%)';
      // NO PANEL SCRIM: a two-layer model — the glass is the CHROME layer (clear, refractive) and CONTENT sits on
      // its own opaque surface ABOVE it; they never blend. Content legibility is the iframe UI's job.
      var scrim=window[${JSON.stringify(SCRIM_G)}];
      if(scrim){ scrim.style.background='transparent'; }
      host.style.border = light ? '1px solid rgba(255,255,255,.50)' : '1px solid rgba(255,255,255,.10)';
      host.style.boxShadow = light
        ? 'inset 0 1px 0 rgba(255,255,255,.90), inset 0 0 0 1px rgba(255,255,255,.28), inset 0 -10px 22px rgba(0,0,0,.05), 0 12px 40px rgba(30,40,70,.18), 0 2px 8px rgba(0,0,0,.10)'
        : 'inset 0 1px 0 rgba(255,255,255,.38), inset 0 0 0 1px rgba(255,255,255,.06), inset 0 -12px 26px rgba(0,0,0,.22), 0 16px 48px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.35)';
      var f=window[${JSON.stringify(IFRAME_G)}]; if(f){ try{ f.contentWindow.postMessage({theme:th},'*'); }catch(_){} }
    }
    // ── REFRACTION (the 4th layer — what makes it actually "liquid glass") ───────────────────────
    // Build a DISPLACEMENT MAP for the widget's exact size: an RGBA image where R encodes X-shift and G encodes
    // Y-shift (128 = no shift). The interior stays neutral so the centre passes straight through; along a "bezel"
    // band near the rounded-rect edge the sampling is pushed OUTWARD along the surface normal with a squircle
    // falloff, so page content magnifies and bends right at the lip — like a thick pane of glass. SVG
    // feDisplacementMap as a backdrop-filter is Chromium-only; falls back to plain blur if anything fails.
    function genGlassMap(w,h,radius,bezel){
      var cv=document.createElement('canvas'); cv.width=w; cv.height=h;
      var ctx=cv.getContext('2d'); var img=ctx.createImageData(w,h); var d=img.data;
      var cx=w/2, cy=h/2, hw=w/2, hh=h/2;
      function sdf(px,py){                                            // signed distance to the rounded rect (<0 inside)
        var qx=Math.abs(px-cx)-(hw-radius), qy=Math.abs(py-cy)-(hh-radius);
        var ax=Math.max(qx,0), ay=Math.max(qy,0);
        return Math.sqrt(ax*ax+ay*ay)+Math.min(Math.max(qx,qy),0)-radius;
      }
      for(var y=0;y<h;y++){ for(var x=0;x<w;x++){
        var i=(y*w+x)*4, dist=sdf(x+0.5,y+0.5), depth=-dist, rr=128, gg=128;
        if(dist<0 && depth<bezel){
          var nx=sdf(x+1.5,y+0.5)-sdf(x-0.5,y+0.5);                   // gradient of the SDF = outward surface normal
          var ny=sdf(x+0.5,y+1.5)-sdf(x+0.5,y-0.5);
          var nl=Math.sqrt(nx*nx+ny*ny)||1; nx/=nl; ny/=nl;
          var t=depth/bezel;                                         // 0 at the very edge -> 1 at the centre
          var mag=Math.pow(1-t,1.1);                                 // near-linear falloff
          rr=128+nx*mag*127; gg=128+ny*mag*127;
        }
        d[i]=rr; d[i+1]=gg; d[i+2]=128; d[i+3]=255;
      } }
      ctx.putImageData(img,0,0); return cv.toDataURL();
    }
    function applyRefraction(){
      var host=document.getElementById(HOST); if(!host) return;
      var light=(window[${JSON.stringify(THEME_G)}]==='light');
      try{
        var r=host.getBoundingClientRect(), w=Math.round(r.width), h=Math.round(r.height);
        if(w<8||h<8) return;
        var bezel=Math.max(8, Math.min(w,h)/2-2), radius=26, key=w+'x'+h;   // bezel = FULL half-extent → the lens reaches the centre, not just a rim band
        if(host.__lwGlassKey!==key){                                // only rebuild the (costly) map when the size changes
          host.__lwGlassKey=key;
          var ns='http://www.w3.org/2000/svg', svg=document.getElementById(${JSON.stringify(GLASS.svg)});
          if(!svg){
            svg=document.createElementNS(ns,'svg'); svg.id=${JSON.stringify(GLASS.svg)};
            svg.setAttribute('width','0'); svg.setAttribute('height','0');
            svg.style.cssText='position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
            var filt=document.createElementNS(ns,'filter'); filt.id=${JSON.stringify(GLASS.filter)};
            filt.setAttribute('color-interpolation-filters','sRGB');
            filt.setAttribute('x','0'); filt.setAttribute('y','0'); filt.setAttribute('width','1'); filt.setAttribute('height','1');
            var fe=document.createElementNS(ns,'feImage'); fe.id=${JSON.stringify(GLASS.img)}; fe.setAttribute('result','map');
            var dm=document.createElementNS(ns,'feDisplacementMap'); dm.id=${JSON.stringify(GLASS.displacementMap)};
            dm.setAttribute('in','SourceGraphic'); dm.setAttribute('in2','map');
            dm.setAttribute('xChannelSelector','R'); dm.setAttribute('yChannelSelector','G');
            filt.appendChild(fe); filt.appendChild(dm); svg.appendChild(filt);
            (document.body||document.documentElement).appendChild(svg);
          }
          var url=genGlassMap(w,h,radius,bezel);
          var fe2=document.getElementById(${JSON.stringify(GLASS.img)}), dm2=document.getElementById(${JSON.stringify(GLASS.displacementMap)});
          fe2.setAttribute('x','0'); fe2.setAttribute('y','0'); fe2.setAttribute('width',w); fe2.setAttribute('height',h);
          fe2.setAttribute('href',url); fe2.setAttributeNS('http://www.w3.org/1999/xlink','href',url);
          dm2.setAttribute('scale', String(Math.round(bezel*1.3)));  // max edge displacement in px — the "thickness" of the glass
        }
        // Filter order matters: SVG displacement (refraction) runs FIRST, then a LIGHT blur, kept low so the rim
        // refraction stays crisp; text legibility over busy content is the iframe UI's job (its own opaque surface).
        var bf='url(#'+${JSON.stringify(GLASS.filter)}+') blur(4px) saturate(180%) brightness('+(light?'1.05':'1.12')+')';
        host.style.webkitBackdropFilter=bf; host.style.backdropFilter=bf;
      }catch(e){                                                     // any failure (no canvas, no SVG-backdrop) -> plain frost
        var fb='blur(16px) saturate(180%) brightness('+(light?'1.05':'1.12')+')';
        host.style.webkitBackdropFilter=fb; host.style.backdropFilter=fb;
      }
    }
    function mount(){
      var current=document.getElementById(HOST);
      if(current){
        // Registering the same sticky injection id replaces its source. Apply
        // a changed consumer bundle to the already-mounted iframe too; the
        // ordinary idempotency guard must not pin yesterday's UI until the
        // host page happens to navigate.
        if(current.getAttribute('data-lw-revision')!==REV){
          var live=window[${JSON.stringify(IFRAME_G)}]||(current.shadowRoot&&current.shadowRoot.querySelector('iframe'));
          if(live){ current.setAttribute('data-lw-revision',REV); live.srcdoc=HTML; window[${JSON.stringify(IFRAME_G)}]=live; }
        }
        return;
      }
      var parent=document.body||document.documentElement;
      if(!parent) return;                                            // runs at document-start on reload — DOM not ready yet; the guard retries
      var host=document.createElement('div'); host.id=HOST;
      host.setAttribute('data-lw-revision',REV);
      // anchored bottom-right; size is DRIVEN BY THE IFRAME via resize messages (badge = small, panel = larger),
      // so it only ever covers what's actually drawn and never eats clicks over the page.
      // The HOST owns the rounded corners + clip + GLASS (backdrop-filter cannot cross an iframe boundary, so the
      // blur/tint must live here); the iframe stays transparent so the host's blurred backdrop shows through.
      // BOOT SIZE = a plausible COLLAPSED PILL (~220x44), not a large placeholder card: the real size arrives one
      // ack-loop hop later (size-handshake.ts), and until it does this is what the page shows. Sized rather than
      // hidden deliberately — a widget that reveals only on a message is INVISIBLE on any page where that message
      // never arrives, which is the worse failure of the two; a ~16px settle is not.
      host.style.cssText='position:fixed;bottom:16px;right:16px;width:220px;height:44px;z-index:2147483647;border-radius:26px;overflow:hidden;transition:none';
      var P=window[${JSON.stringify(POS_G)}];                          // keep a dragged position across SPA re-mounts
      if(P){
        if(P.hx){                                                      // corner anchor (PiP) → growth expands inward
          host.style[P.hx]='16px'; host.style[(P.hx==='left')?'right':'left']='auto';
          host.style[P.hy]='16px'; host.style[(P.hy==='top')?'bottom':'top']='auto';
        } else { host.style.left=P.left+'px'; host.style.top=P.top+'px'; host.style.right='auto'; host.style.bottom='auto'; }   // legacy absolute
      }
      var sh=host.attachShadow({mode:'open'});
      // SCRIM: between the host's refractive backdrop and the (transparent) iframe UI. Coloured per-theme in
      // applyTheme(); never intercepts clicks. Kept transparent by default (see the "NO PANEL SCRIM" note above).
      var scrim=document.createElement('div');
      scrim.style.cssText='position:absolute;inset:0;pointer-events:none;border-radius:26px';
      sh.appendChild(scrim); window[${JSON.stringify(SCRIM_G)}]=scrim;
      var f=document.createElement('iframe');
      f.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation');   // same-origin so the CDP CSP-bypass runs the bundle; allow-popups = a card can open a tab; allow-top-navigation-by-user-activation = a link can navigate THIS tab (target=_top) on a click
      f.setAttribute('allowtransparency','true');
      f.style.cssText='position:relative;width:100%;height:100%;border:0;background:transparent';   // TRANSPARENT — host provides the glass behind it
      f.srcdoc=HTML; sh.appendChild(f);
      parent.appendChild(host);
      window[${JSON.stringify(IFRAME_G)}]=f;
      applyTheme();                                                  // paint the glass for the current page theme
      applyRefraction();                                             // build the displacement map + refractive backdrop
    }
    // DRAG: the gesture STARTS inside the iframe, so the browser gives the iframe ownership of it — the host
    // window never receives the moves. So the IFRAME tracks its own mousemove and relays frame-independent
    // SCREEN-coord deltas here via dragstart/dragmove/dragend; the host just repositions itself.
    function dragStart(sx, sy){
      var host=document.getElementById(HOST); if(!host) return;
      var r=host.getBoundingClientRect();
      window[${JSON.stringify(DRAG_G)}]={ sl:r.left, st:r.top, w:r.width, h:r.height, sx:sx, sy:sy };
      host.style.transition='width .42s cubic-bezier(.34,1.32,.5,1),height .42s cubic-bezier(.34,1.32,.5,1)';
      host.style.left=r.left+'px'; host.style.top=r.top+'px'; host.style.right='auto'; host.style.bottom='auto';
    }
    function dragMove(x, y){
      var s=window[${JSON.stringify(DRAG_G)}], host=document.getElementById(HOST); if(!s||!host) return;
      var nl=Math.max(4, Math.min(s.sl+(x-s.sx), innerWidth-s.w-4));
      var nt=Math.max(4, Math.min(s.st+(y-s.sy), innerHeight-s.h-4));
      host.style.left=nl+'px'; host.style.top=nt+'px'; window[${JSON.stringify(POS_G)}]={left:nl, top:nt};
    }
    // THE CAPTURE PEEK — a SEPARATE fixed overlay (NOT inside the widget iframe, so it never changes the widget's
    // size). pointer-events:none → purely informational. Positioned just above the widget host; auto-hidden when
    // the iframe relays peek:null. Text is escaped (it comes from the app).
    function lwEsc(t){ return String(t==null?'':t).replace(/[&<>"]/g,function(c){ return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':'&quot;'; }); }
    function showPeek(p){
      var PID=${JSON.stringify(PEEK_ID)}, el=document.getElementById(PID);
      if(!p){ if(el){ el.style.opacity='0'; el.style.transform='translateY(10px) scale(.95)'; setTimeout(function(){ try{ el.remove(); }catch(_){} }, 320); } return; }
      if(!el){ el=document.createElement('div'); el.id=PID;
        el.style.cssText='position:fixed;z-index:2147483646;display:flex;gap:10px;align-items:center;width:262px;padding:9px 11px;border-radius:15px;background:rgba(22,24,32,.9);border:1px solid rgba(255,255,255,.13);box-shadow:0 14px 44px rgba(0,0,0,.5);color:#fff;font-family:-apple-system,system-ui,sans-serif;pointer-events:none;backdrop-filter:saturate(160%) blur(22px);-webkit-backdrop-filter:saturate(160%) blur(22px);opacity:0;transform:translateY(10px) scale(.95);transition:opacity .3s ease,transform .32s cubic-bezier(.2,.9,.3,1.3)';
        document.documentElement.appendChild(el); }
      var thumb = p.thumb ? '<img src="'+p.thumb+'" style="width:48px;height:48px;object-fit:cover;border-radius:10px;border:1px solid rgba(255,255,255,.1);flex:none">'
        : '<div style="width:48px;height:48px;border-radius:10px;background:rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;flex:none;color:#7a8395">◉</div>';
      el.innerHTML = thumb + '<div style="min-width:0;flex:1;text-align:left">'
        + '<div style="font-weight:600;font-size:11.5px">'+lwEsc(p.label||'Captured')+'</div>'
        + '<div style="color:#9aa3b2;font-size:11px;margin-top:3px;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">'+lwEsc(p.text||'')+'</div></div>';
      var host=document.getElementById(HOST);
      if(host){ var r=host.getBoundingClientRect(); el.style.right=Math.max(8, innerWidth-r.right)+'px'; el.style.left='auto'; el.style.bottom=(innerHeight-r.top+10)+'px'; el.style.top='auto'; }
      else { el.style.right='20px'; el.style.left='auto'; el.style.bottom='20px'; el.style.top='auto'; }
      requestAnimationFrame(function(){ el.style.opacity='1'; el.style.transform='none'; });
    }
    if(!window[${JSON.stringify(GUARD_G)}]){
      window[${JSON.stringify(GUARD_G)}]=setInterval(function(){ mount(); applyTheme(); applyRefraction(); },800);   // re-mount across SPA nav / reload, re-probe theme, re-assert the refractive backdrop (self-heals)
      if(document.addEventListener) document.addEventListener('DOMContentLoaded',mount);   // snappier than waiting for the interval
      window.addEventListener('message',function(e){
        var d=e.data&&e.data[CHROME]; if(!d) return;                 // not this ns's channel → ignore (lets several ns instances share one page)
        if(d.action==='resize'){                                     // iframe asked the host to fit its content
          // ACK FIRST, unconditionally: the iframe re-posts its size on a short interval until it hears this back
          // (size-handshake.ts), which is what makes the size land even when the FIRST post arrived before
          // this listener was armed. Echo the RECEIVED w/h (not the clamped ones applied below) — the iframe
          // matches the ack against what it sent. Same CHROME marker as every other message on this channel,
          // so a second ns instance on the page can never consume this one's ack.
          var ackMsg={}; ackMsg[CHROME]={ action:'sizeAck', w:d.w, h:d.h };
          var ackTarget=e.source||(window[${JSON.stringify(IFRAME_G)}]&&window[${JSON.stringify(IFRAME_G)}].contentWindow);
          try{ if(ackTarget) ackTarget.postMessage(ackMsg,'*'); }catch(_){}
          var h=document.getElementById(HOST);
          if(h){ h.style.width=Math.max(80,Math.ceil(d.w))+'px'; h.style.height=Math.max(40,Math.ceil(d.h))+'px'; applyRefraction();   // size changed → rebuild the displacement map to fit
            // SPRING SIZE-MORPH (the Dynamic-Island expand): animate width/height on every change AFTER the first
            // sizing. The first one is instant (transition:none in cssText) so there's no boot settle.
            if(!h.__lwAnim){ h.__lwAnim=1; requestAnimationFrame(function(){ var hb=document.getElementById(HOST); if(hb) hb.style.transition='width .42s cubic-bezier(.34,1.32,.5,1),height .42s cubic-bezier(.34,1.32,.5,1)'; }); }
          }
          return;                                                    // resize is chrome, NOT an intent — don't queue it
        }
        if(d.action==='ready'){                                      // iframe mounted (incl. after a reload) → tell it the page theme
          var f=window[${JSON.stringify(IFRAME_G)}];
          if(f){ try{ f.contentWindow.postMessage({theme:window[${JSON.stringify(THEME_G)}]||'dark'},'*'); }catch(_){} }
          return;
        }
        if(d.action==='peek'){ showPeek(d.peek); return; }            // capture peek → a SEPARATE overlay (never resizes the widget)
        if(d.action==='dragstart'){ dragStart(d.sx, d.sy); return; }  // header grabbed inside the iframe
        if(d.action==='dragmove'){ dragMove(d.x, d.y); return; }      // iframe relays each move → reposition host
        if(d.action==='dragend'){                                      // PiP CORNER-SNAP: release → spring to the nearest corner, then anchor there
          var hh=document.getElementById(HOST);
          if(hh){
            var r=hh.getBoundingClientRect();
            var hx=(r.left+r.width/2 < innerWidth/2)?'left':'right';
            var hy=(r.top+r.height/2 < innerHeight/2)?'top':'bottom';
            var tl=(hx==='left')?16:Math.max(16, innerWidth-r.width-16);
            var tt=(hy==='top')?16:Math.max(16, innerHeight-r.height-16);
            hh.style.transition='left .4s cubic-bezier(.34,1.3,.5,1),top .4s cubic-bezier(.34,1.3,.5,1)';
            hh.style.left=tl+'px'; hh.style.top=tt+'px'; hh.style.right='auto'; hh.style.bottom='auto';
            window[${JSON.stringify(POS_G)}]={ hx:hx, hy:hy };           // persist the CORNER (not absolute px) across re-mounts
            setTimeout(function(){ var h2=document.getElementById(HOST); if(!h2) return;
              h2.style.transition='width .42s cubic-bezier(.34,1.32,.5,1),height .42s cubic-bezier(.34,1.32,.5,1)';
              h2.style[hx]='16px'; h2.style[(hx==='left')?'right':'left']='auto';
              h2.style[hy]='16px'; h2.style[(hy==='top')?'bottom':'top']='auto';
            },410);
          }
          window[${JSON.stringify(DRAG_G)}]=null; return;
        }
        if(d.action==='intent'){                                     // a NAMED APP intent (e.g. "ctl"/"cfg") → queue it; WidgetHost.onIntent(name, cb) drains + dedups by d.id
          var key=${JSON.stringify(nsPrefix(ns) + "_intent_")}+d.name;
          if(!window[key]) window[key]=[];
          window[key].push({ id:d.id, payload:d.payload }); return;
        }
      });
    }
    try{ mount(); }catch(e){}                                         // mount now if the DOM is already there (initial inject); safe no-op otherwise
  })();`;
}
