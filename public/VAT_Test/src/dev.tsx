import { Suspense, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Physics } from '@react-three/rapier'
import { DevEnvironment, XRiftProvider } from '@xrift/world-components'
import { ACESFilmicToneMapping, PCFShadowMap } from 'three'
import { World } from './World'
import './style.css'
function App(){
  const capture=new URLSearchParams(location.search).get('capture')
  const [walk,setWalk]=useState(false)
  const [mode,setMode]=useState(capture==='meadow'||new URLSearchParams(location.search).has('meadow')?2:0)
  const nextMode=()=>setMode((mode+1)%3)
  return <XRiftProvider baseUrl="/">
    {walk ? <DevEnvironment shadows moveSpeed={3} spawnPosition={[0,1.6,13]} physicsConfig={{gravity:9.81,allowInfiniteJump:false}} camera={{near:.05,far:150,fov:55}}><World/></DevEnvironment> :
      <Canvas shadows={{type:PCFShadowMap}} camera={{position:capture==='meadow'?[8,2.8,13]:capture?[7,5.6,13]:[9,6.4,16],fov:42,near:.05,far:150}} gl={{antialias:true,toneMapping:ACESFilmicToneMapping,preserveDrawingBuffer:true}} dpr={[1,1.5]}>
        <Suspense fallback={null}><Physics paused><World preview previewMode={mode} onPreviewSwitch={nextMode} hidePreviewControls={!!capture}/></Physics></Suspense>
        <OrbitControls target={capture==='meadow'?[0,1.3,0]:[0,3.2,0]} minDistance={8} maxDistance={35} maxPolarAngle={Math.PI/2-.025}/>
      </Canvas>}
    {!capture && <><header><h1>VAT TEST</h1></header>
    <button onClick={()=>setWalk(!walk)}>{walk?'全景へ戻る ↗':'空間を歩く →'}</button>
    {!walk && <button style={{top:110}} onClick={nextMode}>{['棒の間を通過','草原へ','浮遊に戻す'][mode]}</button>}
    <footer><span>{walk?'WASD / マウス · Escで解除':'ドラッグで視点を回転 · スクロールでズーム'}</span><span>Ø 5 M &nbsp; / &nbsp; 12 SEC LOOP</span></footer></>}
  </XRiftProvider>
}
createRoot(document.getElementById('root')!).render(<App/>);
