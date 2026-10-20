// 包装页只调用查看器能力，模型与查看器文件保持原样。版本与 car3d.py 同步。
const WRAPPER_VERSION = 14;
const q = new URLSearchParams(location.search);
// 后端仅提示本车已落盘的文件；与查看器的 fetch 使用相同的 CORS/凭据模式。
try{
  const paths=JSON.parse(q.get("preload")||"[]");
  if(Array.isArray(paths))for(const path of [...new Set(paths)].slice(0,2)){
    if(typeof path!=="string"||!/^([A-Za-z0-9]+_[0-9]{4})\/\1_(starter|full)_car\.fbx$/.test(path))continue;
    const link=document.createElement("link");link.rel="preload";link.as="fetch";link.crossOrigin="anonymous";link.href="./"+path;document.head.appendChild(link);
  }
}catch{ /* 预加载提示无效不影响查看器的正常加载。 */ }
const cfg = {
  carType:q.get("car")||"C10", year:Number(q.get("year")||2026),
  carTypeCode:q.get("trim")||"", colorCode:Number(q.get("color")||0),
  rudder:0, offset:Number(q.get("offset")||.37), radius:Number(q.get("radius")||15),
  seat:Number(q.get("seat")||5), roofColorCode:Number(q.get("roof")||0),
  sdkVersion:q.get("sdk")||"3.15.1", licenseNumber:"", theme:q.get("theme")||"default",
};
if(q.has("alias")) cfg.alias=q.get("alias");
let radius=cfg.radius, offset=cfg.offset, drop=Number(q.get("drop")||0);
let background=q.get("bg")||"day", paint="", pose={}, full=false, first=false, released=false;
const bootColors={day:"#f3f6fb",night:"#101a2b",studio:"#e9edf2",dusk:"#e5c8bd",aurora:"#142b35",blueprint:"#15324c"};
document.documentElement.style.setProperty("--boot-bg",bootColors[background]||bootColors.day);
document.documentElement.style.colorScheme=["night","aurora","blueprint"].includes(background)?"dark":"light";
let viewApplied=false, skyCache=null, poseCar=null, appliedPose={}, revealing=false;
const started=performance.now();
const loadTimes={};
const post=m=>{if(parent!==window)parent.postMessage(m,location.origin)};
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
function sceneOf(){
  let s=window.viewer?.scene||window.viewer?.viewer?.scene;
  if(!s){s=window.car;while(s&&!s.isScene)s=s.parent}
  return s;
}
function skyNode(){
  if(skyCache?.parent)return skyCache;
  sceneOf()?.traverse(o=>{if(o.material?.uniforms?.nightTexture)skyCache=o});
  return skyCache;
}
function redraw(){
  const v=window.viewer, s=sceneOf();
  if(!v?.renderer||!v.camera||!s)return false;
  v.renderer.render(s,v.camera);return true;
}
// setRadius 会 reset 相机方向；只在整车定景时用，后续尺寸变化保留用户旋转角度。
function applyView(reset=false){
  const v=window.viewer, c=v?.controls;
  if(!v||!c)return false;
  if(c.target0){
    if(c.__leapBaseY===undefined)c.__leapBaseY=c.target0.y;
    const y=c.__leapBaseY+drop/100*.335*radius;
    c.target0.y=y;if(!reset&&c.target)c.target.y=y;
  }
  if(reset||!viewApplied)v.setRadius(radius);
  else if(c.setRadiusImmediately)c.setRadiusImmediately(radius);
  else v.setRadius(radius);
  v.setOffsetVertical?.(offset*100);commitCamera(c);viewApplied=true;redraw();return true;
}
const images=new Map(), originals=new WeakMap();
function panorama(name){
  if(images.has(name))return images.get(name);
  const c=document.createElement("canvas");c.width=1024;c.height=512;
  const x=c.getContext("2d"), g=x.createLinearGradient(0,0,0,512);
  const palettes={studio:["#e7ebf2","#f7f8fa","#bfc9d8"],dusk:["#333b68","#efb49f","#b89a8e"],
    aurora:["#091b32","#237e86","#122e49"],blueprint:["#071831","#174066","#0c284a"]};
  const p=palettes[name]||palettes.studio;
  g.addColorStop(0,p[0]);g.addColorStop(.55,p[1]);g.addColorStop(1,p[2]);
  x.fillStyle=g;x.fillRect(0,0,1024,512);
  if(name==="aurora"){
    const a=x.createLinearGradient(0,0,1024,240);a.addColorStop(0,"#46dca000");a.addColorStop(.4,"#58e2b155");a.addColorStop(.7,"#8b70dd44");a.addColorStop(1,"#46dca000");
    x.fillStyle=a;x.beginPath();x.moveTo(0,95);x.bezierCurveTo(300,0,600,300,1024,45);x.lineTo(1024,160);x.bezierCurveTo(600,390,300,90,0,210);x.fill();
  }
  if(name==="blueprint"){
    x.strokeStyle="#8bc8ed25";x.lineWidth=1;
    for(let i=0;i<1024;i+=32){x.beginPath();x.moveTo(i,0);x.lineTo(i,512);x.stroke()}
    for(let j=0;j<512;j+=32){x.beginPath();x.moveTo(0,j);x.lineTo(1024,j);x.stroke()}
  }
  images.set(name,c);return c;
}
let starry;
function nightImage(){
  if(!starry)starry=new Promise(resolve=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>resolve(null);im.src="./textures/skybox_night_starry.jpg"});
  return starry;
}
function swap(tex,img){
  if(!tex||!img||tex.image===img)return;
  if(!originals.has(tex))originals.set(tex,tex.image);
  tex.dispose();tex.image=img;tex.needsUpdate=true;
}
async function setBackground(name){
  const node=skyNode();if(!node)return false;
  node.visible=true;
  if(window.viewer?.frameState?.bg2D)window.viewer.frameState.bg2D.visible=false;
  const u=node.material.uniforms;
  const image=name==="night"?await nightImage():name==="day"?null:panorama(name);
  if(background!==name)return false;
  for(const key of ["dayTexture","nightTexture"]){
    const tex=u[key]?.value;
    if(image)swap(tex,image);else if(tex&&originals.has(tex))swap(tex,originals.get(tex));
  }
  const night=["night","aurora","blueprint"].includes(name)?1:0,m=node.material;
  m.setDayOrNightImmediately?.(night);if(u.dayOrNight)u.dayOrNight.value=night;
  m.d2n=night;m.d2nAnim=false;m.d2nPoc=1;if(u.colorStrength)u.colorStrength.value=night?.92:1;
  if(window.viewer?.frameState)window.viewer.frameState.updateEnvironment=true;
  redraw();return true;
}
const originalPaint=new WeakMap();
function setPaint(hex){
  if(hex!==""&&!/^#[0-9a-f]{6}$/i.test(hex))return false;
  // 加载期间仅保留最后一次选择，避免把低模或预览色当作原车漆快照。
  if(!full)return false;
  const u=window.car?.carPaint_CarPaintMaterial?.uniforms;
  if(!u?.color?.value?.set||!u?.blendColor?.value?.set)return false;
  if(!originalPaint.has(u)){
    if(!u.color.value.clone||!u.blendColor.value.clone)return false;
    originalPaint.set(u,{color:u.color.value.clone(),blendColor:u.blendColor.value.clone()});
  }
  if(hex===""){
    const original=originalPaint.get(u);
    u.color.value.copy(original.color);u.blendColor.value.copy(original.blendColor);redraw();return true;
  }
  const n=parseInt(hex.slice(1),16),r=(n>>16&255)/255,g=(n>>8&255)/255,b=(n&255)/255;
  u.color?.value?.set(r,g,b,1);u.blendColor?.value?.set(r*.45,g*.45,b*.45,1);redraw();return true;
}
// 只改车漆着色器，不修改共享模型文件或玻璃、饰条材质。
const wrapSides=["left","right","top","front","rear"];
let wrapSerial=0,wrapConfig=null,wrapTexture=null,wrapAtlasRects=new Map();const wrapImages=new Map(),wrapSources=new Map(),wrapPendingSources=new Map();
const wrapMaterials=new Set();let wrapBounds=null,wrapCar=null;
function carBounds(){
  const car=window.car;if(wrapCar===car&&wrapBounds)return wrapBounds;let bounds=null;
  car?.updateMatrixWorld?.(true);
  car?.traverse?.(node=>{
    const materials=Array.isArray(node.material)?node.material:[node.material];
    if(!node.geometry||!materials.some(m=>m?.uniforms?.blendColor&&m?.fragmentShader?.includes('fresnelCol')))return;
    if(!node.geometry.boundingBox)node.geometry.computeBoundingBox?.();const box=node.geometry.boundingBox?.clone();if(!box)return;
    box.applyMatrix4(node.matrixWorld);if(bounds)bounds.union(box);else bounds=box;
  });wrapCar=car;wrapBounds=bounds;return bounds;
}
function wheelPoints(){
  const car=window.car;return ['LF','RF','LR','RR'].map(key=>{const node=car?.['wheel'+key+'2']||car?.['wheel'+key]||car?.getObjectByName?.('Wheel_'+key+'_Main');return node?.getWorldPosition?.(node.position.clone())||null});
}
function wrapFrame(side,box){
  const points=wheelPoints(),up=box.min.clone().set(0,1,0);
  if(!points[0]||!points[1]||!points[2])return null;
  const front=points[0].clone().sub(points[2]).normalize(),left=points[0].clone().sub(points[1]).normalize();
  return side==='top'?{u:left.clone().negate(),v:front,n:up}:side==='front'?{u:left.clone(),v:up,n:front}:side==='rear'?{u:left.clone().negate(),v:up,n:front.clone().negate()}:side==='right'?{u:front.clone().negate(),v:up,n:left.clone().negate()}:{u:front,v:up,n:left};
}
function wrapUniforms(side){return `haWrap${side[0].toUpperCase()+side.slice(1)}`}
function updateWrap(){
  if(!wrapConfig)return false;const box=carBounds();if(!box)return false;
  const centerBase=box.min.clone().add(box.max).multiplyScalar(.5),corners=[];
  for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z])corners.push(centerBase.clone().set(x,y,z));
  const extent=axis=>{const values=corners.map(p=>p.dot(axis));return Math.max(...values)-Math.min(...values)};
  const values={};
  for(const side of wrapSides){const config=wrapConfig.faces[side],image=wrapImages.get(side),frame=config&&wrapFrame(side,box);if(!config||!image||!frame)continue;
    const center=centerBase.clone(),span=extent(frame.u),height=extent(frame.v),width=span*config.scale/100;
    center.addScaledVector(frame.u,(config.x/100-.5)*span).addScaledVector(frame.v,(config.y/100-.5)*height);
    values[side]={center,frame,size:[Math.max(.01,width),Math.max(.01,width*image.height/image.width)],rotation:[Math.cos(config.rotation*Math.PI/180),Math.sin(config.rotation*Math.PI/180)],opacity:config.opacity/100};
  }
  window.car.traverse(node=>{for(const m of Array.isArray(node.material)?node.material:[node.material]){
    if(!m?.uniforms?.blendColor||!m.fragmentShader?.includes('fresnelCol'))continue;
    if(!m.uniforms.haWrapLeftOpacity){const needle='vec3 diffuse = fresnelCol * NdotL;';if(!m.fragmentShader.includes(needle))continue;
      const declarations=`uniform highp sampler2D haWrapTexture;`+wrapSides.map(side=>{const p=wrapUniforms(side);return `uniform highp vec3 ${p}Center;uniform highp vec3 ${p}U;uniform highp vec3 ${p}V;uniform highp vec3 ${p}N;uniform highp vec2 ${p}Size;uniform highp vec2 ${p}Rotation;uniform highp vec4 ${p}Rect;uniform highp float ${p}Opacity;`}).join('');
      const projections=wrapSides.map(side=>{const p=wrapUniforms(side);return `if(${p}Opacity>0.0){vec3 ${p}wp=posWS.xyz-${p}Center;vec2 ${p}uv=vec2(dot(${p}wp,${p}U),dot(${p}wp,${p}V));${p}uv=mat2(${p}Rotation.x,-${p}Rotation.y,${p}Rotation.y,${p}Rotation.x)*${p}uv/${p}Size+0.5;float ${p}mask=step(0.0,${p}uv.x)*step(${p}uv.x,1.0)*step(0.0,${p}uv.y)*step(${p}uv.y,1.0)*smoothstep(0.15,0.55,dot(normalize(nDirWS),${p}N));vec4 ${p}decal=texture2D(haWrapTexture,clamp(${p}Rect.xy+${p}uv*${p}Rect.zw,0.0,1.0));fresnelCol=mix(fresnelCol,${p}decal.rgb,${p}mask*${p}decal.a*${p}Opacity);}`}).join('');
      m.fragmentShader=`${declarations}\n`+m.fragmentShader.replace(needle,`${projections}\n${needle}`);m.needsUpdate=true;wrapMaterials.add(m);
    }
    for(const side of wrapSides){const p=wrapUniforms(side),v=values[side];Object.assign(m.uniforms,{haWrapTexture:{value:wrapTexture},[p+'Center']:{value:v?.center||centerBase},[p+'U']:{value:v?.frame.u||centerBase},[p+'V']:{value:v?.frame.v||centerBase},[p+'N']:{value:v?.frame.n||centerBase},[p+'Size']:{value:v?.size||[1,1]},[p+'Rotation']:{value:v?.rotation||[1,0]},[p+'Rect']:{value:wrapAtlasRects.get(side)||[0,0,0,0]},[p+'Opacity']:{value:v?.opacity||0}});}
  }});redraw();return wrapMaterials.size>0;
}
async function setWrap(value){
  if(!value){++wrapSerial;wrapConfig={version:2,faces:{}};for(const m of wrapMaterials){m.uniforms.haWrapTexture.value=null;for(const side of wrapSides)m.uniforms[wrapUniforms(side)+'Opacity'].value=0;}wrapTexture?.dispose();wrapTexture=null;wrapImages.clear();wrapSources.clear();wrapPendingSources.clear();wrapAtlasRects.clear();redraw();return true;}
  let faces=value.version===2&&value.faces&&typeof value.faces==='object'?value.faces:(value.image?{[wrapSides.includes(value.side)?value.side:'left']:value}:null);if(!faces)return false;
  const normalized={};let total=0;
  for(const side of wrapSides){const face=faces[side];if(!face)continue;if(!['left','right','top','front','rear'].includes(face.side||side))return false;
    for(const [key,min,max] of [['x',0,100],['y',0,100],['scale',5,200],['rotation',-180,180],['opacity',0,100]])if(!Number.isFinite(face[key])||face[key]<min||face[key]>max)return false;
    const image=face.image||wrapPendingSources.get(side)||wrapSources.get(side);if(!image||typeof image!=='string'||image.length>1400000||!/^data:image\/(png|jpeg|webp);base64,/.test(image))return false;total+=image.length;
    normalized[side]={image,side,x:face.x,y:face.y,scale:face.scale,rotation:face.rotation,opacity:face.opacity};
  }
  if(total>2400000)return false;
  const gl=window.viewer?.renderer?.getContext?.();if(gl?.MAX_TEXTURE_IMAGE_UNITS){const limit=gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);if(limit<8||(gl.MAX_TEXTURE_SIZE&&gl.getParameter(gl.MAX_TEXTURE_SIZE)<2048))return false;const material=window.car?.carPaint_CarPaintMaterial,samplers=material?.fragmentShader?.match(/uniform\s+(?:lowp|mediump|highp)?\s*sampler\w*\s+(\w+)/g)||[],base=samplers.filter(decl=>!/\bhaWrapTexture\b/.test(decl));if(base.length+(samplers.length===base.length?1:0)>limit)return false;}
  const needsAtlas=wrapSides.some(side=>normalized[side]?normalized[side].image!==wrapSources.get(side):wrapImages.has(side));
  const original=window.car?.carPaint_CarPaintMaterial?.uniforms?.mainTexture?.value;if(full&&needsAtlas&&!original?.clone)return false;
  const serial=++wrapSerial;for(const side of wrapSides){if(normalized[side])wrapPendingSources.set(side,normalized[side].image);else wrapPendingSources.delete(side);}
  const next={version:2,faces:normalized};
  if(!full){wrapConfig=next;return true;}
  const decoded=await Promise.all(wrapSides.filter(side=>normalized[side]&&normalized[side].image!==wrapSources.get(side)).map(async side=>{const image=await new Promise(resolve=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>resolve(null);im.src=normalized[side].image});return [side,image]}));
  if(serial!==wrapSerial)return true;if(decoded.some(([,image])=>!image||image.width>1024||image.height>1024))return false;
  const nextImages=new Map(wrapImages);for(const side of wrapSides){if(!normalized[side])nextImages.delete(side);}
  for(const [side,image] of decoded)nextImages.set(side,image);
  const rebuild=decoded.length>0||wrapSides.some(side=>!normalized[side]&&wrapImages.has(side));let nextTexture=wrapTexture,nextRects=new Map(wrapAtlasRects);
  if(rebuild&&nextImages.size){const canvas=document.createElement('canvas');canvas.width=2048;canvas.height=2048;const ctx=canvas.getContext('2d');if(!ctx)return false;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.imageSmoothingQuality='high';nextRects=new Map();
    wrapSides.forEach((side,index)=>{const image=nextImages.get(side);if(!image)return;const col=index%4,row=Math.floor(index/4),cellX=col*512,cellY=row*1024,scale=Math.min(508/image.width,1020/image.height),w=image.width*scale,h=image.height*scale,x=cellX+(512-w)/2,y=cellY+(1024-h)/2;ctx.drawImage(image,x,y,w,h);nextRects.set(side,[(x+.5)/2048,(2048-y-h+.5)/2048,Math.max(0,w-1)/2048,Math.max(0,h-1)/2048]);});
    try{nextTexture=original.clone();if(original.source?.constructor)nextTexture.source=new original.source.constructor(canvas);else nextTexture.image=canvas;nextTexture.flipY=true;nextTexture.generateMipmaps=false;nextTexture.minFilter=original.magFilter??original.minFilter;nextTexture.needsUpdate=true;}catch{nextTexture?.dispose?.();return false;}
  }
  if(serial!==wrapSerial){if(nextTexture!==wrapTexture)nextTexture?.dispose();return true;}
  if(rebuild){wrapTexture?.dispose();wrapTexture=nextImages.size?nextTexture:null;if(!nextImages.size)wrapTexture?.dispose();wrapAtlasRects=nextRects;wrapImages.clear();for(const entry of nextImages)wrapImages.set(...entry);wrapSources.clear();for(const side of wrapSides)if(normalized[side]){wrapSources.set(side,normalized[side].image);if(wrapPendingSources.get(side)===normalized[side].image)wrapPendingSources.delete(side);}else wrapPendingSources.delete(side);}
  wrapConfig=next;return updateWrap();
}
let tireView=false,savedView=null,motionSpeed=-1,inView=true,tireFrame=0,tireTransition=false;
let tireLayoutKey='',tireLabels=null,tireOpacity=0,tireResizeFrame=0;
const tireKeys=['tire_fl','tire_fr','tire_rl','tire_rr'];
const reduced=typeof matchMedia==='function'?matchMedia('(prefers-reduced-motion: reduce)'):null;
// SDK 的 update 在没有角度标记时会从旧位置重算半径；锁定 controls 后也需标记才能更新。
function commitCamera(c){const theta=c.getAzimuthalAngle?.();if(Number.isFinite(theta))c.setThetaImmediately?.(theta);c.update?.();}
const bound=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
function tireBounds(){
  const width=Number.isFinite(pose.tireWidth)?pose.tireWidth:64,height=Number.isFinite(pose.tireHeight)?pose.tireHeight:34;
  const top=bound(Number.isFinite(pose.tireTop)?pose.tireTop:120,0,innerHeight);
  const bottom=bound(Number.isFinite(pose.tireBottom)?pose.tireBottom:innerHeight-85,0,innerHeight);
  return {width,height,top,bottom,left:width/2+8,right:innerWidth-width/2-8,
    first:top+height/2,last:bottom-height/2,gap:width/2+12,
    valid:innerWidth>=width*2+24&&bottom-top>=height*2+8};
}
function projectWheels(points){
  const v=window.viewer;if(!v?.camera||points.some(p=>!p))return null;
  v.camera.updateMatrixWorld?.();
  const h=innerHeight+(v.viewportSetter?.__cur_offset__||0);
  const out=points.map(p=>{const n=p.clone().project(v.camera);return {x:(n.x+1)*innerWidth/2,y:(1-n.y)*h/2}});
  return out.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))?out:null;
}
function fitTireCamera(points,b){
  const v=window.viewer,c=v.controls;
  // 用两根轮轴的中心求车头方向，避免单个轮位误差；世界 Y 为查看器的竖直轴。
  const front=points[0].clone().addScaledVector(points[1],1).addScaledVector(points[2],-1).addScaledVector(points[3],-1);
  if(!Number.isFinite(front.x)||!Number.isFinite(front.z)||Math.hypot(front.x,front.z)<.001)return null;
  const center=points[0].clone();center.x=center.y=center.z=0;
  points.forEach(p=>center.addScaledVector(p,.25));
  cameraAt(c,{theta:Math.atan2(-front.x,-front.z),phi:.001,radius,target:center});
  let projected=projectWheels(points);if(!projected)return null;
  const span=key=>Math.max(...projected.map(p=>p[key]))-Math.min(...projected.map(p=>p[key]));
  const distance=radius*Math.max(1,span('x')/Math.max(1,b.right-b.left-2*b.gap),span('y')/Math.max(1,b.last-b.first-8))*1.08;
  c.setRadiusImmediately?.(distance);commitCamera(c);
  projected=projectWheels(points);if(!projected)return null;
  const dx=innerWidth/2-(Math.min(...projected.map(p=>p.x))+Math.max(...projected.map(p=>p.x)))/2;
  const dy=(b.top+b.bottom-Math.min(...projected.map(p=>p.y))-Math.max(...projected.map(p=>p.y)))/2;
  const scale=2*Math.tan(v.camera.fov*Math.PI/360)*distance/(innerHeight+(v.viewportSetter?.__cur_offset__||0));
  if(!Number.isFinite(scale))return null;
  const matrix=v.camera.matrixWorld?.elements;if(!matrix||matrix.length<11)return null;
  const right=center.clone(),up=center.clone();
  [right.x,right.y,right.z]=matrix.slice(0,3);[up.x,up.y,up.z]=matrix.slice(4,7);
  c.target.addScaledVector(right,-dx*scale).addScaledVector(up,dy*scale);commitCamera(c);
  projected=projectWheels(points);if(!projected)return null;
  // 四轮身份决定左右列；不再以当前屏幕中线作 ±48px 的不连续判断。
  // 部分素材的 LF/RF 节点在世界空间镜像；仅在车头已朝上后取屏幕左右轮列。
  // 标签仍按车辆语义固定为左前/右前/左后/右后，不随起始视角重新分配。
  const left=bound(Math.min(...projected.map(p=>p.x))-b.gap,b.left,innerWidth/2-b.width/2-4);
  const rightX=bound(Math.max(...projected.map(p=>p.x))+b.gap,innerWidth/2+b.width/2+4,b.right);
  const frontY=(projected[0].y+projected[1].y)/2,rearY=(projected[2].y+projected[3].y)/2;
  const separation=bound(rearY-frontY,b.height+8,b.last-b.first);
  const middle=bound((frontY+rearY)/2,b.first+separation/2,b.last-separation/2);
  return [0,1,2,3].map(i=>({x:i%2?rightX:left,y:middle+(i<2?-1:1)*separation/2}));
}
function projectTires(){
  if(!tireView||!tireLabels||innerWidth<=0||innerHeight<=0)return;
  post({t:'tires',opacity:tireOpacity,points:JSON.stringify(tireLabels.map((p,i)=>({key:tireKeys[i],x:p.x/innerWidth*100,y:p.y/innerHeight*100})))});
}
function cameraState(c){return {theta:c.getAzimuthalAngle?.(),phi:c.getPolarAngle?.(),radius:c.getDistance?.()||window.viewer?.camera?.position?.distanceTo?.(c.target)||radius,target:c.target?.clone?.(),enabled:c.enabled};}
function cameraAt(c,s){if(Number.isFinite(s.theta))c.setThetaImmediately?.(s.theta);if(Number.isFinite(s.phi))c.setPhiImmediately?.(s.phi);c.setRadiusImmediately?.(s.radius);if(s.target)c.target?.copy?.(s.target);c.update?.();}
function transitionCamera(c,start,end,done,labels=tireLabels){
  cancelAnimationFrame(tireFrame);tireTransition=true;
  const fromLabels=tireLabels,fromOpacity=tireOpacity,toOpacity=tireView?1:0;
  const placeLabels=t=>{if(labels&&fromLabels)tireLabels=labels.map((p,i)=>({x:fromLabels[i].x+(p.x-fromLabels[i].x)*t,y:fromLabels[i].y+(p.y-fromLabels[i].y)*t}));tireOpacity=fromOpacity+(toOpacity-fromOpacity)*t;projectTires();};
  const finish=()=>{cameraAt(c,end);placeLabels(1);tireFrame=0;tireTransition=false;done();};
  if(reduced?.matches||!start.target?.lerp||!Number.isFinite(start.theta)||!Number.isFinite(start.phi)){finish();return;}
  const began=performance.now();let last=-Infinity;const delta=Math.atan2(Math.sin(end.theta-start.theta),Math.cos(end.theta-start.theta));
  const step=()=>{const now=performance.now(),p=Math.min(1,(now-began)/460);if(p===1){finish();return;}if(now-last>=1000/30){last=now;const t=p*p*(3-2*p);cameraAt(c,{theta:start.theta+delta*t,phi:start.phi+(end.phi-start.phi)*t,radius:start.radius+(end.radius-start.radius)*t,target:start.target.clone().lerp(end.target,t)});redraw();placeLabels(t);}tireFrame=requestAnimationFrame(step);};
  cameraAt(c,start);placeLabels(0);tireFrame=requestAnimationFrame(step);
}
function restoreTireView(c,start){
  const restore=savedView;if(!restore)return;
  transitionCamera(c,start,restore,()=>{
    c.minPolarAngle=restore.minPolar;c.maxDistance=restore.maxDistance;
    c.minAzimuthAngle=restore.minAzimuth;c.maxAzimuthAngle=restore.maxAzimuth;
    c.enableDamping=restore.damping;c.autoRotate=restore.autoRotate;c.enabled=restore.enabled;
    savedView=null;tireLayoutKey='';tireLabels=null;tireOpacity=0;redraw();
  });
}
function setTireView(on,force=false){
  const c=window.viewer?.controls;if(!c||!full)return;
  if(!on){if(savedView&&(tireView||force||!tireTransition)){tireView=false;restoreTireView(c,cameraState(c));}return;}
  const b=tireBounds(),key=JSON.stringify([radius,offset,drop,innerWidth,innerHeight,b]);
  if(tireView&&key===tireLayoutKey&&!force)return;
  const points=wheelPoints(),initial=projectWheels(points);
  if(!b.valid||!initial){
    cancelAnimationFrame(tireFrame);tireFrame=0;tireTransition=false;tireLayoutKey='';tireLabels=null;tireOpacity=0;
    post({t:'tires',available:false});return;
  }
  const start=cameraState(c);
  if(!savedView){
    savedView={...start,minPolar:c.minPolarAngle,maxDistance:c.maxDistance,minAzimuth:c.minAzimuthAngle,maxAzimuth:c.maxAzimuthAngle,damping:c.enableDamping,autoRotate:c.autoRotate};
    c.stopViewControl?.();c.enabled=false;c.autoRotate=false;c.enableDamping=false;
    // stopViewControl 不清除 SDK 的 sphericalDelta。无阻尼提交一次可消费并清空惯性，
    // 再还原快照；两次更新之间不绘制，避免这次消费造成可见的首帧跳动。
    commitCamera(c);cameraAt(c,start);
  }
  if(!tireLabels){tireLabels=initial.map(p=>({x:bound(p.x,b.left,b.right),y:bound(p.y,b.first,b.last)}));tireOpacity=0;}
  c.minPolarAngle=.001;c.maxDistance=Infinity;c.minAzimuthAngle=-Infinity;c.maxAzimuthAngle=Infinity;
  const labels=fitTireCamera(points,b),end=cameraState(c);cameraAt(c,start);
  if(!labels){tireView=false;restoreTireView(c,start);post({t:'tires',available:false});return;}
  tireView=true;tireLayoutKey=key;
  transitionCamera(c,start,end,()=>{redraw();projectTires();},labels);
}
function syncMotion(){
  const speed=full&&!document.hidden&&inView&&!reduced?.matches&&typeof pose.speed==='number'?Math.max(0,Math.min(200,pose.speed)):0;
  if(motionSpeed===speed)return;motionSpeed=speed;
  // 仅作运动提示，避免 SDK 按实际车速滚动地面产生过强视觉刺激。
  window.car?.handleVehicleMove?.(speed>0?Math.min(6,Math.max(.6,speed*.06)):0);
  // 覆盖同名需求：行驶时至多 20 fps，驻车即结束持续渲染。
  window.viewer?.setFPS?.(20,0,'VehicleMove');
  if(speed)window.viewer?.setFPS?.(20,Infinity,'VehicleMove');
}
reduced?.addEventListener?.('change',()=>{syncMotion();if(savedView)setTireView(tireView,true);});
window.addEventListener('resize',()=>{
  cancelAnimationFrame(tireResizeFrame);
  // 包装层监听先于 SDK 注册；等 SDK 更新 viewport/aspect 后再计算投影。
  tireResizeFrame=requestAnimationFrame(()=>{tireResizeFrame=0;if(savedView)setTireView(tireView,true);});
});
if(typeof IntersectionObserver==='function')new IntersectionObserver(entries=>{inView=entries.some(e=>e.isIntersecting);syncMotion()}).observe(document.documentElement);
function applyPose(){
  const car=window.car,v=window.viewer;
  if(!full||!car||!v?.controls)return false;
  if(poseCar!==car){poseCar=car;appliedPose={}}
  const enabled=v.controls.enabled;v.controls.enabled=false;let changed=false;
  try{
    for(const [key,method] of [["lf","handleDoorLFWindow"],["rf","handleDoorRFWindow"],["lr","handleDoorLRWindow"],["rr","handleDoorRRWindow"],["trunk","handleTrunk"]]){
      const val=pose[key];
      if(typeof val!=="number"||!Number.isFinite(val)||val<0||val>1||appliedPose[key]===val||typeof car[method]!=="function")continue;
      // 暂停自动转向；初次直接定态，后续只做部件动画。
      car[method](key==="trunk"?val===1:val,!released);appliedPose[key]=val;changed=true;
    }
    if(changed){car.update?.();v.setFPS?.(30,released?4600:120,"ha-state");redraw()}
    return true;
  }finally{v.controls.enabled=enabled;if(released){setTireView(pose.tires===1);syncMotion();}}
}
async function reveal(){
  if(released||revealing)return;
  revealing=true;
  await setBackground(background);setPaint(paint);if(wrapConfig){try{if(!await setWrap(wrapConfig))post({t:'ack',of:'wrap',ok:false})}catch{post({t:'ack',of:'wrap',ok:false})}}applyPose();
  applyView(true);setTireView(pose.tires===1);await nextFrame();await nextFrame();redraw();projectTires();
  document.documentElement.classList.remove("pending");released=true;syncMotion();
  loadTimes.ready=performance.now()-started;post({t:"ready",ms:loadTimes.ready});
}
window.onFirstFrame=()=>{first=true;loadTimes.first=performance.now()-started;post({t:"first",ms:loadTimes.first})};
window.onFullCarLoaded=()=>{full=true;clearTimeout(timeout);setPaint(paint);loadTimes.full=performance.now()-started;post({t:"full",ms:loadTimes.full});void reveal()};
window.addEventListener("message",ev=>{
  if(ev.source!==parent||ev.origin!==location.origin)return;
  const d=ev.data;if(!d||typeof d!=="object")return;
  if(d.t==="background"||d.t==="daynight"){
    background=d.t==="daynight"?(Number(d.v)===1?"night":"day"):String(d.name);
    if(!["day","night","studio","dusk","aurora","blueprint"].includes(background))background="day";
    void setBackground(background).then(ok=>post({t:"ack",of:"background",ok}));
  }else if(d.t==="paint"){
    if(typeof d.hex!=="string"||(d.hex!==""&&!/^#[0-9a-f]{6}$/i.test(d.hex)))return;
    paint=d.hex;post({t:"ack",of:"paint",ok:setPaint(paint)});
  }
  else if(d.t==="vehicle"){pose=d;post({t:"ack",of:"vehicle",ok:applyPose()})}
  else if(d.t==='wrap'){try{void setWrap(JSON.parse(d.value)).then(ok=>post({t:'ack',of:'wrap',ok}),()=>post({t:'ack',of:'wrap',ok:false}))}catch{post({t:'ack',of:'wrap',ok:false})}}
  else if(d.t==="view"){
    if(Number.isFinite(d.radius)&&d.radius>0)radius=d.radius;
    if(Number.isFinite(d.offset))offset=d.offset;
    if(Number.isFinite(d.drop))drop=d.drop;
    if(released&&savedView){
      // 记住新尺寸下的普通取景；胎压过渡由同一个动画接管，不能被 applyView 抢写。
      savedView.radius=radius;
      if(savedView.target&&window.viewer.controls.__leapBaseY!==undefined)savedView.target.y=window.viewer.controls.__leapBaseY+drop/100*.335*radius;
      window.viewer.setOffsetVertical?.(offset*100);setTireView(tireView,true);
      post({t:'ack',of:'view',ok:true});
    }else post({t:"ack",of:"view",ok:released?applyView():true});
  }else if(d.t==="probe")post({t:"ack",of:"probe",version:WRAPPER_VERSION,full,first,released,loadTimes:{...loadTimes},
    hasPaint:!!window.car?.carPaint_CarPaintMaterial,hasSky:!!skyNode(),background,
    stateMethods:["handleDoorLFWindow","handleDoorRFWindow","handleDoorLRWindow","handleDoorRRWindow","handleTrunk"].filter(k=>typeof window.car?.[k]==="function")});
});
window.__api={setBackground,setPaint,setWrap,applyView,applyPose,redraw,sceneOf,skyNode,version:WRAPPER_VERSION};
const timeout=setTimeout(()=>{if(!full){if(first)void reveal();post({t:"err",msg:first?"完整模型未就绪，当前显示简化车模":"车模加载超时，请导出诊断检查素材完整性"})}},25000);
try{
  if(background==="night")void nightImage();
  window.web3dPerformanceOptions={metricsEnabled:false,dynamicDprEnabled:true,transitionPixelRatioCap:1.25};
  await import(`./index.js?v=${WRAPPER_VERSION}`);
  await window.newInit(JSON.stringify(cfg),JSON.stringify({width:innerWidth,height:innerHeight,energy:0,inland:0}));
}catch(e){clearTimeout(timeout);post({t:"err",msg:String(e)})}
document.addEventListener("visibilitychange",()=>{syncMotion();if(document.hidden)window.onBackend?.();else window.onFrontend?.()});
