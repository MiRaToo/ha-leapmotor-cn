// 车衣多面回归：本地设置迁移/容量、五面共享一张图集、清除、取消草稿与过期解码。
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/cards/control/car-wrap.ts',import.meta.url),'utf8');
const local=new Map();
class LitElement{requestUpdate(){}updateComplete=Promise.resolve()}
const lit={LitElement,html:()=>'',css:()=>'',unsafeCSS:v=>v,nothing:null},modules={
  'lit':lit,'lit/directives/live.js':{live:v=>v},'../../lib/ui/styles':{uiStyles:''}
};
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const registered=new Map(),customElements={get:k=>registered.get(k),define:(k,v)=>registered.set(k,v)};
const componentContext={exports:{},require:id=>modules[id],customElements,localStorage:{setItem(k,v){local.set(k,v)},removeItem(k){local.delete(k)}},URL,Image:class{},document:{},requestAnimationFrame:()=>1,cancelAnimationFrame(){}};
vm.runInNewContext(compiled,componentContext);const {readWrap,writeWrap,LeapmotorCarWrap}=componentContext.exports;
const old={image:'data:image/png;base64,old',side:'right',x:20,y:30,scale:70,rotation:15,opacity:80};
const migrated=readWrap(old);assert.equal(migrated.version,2);assert.deepEqual(Object.keys(migrated.faces),['right']);assert.equal(migrated.faces.right.rotation,15);
const tooBig={version:2,faces:{}};for(const side of ['left','right','top'])tooBig.faces[side]={...old,image:'data:image/png;base64,'+'a'.repeat(900000),side};
assert.throws(()=>writeWrap('wrap-test',tooBig),/限制/,'serialized storage cap rejects oversized combined image data');
writeWrap('wrap-cancel',migrated);const editor=new LeapmotorCarWrap();let canceled=false;editor.onCancel=()=>{canceled=true};editor.draft=readWrap(migrated);editor.draft.faces.right.rotation=90;editor.dirty=true;editor.willUpdate(new Map([['value',null]]));assert.equal(editor.draft.faces.right.rotation,90,'external rerender cannot erase dirty draft');editor.cancel();assert.equal(canceled,true,'cancel exits without saving draft');assert.equal(readWrap(JSON.parse(local.get('wrap-cancel'))).faces.right.rotation,15,'cancel leaves saved face unchanged');

class Vec{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z}clone(){return new Vec(this.x,this.y,this.z)}copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this}set(x,y,z){this.x=x;this.y=y;this.z=z;return this}add(v){this.x+=v.x;this.y+=v.y;this.z+=v.z;return this}addScaledVector(v,n){this.x+=v.x*n;this.y+=v.y*n;this.z+=v.z*n;return this}sub(v){this.x-=v.x;this.y-=v.y;this.z-=v.z;return this}multiplyScalar(n){this.x*=n;this.y*=n;this.z*=n;return this}normalize(){const n=Math.hypot(this.x,this.y,this.z)||1;return this.multiplyScalar(1/n)}negate(){return this.multiplyScalar(-1)}dot(v){return this.x*v.x+this.y*v.y+this.z*v.z}}
class Box{constructor(min,max){this.min=min;this.max=max}clone(){return new Box(this.min.clone(),this.max.clone())}applyMatrix4(){return this}union(){return this}}
const disposed=[];class Source{constructor(data){this.data=data}}
const original={source:new Source({}),magFilter:1006,minFilter:1008,clone(){const tex={source:this.source,dispose(){disposed.push(this)},needsUpdate:false};return tex}};
const material={uniforms:{blendColor:{},mainTexture:{value:original}},fragmentShader:'vec3 diffuse = fresnelCol * NdotL;',needsUpdate:false};
const bbox=new Box(new Vec(-1,0,-2),new Vec(1,2,2));
const wheels={LF:new Vec(-1,0,1),RF:new Vec(1,0,1),LR:new Vec(-1,0,-1),RR:new Vec(1,0,-1)};
const mesh={geometry:{boundingBox:bbox,computeBoundingBox(){}},matrixWorld:{},material};
const car={carPaint_CarPaintMaterial:material,updateMatrixWorld(){},traverse(fn){fn(mesh)},getObjectByName(name){return name.endsWith('LF_Main')?null:null}};
for(const [key,pos] of Object.entries(wheels))car['wheel'+key+'2']={position:pos,getWorldPosition(target){return target.copy(pos)}};
let draws=0;const canvases=[];const document={documentElement:{style:{setProperty(){}},classList:{remove(){}}},addEventListener(){},createElement(){const canvas={width:0,height:0,getContext(){return {clearRect(){},drawImage(){draws++}}}};canvases.push(canvas);return canvas}};
const pendingImages=[];class ControlledImage{constructor(){this.width=64;this.height=32;pendingImages.push(this)}set src(v){this.value=v}resolve(){this.onload?.()}}
let textureUnits=8;const gl={MAX_TEXTURE_IMAGE_UNITS:1,MAX_TEXTURE_SIZE:2,getParameter(key){return key===1?textureUnits:4096}};
const viewer={renderer:{render(){},getContext(){return gl}},scene:{traverse(){}},camera:{},setFPS(){}};
const handlers={},parent={postMessage(){}};const win={car,viewer,addEventListener(type,fn){handlers[type]=fn},newInit:async()=>{}};
const env={window:win,document,parent,location:{origin:'http://localhost',search:'?car=C10'},URLSearchParams,performance:{now:()=>1},requestAnimationFrame:fn=>setImmediate(fn),cancelAnimationFrame:clearImmediate,setTimeout:()=>1,clearTimeout(){},Image:ControlledImage,console,matchMedia:()=>({matches:true,addEventListener(){}})};
let view=readFileSync(new URL('../custom_components/leapmotor/www/car3d/view.js',import.meta.url),'utf8').replace('await import(`./index.js?v=${WRAPPER_VERSION}`);','');
await vm.runInNewContext(`(async()=>{${view}\n})()`,env);win.onFullCarLoaded();for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
const image=n=>'data:image/png;base64,'+n;
const upload=(side,name)=>({image:image(name),side,x:50,y:50,scale:60,rotation:0,opacity:100});
const first=win.__api.setWrap({image:image('legacy'),side:'left',x:50,y:50,scale:60,rotation:0,opacity:100});pendingImages.at(-1).resolve();assert.equal(await first,true,'legacy single-face message is accepted');
assert.equal(material.uniforms.haWrapLeftOpacity.value,1);assert.match(material.fragmentShader,/uniform highp sampler2D haWrapTexture;/);assert.equal((material.fragmentShader.match(/uniform highp sampler2D/g)||[]).length,1,'all five face images share one sampler');
const leftFace=upload('left','l'),rightFace={...upload('right','r'),x:30,y:40,scale:90,rotation:20,opacity:70};
const multi=win.__api.setWrap({version:2,faces:{left:leftFace,right:rightFace}});pendingImages.slice(-2).forEach(im=>im.resolve());assert.equal(await multi,true,'two independent faces render together');
assert.equal(material.uniforms.haWrapLeftOpacity.value,1);assert.equal(material.uniforms.haWrapRightOpacity.value,.7);assert.ok(Math.abs(material.uniforms.haWrapRightRotation.value[0]-Math.cos(20*Math.PI/180))<1e-9,'right face keeps its independent rotation');assert.notDeepEqual(material.uniforms.haWrapLeftCenter.value,material.uniforms.haWrapRightCenter.value,'each face gets its own image position');assert.equal(canvases.at(-1).width,2048);assert.equal(draws>=3,true,'atlas includes both face images');assert.equal(disposed.length,1,'replacing the atlas releases its previous texture');
const removeLeft=win.__api.setWrap({version:2,faces:{right:{side:'right',x:30,y:40,scale:90,rotation:20,opacity:70}}});assert.equal(await removeLeft,true);assert.equal(material.uniforms.haWrapLeftOpacity.value,0);assert.equal(material.uniforms.haWrapRightOpacity.value,.7,'removing left keeps right configured and visible');
const beforeClear=disposed.length;assert.equal(await win.__api.setWrap(null),true);assert.equal(material.uniforms.haWrapRightOpacity.value,0);assert.equal(disposed.length,beforeClear+1,'clear releases the active atlas');
const initialImageRequest=win.__api.setWrap({version:2,faces:{top:upload('top','initial-pending')}});const initialDecode=pendingImages.at(-1);
const latestTransform=win.__api.setWrap({version:2,faces:{top:{side:'top',x:80,y:25,scale:75,rotation:35,opacity:90}}});const latestDecode=pendingImages.at(-1);assert.notEqual(initialDecode,latestDecode);assert.equal(latestDecode.value,image('initial-pending'),'image-omitting transform reuses the newest validated pending source');latestDecode.resolve();assert.equal(await latestTransform,true,'latest transform decodes/applies the in-flight image');assert.equal(material.uniforms.haWrapTopOpacity.value,.9);initialDecode.resolve();await initialImageRequest;assert.equal(material.uniforms.haWrapTopRotation.value[0],Math.cos(35*Math.PI/180),'stale first decode cannot override the latest transform');
const replacement=win.__api.setWrap({version:2,faces:{top:upload('top','replacement-pending')}}),replacementDecode=pendingImages.at(-1);
const replacementTransform=win.__api.setWrap({version:2,faces:{top:{side:'top',x:15,y:65,scale:95,rotation:-25,opacity:60}}}),replacementLatest=pendingImages.at(-1);assert.equal(replacementLatest.value,image('replacement-pending'),'replacement transform also reuses pending image');replacementLatest.resolve();assert.equal(await replacementTransform,true);replacementDecode.resolve();await replacement;assert.equal(material.uniforms.haWrapTopRotation.value[0],Math.cos(-25*Math.PI/180),'late replaced image does not replace latest transform');
const stale=win.__api.setWrap({version:2,faces:{top:upload('top','stale')}});const staleImage=pendingImages.at(-1);await win.__api.setWrap(null);staleImage.resolve();await stale;assert.equal(material.uniforms.haWrapTexture.value,null,'late image decode cannot restore a cleared preview');
textureUnits=7;const lowUnits=win.__api.setWrap({version:2,faces:{top:upload('top','low-gpu')}});pendingImages.at(-1).resolve();assert.equal(await lowUnits,false,'renderer below the eight-unit minimum rejects a wrap safely');textureUnits=8;
material.fragmentShader=Array.from({length:7},(_,i)=>`uniform sampler2D base${i};`).join('')+'vec3 diffuse = fresnelCol * NdotL;';const fitsEight=win.__api.setWrap({version:2,faces:{top:upload('top','fits-eight')}});pendingImages.at(-1).resolve();assert.equal(await fitsEight,true,'seven existing samplers plus the atlas fit the eight-unit limit');
const rejected=win.__api.setWrap({version:2,faces:Object.fromEntries(['left','right','top'].map(side=>[side,{...upload(side,'x'),image:image('x'.repeat(900000))}]))});assert.equal(await rejected,false,'view applies same combined payload cap');
console.log('Car wrap smoke: legacy migration, draft preservation/cancel, multi-face atlas, single-face clear, stale decode, disposal, storage cap, 8 texture units passed');
