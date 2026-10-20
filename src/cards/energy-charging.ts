import { html, svg, type TemplateResult, nothing } from "lit";
import {niceAxis,fmtTick} from "../lib/format";
import { live } from "lit/directives/live.js";

export interface Tariff {
  peak_price: number | null;
  valley_price: number | null;
  ac_peak_price?:number|null; ac_valley_price?:number|null;
  dc_periods?:{start:string;end:string;price:number}[]|null;
  valley_start: string;
  valley_end: string;
  efficiency: number; ac_efficiency?:number|null; dc_efficiency?:number|null;
}
export interface ChargeDay {
  day: string; kwh: number; grid_kwh: number; peak_kwh: number; valley_kwh: number;
  cost: number | null; consumed_kwh?: number | null;
}
export interface ChargeSession {
  id: string; started_at: number; ended_at?: number; last_at: number;
  soc_start?: number | null; soc_end?: number | null;
  kwh: number | null; grid_kwh: number | null; cost: number | null;
  active: boolean; partial: boolean; sources: string[]; reason?: string;
  charge_type?: "ac"|"dc"|"unknown"|"mixed"; peak_kw?:number|null; average_kw?:number|null;
  power_samples?:[number,number|null][];
  /** SOC values aligned by index with power_samples; null means the vehicle omitted that frame. */
  soc_samples?:(number|null)[];
  price_override?:{mode:'unit'|'total';value:number}|null;
}
export type ChargePowerSample = [number,number|null];
export function sessionSocSamples(s:ChargeSession): (number|null)[] {
  if(!Array.isArray(s.soc_samples))return [];
  return s.soc_samples.map(value=>{
    const n=value==null?null:Number(value);
    return n!=null&&Number.isFinite(n)&&n>=0&&n<=100?n:null;
  });
}
export interface ChargeData {
  vin?: string; days: ChargeDay[]; sessions: ChargeSession[]; tariff: Tariff;
  active: boolean; revision: number; timezone: string;
  summary: { kwh: number; grid_kwh: number; cost: number | null; count: number };
}
export const decimal = (n: number | null | undefined, digits = 1) => n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("zh-CN", {minimumFractionDigits:digits,maximumFractionDigits:digits});
const clock = (ts: number, zone: string, date = true) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: zone, ...(date ? {month:"numeric",day:"numeric"} as const : {}),hour:"2-digit",minute:"2-digit",hour12:false,
}).format(new Date(ts*1000));

const chargeType=(type?:string)=>type==="dc"?"直流 · 快充":type==="ac"?"交流 · 慢充":type==="mixed"?"充电类型变化":"充电类型未知";
export function sessionPowerSamples(s:ChargeSession):ChargePowerSample[] {
  return (s.power_samples||[]).reduce<ChargePowerSample[]>((out,p)=>{
    if(!Array.isArray(p)||p[0]==null||!Number.isFinite(Number(p[0])))return out;
    const kw=p[1]==null?null:Number(p[1]);
    out.push([Number(p[0]),kw!=null&&Number.isFinite(kw)?kw:null]);
    return out;
  },[]).sort((a,b)=>a[0]-b[0]);
}
function powerChart(s:ChargeSession,zone:string,selected:number,choose:(id:string,index:number)=>void):TemplateResult {
  const samples=sessionPowerSamples(s),socRaw=sessionSocSamples(s),socs=samples.map((_,i)=>socRaw[i]??null),hasSoc=socs.some(v=>v!=null),width=360,left=42,right=338,top=18,bottom=108;
  if(!samples.length)return html`<section class="powerPlot"><b>充电功率 · kW</b><div class="powerEmpty">暂无功率采样</div></section>`;
  const start=samples[0][0],end=samples[samples.length-1][0],span=Math.max(1,end-start);
  const max=Math.max(1,...samples.map(p=>p[1]??0)),x=(at:number)=>left+(at-start)/span*(right-left),y=(kw:number)=>bottom-kw/max*(bottom-top),sy=(soc:number)=>bottom-soc/100*(bottom-top);
  let d="",pen=false,previousAt:number|null=null;
  for(const [at,kw] of samples){
    if(kw==null){pen=false;previousAt=null;continue;}
    d+=(pen&&previousAt!=null&&at-previousAt<=900?"L":"M")+x(at).toFixed(1)+" "+y(kw).toFixed(1)+" ";
    pen=true;previousAt=at;
  }
  let sd="",socPen=false,socPreviousAt:number|null=null;
  samples.forEach(([at],i)=>{
    const value=socs[i];
    if(value==null){socPen=false;socPreviousAt=null;return;}
    sd+=(socPen&&socPreviousAt!=null&&at-socPreviousAt<=900?"L":"M")+x(at).toFixed(1)+" "+sy(value).toFixed(1)+" ";
    socPen=true;socPreviousAt=at;
  });
  const index=selected>=0&&selected<samples.length?selected:-1,point=index>=0?samples[index]:null;
  const cursor=point?x(point[0]):null;
  const pointSoc=index>=0?socs[index]:null;
  const readout=point
    ? `${clock(point[0],zone,true)} · ${point[1]==null?"功率暂无":decimal(point[1],1)+" kW"}${hasSoc?" · "+(pointSoc==null?"SOC 暂无":"SOC "+decimal(pointSoc,0)+"%"):""}`
    : "拖动曲线查看采样时间、功率与 SOC";
  return html`<section class="powerPlot">
    <div class="powerPlotHead"><b>${hasSoc?"充电功率 · SOC":"充电功率"}</b><span>${hasSoc?"kW · SOC % · ":"kW · "}${clock(start,zone,false)}—${clock(end,zone,false)}</span></div>
    <svg class="sessionPowerSvg" data-session-id=${s.id} data-plot-left=${left} data-plot-right=${right}
      data-plot-start=${start} data-plot-end=${end} viewBox=${`0 0 ${width} 148}`} role="group" tabindex="0"
      aria-label=${hasSoc?"充电功率与 SOC 变化，左右方向键选择采样点":"充电功率变化，左右方向键选择采样点"}
      @keydown=${(e:KeyboardEvent)=>{if(e.key!=="ArrowLeft"&&e.key!=="ArrowRight")return;e.preventDefault();choose(s.id,Math.max(0,Math.min(samples.length-1,index<0?0:index+(e.key==="ArrowRight"?1:-1))))}}>
      ${[0,.5,1].map(f=>{const kw=max*f,yy=y(kw);return svg`<line x1=${left} x2=${right} y1=${yy} y2=${yy} class="powerGrid"/><text x=${left-6} y=${yy+3} text-anchor="end" class="axisTxt">${decimal(kw,1)}</text>`})}
      <path d=${d} fill="none" stroke="#40b49d" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${hasSoc?svg`<path class="socLine" d=${sd} fill="none" stroke="#7b6de0" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>${[0,50,100].map(v=>svg`<text x=${right+5} y=${sy(v)+3} class="axisTxt socAxis">${v}</text>`)}`:nothing}
      ${point&&cursor!=null?svg`<line x1=${cursor} x2=${cursor} y1=${top} y2=${bottom} class="powerCursor"/>${point[1]!=null?svg`<circle cx=${cursor} cy=${y(point[1])} r="4" class="powerPoint"/>`:nothing}${pointSoc!=null?svg`<circle cx=${cursor} cy=${sy(pointSoc)} r="3.5" class="socPoint"/>`:nothing}`:nothing}
      <text x=${left} y="138" class="axisTxt">${clock(start,zone,false)}</text><text x=${right} y="138" text-anchor="end" class="axisTxt">${clock(end,zone,false)}</text>
    </svg>
    <div class="powerReadout" aria-live="polite">${readout}</div>
  </section>`;
}

export function chargePanel(data: ChargeData | null, error: string, selected: number, choose: (i: number) => void, priceEditor:(s:ChargeSession)=>TemplateResult|typeof nothing=()=>nothing, rangeTools:TemplateResult|typeof nothing=nothing, recordTools:TemplateResult|typeof nothing=nothing, plot:{width?:number;series:string[];chart:string;toggle:(key:string)=>void;switchChart:()=>void}={series:["charge","used"],chart:"line",toggle:()=>{},switchChart:()=>{}}, sessionSelected:Record<string,number>={}, chooseSession:(id:string,index:number)=>void=()=>{}): TemplateResult {
  if (error) return html`<p class="billNote error">${error}</p>`;
  if (!data) return html`<p class="billNote">正在读取充电记录…</p>`;
  const days = data.days, count = days.length;
  const axis=niceAxis(Math.max(0,...days.flatMap(d=>[d.kwh,d.consumed_kwh||0])),4),costAxis=niceAxis(Math.max(0,...days.map(d=>d.cost||0)),4);
  const width=Math.max(220,plot.width||350),height=122,bottom=150,step=(width-50)/Math.max(1,count),x=(i:number)=>32+(i+.5)*step;
  const series=[{key:'charge',label:'充电',unit:'kWh',color:'#40b49d',values:days.map(d=>d.kwh),axis},
    {key:'used',label:'行驶耗电',unit:'kWh',color:'#e6a15a',values:days.map(d=>d.consumed_kwh??null),axis},
    {key:'cost',label:'电费',unit:'元',color:'#6c86e8',values:days.map(d=>d.cost),axis:costAxis}].filter(v=>plot.series.includes(v.key));
  const y=(v:number,axis:{max:number})=>bottom-v/axis.max*height;
  const pick=days[selected];
  const tip=pick?html`<div class="chargeTip on" style=${`--tip-x:${x(selected)/width*100}%`} aria-live="polite"><b>${pick.day}</b>${series.map(v=>html`<span><i style=${'background:'+v.color}></i>${v.label} ${decimal(v.values[selected],2)} ${v.unit}</span>`)}</div>`:nothing;
  const graph=html`<div class="chargeChart"><svg viewBox=${`0 0 ${width} 176`} preserveAspectRatio="none" class="chargeSvg" role="img" aria-label="逐日充电与行驶耗电趋势图">
    ${(series.some(s=>s.key!=='cost')?axis:costAxis).ticks.map(t=>svg`<line x1="32" x2=${width-18} y1=${y(t,series.some(s=>s.key!=='cost')?axis:costAxis)} y2=${y(t,series.some(s=>s.key!=='cost')?axis:costAxis)} class="gridline"/><text x="26" y=${y(t,series.some(s=>s.key!=='cost')?axis:costAxis)+3} text-anchor="end" class="axisTxt">${fmtTick(t)}</text>`)}
    ${series.some(s=>s.key==='cost')&&series.length>1?costAxis.ticks.map(t=>svg`<text x=${width-14} y=${y(t,costAxis)+3} class="axisTxt" fill="#6c86e8">${fmtTick(t)}</text>`):nothing}
    ${pick?svg`<rect class="chartHit selected" x=${32+selected*step} y="28" width=${step} height=${height} rx="3"/>`:nothing}
    ${series.map((v,j)=>{let path='';let gap=true;v.values.forEach((value,i)=>{if(value==null){gap=true;return;}path+=(gap?'M':'L')+x(i)+' '+y(value,v.axis)+' ';gap=false;});return plot.chart==='bar'?v.values.map((value,i)=>value==null?nothing:svg`<rect x=${32+i*step+step*.15+j*step*.7/series.length} y=${y(value,v.axis)} width=${step*.7/series.length-1} height=${bottom-y(value,v.axis)} fill=${v.color} rx="1.5"/>`):svg`<path d=${path} fill="none" stroke=${v.color} stroke-width="2.5"/>${v.values.map((value,i)=>value==null?nothing:svg`<circle cx=${x(i)} cy=${y(value,v.axis)} r=${i===selected?4.2:2.6} fill=${v.color}/>`)} `;})}
    ${days.map((d,i)=>svg`<g role="button" tabindex="0" aria-pressed=${selected===i} aria-label=${d.day+' 查看详情'} @click=${(e:MouseEvent)=>{if(e.detail===0)choose(i)}} @keydown=${(e:KeyboardEvent)=>{if(['Enter',' ','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();choose(Math.max(0,Math.min(count-1,i+(e.key==='ArrowLeft'?-1:e.key==='ArrowRight'?1:0))))}}}><rect class="chartHit" x=${32+i*step} y="28" width=${step} height=${height}/>${(count-1-i)%Math.max(1,Math.ceil(count/Math.max(2,Math.floor((width-50)/34))))===0?svg`<text x=${x(i)} y="170" text-anchor="middle" class="axisTxt">${d.day.slice(5).replace('-','/')}</text>`:nothing}</g>`)}
    </svg>${tip}</div>`;
  const metric=(label:string,value:string,unit="")=>html`<div class="chargeDataMetric"><span>${label}</span><b>${value}${unit?html`<i>${unit}</i>`:nothing}</b></div>`;
  return html`<section class="chargePlot"><div class="plotHeading"><b>充电与行驶耗电</b><span>${[series.some(s=>s.key!=='cost')?'kWh':'',series.some(s=>s.key==='cost')?'元':''].filter(Boolean).join(' · ')} / 日</span></div>${graph}<div class="chargeCtrls"><div class="chargeSeries">${[['charge','充电','#40b49d'],['used','行驶耗电','#e6a15a'],['cost','电费','#6c86e8']].map(([key,label,color])=>html`<button aria-pressed=${plot.series.includes(key)} class=${plot.series.includes(key)?'on':''} @click=${()=>plot.toggle(key)}><i style=${'background:'+color}></i>${label}</button>`)}</div><div class="chargeRange">${rangeTools}<button class="chartSwitch" @click=${()=>plot.switchChart()}>${plot.chart==='bar'?'柱状':'折线'}</button></div></div></section><section class="chargeRecords"><div class="plotHeading"><b>充电记录</b><span>${data.summary.count} 次${data.active?" · 正在充电":""}</span>${recordTools}</div>${data.sessions.length?data.sessions.map(s=>{const mins=Math.max(0,(s.last_at-s.started_at)/60),soc=s.soc_start==null&&s.soc_end==null?"—":`${decimal(s.soc_start,0)}% → ${decimal(s.soc_end,0)}%`,costLabel=s.price_override?.mode==="total"?"实付费用":s.cost==null?"费用":"估算费用";return html`<details class="chargeRecord"><summary><span class="chargeWhen"><b>${clock(s.started_at,data.timezone)}</b><small>${s.active?"正在充电":clock(s.ended_at||s.last_at,data.timezone,false)}${s.partial?" · 部分记录":""} · ${chargeType(s.charge_type)}</small></span><span class="chargeAmount"><b>${decimal(s.kwh,2)}<small> kWh</small></b><small>${s.cost==null?"未设电价":(s.price_override?.mode==="total"?"实付 ¥":"约 ¥")+decimal(s.cost,2)}</small></span><ha-icon class="chargeChevron" icon="mdi:chevron-down"></ha-icon></summary><div class="chargeDetail">${powerChart(s,data.timezone,sessionSelected[s.id]??-1,chooseSession)}<section class="chargeDataCard"><header class="chargeDataHead"><div><b>充电详情</b><small>${clock(s.started_at,data.timezone)} — ${s.active?"进行中 · "+clock(s.last_at,data.timezone):clock(s.ended_at||s.last_at,data.timezone)}</small></div><span class="chargeTypeTag">${s.active?"正在充电":s.partial?"部分记录":"已结束"}</span></header><div class="chargeDataGrid">${metric("充电类型",chargeType(s.charge_type))}${metric("观测时长",decimal(mins,0),"分钟")}${metric("电量变化",soc)}${metric("电池侧充电",decimal(s.kwh,2),"kWh")}${metric("估算取电",decimal(s.grid_kwh,2),"kWh")}${metric(costLabel,s.cost==null?"—":"¥"+decimal(s.cost,2))}${metric("平均功率",decimal(s.average_kw),"kW")}${metric("峰值功率",decimal(s.peak_kw),"kW")}</div><div class="chargeDataNotes"><span>${s.sources.includes("soc")?"含 SOC 与电池容量折算":s.sources.length?"按充电功率采样估算":"暂无可用电量样本"}</span>${s.reason?html`<span>结束原因：${s.reason}</span>`:nothing}${s.partial?html`<span class="partialNote">存在中断或缺失采样，本次记录可能不完整</span>`:nothing}${s.price_override?html`<span>${s.price_override.mode==="total"?"本次实付总额":"本次独立电价"} · ${s.price_override.mode==="unit"?decimal(s.price_override.value,2)+" 元/kWh":"¥"+decimal(s.price_override.value,2)}</span>`:nothing}</div>${priceEditor(s)}</section></div></details>`}):html`<p class="billNote">还没有驻车充电记录。记录从安装此版本后开始。</p>`}</section><p class="billNote">仅记录驻车且明确充电的采样区间；费用按当前或本次指定电价估算，已录入的实付金额单独计入。</p>`;
}

export function tariffForm(draft: Record<string,string>, saving: boolean, error: string, timezone: string,
                           edit: (key: string,value: string)=>void, save: ()=>void, close: ()=>void,
                           periods:{start:string;end:string;price:string}[], editPeriod:(i:number,key:'start'|'end'|'price',value:string)=>void,addPeriod:()=>void,removePeriod:(i:number)=>void): TemplateResult {
  const input=(key:string,label:string,type="number",min="0",max="100")=>html`<label>${label}<input type=${type} min=${min} max=${max} step=${type==="time"?60:.01} .value=${live(draft[key]||"")} @input=${(e:Event)=>edit(key,(e.target as HTMLInputElement).value)} ?disabled=${saving}></label>`;
  const efficiency=(key:string,label:string)=>html`<label class="tariffEfficiency"><span>${label}</span><span class="tariffEfficiencyInput"><input type="number" min="50" max="100" step="1" .value=${live(draft[key]||"")} @input=${(e:Event)=>edit(key,(e.target as HTMLInputElement).value)} ?disabled=${saving}><i>%</i></span></label>`;
  return html`<div class="tariffBackdrop" @click=${(e:Event)=>{if(e.target===e.currentTarget&&!saving)close()}} @keydown=${(e:KeyboardEvent)=>{if(e.key==='Escape'&&!saving){e.stopPropagation();close()}if(e.key==='Tab'){const nodes=Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')).filter(n=>n.offsetParent!==null),first=nodes[0],last=nodes[nodes.length-1],active=first?.getRootNode() as ShadowRoot;if(e.shiftKey&&active?.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&active?.activeElement===last){e.preventDefault();first?.focus()}}}}><section class="tariffForm" role="dialog" aria-modal="true" aria-label="电价设置" tabindex="-1">
    <header class="tariffHead"><div><b>电价设置</b><small>${timezone}</small></div><button aria-label="关闭电价设置" @click=${close} ?disabled=${saving}>×</button></header>
    <div class="tariffScroll">
      <section class="tariffSection"><div class="tariffSectionHead"><b>交流慢充</b><span>家用峰谷价</span></div>
        <div class="tariffGrid">${input("ac_peak_price","峰电价 · 元/kWh")}${input("ac_valley_price","谷电价 · 元/kWh")}</div>
        <div class="tariffMeta"><div class="tariffTimeGroup"><span class="tariffFieldLabel">谷电时段</span><div class="tariffTimeRange">
          ${input("valley_start","开始","time")}<span class="tariffTimeArrow">至</span>${input("valley_end","结束","time")}
        </div></div>${efficiency("ac_efficiency","交流效率")}</div>
        <p class="billNote">支持跨午夜，谷电时段之外使用峰电价。</p>
      </section>
      <section class="tariffSection"><div class="tariffSectionHead"><b>直流快充</b><span>公共分时价</span></div>
        <p class="billNote">填写含服务费的单价，时段须无重叠并覆盖 24 小时。开始与结束相同表示全天；价格全部留空可暂不设置分时价。</p>
        <div class="periodRows">${periods.map((p,i)=>html`<div class="periodRow">
          <div class="periodTimes"><label><span>开始</span><input type="time" aria-label=${'时段'+(i+1)+'开始'} .value=${live(p.start)} @input=${(e:Event)=>editPeriod(i,'start',(e.target as HTMLInputElement).value)} ?disabled=${saving}></label><span class="periodTimeArrow">至</span><label><span>结束</span><input type="time" aria-label=${'时段'+(i+1)+'结束'} .value=${live(p.end)} @input=${(e:Event)=>editPeriod(i,'end',(e.target as HTMLInputElement).value)} ?disabled=${saving}></label></div>
          <label class="periodPrice"><span>电价 · 元/kWh</span><input type="number" min="0" max="100" step="0.01" aria-label=${'时段'+(i+1)+'电价'} .value=${live(p.price)} @input=${(e:Event)=>editPeriod(i,'price',(e.target as HTMLInputElement).value)} ?disabled=${saving}></label>
          <button aria-label=${'删除时段'+(i+1)} @click=${()=>removePeriod(i)} ?disabled=${saving||periods.length===1}>×</button>
        </div>`)}</div>
        <button class="addPeriod" @click=${addPeriod} ?disabled=${saving||periods.length>=24}>添加电价时段</button>
      </section>
      <section class="tariffSection"><div class="tariffSectionHead"><b>能耗折算</b><span>电池侧 → 电网侧</span></div>
        ${efficiency("dc_efficiency","直流效率")}
        <p class="billNote">交流和直流按各自效率折算取电量；未知枪型保留旧默认效率。费用按对应枪型计价，未单独修正的历史费用按当前设置重算。</p>
      </section>
      ${error?html`<p class="billNote error" role="alert">${error}</p>`:nothing}
    </div>
    <div class="tariffActions"><button @click=${close} ?disabled=${saving}>取消</button><button class="savePrice" @click=${save} ?disabled=${saving}>${saving?"保存中…":"保存电价"}</button></div>
  </section></div>`;
}

export const energyPanelStyles = `
  .card { container-type:inline-size; gap:14px; }
  .energyTop{display:flex;align-items:center;gap:10px;}.energyTop .energyModes{flex:1;min-width:0;}.energyTop .refresh{flex:none;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:50%;background:var(--lm-surface-control, var(--card-background-color,#fff));color:inherit;box-shadow:var(--lm-shadow-control, 0 1px 4px #0002);cursor:pointer;}
  .head { border-bottom:0; padding-bottom:0; }
  .head .title { font-size:16px; letter-spacing:-.02em; }
  .head .sum { font-size:11px; color:var(--secondary-text-color,#6b7280); }
  .energyModes { position:relative;display:flex; gap:4px; padding:4px; border-radius:var(--lm-radius-control, 12px); background:var(--lm-surface-inset, var(--secondary-background-color,#eef1f5)); }
  .energyModes button { flex:1; border:0; padding:8px; border-radius:var(--lm-radius-control, 9px); background:transparent; color:var(--secondary-text-color,#6b7280); font:inherit; cursor:pointer; }
  .energyModes .modeIndicator { position:absolute;left:4px;top:4px;bottom:4px;width:calc((100% - 8px)/2);border-radius:var(--lm-radius-control, 9px);background:var(--lm-surface-control, var(--card-background-color,#fff));box-shadow:var(--lm-shadow-control, 0 1px 4px #0002);transition:transform 180ms ease;pointer-events:none; }.energyModes.charge .modeIndicator{transform:translateX(100%);}.energyModes button{position:relative;z-index:1;padding:10px 4px;font-size:12px;}.energyModes button.on { color:var(--primary-text-color,#222);font-weight:650; }
  .energySummary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
  .energyStat { display:flex; flex-direction:column; gap:4px; padding:10px 9px; min-width:0; border-radius:var(--lm-radius-control, 12px); background:color-mix(in srgb,var(--primary-color,#03a9f4) 5%,var(--lm-surface-control, var(--card-background-color,#fff))); }
  .energyStat span,.energyStat small { font-size:10px; color:var(--secondary-text-color,#6b7280); }
  .energyStat b { font-size:23px; font-weight:650; letter-spacing:-.04em; white-space:nowrap; }
  .energyStat small { font-weight:400;letter-spacing:0; }
  .energyStat.cost b { color:#15956e; }
  .energyTools { display:flex;align-items:center;justify-content:flex-end;gap:5px;margin-top:8px; }
  .energyTools button { font:inherit; border:0; padding:5px 8px; font-size:10px; border-radius:var(--lm-radius-control, 8px); cursor:pointer; color:inherit; background:var(--lm-surface-control, var(--card-background-color,#fff));box-shadow:var(--lm-shadow-control, 0 1px 4px #0002); }
  .energyTools button.on { color:var(--primary-color,#03a9f4); }
  .plotHeading .priceBtn { margin-left:auto;font-size:10px;border:0;padding:6px 8px;border-radius:var(--lm-radius-control, 8px);background:var(--lm-surface-control, var(--card-background-color,#fff));color:inherit;box-shadow:var(--lm-shadow-control, 0 1px 4px #0002);cursor:pointer; }.plotHeading .priceBtn:disabled{opacity:.45;cursor:default;}.chargeRecords .plotHeading{justify-content:flex-start;}
  .billNote { color:var(--secondary-text-color,#6b7280); font-size:11px; line-height:1.6; margin:4px 0; }
  .billNote.error { color:var(--error-color,#db4437); }
  .plotHeading { display:flex; align-items:center; justify-content:space-between;gap:8px;font-size:12px; }
  .plotHeading span { font-size:10px;color:var(--secondary-text-color,#6b7280); }
  .chargePlot { padding:12px 10px; border-radius:var(--lm-radius-section, 14px); background:var(--lm-surface-control, var(--card-background-color,#fff));box-shadow:var(--lm-shadow-control, 0 1px 4px #0002); }
  .chargeLegend { display:flex;flex-wrap:wrap;gap:12px;margin-top:10px;font-size:10px;color:var(--secondary-text-color,#6b7280); }
  .chargeLegend span { display:flex;align-items:center;gap:4px; }
  .chargeLegend i { width:6px;height:6px;border-radius:2px; }
  .valley { fill:#40b49d; background:#40b49d; } .peak { fill:#6c86e8;background:#6c86e8; } .used { fill:#e6a15a;background:#e6a15a; }
  .chargeSvg { height:176px;user-select:none;-webkit-user-select:none;width:100%;display:block;margin-top:6px;overflow:visible;touch-action:pan-y; }
  .chartHit { fill:transparent;cursor:ew-resize; }.chartHit.selected{fill:var(--primary-color,#03a9f4);fill-opacity:.09;} .chargeSvg g:focus { outline:0; } .chargeSvg g:focus .chartHit { stroke:var(--primary-color,#03a9f4); }
  .chargeChart{position:relative;}.chargeTip{position:absolute;z-index:2;top:12px;left:clamp(min(106px,50%),var(--tip-x,50%),max(50%,calc(100% - 106px)));transform:translateX(-50%);display:none;pointer-events:none;flex-direction:column;gap:4px;width:200px;max-width:calc(100% - 12px);padding:8px 10px;border-radius:var(--lm-radius-control, 10px);font-size:10px;line-height:1.5;background:var(--lm-surface-control, var(--card-background-color,#fff));box-shadow:var(--lm-shadow-floating, 0 1px 4px #0003);box-sizing:border-box;}.chargeTip.on{display:flex;}.chargeTip span{overflow-wrap:anywhere;}

  .chargeCtrls,.chargeSeries,.chargeRange{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}.chargeCtrls{margin-top:10px;}.chargeRange{margin-left:auto;}.chargeRange .energyTools{margin:0;}.chargeCtrls button{border:0;border-radius:var(--lm-radius-control, 8px);padding:5px 8px;font:inherit;font-size:10px;color:inherit;background:var(--lm-surface-control, var(--card-background-color,#fff));box-shadow:var(--lm-shadow-control, 0 1px 4px #0002);cursor:pointer;}.chargeSeries button{display:flex;align-items:center;gap:4px;opacity:.5;}.chargeSeries button.on{opacity:1;}.chargeSeries i,.chargeTip i{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;}
  .chargeRecords { display:flex; flex-direction:column; gap:8px; margin-top:16px; }
  .chargeRecord { padding:0 10px; border:var(--lm-section-border,0);border-radius:var(--lm-radius-section,14px);background:var(--lm-surface-section,var(--card-background-color,#fff));box-shadow:var(--lm-shadow-section,0 1px 4px rgba(0,0,0,.16)); }
  .chargeRecord summary { display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;padding:11px 0;list-style:none; }
  .chargeRecord summary::-webkit-details-marker { display:none; }
  .chargeWhen,.chargeAmount { display:flex;flex-direction:column;gap:4px;min-width:0; }
  .chargeWhen b,.chargeAmount b { font-size:13px; }.chargeWhen small,.chargeAmount small { font-size:10px;color:var(--secondary-text-color,#6b7280); }
  .chargeAmount { text-align:right; }
  .chargeChevron{flex:none;--mdc-icon-size:18px;color:var(--secondary-text-color,#6b7280);transition:transform 160ms ease;}.chargeRecord[open] .chargeChevron{transform:rotate(180deg);}
  .chargeDetail { display:flex;flex-direction:column;gap:10px;padding:0 0 12px;font-size:10px;color:var(--secondary-text-color,#6b7280); }
  .tariffBackdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--lm-mask, #0006);box-sizing:border-box;}.tariffForm { display:flex;flex-direction:column;width:min(460px,100%);max-height:85dvh;overflow:hidden;padding:0;border-radius:var(--lm-radius-overlay, 18px);background:var(--lm-surface-control, var(--card-background-color,#fff));color:var(--primary-text-color,#222);box-shadow:var(--lm-shadow-dialog, 0 8px 30px #0003);box-sizing:border-box; }.tariffHead{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px;flex:none;}.tariffHead div{display:grid;gap:4px;}.tariffHead small{font-size:10px;color:var(--secondary-text-color,#6b7280);}.tariffHead button,.periodRow button,.addPeriod{border:0;border-radius:var(--lm-radius-control, 9px);padding:7px 10px;background:var(--lm-surface-control, var(--card-background-color,#fff));color:inherit;box-shadow:var(--lm-shadow-control, 0 1px 4px #0002);font:inherit;cursor:pointer;}.tariffHead button{font-size:20px;line-height:1;}.tariffScroll{overflow-y:auto;overscroll-behavior:contain;padding:0 16px;}.tariffSection{padding:12px 0;border-top:1px solid var(--divider-color,#0001);}.tariffSection>b{font-size:12px;}.periodRows{display:grid;gap:8px;margin:12px 0;}.periodRow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,.85fr) 28px;gap:6px;align-items:end;}.periodRow label{display:grid;gap:5px;font-size:10px;color:var(--secondary-text-color,#6b7280);}.periodRow input{box-sizing:border-box;min-width:0;width:100%;border:0;border-radius:var(--lm-radius-control, 8px);padding:8px 3px;background:var(--lm-surface-inset, var(--secondary-background-color,#eef1f5));color:inherit;font:inherit;}.periodRow button{padding:8px 0;}.tariffForm .tariffActions{padding:12px 16px;flex:none;border-top:1px solid var(--divider-color,#0001);}.tariffForm button:disabled{opacity:.45;cursor:default;}
  .tariffGrid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0; }
  .tariffGrid label { display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--secondary-text-color,#6b7280); }
  .tariffGrid input { min-width:0; width:100%;box-sizing:border-box;border:0;border-radius:var(--lm-radius-control, 8px);padding:8px;background:var(--lm-surface-inset, var(--secondary-background-color,#eef1f5));color:var(--primary-text-color,#212121);font:inherit; }
  .tariffForm { width:min(520px,100%);container-type:inline-size; }
  .tariffSectionHead { display:flex;align-items:baseline;gap:8px; }
  .tariffSectionHead span { margin-left:auto;font-size:10px;color:var(--secondary-text-color,#6b7280); }
  .tariffSectionHead b { font-size:13px; }
  .tariffSection .tariffGrid { margin:10px 0; }
  .tariffMeta { display:grid;gap:10px;margin:10px 0; }
  .tariffTimeGroup { display:grid;gap:5px; }
  .tariffFieldLabel,.tariffTimeRange label,.periodTimes label,.periodPrice,.tariffEfficiency { font-size:10px;color:var(--secondary-text-color,#6b7280); }
  .tariffTimeRange { display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:8px; }
  .tariffTimeRange label,.periodTimes label { display:grid;gap:4px;min-width:0; }
  .tariffTimeRange label>span,.periodTimes label>span { font-size:9px; }
  .tariffTimeArrow,.periodTimeArrow { text-align:center;font-size:11px;color:var(--secondary-text-color,#6b7280); }
  .tariffTimeRange input,.tariffEfficiencyInput input { box-sizing:border-box;min-width:0;width:100%;border:0;border-radius:var(--lm-radius-control,8px);padding:8px 7px;background:var(--lm-surface-inset,var(--secondary-background-color,#eef1f5));color:var(--primary-text-color,#212121);font:inherit; }
  .tariffEfficiency { display:flex;flex-direction:column;gap:5px;width:min(100%,180px); }
  .tariffEfficiencyInput { display:flex;align-items:center;gap:6px; }
  .tariffEfficiencyInput input { width:90px; }
  .tariffEfficiencyInput i { font-style:normal; }
  .periodRows { display:grid;gap:8px;margin:12px 0; }
  .periodRow { display:grid;grid-template-columns:minmax(0,1.35fr) minmax(100px,.8fr) 32px;align-items:end;gap:8px; }
  .periodTimes { display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:end;gap:5px;min-width:0; }
  .periodPrice { display:grid;gap:4px;min-width:0;white-space:nowrap; }
  .periodTimes input,.periodPrice input { box-sizing:border-box;min-width:0;width:100%;height:36px;border:0;border-radius:var(--lm-radius-control,8px);padding:7px 6px;background:var(--lm-surface-inset,var(--secondary-background-color,#eef1f5));color:var(--primary-text-color,#212121);font:inherit; }
  .periodRow button { width:32px;height:36px;padding:0; }
  @container (max-width:360px) {
    .periodRow { grid-template-columns:minmax(0,1fr) 32px;column-gap:6px; }
    .periodTimes { grid-column:1/-1; }
    .periodPrice { grid-column:1;grid-row:2; }
    .periodRow button { grid-column:2;grid-row:2; }
  }
  .tariffActions { display:flex;justify-content:flex-end;gap:8px; }
  .tariffActions button { box-shadow:var(--lm-shadow-control, 0 1px 4px #0002);border:0;border-radius:var(--lm-radius-control, 8px);padding:8px 12px;font:inherit;cursor:pointer;background:var(--lm-surface-control, var(--card-background-color,#fff));color:inherit; }
  .tariffActions .savePrice { background:var(--primary-color,#03a9f4);color:white; }
  .sessionPrice{grid-column:1/-1;}.sessionPrice button{border:0;padding:6px 10px;border-radius:var(--lm-radius-control, 8px);font:inherit;background:var(--lm-surface-control, var(--card-background-color,#fff));color:inherit;box-shadow:var(--lm-shadow-control, 0 1px 4px #0002);cursor:pointer;}.sessionPrice input,.sessionPrice select{width:100%;min-width:0;padding:7px;border:0;border-radius:var(--lm-radius-control, 8px);font:inherit;color:inherit;background:var(--lm-surface-inset, var(--secondary-background-color,#eef1f5));}.sessionPrice label{display:grid;gap:6px;margin:8px 0;}
  .chartSec { box-shadow:var(--lm-shadow-section, 0 1px 4px rgba(0,0,0,.16));padding:12px 8px;border-radius:var(--lm-radius-section, 14px);background:var(--lm-surface-control, var(--card-background-color,#fff)); }
  .energyStat { background:var(--lm-surface-control, var(--card-background-color,#fff));box-shadow:var(--lm-shadow-section, 0 1px 4px rgba(0,0,0,.16)); }.energyModes{background:var(--lm-surface-inset, var(--secondary-background-color,#eef1f5));box-shadow:inset 0 1px 3px #0001;}
  .ctrls .chip { box-shadow:var(--lm-shadow-section, 0 1px 4px rgba(0,0,0,.16)); }
  .energySummary.reev { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .powerPlot { padding:10px;border-radius:var(--lm-radius-section,14px);background:var(--lm-surface-section,var(--card-background-color,#fff));box-shadow:var(--lm-shadow-section,0 1px 4px rgba(0,0,0,.16));font-size:10px; }
  .powerPlotHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;}.powerPlotHead b{font-size:12px;color:var(--primary-text-color,#222);}.powerPlotHead span{font-size:10px;white-space:nowrap;}
  .sessionPowerSvg{display:block;width:100%;height:auto;margin-top:6px;overflow:visible;touch-action:pan-y;user-select:none;-webkit-user-select:none;cursor:ew-resize;}
  .powerGrid{stroke:var(--divider-color,#0002);stroke-dasharray:3 4;opacity:.8;}.powerPlot .axisTxt{font-size:9px;fill:var(--secondary-text-color,#6b7280);}.powerCursor{stroke:var(--primary-text-color,#222);stroke-width:1;stroke-dasharray:3 3;opacity:.7;pointer-events:none;}.powerPoint{fill:#40b49d;stroke:var(--card-background-color,#fff);stroke-width:2;pointer-events:none;}.socLine{pointer-events:none;}.socPoint{fill:#7b6de0;stroke:var(--card-background-color,#fff);stroke-width:2;pointer-events:none;}.socAxis{fill:#7b6de0!important;}
  .powerReadout{min-height:16px;margin-top:4px;font-size:10px;color:var(--secondary-text-color,#6b7280);}.powerEmpty{padding:26px 4px;text-align:center;color:var(--secondary-text-color,#6b7280);}
  .chargeDataCard{padding:12px;border-radius:var(--lm-radius-section,14px);background:var(--lm-surface-section,var(--card-background-color,#fff));box-shadow:var(--lm-shadow-section,0 1px 4px rgba(0,0,0,.16));}
  .chargeDataHead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:10px;border-bottom:1px solid var(--divider-color,#0001);}.chargeDataHead>div{display:grid;gap:4px;min-width:0;}.chargeDataHead b{font-size:13px;color:var(--primary-text-color,#222);}.chargeDataHead small{font-size:10px;overflow-wrap:anywhere;}.chargeTypeTag{flex:none;padding:4px 7px;border-radius:999px;background:var(--lm-surface-inset,var(--secondary-background-color,#eef1f5));font-size:9px;}
  .chargeDataGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 8px;padding:12px 0;}.chargeDataMetric{display:flex;flex-direction:column;gap:4px;min-width:0;}.chargeDataMetric>span{font-size:10px;}.chargeDataMetric>b{font-size:14px;font-weight:650;line-height:1.25;color:var(--primary-text-color,#222);overflow-wrap:anywhere;}.chargeDataMetric i{margin-left:3px;font-size:9px;font-weight:400;font-style:normal;color:var(--secondary-text-color,#6b7280);}
  .chargeDataNotes{display:flex;flex-direction:column;gap:4px;padding-top:8px;border-top:1px solid var(--divider-color,#0001);font-size:10px;line-height:1.5;}.chargeDataNotes .partialNote{color:var(--warning-color,#a66b00);}
  @container(max-width:360px){.chargeDataGrid{grid-template-columns:repeat(2,minmax(0,1fr));}}
  .ctrls { gap:5px; }
  .ctrls .chip { box-shadow:var(--lm-shadow-section, 0 1px 4px rgba(0,0,0,.16)); padding:5px 8px; font-size:10px; border-radius:var(--lm-radius-control, 8px); }
  .gridline { stroke-dasharray:3 5;opacity:.7; }.line { stroke-width:2.5; }
  .tip { white-space:normal;max-width:calc(100% - 16px);box-sizing:border-box; }
  @container(max-width:300px) { .energyStat { padding:8px 6px; }.energyStat b { font-size:19px; }.head .sum { display:none; } }
`;
