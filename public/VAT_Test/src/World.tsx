import { Suspense, useEffect, useMemo } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import { Interactable, SpawnPoint, useInstanceState, useXRift, useServerClock } from '@xrift/world-components'
import { Meadow } from './Meadow'
import { BufferAttribute, CanvasTexture, DataTexture, FileLoader, HalfFloatType, MeshDepthMaterial, MeshPhysicalMaterial, NearestFilter, NoColorSpace, Object3D, RGBAFormat, RGBADepthPacking, Sphere, SphereGeometry, SRGBColorSpace, Vector3, type Material } from 'three'

const FRAMES=120, DURATION=12, WIDTH=1024, ROWS=7, HEIGHT=FRAMES*ROWS
function Sculpture({passage,hidden}:{passage:boolean;hidden:boolean}) {
  const { baseUrl } = useXRift()
  const { now } = useServerClock()
  const buffers = useLoader(FileLoader, ['position','normal','pass-position','pass-normal'].map(name=>`${baseUrl}vat-${name}.bin`), loader => loader.setResponseType('arraybuffer')) as ArrayBuffer[]
  const assets = useMemo(() => {
    const textures = buffers.map(buffer => {
      if(buffer.byteLength !== WIDTH*HEIGHT*8) throw new Error('Invalid VAT texture size')
      const texture = new DataTexture(new Uint16Array(buffer), WIDTH, HEIGHT, RGBAFormat, HalfFloatType)
      texture.colorSpace=NoColorSpace
      texture.minFilter=texture.magFilter=NearestFilter
      texture.generateMipmaps=false
      texture.needsUpdate=true
      return texture
    })
    const geometry = new SphereGeometry(1,96,64)
    geometry.setAttribute('vatIndex',new BufferAttribute(Float32Array.from({length:geometry.attributes.position.count},(_,i)=>i),1))
    geometry.boundingSphere=new Sphere(new Vector3(),10)
    const uniforms={vatPosition:{value:textures[0]},vatNormal:{value:textures[1]},vatFrame:{value:0},marblePhase:{value:0}}
    const header=`
      attribute float vatIndex;
      uniform sampler2D vatPosition;
      uniform sampler2D vatNormal;
      uniform float vatFrame;
      vec2 vatUV(float frame) {
        return vec2((mod(vatIndex,${WIDTH}.0)+0.5)/${WIDTH}.0,(frame*${ROWS}.0+floor(vatIndex/${WIDTH}.0)+0.5)/${HEIGHT}.0);
      }
      vec3 vatRead(sampler2D tex) {
        float frame=floor(vatFrame);
        return mix(texture2D(tex,vatUV(frame)).xyz,texture2D(tex,vatUV(mod(frame+1.0,${FRAMES}.0))).xyz,fract(vatFrame));
      }
    `
    function patch(material: Material, normal: boolean) {
      material.onBeforeCompile=shader=>{
        Object.assign(shader.uniforms,uniforms)
        shader.vertexShader=header+shader.vertexShader.replace('#include <begin_vertex>','vec3 transformed = vatRead(vatPosition);')
        if(normal) {
          shader.vertexShader='varying vec3 marblePosition;\n'+shader.vertexShader
            .replace('vec3 transformed = vatRead(vatPosition);','vec3 transformed = vatRead(vatPosition); marblePosition = position;')
            .replace('#include <beginnormal_vertex>','vec3 objectNormal = normalize(vatRead(vatNormal));\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(tangent.xyz);\n#endif')
          shader.fragmentShader=`
            varying vec3 marblePosition;
            uniform float marblePhase;
            // Object-space coordinates keep the pattern continuous across UV seams.
            float marbleField(vec3 p) {
              return sin(p.x+sin(p.z*1.3))*cos(p.y*.83)+.5*sin(p.y*1.7+p.z);
            }
            vec3 pastelBand(float index) {
              if(index<1.0) return vec3(.80,.25,.40); // rose
              if(index<2.0) return vec3(.42,.24,.66); // lavender
              if(index<3.0) return vec3(.20,.51,.72); // sky
              if(index<4.0) return vec3(.24,.66,.49); // mint
              if(index<5.0) return vec3(.91,.77,.25); // butter yellow
              return vec3(.93,.47,.35);              // peach
            }
          `+shader.fragmentShader.replace('#include <color_fragment>', `
            #include <color_fragment>
            vec3 p = normalize(marblePosition)*2.8;
            float c = cos(marblePhase), s = sin(marblePhase);
            p.xz = mat2(c,-s,s,c)*p.xz;
            vec3 flow = vec3(sin(marblePhase),cos(marblePhase),sin(2.0*marblePhase))*.65;
            float warp = marbleField(p+flow);
            float fine = marbleField(p*2.1+warp+flow);
            float ribbon = p.y*3.1+p.x*1.2+warp*3.4+fine*.85;
            float band = mod(ribbon,6.0);
            float edge = fract(band);
            vec3 color = mix(pastelBand(floor(band)),pastelBand(mod(floor(band)+1.0,6.0)),smoothstep(0.0,1.0,edge));
            // Smooth rainbow gradients separated by distinct white ribbons.
            float lineDistance = abs(fract(ribbon*.5)-.5);
            float aa = max(fwidth(ribbon)*.5,.002);
            float cream = 1.0-smoothstep(.008,.008+aa,lineDistance);
            diffuseColor.rgb *= mix(color,vec3(.98,.98,.97),cream*.96);
          `).replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.12;')
        }
      }
      material.customProgramCacheKey=()=>`vat-test-pastel-gradient-v7-${normal}`
    }
    const material=new MeshPhysicalMaterial({color:'#ffffff',metalness:.03,roughness:.36,clearcoat:.65,clearcoatRoughness:.25})
    const depth=new MeshDepthMaterial({depthPacking:RGBADepthPacking})
    patch(material,true); patch(depth,false)
    return {textures,geometry,material,depth,uniforms}
  },[buffers])
  useEffect(()=>()=>{
    assets.geometry.dispose(); assets.material.dispose(); assets.depth.dispose()
    assets.textures.forEach(t=>t.dispose())
  },[assets])
  useFrame(()=>{
    const seconds=now()/1000
    assets.uniforms.vatPosition.value=assets.textures[passage?2:0]
    assets.uniforms.vatNormal.value=assets.textures[passage?3:1]
    assets.uniforms.vatFrame.value=(seconds%DURATION)/DURATION*FRAMES
    assets.uniforms.marblePhase.value=(seconds%60)/60*Math.PI*2
  })
  return <mesh visible={!hidden} position={[0,4.2,0]} geometry={assets.geometry} material={assets.material} customDepthMaterial={assets.depth} castShadow />
}

const MODES=['01 / FLOAT','02 / SQUEEZE','03 / MEADOW']
const NEXT_MODE_TEXT=['棒の間を通過するアニメーションへ切り替え','風の草原へ切り替え','浮遊アニメーションへ切り替え']
const MODE_COLORS=['#e7b7c8','#acbfe2','#b7dfa8']
function SwitchLabel({mode}:{mode:number}) {
  const texture=useMemo(()=>{
    const canvas=document.createElement('canvas');canvas.width=768;canvas.height=256
    const ctx=canvas.getContext('2d')!
    ctx.fillStyle='#f5f5f2';ctx.fillRect(0,0,768,256)
    ctx.fillStyle='#525d63';ctx.textAlign='center';ctx.font='44px sans-serif'
    ctx.fillText(MODES[mode],384,106)
    ctx.font='24px sans-serif';ctx.fillText('SWITCH ANIMATION',384,170)
    const tex=new CanvasTexture(canvas);tex.colorSpace=SRGBColorSpace;return tex
  },[mode])
  useEffect(()=>()=>texture.dispose(),[texture])
  return <mesh position={[0,1.65,0]}><planeGeometry args={[1.55,.52]}/><meshBasicMaterial map={texture} toneMapped={false}/></mesh>
}
export interface WorldProps { preview?: boolean; previewMode?: number; onPreviewSwitch?: () => void; hidePreviewControls?: boolean }
export function World({preview=false,previewMode=0,onPreviewSwitch,hidePreviewControls=false}:WorldProps) {
  const { baseUrl } = useXRift()
  const [sharedMode,setSharedMode]=useInstanceState('vat-test-mode',0)
  const mode=preview?previewMode:sharedMode
  const passage=mode===1, meadow=mode===2
  const switchAnimation=()=>preview?onPreviewSwitch?.():setSharedMode((sharedMode+1)%MODES.length)
  const target=useMemo(()=>{const object=new Object3D();object.position.set(0,3.6,0);return object},[])
  return <>
    <color attach="background" args={[meadow?'#d4f0fa':'#f7f7f5']} />
    <fog attach="fog" args={meadow?['#d4f0fa',32,108]:['#f7f7f5',28,75]} />
    <ambientLight intensity={.35} />
    <hemisphereLight args={meadow?['#e9f7ff','#7fb86a',.9]:['#f5f8ff','#a3a3a0',.55]} />
    <primitive object={target}/>
    {meadow ? <>
      <directionalLight position={[-30,40,20]} color="#fff6e2" intensity={1.5}/>
      <Suspense fallback={null}><Meadow baseUrl={baseUrl}/></Suspense>
    </> : <>
    <spotLight position={[-7,12,7]} target={target} color="#fff1de" intensity={1200} angle={.46} penumbra={.9} decay={2} distance={28} castShadow shadow-mapSize={[2048,2048]} shadow-radius={5} shadow-bias={-.0002} shadow-normalBias={.035} shadow-camera-near={.5} shadow-camera-far={28} />
    <spotLight position={[6,9,-5]} target={target} color="#dcecff" intensity={1450} angle={.44} penumbra={1} decay={2} distance={24} />
    <spotLight position={[3,6,10]} target={target} color="#ffffff" intensity={160} angle={.42} penumbra={1} decay={2} distance={20} />
    </>}
    <Sculpture passage={passage} hidden={meadow} />
    {passage && [-1.6,1.6].map(z=><group key={z}>
      <mesh position={[0,3.8,z]} castShadow receiveShadow>
        <cylinderGeometry args={[.35,.35,7.6,48]}/>
        <meshStandardMaterial color="#d4b980" metalness={.5} roughness={.28}/>
      </mesh>
      <RigidBody type="fixed" colliders={false}><CuboidCollider args={[.35,3.8,.35]} position={[0,3.8,z]}/></RigidBody>
    </group>)}
    <group visible={!(preview && hidePreviewControls)} position={[3.6,0,8]}>
      <mesh position={[0,.55,0]}><cylinderGeometry args={[.12,.23,1.1,24]}/><meshStandardMaterial color="#dddeda"/></mesh>
      <Interactable id="vat-animation-switch" interactionText={NEXT_MODE_TEXT[mode]} onInteract={switchAnimation}>
        <mesh position={[0,1.15,0]}><cylinderGeometry args={[.27,.29,.16,32]}/><meshStandardMaterial color={MODE_COLORS[mode]} roughness={.3}/></mesh>
      </Interactable>
      <SwitchLabel mode={mode}/>
    </group>
    <mesh rotation={[-Math.PI/2,0,0]} receiveShadow><planeGeometry args={[180,180]}/><meshStandardMaterial color={meadow?'#1c5a26':'#f4f3f0'} emissive={meadow?'#1c5a26':'#f4f3f0'} emissiveIntensity={meadow?.2:.55} roughness={.91}/></mesh>
    <RigidBody type="fixed" colliders={false}><CuboidCollider args={[90,.15,90]} position={[0,-.15,0]}/></RigidBody>
    {!preview && <SpawnPoint position={[0,0,13]}/>}
  </>
}
