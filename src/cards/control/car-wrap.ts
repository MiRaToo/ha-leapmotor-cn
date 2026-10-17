import {LitElement,html,css,unsafeCSS,nothing,type PropertyValues} from 'lit';
import {live} from 'lit/directives/live.js';
import {uiStyles} from '../../lib/ui/styles';

export const WRAP_SIDES=['left','right','top','front','rear'] as const;
export type WrapSide=typeof WRAP_SIDES[number];
export interface CarWrapFace {image:string;side:WrapSide;x:number;y:number;scale:number;rotation:number;opacity:number;}
/** Versioned local configuration. Each face owns an independent image and transform. */
export interface CarWrap {version:2;faces:Partial<Record<WrapSide,CarWrapFace>>;}
const MAX_IMAGE_CHARS=1_400_000,MAX_TOTAL_CHARS=2_400_000;
const clamp=(v:any,lo:number,hi:number,fallback:number)=>Number.isFinite(Number(v))?Math.max(lo,Math.min(hi,Number(v))):fallback;
function face(value:any,side:WrapSide):CarWrapFace|null {
  if(!value||typeof value.image!=='string'||!/^data:image\/(png|jpeg|webp);base64,/.test(value.image)||value.image.length>MAX_IMAGE_CHARS)return null;
  return {image:value.image,side,x:clamp(value.x,0,100,50),y:clamp(value.y,0,100,50),scale:clamp(value.scale,5,200,60),rotation:clamp(value.rotation,-180,180,0),opacity:clamp(value.opacity,0,100,100)};
}
export function readWrap(value:any):CarWrap|null {
  if(!value||typeof value!=='object')return null;
  const faces:CarWrap['faces']={};
  if(value.version===2&&value.faces&&typeof value.faces==='object'){
    for(const side of WRAP_SIDES){const parsed=face(value.faces[side],side);if(parsed)faces[side]=parsed;}
  }else if(typeof value.image==='string'){
    // Migrate the prior single-face shape without changing its saved transform.
    const side:WrapSide=WRAP_SIDES.includes(value.side)?value.side:'left',parsed=face(value,side);if(parsed)faces[side]=parsed;
  }
  return Object.keys(faces).length?{version:2,faces}:null;
}
export function wrapStorageSize(value:CarWrap|null):number{return value?JSON.stringify(value).length:0;}
export function writeWrap(key:string,value:CarWrap|null):void {
  if(!value){localStorage.removeItem(key);return;}
  if(wrapStorageSize(value)+key.length>MAX_TOTAL_CHARS)throw new Error('五个投影面的图片总量超过本机存储限制，请移除图片或换用较小图片');
  localStorage.setItem(key,JSON.stringify(value));
}

/** 图片留在本机。预览直接更新现有 3D 材质，调节时不重载车模。 */
export class LeapmotorCarWrap extends LitElement {
  static properties={value:{attribute:false},storageKey:{type:String},onPreview:{attribute:false},onSave:{attribute:false},onCancel:{attribute:false}};
  value:CarWrap|null=null;storageKey='';onPreview:(v:CarWrap|null)=>void=()=>{};onSave:(v:CarWrap|null)=>void=()=>{};onCancel:()=>void=()=>{};
  private draft:CarWrap|null=null;private error='';private frame=0;private fileSeq=0;private activeSide:WrapSide='left';private dirty=false;
  protected willUpdate(changed:PropertyValues){if(changed.has('value')&&!this.dirty)this.draft=readWrap(this.value);}
  disconnectedCallback(){super.disconnectedCallback();cancelAnimationFrame(this.frame);++this.fileSeq;}
  private preview(){if(this.frame)return;this.frame=requestAnimationFrame(()=>{this.frame=0;this.onPreview(this.cloneDraft())});}
  private cloneDraft():CarWrap|null{return this.draft?{version:2,faces:Object.fromEntries(WRAP_SIDES.flatMap(side=>this.draft?.faces[side]?[ [side,{...this.draft.faces[side]!}] ]:[])) as CarWrap['faces']}:null;}
  private ensureDraft(){this.draft||={version:2,faces:{}};}
  private async file(e:Event){
    const input=e.target as HTMLInputElement,file=input.files?.[0],side=this.activeSide,seq=++this.fileSeq;this.error='';if(!file)return;
    try{
      if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>8*1024*1024)throw Error('请选择不超过 8 MiB 的 PNG、JPEG 或 WebP');
      const url=URL.createObjectURL(file),im=new Image();try{await new Promise<void>((ok,bad)=>{im.onload=()=>ok();im.onerror=()=>bad(Error('图片无法读取'));im.src=url});}finally{URL.revokeObjectURL(url)}
      if(seq!==this.fileSeq)return;
      const c=document.createElement('canvas'),scale=Math.min(1,768/Math.max(im.naturalWidth,im.naturalHeight));c.width=Math.max(1,Math.round(im.naturalWidth*scale));c.height=Math.max(1,Math.round(im.naturalHeight*scale));const ctx=c.getContext('2d');if(!ctx)throw Error('无法处理这张图片');ctx.drawImage(im,0,0,c.width,c.height);
      const image=c.toDataURL('image/png');if(image.length>MAX_IMAGE_CHARS)throw Error('压缩后图片仍过大，请使用更简洁或尺寸更小的图片');
      if(seq!==this.fileSeq)return;this.ensureDraft();this.draft!.faces[side]={image,side,x:50,y:50,scale:60,rotation:0,opacity:100};this.dirty=true;this.preview();
    }catch(err){if(seq===this.fileSeq)this.error=(err as Error).message;}
    input.value='';this.requestUpdate();
  }
  private changeFace(key:'x'|'y'|'scale'|'rotation'|'opacity',value:number){const current=this.draft?.faces[this.activeSide];if(!current)return;current[key]=value;this.dirty=true;this.preview();this.requestUpdate();}
  private slider(key:'x'|'y'|'scale'|'rotation'|'opacity',label:string,min:number,max:number,unit='%'){
    const current=this.draft?.faces[this.activeSide];if(!current)return nothing;
    return html`<label>${label}<input aria-label=${label} type="range" min=${min} max=${max} .value=${live(String(current[key]))} @input=${(e:Event)=>this.changeFace(key,Number((e.target as HTMLInputElement).value))}><output>${current[key]}${unit}</output></label>`;
  }
  private save(){try{writeWrap(this.storageKey,this.cloneDraft());this.dirty=false;++this.fileSeq;cancelAnimationFrame(this.frame);this.frame=0;this.onSave(this.cloneDraft())}catch(err){this.error=(err as Error).message||'本机存储空间不足，未保存';this.requestUpdate();}}
  private cancel(){++this.fileSeq;cancelAnimationFrame(this.frame);this.frame=0;this.onCancel();}
  private sideKey(e:KeyboardEvent){if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const i=WRAP_SIDES.indexOf(this.activeSide),next=e.key==='Home'?0:e.key==='End'?WRAP_SIDES.length-1:(i+(e.key==='ArrowRight'?1:-1)+WRAP_SIDES.length)%WRAP_SIDES.length;this.activeSide=WRAP_SIDES[next];this.requestUpdate();this.updateComplete.then(()=>this.shadowRoot?.querySelector<HTMLButtonElement>(`[data-side="${this.activeSide}"]`)?.focus());}
  protected render(){
    const current=this.draft?.faces[this.activeSide],labels:Record<WrapSide,string>={left:'左侧',right:'右侧',top:'车顶',front:'车头',rear:'车尾'};
    return html`<div class="head"><b>车衣预览</b><small>仅本机 · 图片投影至车漆</small></div><div class="folders" role="tablist" aria-label="车衣投影面" @keydown=${(e:KeyboardEvent)=>this.sideKey(e)}>${WRAP_SIDES.map(side=>html`<button class="folder" role="tab" data-side=${side} id="wrap-tab-${side}" aria-controls="wrap-panel" aria-selected=${this.activeSide===side} tabindex=${this.activeSide===side?'0':'-1'} @click=${()=>{this.activeSide=side;this.requestUpdate()}}>${this.draft?.faces[side]?html`<img alt="" src=${this.draft.faces[side]!.image}>`:html`<span class="folderIcon" aria-hidden="true">▱</span>`}<span>${labels[side]}</span><small>${this.draft?.faces[side]?'已设置':'空'}</small></button>`)}</div><section id="wrap-panel" role="tabpanel" aria-labelledby="wrap-tab-${this.activeSide}"><label class="upload">${current?'更换图片':'上传图片'}<input type="file" accept="image/png,image/jpeg,image/webp" @change=${(e:Event)=>void this.file(e)}></label>${current?html`${this.slider('x','水平位置',0,100)}${this.slider('y','垂直位置',0,100)}${this.slider('scale','图案大小',5,200)}${this.slider('rotation','旋转',-180,180,'°')}${this.slider('opacity','不透明度',0,100)}<small>旋转车模检查贴合；车窗和饰条保留原材质。</small>`:html`<small>可为每个投影面分别上传图案，并独立调整位置和大小。</small>`}</section>${this.error?html`<p role="alert">${this.error}</p>`:nothing}<div class="actions"><button ?disabled=${!current} @click=${()=>{if(this.draft){delete this.draft.faces[this.activeSide];if(!Object.keys(this.draft.faces).length)this.draft=null;}this.dirty=true;this.preview();this.requestUpdate()}}>清除当前面</button><button ?disabled=${!this.draft} @click=${()=>{this.draft=null;this.dirty=true;this.preview();this.requestUpdate()}}>清除全部</button><button @click=${()=>this.cancel()}>返回</button><button @click=${()=>this.save()}>确定</button></div>`;
  }
  /* 共享控件层显式导入(本组件有自己的 shadow root, 父卡的 CSS 进不来) —— 放在最前面 */
  static styles=css`${unsafeCSS(uiStyles)}:host{display:flex;flex-direction:column;gap:10px;width:min(100%,340px);padding:12px;box-sizing:border-box;border-radius:var(--lm-radius-section,14px);background:var(--lm-surface-section,var(--card-background-color,#fff));box-shadow:var(--lm-shadow-section,0 1px 4px #0002);color:var(--primary-text-color,#222);font-size:12px;}.head,.actions{display:flex;align-items:center;gap:8px;}.head small{margin-left:auto;}.folders{display:flex;gap:5px;overflow-x:auto;padding:2px 1px 5px;scrollbar-width:thin;}.folder{flex:0 0 58px;display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 3px;border:1px solid var(--divider-color,#ddd);border-radius:8px 8px 5px 5px;background:var(--card-background-color,#fff);color:inherit;font:inherit;box-shadow:none;}.folder[aria-selected=true]{border-color:var(--primary-color,#03a9f4);background:color-mix(in srgb,var(--primary-color,#03a9f4) 12%,var(--card-background-color,#fff));}.folder img,.folderIcon{width:36px;height:28px;object-fit:cover;border-radius:4px;background:var(--secondary-background-color,#eee);}.folderIcon{display:grid;place-items:center;font-size:22px;color:var(--secondary-text-color,#777);}.folder small{font-size:9px;}section{display:flex;flex-direction:column;gap:10px;}label{display:flex;align-items:center;gap:10px;}input[type=range]{flex:1;min-width:30px;accent-color:var(--primary-color,#03a9f4);}output{min-width:40px;text-align:right;}input[type=file]{min-width:0;max-width:230px;}button{border:0;border-radius:8px;padding:7px;background:var(--card-background-color,#fff);color:inherit;font:inherit;box-shadow:0 1px 4px #0002;cursor:pointer;}.actions{justify-content:flex-end;}.actions button:first-child{margin-right:auto;}button:disabled{opacity:.45;cursor:default;}small{font-size:10px;color:var(--secondary-text-color,#6b7280);}p{color:var(--error-color,#c44);margin:0;}`;
}
if(!customElements.get('leapmotor-car-wrap'))customElements.define('leapmotor-car-wrap',LeapmotorCarWrap);
