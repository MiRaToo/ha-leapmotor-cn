import {LitElement,html,css,unsafeCSS,nothing,type PropertyValues} from 'lit';
import {live} from 'lit/directives/live.js';
import {uiStyles} from '../../lib/ui/styles';

/** 弹窗中的车机工具。只在挂载或切换车辆时读取，不跟随 HA 推送重复请求。 */
export class LeapmotorVehicleTools extends LitElement {
  static properties={hass:{attribute:false},entityId:{type:String},section:{type:String},chargeEnabled:{attribute:false}};
  hass:any=null;entityId='';section='schedule';chargeEnabled=false;
  private confirmTimer:ReturnType<typeof setTimeout>|null=null;private confirmSeq=0;
  private info:any=null;private loaded='';private seq=0;private busy=false;private error='';private message='';
  private chargeDays:number[]=[];private recharge=false;
  private preheat={id:'',enabled:false,start:'07:00',days:[] as number[]};
  private destination={name:'',address:'',latitude:'',longitude:'',coordinate_type:'gcj02',poi_id:''};
  private mapQuery='';private mapCity='';private mapRows:any[]=[];private searching=false;private mapSeq=0;
  private amapKey='';
  private async searchPlaces(){const seq=++this.mapSeq,target=this.entityId;this.searching=true;this.error='';this.mapRows=[];this.requestUpdate();try{const response=await this.hass.callWS({type:'leapmotor/map/search',entity_id:target,keywords:this.mapQuery,city:this.mapCity});if(seq!==this.mapSeq||target!==this.entityId)return;this.mapRows=response.places||[];if(!this.mapRows.length)this.message='没有找到地点，请补充城市或具体名称'}catch(e){if(seq===this.mapSeq)this.error=String((e as any)?.message||'地点搜索失败')}finally{if(seq===this.mapSeq){this.searching=false;this.requestUpdate()}}}
  private image='';private imageUrl='';private imageLabel='';private fileSeq=0;
  protected updated(_changed:PropertyValues){if(this.hass&&this.entityId&&this.loaded!==this.entityId){this.loaded=this.entityId;void this.load();}}
  disconnectedCallback(){super.disconnectedCallback();this.cancelConfirm();++this.mapSeq;++this.seq;++this.fileSeq;if(this.imageUrl)URL.revokeObjectURL(this.imageUrl);this.imageUrl='';this.image='';}
  private async load(){
    this.cancelConfirm();++this.mapSeq;this.mapRows=[];this.searching=false;const seq=++this.seq;this.error='';this.info=null;this.requestUpdate();
    try{const info=await this.hass.callWS({type:'leapmotor/vehicle_tools/info',entity_id:this.entityId,section:this.section});if(seq!==this.seq)return;this.info=info;
      const charge=info.charge||{};this.chargeDays=Number(charge.circulation)?String(charge.cycles||'').split(',').flatMap((x,i)=>x==='1'?[i]:[]):[];this.recharge=Number(charge.recharge)===1;
      this.choosePreheat(info.preheat?.[0]);
    }catch(err){if(seq===this.seq)this.error=String((err as any)?.message||'功能读取失败').slice(0,160)}finally{if(seq===this.seq)this.requestUpdate()}
  }
  private choosePreheat(p?:any){this.preheat={id:p?.set_id||'',enabled:String(p?.on)==='1',start:p?.start_time?.slice(11,16)||'07:00',days:Array.isArray(p?.days)?p.days.map(Number).filter((d:number)=>Number.isInteger(d)&&d>=0&&d<=6):[]};this.requestUpdate();}
  private days(values:number[],change:(days:number[])=>void,label:string){return html`<div class="week" role="group" aria-label=${label}>${['日','一','二','三','四','五','六'].map((d,i)=>html`<button type="button" aria-label=${'周'+d} aria-pressed=${values.includes(i)} class=${values.includes(i)?'on':''} @click=${()=>{change(values.includes(i)?values.filter(x=>x!==i):[...values,i].sort());this.requestUpdate()}}>${d}</button>`)}</div><small>${values.length?'每周重复':'仅下一次'}</small>`;}
  private cancelConfirm(){++this.confirmSeq;if(this.confirmTimer)clearTimeout(this.confirmTimer);this.confirmTimer=null;}
  private confirmPreheat(expected:any,target:string,seq:number,attempt=0){
    this.confirmTimer=setTimeout(()=>{this.confirmTimer=null;if(!this.isConnected||seq!==this.confirmSeq||target!==this.entityId)return;
      void this.hass.callWS({type:'leapmotor/vehicle_tools/info',entity_id:target,section:'schedule'}).then((info:any)=>{
        if(seq!==this.confirmSeq||target!==this.entityId)return;
        const found=info.preheat?.find((p:any)=>(!expected.id||p.set_id===expected.id)&&String(p.on)===(expected.enabled?'1':'0')&&p.start_time?.slice(11,16)===expected.start&&JSON.stringify((p.days||[]).map(Number).sort())===JSON.stringify([...expected.days].sort()));
        if(found){this.info=info;if(this.preheat.start===expected.start&&this.preheat.enabled===expected.enabled)this.preheat.id=found.set_id;this.message='车端预约配置已确认';this.requestUpdate();return;}
        if(attempt<2)this.confirmPreheat(expected,target,seq,attempt+1);else {this.message='暂未收到一致回报，请稍后重新读取；已保留本次设置';this.requestUpdate();}
      }).catch(()=>{if(seq!==this.confirmSeq)return;if(attempt<2)this.confirmPreheat(expected,target,seq,attempt+1);else{this.message='确认读取暂不可用，请稍后重新读取';this.requestUpdate();}});
    },[5000,15000,30000][attempt]);
  }
  private async send(kind:string,data:Record<string,any>):Promise<boolean>{
    if(this.busy)return false;this.cancelConfirm();this.busy=true;this.error='';this.message='';this.requestUpdate();const target=this.entityId;
    try{const response=await this.hass.callWS({type:'leapmotor/vehicle_tools/save',entity_id:target,kind,data});if(target!==this.entityId)return false;
      this.message='云端已受理，等待车端确认';
      if(kind==='charge')await this.load();
      else if(kind==='preheat'){if(response?.preheat?.set_id){this.preheat.id=response.preheat.set_id;data={...data,id:response.preheat.set_id}}this.confirmPreheat({...data,days:[...data.days]},target,this.confirmSeq);}
      return true;
    }catch(err){if(target===this.entityId)this.error=String((err as any)?.message||'请求未成功，请重试').slice(0,180);return false;}
    finally{this.busy=false;this.requestUpdate();}
  }
  private async saveAmapKey(){
    if(this.busy)return;this.busy=true;this.error='';this.message='';this.requestUpdate();const target=this.entityId;
    try{const response=await this.hass.callWS({type:'leapmotor/amap/save',entity_id:target,key:this.amapKey});if(target!==this.entityId)return;this.info={...(this.info||{}),amap_configured:!!response?.amap_configured};this.amapKey='';this.message=response?.amap_configured?'高德 Web 服务 Key 已保存':'高德地点搜索已停用';}
    catch(err){if(target===this.entityId)this.error=String((err as any)?.message||'Key 保存失败，请重试').slice(0,180)}
    finally{this.busy=false;this.requestUpdate()}
  }
  private async togglePreheat(enabled:boolean){
    const previous=this.preheat.enabled;this.preheat.enabled=enabled;this.requestUpdate();
    if(!await this.send('preheat',{...this.preheat,days:[...this.preheat.days]})){this.preheat.enabled=previous;this.requestUpdate();}
  }
  private schedulePanel(){return html`
    ${this.info.can_charge&&this.chargeEnabled?html`<section class="scheduleFields"><b>预约充电 · 重复</b>${this.days(this.chargeDays,v=>{this.chargeDays=v},'预约充电重复日期')}<label class="check"><input type="checkbox" .checked=${this.recharge} @change=${(e:Event)=>{this.recharge=(e.target as HTMLInputElement).checked}}>到停止时间未达到充电上限，将继续充电</label><div class="toolActions"><button @click=${()=>void this.send('charge',{days:this.chargeDays,recharge:this.recharge})}>保存充电重复与续充</button><button @click=${()=>void this.load()}>重新读取</button></div></section>`:nothing}
    ${this.info.can_preheat?html`<section>
      ${this.info.preheat?.length>1?html`<label>选择预约<select .value=${this.preheat.id} @change=${(e:Event)=>this.choosePreheat(this.info.preheat.find((p:any)=>p.set_id===(e.target as HTMLSelectElement).value))}>${this.info.preheat.map((p:any)=>html`<option value=${p.set_id}>${p.start_time} · ${String(p.on)==='1'?'已开':'已关'}</option>`)}</select></label>`:nothing}
      <label class="check preheatTitle"><input type="checkbox" role="switch" .checked=${this.preheat.enabled} ?disabled=${!!this.info.preheat_error} @change=${(e:Event)=>void this.togglePreheat((e.target as HTMLInputElement).checked)}>预约电池预热</label>
      ${this.info.preheat_error?html`<p class="error">${this.info.preheat_error}</p>`:nothing}
      ${this.preheat.enabled?html`<div class="scheduleFields"><label>预热开始时间<input type="time" .value=${live(this.preheat.start)} @change=${(e:Event)=>{this.preheat.start=(e.target as HTMLInputElement).value}}></label>${this.days(this.preheat.days,v=>{this.preheat.days=v},'预热重复日期')}<p>车辆自动结束预热，无需设置结束时间。</p></div>`:nothing}
      <div class="toolActions">${this.preheat.enabled?html`<button ?disabled=${!!this.info.preheat_error} @click=${()=>void this.send('preheat',{...this.preheat,days:[...this.preheat.days]})}>保存预热预约</button>`:nothing}<button @click=${()=>void this.load()}>重新读取</button></div>
    </section>`:html`<p>当前账号未授权电池预热预约。</p>`}`;}
  private amapPanel(){return html`<details class="amapSettings"><summary>高德地点搜索 · ${this.info?.amap_configured?'已配置':'未配置'}</summary><section>
    <b>高德 Web 服务 Key</b>
    <p>${this.info?.amap_configured?'已配置。更换时输入新的 Key；留空后保存会移除当前 Key。':'尚未配置。填入高德 Web 服务 Key 后，地点搜索即可使用。'}</p>
    <label>Web 服务 Key<input type="password" autocomplete="new-password" .value=${live(this.amapKey)} placeholder=${this.info?.amap_configured?'已配置 · 输入新 Key 以更换':'32 位 Key'} @input=${(e:Event)=>{this.amapKey=(e.target as HTMLInputElement).value}}></label>
    <div class="toolActions"><button ?disabled=${this.busy} @click=${()=>void this.saveAmapKey()}>${this.amapKey.trim()?'保存 Key':this.info?.amap_configured?'移除 Key':'保存设置'}</button><button ?disabled=${this.busy} @click=${()=>void this.load()}>重新读取</button></div>
    <p>Key 仅保存在 Home Assistant 集成配置中，不会显示在卡片或发送给浏览器以外的服务。</p>
  </section></details>`;}
  private async file(event:Event){
    const file=(event.target as HTMLInputElement).files?.[0],seq=++this.fileSeq;this.image='';this.imageLabel='';if(this.imageUrl)URL.revokeObjectURL(this.imageUrl);this.imageUrl='';this.error='';
    if(!file){this.requestUpdate();return;}
    try{
      if(!['image/jpeg','image/png'].includes(file.type)||file.size>2*1024*1024)throw Error('请选择不超过 2 MiB 的 JPEG 或 PNG');
      const url=URL.createObjectURL(file);this.imageUrl=url;
      const img=new Image();await new Promise<void>((ok,bad)=>{img.onload=()=>ok();img.onerror=()=>bad(Error('图片无法读取'));img.src=url});
      if(seq!==this.fileSeq)return;
      if(!(img.naturalWidth>1920&&img.naturalHeight>960&&img.naturalWidth<=4096&&img.naturalHeight<=2048))throw Error('宽须大于 1920、高须大于 960，最大 4096×2048');
      if(Math.abs(img.naturalWidth/img.naturalHeight-2)>.02)throw Error('请选择 2:1 的全景图片');
      const data=await new Promise<string>((ok,bad)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(',')[1]);r.onerror=()=>bad(Error('图片读取失败'));r.readAsDataURL(file)});
      if(seq!==this.fileSeq)return;this.image=data;this.imageLabel=`${file.name} · ${img.naturalWidth} × ${img.naturalHeight}`;
    }catch(err){if(seq!==this.fileSeq)return;this.error=String((err as Error).message);if(this.imageUrl)URL.revokeObjectURL(this.imageUrl);this.imageUrl='';}
    this.requestUpdate();
  }
  private input(key:keyof typeof this.destination,label:string,type='text'){return html`<label>${label}<input type=${type} .value=${live(this.destination[key])} @input=${(e:Event)=>{this.destination[key]=(e.target as HTMLInputElement).value;this.destination.poi_id=''}}></label>`;}
  protected render(){
    if(!this.hass?.user?.is_admin)return html`<p>需要管理员权限使用预约和车机工具。</p>`;
    if(!this.entityId)return html`<p>正在等待所选车辆实体…</p>`;
    return html`${this.error?html`<p class="error" role="alert">${this.error}</p>`:nothing}${this.message?html`<p role="status">${this.message}</p>`:nothing}${!this.info?html`<button @click=${()=>void this.load()}>重新读取功能</button>`:this.section==='amap'?html`<fieldset ?disabled=${this.busy}>${this.amapPanel()}</fieldset>`:html`<fieldset ?disabled=${this.busy}>${this.section==='schedule'?this.schedulePanel():html`<details><summary>发送目的地</summary>${this.info.can_destination?html`${this.info.amap_configured?html`<div class="mapSearch"><label>高德地点搜索<input aria-label="高德地点关键词" .value=${live(this.mapQuery)} placeholder="输入地点名称" @input=${(e:Event)=>{this.mapQuery=(e.target as HTMLInputElement).value}} @keydown=${(e:KeyboardEvent)=>{if(e.key==='Enter'&&!this.searching){e.preventDefault();void this.searchPlaces()}}}></label><label>城市（可选）<input .value=${live(this.mapCity)} @input=${(e:Event)=>{this.mapCity=(e.target as HTMLInputElement).value}}></label><button ?disabled=${this.searching} @click=${()=>void this.searchPlaces()}>${this.searching?'搜索中…':'搜索地点'}</button>${this.mapRows.map(row=>html`<button class="placeResult" @click=${()=>{this.destination={name:row.name,address:row.address,latitude:String(row.latitude),longitude:String(row.longitude),coordinate_type:'gcj02',poi_id:row.poi_id};this.mapRows=[];this.requestUpdate()}}><b>${row.name}</b><small>${row.city} ${row.address}</small></button>`)}</div>`:html`<p>可在控车卡「设置」中填写高德 Web 服务 Key，启用地点搜索。</p>`}<label>从 HA 区域选择<select @change=${(e:Event)=>{const s=this.hass.states[(e.target as HTMLSelectElement).value];if(s){this.destination={name:s.attributes.friendly_name||'目的地',address:'',latitude:String(s.attributes.latitude),longitude:String(s.attributes.longitude),coordinate_type:'wgs84',poi_id:''};this.requestUpdate()}}}><option value="">手动输入</option>${Object.values(this.hass.states||{}).filter((s:any)=>s.entity_id?.startsWith('zone.')).map((s:any)=>html`<option value=${s.entity_id}>${s.attributes.friendly_name}</option>`)}</select></label>${this.input('name','目的地名称')}${this.input('address','详细地址')}<div class="grid">${this.input('latitude','纬度','number')}${this.input('longitude','经度','number')}</div><label>坐标类型<select .value=${this.destination.coordinate_type} @change=${(e:Event)=>{this.destination.coordinate_type=(e.target as HTMLSelectElement).value}}><option value="gcj02">高德／腾讯 · GCJ-02</option><option value="wgs84">GPS／HA 区域 · WGS-84</option></select></label><button @click=${()=>{const d=this.destination;if(!d.name.trim()||!d.latitude.trim()||!d.longitude.trim()){this.error='请填写目的地和坐标';this.requestUpdate();return;}void this.send('destination',{...d,latitude:Number(d.latitude),longitude:Number(d.longitude)})}}>发送到车机</button>`:html`<p>当前账号未授权发送目的地。</p>`}</details>
      <details><summary>上传全景壁纸</summary><label>选择全景图片<input type="file" accept="image/jpeg,image/png" @change=${(e:Event)=>void this.file(e)}></label><p>2:1 JPEG／PNG，宽大于 1920、高大于 960，最大 4096×2048，文件不超过 2 MiB。</p>${this.image&&this.imageUrl?html`<img class="preview" src=${this.imageUrl} alt="待上传的全景壁纸"><p>${this.imageLabel}</p>`:nothing}<button ?disabled=${!this.image} @click=${()=>void this.send('panorama',{image:this.image})}>上传到车机</button></details>`}</fieldset>`}${this.busy?html`<p>正在提交…</p>`:nothing}`;
  }
  static styles=css`
    /* 共享控件层(显式导入): 本组件有自己的 shadow root, 父卡的 CSS 进不来。
       放在前面也能生效 —— 本文件的覆盖都带 :host(...) 前缀, 特异度更高。 */
    ${unsafeCSS(uiStyles)}
    :host{display:block;font-size:12px;color:var(--primary-text-color,#222);}*{box-sizing:border-box;}fieldset{padding:0;border:0;min-width:0;}section,details{padding:12px 0;border-top:1px solid var(--divider-color,#0001);}summary,b{font-weight:600;}summary{cursor:pointer;}label{display:flex;flex-direction:column;gap:5px;margin:10px 0;}p,small{font-size:10px;line-height:1.6;color:var(--secondary-text-color,#6b7280);}button,input,select{font:inherit;color:inherit;}button{border:0;border-radius:9px;background:var(--card-background-color,#fff);box-shadow:0 1px 4px #0002;padding:7px 10px;cursor:pointer;transition:transform 160ms,opacity 160ms;}button:active{transform:scale(.97);}button:disabled,fieldset:disabled{opacity:.5;cursor:default;}input,select{width:100%;min-width:0;border:0;border-radius:8px;padding:8px;background:var(--secondary-background-color,#eef1f5);}input[type=checkbox]{appearance:none;position:relative;width:36px;height:20px;padding:0;margin:0 0 0 auto;flex:none;border-radius:999px;box-shadow:inset 0 1px 3px #0003;cursor:pointer;order:2;}input[type=checkbox]::before{content:"";position:absolute;left:3px;top:3px;width:14px;height:14px;border-radius:50%;background:var(--card-background-color,#fff);box-shadow:0 1px 3px #0003;transition:transform 160ms ease,background 160ms ease;}input[type=checkbox]:checked::before{transform:translateX(16px);background:var(--primary-color,#03a9f4);}.check{flex-direction:row;align-items:center;gap:12px;line-height:1.6;}.week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;margin:10px 0 4px;}.week button{padding:6px 0;}.week .on{color:var(--primary-color,#03a9f4);box-shadow:0 1px 4px #0002;background:color-mix(in srgb,var(--primary-color,#03a9f4) 7%,var(--card-background-color,#fff));}.placeResult{display:flex;flex-direction:column;gap:4px;text-align:left;width:100%;margin-top:8px;}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}.error{color:var(--error-color,#d44);}.preview{width:100%;display:block;aspect-ratio:2;object-fit:contain;border-radius:8px;}.toolActions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px;}.preheatTitle{font-weight:600;}.scheduleFields{animation:fieldsIn 150ms ease;}@keyframes fieldsIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){button,input[type=checkbox]::before{transition:none;}.scheduleFields{animation:none;}}
  `;
}
if(!customElements.get('leapmotor-vehicle-tools'))customElements.define('leapmotor-vehicle-tools',LeapmotorVehicleTools);
