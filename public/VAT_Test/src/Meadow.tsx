import { useEffect, useMemo } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import { useServerClock } from '@xrift/world-components'
import { BackSide, BufferAttribute, DataTexture, DoubleSide, FileLoader, HalfFloatType, InstancedBufferAttribute, InstancedBufferGeometry, LinearFilter, Mesh, MeshLambertMaterial, NearestFilter, NoColorSpace, RepeatWrapping, RGBAFormat, ShaderMaterial, Sphere, SphereGeometry, Vector3 } from 'three'

const FRAMES=64, BLADES=7, BLADE_VERTS=9, BLADE_INDICES=21, WIDTH=BLADES*BLADE_VERTS
const CHUNK=12, CHUNKS=10, TUFTS_PER_M2=12, TUFTS=CHUNK*CHUNK*TUFTS_PER_M2
// Every time term is a whole number of cycles in LOOP, so wrapping the server clock is seamless.
const LOOP=96, WAVE_PERIOD=LOOP/30, WAVELENGTH=16, TRAIL_LIFE=LOOP/26
const WIND_ANGLE=-.42, WIND_X=Math.cos(WIND_ANGLE), WIND_Z=Math.sin(WIND_ANGLE)
const TRAILS=64, TRAIL_SEGMENTS=30

const windHeader=`
  const vec2 windDir=vec2(${WIND_X.toFixed(5)},${WIND_Z.toFixed(5)});
  const vec2 windSide=vec2(${(-WIND_Z).toFixed(5)},${WIND_X.toFixed(5)});
  const float TAU=6.2831853;
`
const grassHeader=windHeader+`
  attribute vec4 grassInstance;
  attribute float grassU;
  attribute vec3 grassSide;
  attribute float grassHeight;
  uniform sampler2D grassPosition;
  uniform sampler2D grassNormal;
  uniform float grassTime;
  varying float vGrassHeight;
  varying float vGrassBend;
  varying float vGrassTint;
  float grassHash(vec2 p) { return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
`
const grassBody=`
  vec2 grassOrigin=grassInstance.xy;
  float grassAlong=dot(grassOrigin,windDir), grassAcross=dot(grassOrigin,windSide);
  float grassLoop=grassTime/${LOOP}.0*TAU;
  // Warped fronts and drifting gust patches keep the crests from reading as straight stripes.
  float grassWarp=.55*sin(grassAcross/19.0+grassAlong/41.0+grassLoop)+.28*sin(grassAcross/7.3-grassAlong/23.0-2.0*grassLoop);
  float grassRand=grassHash(grassOrigin);
  float grassFrame=grassTime/${WAVE_PERIOD.toFixed(4)}-grassAlong/${WAVELENGTH}.0+grassWarp+(grassRand-.5)*.05;
  float grassGust=sin(grassAlong/13.0-5.0*grassLoop+1.4*sin(grassAcross/17.0))*.5+.5;
  float grassStrength=.55+.45*grassGust*grassGust*(3.0-2.0*grassGust);
  vec2 grassUV=vec2((grassU+.5)/${WIDTH}.0,grassFrame+.5/${FRAMES}.0);
  float grassCos=cos(grassInstance.z), grassSin=sin(grassInstance.z), grassScale=grassInstance.w;
  // Blades thicken with distance to compensate for the far LODs drawing fewer of them.
  float grassWiden=mix(1.0,2.8,smoothstep(10.0,48.0,distance(cameraPosition.xz,grassOrigin)));
  vec3 grassRest=(position+grassSide*(grassWiden-1.0))*grassScale;
  grassRest=vec3(grassCos*grassRest.x+grassSin*grassRest.z,grassRest.y,-grassSin*grassRest.x+grassCos*grassRest.z);
  vec3 grassBent=texture2D(grassPosition,grassUV).xyz*grassStrength*grassScale;
  vec3 grassBentNormal=texture2D(grassNormal,grassUV).xyz*grassStrength;
  vec3 grassRestNormal=vec3(grassCos*normal.x+grassSin*normal.z,normal.y,-grassSin*normal.x+grassCos*normal.z);
  grassBent.xz=vec2(windDir.x*grassBent.x-windDir.y*grassBent.z,windDir.y*grassBent.x+windDir.x*grassBent.z);
  grassBentNormal.xz=vec2(windDir.x*grassBentNormal.x-windDir.y*grassBentNormal.z,windDir.y*grassBentNormal.x+windDir.x*grassBentNormal.z);
  vec3 grassFinal=grassRest+grassBent+vec3(grassOrigin.x,0.0,grassOrigin.y);
  vGrassHeight=grassHeight;
  vGrassBend=clamp(length(grassBent.xz)/.55,0.0,1.0);
  vGrassTint=grassRand;
  vec3 objectNormal=normalize(grassRestNormal+grassBentNormal);
  #ifdef USE_TANGENT
  vec3 objectTangent=vec3(tangent.xyz);
  #endif
`
const trailVertex=windHeader+`
  attribute vec2 trailVertex;
  attribute float trailSeed;
  uniform float trailTime;
  varying float vTrailAlpha;
  varying float vTrailEdge;
  float seedAt(float k) { return fract(sin(trailSeed*91.17+k*37.7)*24634.6345); }
  // Stateless path: a gentle drift, with a spiral on the trails that curl.
  vec3 trailPath(float s,float swirl) {
    float along=(seedAt(1.0)-.5)*80.0+s, across=(seedAt(2.0)-.5)*80.0;
    float height=.7+seedAt(3.0)*2.6+.28*sin(s*.31+seedAt(4.0)*TAU);
    across+=.7*sin(s*.17+seedAt(5.0)*TAU);
    float turn=smoothstep(10.0,18.0,s)*(1.0-smoothstep(20.0,28.0,s));
    float angle=(s-19.0)*1.1;
    float radius=swirl*turn*.75;
    along+=radius*sin(angle)*.6;
    across+=radius*cos(angle)*.3;
    height+=radius*(1.0-cos(angle));
    return vec3(windDir.x*along+windSide.x*across,height,windDir.y*along+windSide.y*across);
  }
  void main() {
    float life=fract(trailTime/${TRAIL_LIFE.toFixed(4)}+seedAt(6.0));
    float head=life*34.0, tail=trailVertex.x*(5.0+seedAt(7.0)*3.0);
    float swirl=step(.62,seedAt(8.0));
    vec3 point=trailPath(head-tail,swirl);
    vec3 tangent=normalize(trailPath(head-tail+.15,swirl)-point);
    vec3 sideAxis=normalize(cross(tangent,cameraPosition-point));
    float taper=(1.0-trailVertex.x)*smoothstep(0.0,.2,trailVertex.x);
    float span=(.018+.022*seedAt(9.0))*taper;
    vTrailEdge=trailVertex.y;
    vTrailAlpha=smoothstep(0.0,.14,life)*(1.0-smoothstep(.72,1.0,life))*(1.0-trailVertex.x);
    gl_Position=projectionMatrix*viewMatrix*vec4(point+sideAxis*span*trailVertex.y,1.0);
  }
`
const skyVertex=`
  varying float vSkyHeight;
  void main() { vSkyHeight=normalize(position).y; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }
`
const skyFragment=`
  varying float vSkyHeight;
  void main() { gl_FragColor=vec4(mix(vec3(.83,.94,.98),vec3(.34,.68,.93),smoothstep(0.0,.55,vSkyHeight)),1.0); }
`
const trailFragment=`
  varying float vTrailAlpha;
  varying float vTrailEdge;
  void main() { gl_FragColor=vec4(1.0,1.0,1.0,vTrailAlpha*(1.0-vTrailEdge*vTrailEdge)); }
`
function bladeIndices() {
  const indices:number[]=[]
  for(let b=0;b<BLADES;b++) {
    const base=b*BLADE_VERTS
    for(let s=0;s<3;s++) { const i=base+s*2; indices.push(i,i+1,i+2,i+1,i+3,i+2) }
    indices.push(base+6,base+7,base+8)
  }
  return indices
}
function fieldInstances() {
  let seed=4242
  const random=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296 }
  return Array.from({length:CHUNKS*CHUNKS},(_,c)=>{
    const originX=(c%CHUNKS-CHUNKS/2)*CHUNK, originZ=(Math.floor(c/CHUNKS)-CHUNKS/2)*CHUNK
    const data=new Float32Array(TUFTS*4)
    for(let i=0;i<TUFTS;i++) data.set([originX+random()*CHUNK,originZ+random()*CHUNK,random()*Math.PI*2,.8+random()*.5],i*4)
    return {center:new Vector3(originX+CHUNK/2,.4,originZ+CHUNK/2),data}
  })
}
const cameraWorld=new Vector3()
export function Meadow({baseUrl}:{baseUrl:string}) {
  const { now } = useServerClock()
  const camera=useThree(state=>state.camera)
  const buffers=useLoader(FileLoader,['position','normal','mesh'].map(name=>`${baseUrl}vat-grass-${name}.bin`),loader=>loader.setResponseType('arraybuffer')) as ArrayBuffer[]
  const assets=useMemo(()=>{
    const textures=buffers.slice(0,2).map(buffer=>{
      if(buffer.byteLength!==WIDTH*FRAMES*8) throw new Error('Invalid grass VAT size')
      const texture=new DataTexture(new Uint16Array(buffer),WIDTH,FRAMES,RGBAFormat,HalfFloatType)
      texture.colorSpace=NoColorSpace
      // Hardware filtering blends frames in one fetch; repeat closes the loop seam.
      texture.magFilter=LinearFilter; texture.minFilter=NearestFilter
      texture.wrapT=RepeatWrapping
      texture.generateMipmaps=false
      texture.needsUpdate=true
      return texture
    })
    const mesh=new Float32Array(buffers[2])
    const pick=(offset:number,size:number)=>{
      const out=new Float32Array(WIDTH*size)
      for(let v=0;v<WIDTH;v++) for(let c=0;c<size;c++) out[v*size+c]=mesh[v*10+offset+c]
      return new BufferAttribute(out,size)
    }
    const shared={position:pick(0,3),normal:pick(3,3),grassSide:pick(6,3),grassHeight:pick(9,1),grassU:new BufferAttribute(Float32Array.from({length:WIDTH},(_,i)=>i),1)}
    const index=new BufferAttribute(new Uint16Array(bladeIndices()),1)
    const uniforms={grassPosition:{value:textures[0]},grassNormal:{value:textures[1]},grassTime:{value:0}}
    const material=new MeshLambertMaterial({color:'#ffffff',side:DoubleSide})
    material.onBeforeCompile=shader=>{
      Object.assign(shader.uniforms,uniforms)
      shader.vertexShader=grassHeader+shader.vertexShader
        .replace('#include <beginnormal_vertex>',grassBody)
        .replace('#include <begin_vertex>','vec3 transformed=grassFinal;')
      shader.fragmentShader=`
        varying float vGrassHeight;
        varying float vGrassBend;
        varying float vGrassTint;
      `+shader.fragmentShader.replace('#include <color_fragment>',`
        #include <color_fragment>
        vec3 grassColor=mix(vec3(.02,.17,.06),mix(vec3(.12,.50,.09),vec3(.24,.60,.10),vGrassTint),smoothstep(0.0,.8,vGrassHeight));
        // Pressed-down blades catch the light, which is what makes the wave readable from afar.
        diffuseColor.rgb=mix(grassColor,vec3(.78,.95,.42),smoothstep(.15,.85,vGrassBend)*vGrassHeight*.9);
      `).replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\ntotalEmissiveRadiance+=diffuseColor.rgb*.22;')
    }
    material.customProgramCacheKey=()=>'vat-grass-v1'
    const chunks=fieldInstances().map(({center,data})=>{
      const geometry=new InstancedBufferGeometry()
      geometry.setIndex(index)
      Object.entries(shared).forEach(([name,attribute])=>geometry.setAttribute(name,attribute))
      geometry.setAttribute('grassInstance',new InstancedBufferAttribute(data,4))
      geometry.boundingSphere=new Sphere(center,CHUNK*.8)
      return {center,geometry,mesh:new Mesh(geometry,material)}
    })
    const trailGeometry=new InstancedBufferGeometry()
    const trailData=new Float32Array((TRAIL_SEGMENTS+1)*4), trailIndex:number[]=[]
    for(let i=0;i<=TRAIL_SEGMENTS;i++) {
      trailData.set([i/TRAIL_SEGMENTS,-1,i/TRAIL_SEGMENTS,1],i*4)
      if(i<TRAIL_SEGMENTS) trailIndex.push(i*2,i*2+1,i*2+2,i*2+1,i*2+3,i*2+2)
    }
    trailGeometry.setIndex(trailIndex)
    trailGeometry.setAttribute('trailVertex',new BufferAttribute(trailData,2))
    // three requires a position attribute for its draw range; the shader ignores it.
    trailGeometry.setAttribute('position',new BufferAttribute(new Float32Array((TRAIL_SEGMENTS+1)*6),3))
    trailGeometry.setAttribute('trailSeed',new InstancedBufferAttribute(Float32Array.from({length:TRAILS},(_,i)=>(i+1)/TRAILS),1))
    trailGeometry.instanceCount=TRAILS
    trailGeometry.boundingSphere=new Sphere(new Vector3(0,2,0),80)
    const trailUniforms={trailTime:{value:0}}
    const trailMaterial=new ShaderMaterial({vertexShader:trailVertex,fragmentShader:trailFragment,uniforms:trailUniforms,transparent:true,depthWrite:false,side:DoubleSide})
    const skyMaterial=new ShaderMaterial({vertexShader:skyVertex,fragmentShader:skyFragment,side:BackSide,fog:false,depthWrite:false})
    const skyGeometry=new SphereGeometry(120,32,16)
    return {textures,uniforms,material,chunks,trailGeometry,trailMaterial,trailUniforms,trail:new Mesh(trailGeometry,trailMaterial),sky:new Mesh(skyGeometry,skyMaterial),skyGeometry,skyMaterial}
  },[buffers])
  useEffect(()=>()=>{
    assets.textures.forEach(t=>t.dispose())
    assets.chunks.forEach(chunk=>chunk.geometry.dispose())
    assets.material.dispose(); assets.trailGeometry.dispose(); assets.trailMaterial.dispose()
    assets.skyGeometry.dispose(); assets.skyMaterial.dispose()
  },[assets])
  useFrame(()=>{
    const seconds=(now()/1000)%LOOP
    assets.uniforms.grassTime.value=seconds
    assets.trailUniforms.trailTime.value=seconds
    camera.getWorldPosition(cameraWorld)
    // Follows the viewer so the dome never reaches the far plane.
    assets.sky.position.copy(cameraWorld)
    for(const chunk of assets.chunks) {
      const distance=Math.hypot(chunk.center.x-cameraWorld.x,chunk.center.z-cameraWorld.z)
      const density=Math.max(.3,Math.min(1,1.25-distance/32))
      chunk.geometry.instanceCount=Math.floor(TUFTS*density)
      chunk.geometry.setDrawRange(0,(distance<20?7:distance<40?4:2)*BLADE_INDICES)
    }
  })
  return <>
    {assets.chunks.map((chunk,i)=><primitive key={i} object={chunk.mesh}/>)}
    <primitive object={assets.sky}/>
    <primitive object={assets.trail}/>
  </>
}
