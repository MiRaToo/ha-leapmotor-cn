// 验证包装页的加载门控、相机稳定、状态去重与消息来源；不联网、不执行车控。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const calls=[], messages=[], handlers={}, timers=[];
const tex=()=>({image:{original:true},dispose(){}});
const sky={parent:{},material:{uniforms:{nightTexture:{value:tex()},dayTexture:{value:tex()},colorStrength:{value:1}},setDayOrNightImmediately(v){this.d2n=v}}};
class Vector {
  constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z}
  clone(){return new Vector(this.x,this.y,this.z)}
  copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this}
  lerp(v,t){this.x+=(v.x-this.x)*t;this.y+=(v.y-this.y)*t;this.z+=(v.z-this.z)*t;return this}
  sub(v){this.x-=v.x;this.y-=v.y;this.z-=v.z;return this}
  normalize(){const n=Math.hypot(this.x,this.y,this.z)||1;this.x/=n;this.y/=n;this.z/=n;return this}
  addScaledVector(v,s){this.x+=v.x*s;this.y+=v.y*s;this.z+=v.z*s;return this}
  project(camera){
    const p=this.clone().sub(camera.position),m=camera.matrixWorld.elements;
    const depth=-(p.x*m[8]+p.y*m[9]+p.z*m[10]),scale=1/Math.tan(camera.fov*Math.PI/360);
    this.x=(p.x*m[0]+p.y*m[1]+p.z*m[2])*scale/(depth*camera.aspect);
    this.y=(p.x*m[4]+p.y*m[5]+p.z*m[6])*scale/depth;this.z=0;return this;
  }
}
let theta=.3,phi=1.1,distance=17,now=10,residualTheta=0,residualPhi=0;
const controls={enabled:true,enableDamping:true,dampingFactor:.05,autoRotate:false,minPolarAngle:.2,maxDistance:40,
  minAzimuthAngle:-Infinity,maxAzimuthAngle:Infinity,target0:{y:0},target:new Vector(),
  getAzimuthalAngle:()=>theta,getPolarAngle:()=>phi,getDistance:()=>distance,
  setThetaImmediately(v){theta=v},setPhiImmediately(v){phi=v},stopViewControl(){},
  // SDK 即使禁用交互也会在手动角度提交时累加 sphericalDelta；无阻尼更新才会清空它。
  update(){const k=this.enableDamping?this.dampingFactor:1;theta+=residualTheta*k;phi+=residualPhi*k;
    residualTheta*=this.enableDamping?1-k:0;residualPhi*=this.enableDamping?1-k:0;},
  setRadiusImmediately(r){distance=r;calls.push(['radius',r])}};
const camera={fov:45,aspect:4/3,position:new Vector(),matrixWorld:{elements:[]},updateMatrixWorld(){
  const s=Math.sin(theta),c=Math.cos(theta),sp=Math.sin(phi),cp=Math.cos(phi);
  this.matrixWorld.elements=[c,0,-s,0,-cp*s,sp,-cp*c,0,sp*s,cp,sp*c,0,0,0,0,1];
  this.position.copy(controls.target).addScaledVector(new Vector(sp*s,cp,sp*c),distance);
  this.aspect=env.innerWidth/(env.innerHeight+viewer.viewportSetter.__cur_offset__);
}};
const motionCalls=[];
class PaintVector{constructor(...values){this.values=values}set(...values){this.values=values;return this}clone(){return new PaintVector(...this.values)}copy(v){return this.set(...v.values)}}
const color=new PaintVector(.4,.5,.6,.8),blend=new PaintVector(.11,.22,.33,.7);
const car={handleVehicleMove(s){motionCalls.push(s)},update(){},carPaint_CarPaintMaterial:{uniforms:{color:{value:color},blendColor:{value:blend},untouched:{value:'roof/glass/wrap'}}}};
for(const [key,pos] of Object.entries({LF:new Vector(-2,0,1),RF:new Vector(-2,0,-1),LR:new Vector(2,0,1),RR:new Vector(2,0,-1)}))car['wheel'+key+'2']={position:pos,getWorldPosition(target){return target.copy(pos)}};
for(const [key,method] of [['lf','handleDoorLFWindow'],['rf','handleDoorRFWindow'],['lr','handleDoorLRWindow'],['rr','handleDoorRRWindow'],['trunk','handleTrunk']]){
  car[method]=(value,immediate)=>calls.push([key,value,immediate,controls.enabled]);
}
const viewer={controls,renderer:{render(){}},camera,viewportSetter:{__cur_offset__:0},scene:{traverse(cb){cb(sky)}},frameState:{},setRadius(r){calls.push(['reset',r])},setOffsetVertical(value){this.viewportSetter.__cur_offset__=value},setFPS(){}};
let pending=true;
const gradient={addColorStop(){}};
const context={createLinearGradient(){return gradient},fillRect(){},beginPath(){},moveTo(){},lineTo(){},bezierCurveTo(){},fill(){},stroke(){}};
const bootStyle={setProperty(k,v){this[k]=v}};
const docHandlers={};
const preloads=[];
const doc={head:{appendChild(el){preloads.push(el)}},documentElement:{style:bootStyle,classList:{remove(){pending=false}}},addEventListener(k,fn){docHandlers[k]=fn},createElement(){return {getContext(){return context}}}};
const parent={postMessage(m){messages.push(m)}};
const win={viewer,car,addEventListener(type,fn){handlers[type]=fn},newInit:async()=>{}};
const media={matches:false,addEventListener(_,fn){this.change=fn}};
const env={window:win,document:doc,parent,matchMedia:()=>media,location:{origin:'http://localhost',search:'?car=C16&year=2025&roof=7&sdk=3.20.0&radius=17&bg=night'},
  innerWidth:400,innerHeight:300,URLSearchParams,performance:{now:()=>now},requestAnimationFrame:cb=>setImmediate(()=>{now+=34;cb(now)}),cancelAnimationFrame:clearImmediate,
  setTimeout:cb=>{timers.push(cb);return timers.length},clearTimeout(){},Image:class{set src(_){setImmediate(()=>this.onload?.())}},console};
env.location.search+='&preload='+encodeURIComponent(JSON.stringify(['C16_2025/C16_2025_full_car.fbx','https://other.example/car.fbx']));
const src=readFileSync(new URL('../custom_components/leapmotor/www/car3d/view.js',import.meta.url),'utf8').replace('await import(`./index.js?v=${WRAPPER_VERSION}`);','');
await vm.runInNewContext(`(async()=>{${src}\n})()`,env);
assert.deepEqual(preloads.map(el=>[el.href,el.as,el.crossOrigin]),[['./C16_2025/C16_2025_full_car.fbx','fetch','anonymous']],'仅预加载本地模型路径，忽略外部地址');
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
const near=(a,b,message)=>assert.ok(Math.abs(a-b)<1e-8,`${message}: ${a} vs ${b}`);
const angleNear=(a,b,message)=>near(Math.atan2(Math.sin(a-b),Math.cos(a-b)),0,message);
const tirePose={t:'vehicle',speed:0,tires:1,tireTop:80,tireBottom:265,tireWidth:64,tireHeight:34};
const latestPads=()=>JSON.parse(messages.filter(m=>m.t==='tires'&&m.points).at(-1).points);
for(const angle of [-3,-1,0,3,7]){
  theta=angle;phi=1.1;residualTheta=.8;residualPhi=.2;
  const target=controls.target.clone();const beforeMessages=messages.length;
  send(tirePose);near(theta,angle,'清除惯性不能改变可见起始角度');near(residualTheta,0,'清除横向惯性');near(residualPhi,0,'清除纵向惯性');
  assert.equal(controls.enableDamping,false);await settle();
  const during=[theta,phi,distance];send({...tirePose,speed:10});
  assert.deepEqual([theta,phi,distance],during,'普通车况更新不能重算或打断过渡');
  await settle();angleNear(theta,Math.PI/2,'任意角度及惯性下车头正向');near(phi,.001,'准确到达俯视角');
  const frames=messages.slice(beforeMessages).filter(m=>m.t==='tires'&&m.points);
  assert.equal(frames[0].opacity,0,'有效起点先隐藏');assert.equal(frames.at(-1).opacity,1);
  assert.ok(frames.some(m=>m.opacity>0&&m.opacity<1),'胶囊有中间淡入帧');
  const first=JSON.parse(frames[0].points),last=JSON.parse(frames.at(-1).points);
  for(const frame of frames){const pts=JSON.parse(frame.points);for(let i=0;i<4;i++){
    near(pts[i].x,first[i].x+(last[i].x-first[i].x)*frame.opacity,'横向与相机共享连续缓动');
    near(pts[i].y,first[i].y+(last[i].y-first[i].y)*frame.opacity,'纵向与相机共享连续缓动');
  }}
  const pads=latestPads();assert.ok(pads[0].x<pads[1].x&&pads[2].x<pads[3].x&&pads[0].y<pads[2].y,'四轮身份固定');
  for(const p of pads){assert.ok(p.x*env.innerWidth/100>=40&&p.x*env.innerWidth/100<=env.innerWidth-40);assert.ok(p.y*env.innerHeight/100>=97&&p.y*env.innerHeight/100<=248,'完整胶囊处于安全区域');}
  send({t:'vehicle',tires:0});await settle();await settle();angleNear(theta,angle,'退出恢复原角度');near(phi,1.1,'退出恢复倾角');
  assert.deepEqual(controls.target,target);assert.equal(controls.enabled,true);assert.equal(controls.enableDamping,true);assert.equal(controls.maxDistance,40);assert.equal(controls.minPolarAngle,.2);
}
send(tirePose);await settle();const beforeResize=[theta,phi,distance];
send({t:'view',radius:30});assert.deepEqual([theta,phi,distance],beforeResize,'尺寸更新从当前帧继续，不能直接跳到新半径');
await settle();await settle();const fitted=[theta,phi,distance];send({...tirePose,speed:20});assert.deepEqual([theta,phi,distance],fitted,'结束后不需要额外消息纠正旧终点');
const beforeBounds=[theta,phi,distance];send({...tirePose,tireTop:150,tireBottom:270});assert.deepEqual([theta,phi,distance],beforeBounds,'避让区域变化也从当前帧连续调整');await settle();await settle();
for(const p of latestPads())assert.ok(p.y*env.innerHeight/100>=167&&p.y*env.innerHeight/100<=253);
send({...tirePose,tireTop:260,tireBottom:270});const unavailable=messages.length;await settle();await settle();assert.equal(messages.slice(unavailable).some(m=>m.t==='tires'&&m.points),false,'空间不足后旧动画不能重新显示越界读数');
send(tirePose);await settle();await settle();assert.equal(messages.filter(m=>m.t==='tires').at(-1).opacity,1,'布局恢复后可重新显示');
env.innerWidth=280;env.innerHeight=400;handlers.resize();await settle();await settle();
for(const p of latestPads())assert.ok(p.x*280/100>=40&&p.x*280/100<=240,'窄屏保留完整标签');
send({t:'vehicle',tires:0});await settle();await settle();near(distance,30,'关闭后使用新尺寸的普通取景');
media.matches=true;send(tirePose);angleNear(theta,Math.PI/2,'减少动态时直接定位');assert.equal(messages.filter(m=>m.t==='tires').at(-1).opacity,1);send({t:'vehicle',tires:0});assert.equal(controls.enabled,true);media.matches=false;
const wheel=car.wheelLF2;delete car.wheelLF2;send(tirePose);assert.equal(controls.enabled,true,'缺少轮位不锁死相机');assert.equal(messages.filter(m=>m.t==='tires').at(-1).available,false);car.wheelLF2=wheel;
// C10 实际素材的 LF/RF 世界坐标左右镜像；最终标签仍应位于整列轮胎外侧。
for(const key of ['LF','RF','LR','RR'])car['wheel'+key+'2'].position.z*=-1;
send(tirePose);await settle();await settle();camera.updateMatrixWorld();
const wheelXs=['LF','RF','LR','RR'].map(key=>(car['wheel'+key+'2'].position.clone().project(camera).x+1)*env.innerWidth/2);
for(const [i,p] of latestPads().entries())assert.ok(i%2?p.x*env.innerWidth/100-32>Math.max(...wheelXs):p.x*env.innerWidth/100+32<Math.min(...wheelXs),'镜像节点不让胶囊压住车身');
send({t:'vehicle',tires:0});await settle();await settle();
send({t:'wrap',value:JSON.stringify({image:'https://other.invalid/image.png',side:'left',x:50,y:50,scale:60,rotation:0,opacity:100})});await settle();assert.equal(messages.filter(m=>m.t==='ack'&&m.of==='wrap').at(-1).ok,false,'拒绝外部图片 URL');
console.log('3D wrapper: loading, paint, windows, trunk, origin; tire inertia, perspective projection, mirrored wheels, shared easing, resize/bounds retarget, rapid toggles and reduced motion passed');
