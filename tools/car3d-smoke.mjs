// 验证包装页的加载门控、相机稳定、状态去重与消息来源；不联网、不执行车控。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const calls=[], messages=[], handlers={}, timers=[];
const tex=()=>({image:{original:true},dispose(){}});
const sky={parent:{},material:{uniforms:{nightTexture:{value:tex()},dayTexture:{value:tex()},colorStrength:{value:1}},setDayOrNightImmediately(v){this.d2n=v}}};
class Vector {constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z}clone(){return new Vector(this.x,this.y,this.z)}copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this}lerp(v,t){this.x+=(v.x-this.x)*t;this.y+=(v.y-this.y)*t;this.z+=(v.z-this.z)*t;return this}sub(v){this.x-=v.x;this.y-=v.y;this.z-=v.z;return this}normalize(){const n=Math.hypot(this.x,this.y,this.z)||1;this.x/=n;this.y/=n;this.z/=n;return this}addScaledVector(v,s){this.x+=v.x*s;this.y+=v.y*s;this.z+=v.z*s;return this}project(){return this}}
let theta=.3,phi=1.1,distance=17,now=10;
const controls={enabled:true,target0:{y:0},target:new Vector(),getAzimuthalAngle:()=>theta,getPolarAngle:()=>phi,getDistance:()=>distance,setThetaImmediately(v){theta=v},setPhiImmediately(v){phi=v},update(){},setRadiusImmediately(r){distance=r;calls.push(['radius',r])}};
const motionCalls=[];
class PaintVector{constructor(...values){this.values=values}set(...values){this.values=values;return this}clone(){return new PaintVector(...this.values)}copy(v){return this.set(...v.values)}}
const color=new PaintVector(.4,.5,.6,.8),blend=new PaintVector(.11,.22,.33,.7);
const car={handleVehicleMove(s){motionCalls.push(s)},update(){},carPaint_CarPaintMaterial:{uniforms:{color:{value:color},blendColor:{value:blend},untouched:{value:'roof/glass/wrap'}}}};
for(const [key,pos] of Object.entries({LF:new Vector(-1,0,0),RF:new Vector(1,0,0),LR:new Vector(0,0,0),RR:new Vector(2,0,0)}))car['wheel'+key+'2']={position:pos,getWorldPosition(target){return target.copy(pos)}};
for(const [key,method] of [['lf','handleDoorLFWindow'],['rf','handleDoorRFWindow'],['lr','handleDoorLRWindow'],['rr','handleDoorRRWindow'],['trunk','handleTrunk']]){
  car[method]=(value,immediate)=>calls.push([key,value,immediate,controls.enabled]);
}
const viewer={controls,renderer:{render(){}},camera:{},scene:{traverse(cb){cb(sky)}},frameState:{},setRadius(r){calls.push(['reset',r])},setOffsetVertical(){},setFPS(){}};
let pending=true;
const gradient={addColorStop(){}};
const context={createLinearGradient(){return gradient},fillRect(){},beginPath(){},moveTo(){},lineTo(){},bezierCurveTo(){},fill(){},stroke(){}};
const bootStyle={setProperty(k,v){this[k]=v}};
const docHandlers={};
const doc={documentElement:{style:bootStyle,classList:{remove(){pending=false}}},addEventListener(k,fn){docHandlers[k]=fn},createElement(){return {getContext(){return context}}}};
const parent={postMessage(m){messages.push(m)}};
const win={viewer,car,addEventListener(type,fn){handlers[type]=fn},newInit:async()=>{}};
const env={window:win,document:doc,parent,location:{origin:'http://localhost',search:'?car=C16&year=2025&roof=7&sdk=3.20.0&radius=17&bg=night'},
  innerWidth:400,innerHeight:300,URLSearchParams,performance:{now:()=>now},requestAnimationFrame:cb=>setImmediate(()=>{now+=34;cb(now)}),cancelAnimationFrame:clearImmediate,
  setTimeout:cb=>{timers.push(cb);return timers.length},clearTimeout(){},Image:class{set src(_){setImmediate(()=>this.onload?.())}},console};
const src=readFileSync(new URL('../custom_components/leapmotor/www/car3d/view.js',import.meta.url),'utf8').replace('await import(`./index.js?v=${WRAPPER_VERSION}`);','');
await vm.runInNewContext(`(async()=>{${src}\n})()`,env);
const send=data=>handlers.message({source:parent,origin:'http://localhost',data});
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r))};
assert.equal(bootStyle["--boot-bg"],"#101a2b");assert.equal(bootStyle.colorScheme,"dark");
win.onFirstFrame();assert.equal(pending,true,'低模首帧不提前放行');
send({t:'vehicle',lf:.2,rf:.5,lr:1,rr:0,trunk:1});assert.equal(calls.length,0,'加载期间只存状态');
send({t:'paint',hex:'#FF0000'});send({t:'paint',hex:'#00FF00'});
assert.deepEqual(color.values,[.4,.5,.6,.8],'加载期间不能修改低模或污染原车漆快照');
win.onFullCarLoaded();await settle();
assert.deepEqual(color.values,[0,1,0,1],'整车就绪应用最后一次预选色');
send({t:'paint',hex:''});assert.deepEqual(color.values,[.4,.5,.6,.8]);assert.deepEqual(blend.values,[.11,.22,.33,.7],'实车色恢复完整原始材质参数');
const paintView=[theta,phi,distance,calls.filter(c=>c[0]==='reset').length];
for(const hex of ['#123456','#353535','#FFFFFF',''])send({t:'paint',hex});
assert.deepEqual([theta,phi,distance,calls.filter(c=>c[0]==='reset').length],paintView,'连续换色不重取景或改变旋转角度');
assert.deepEqual(color.values,[.4,.5,.6,.8],'重复切换后仍恢复原车漆');
assert.equal(car.carPaint_CarPaintMaterial.uniforms.untouched.value,'roof/glass/wrap','换色只更新车漆颜色参数');
send({t:'paint',hex:'#bad'});assert.deepEqual(color.values,[.4,.5,.6,.8],'忽略无效车漆消息');
assert.equal(pending,false);assert.equal(calls.filter(c=>c[0]==='reset').length,1,'整车取景只 reset 一次');
assert.deepEqual(calls.find(c=>c[0]==='lr'),['lr',1,true,false],'后窗直接调用方法且不触发自动转向');
assert.deepEqual(calls.find(c=>c[0]==='trunk'),['trunk',true,true,false]);
assert.equal(controls.enabled,true,'恢复用户旋转能力');
const n=calls.length;send({t:'vehicle',lf:.2,rf:.5,lr:1,rr:0,trunk:1});assert.equal(calls.length,n,'同一状态不重放');
send({t:'vehicle',lf:.6});assert.deepEqual(calls.at(-1),['lf',.6,false,false]);
send({t:'view',radius:21,drop:-7});assert.equal(calls.at(-1)[0],'radius');
assert.equal(calls.filter(c=>c[0]==='reset').length,1,'改尺寸不重置旋转角度');
send({t:'background',name:'night'});send({t:'background',name:'dusk'});await settle();
assert.equal(sky.material.d2n,0,'异步星空不覆盖新选的背景');
const count=messages.length;handlers.message({source:{},origin:'http://localhost',data:{t:'view',radius:99}});assert.equal(messages.length,count,'拒绝无关窗口消息');
handlers.message({source:parent,origin:'https://other.example',data:{t:'view',radius:99}});assert.equal(messages.length,count,'拒绝其它来源');
assert.equal(messages.some(m=>m.t==='ready'),true);
send({t:'vehicle',speed:56,tires:1});
assert.equal(motionCalls.at(-1),3.36);assert.equal(controls.enabled,false,'胎压俯视锁定相机');
assert.equal(theta,.3,'俯视切换从原角度开始，不能首帧跳到终点');await settle();await settle();assert.equal(theta,Math.PI/2);
doc.hidden=true;docHandlers.visibilitychange();assert.equal(motionCalls.at(-1),0,'隐藏页面停止行车动画');
doc.hidden=false;docHandlers.visibilitychange();assert.equal(motionCalls.at(-1),3.36,'显示页面恢复轻缓运动');
send({t:'vehicle',speed:0,tires:0});
await settle();await settle();
assert.equal(motionCalls.at(-1),0);assert.equal(controls.enabled,true,'收起胎压恢复旋转');
assert.ok(Math.abs(theta-.3)<1e-9,'退出胎压恢复原角度');
send({t:'vehicle',speed:0,tires:1});send({t:'vehicle',speed:0,tires:0});send({t:'vehicle',speed:0,tires:1});send({t:'vehicle',speed:0,tires:0});await settle();await settle();assert.equal(controls.enabled,true,'连续切换也恢复旋转');assert.ok(Math.abs(theta-.3)<1e-9);
send({t:'wrap',value:JSON.stringify({image:'https://other.invalid/image.png',side:'left',x:50,y:50,scale:60,rotation:0,opacity:100})});await settle();assert.equal(messages.filter(m=>m.t==='ack'&&m.of==='wrap').at(-1).ok,false,'拒绝外部图片 URL');
console.log('3D wrapper: loading, live paint/reset, camera, four windows, trunk, deduplication, theme race, message origin passed');
