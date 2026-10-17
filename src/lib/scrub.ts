/** 容器捕获指针，子 SVG 可重绘；按帧合并，只更新实际改变的选中项。垂直手势仍可滚页。 */
export function bindScrub(host:HTMLElement, select:(x:number,y:number)=>void, accept:(target:Element)=>boolean=()=>true,options:{hover?:boolean;clear?:()=>void}={}) {
  let active=false,raf=0,latest:[number,number]|null=null,pointerId:number|undefined,startX=0,startY=0,dragged=false,ignoreClickUntil=0;
  const surface=host.ownerDocument.defaultView!;
  const flush=()=>{raf=0;if(latest){select(...latest);latest=null}};
  const schedule=(e:PointerEvent)=>{latest=[e.clientX,e.clientY];if(!raf)raf=requestAnimationFrame(flush)};
  const down=(e:PointerEvent)=>{if(e.button!==0||active||!accept(e.target as Element))return;if(!e.pointerType||e.pointerType==='mouse')e.preventDefault();active=true;pointerId=e.pointerId;startX=e.clientX;startY=e.clientY;dragged=false;try{host.setPointerCapture?.(e.pointerId)}catch{/* SVG 重绘或 WebView 不支持捕获时，由 window 接续。 */}select(e.clientX,e.clientY)};
  const move=(e:PointerEvent)=>{if(active&&e.pointerId===pointerId){dragged=dragged||Math.abs(e.clientX-startX)+Math.abs(e.clientY-startY)>4;schedule(e)}};
  const hover=(e:PointerEvent)=>{if(!active&&options.hover&&(!e.pointerType||e.pointerType==='mouse')&&e.buttons===0){if(accept(e.target as Element))schedule(e);else options.clear?.()}};
  const end=(e:PointerEvent)=>{if(!active||e.pointerId!==pointerId)return;if(raf)cancelAnimationFrame(raf);raf=0;latest=null;select(e.clientX,e.clientY);active=false;if(e.pointerType==='touch')options.clear?.();if(dragged)ignoreClickUntil=Date.now()+400;};
  const leave=()=>{if(!active&&options.hover)options.clear?.()};
  const click=(e:MouseEvent)=>{if(Date.now()<ignoreClickUntil&&(e.target===host||accept(e.target as Element))){ignoreClickUntil=0;e.preventDefault();e.stopImmediatePropagation()}};
  const cancel=()=>{active=false;latest=null;if(raf)cancelAnimationFrame(raf);raf=0;options.clear?.()};
  host.addEventListener("pointerdown",down);host.addEventListener("pointermove",hover);host.addEventListener("pointerleave",leave);host.addEventListener('click',click,true);surface.addEventListener("pointermove",move);surface.addEventListener("pointerup",end);surface.addEventListener("pointercancel",cancel);
  return ()=>{cancel();host.removeEventListener("pointerdown",down);host.removeEventListener("pointermove",hover);host.removeEventListener("pointerleave",leave);host.removeEventListener('click',click,true);surface.removeEventListener("pointermove",move);surface.removeEventListener("pointerup",end);surface.removeEventListener("pointercancel",cancel)};
}
