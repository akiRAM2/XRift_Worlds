import { Suspense, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Physics } from '@react-three/rapier'
import { DevEnvironment, XRiftProvider } from '@xrift/world-components'
import { ACESFilmicToneMapping } from 'three'
import { World } from './World'
import './style.css'

function App() {
  const params = new URLSearchParams(location.search)
  const capture = params.has('capture')
  const [walk, setWalk] = useState(params.has('walk'))
  return (
    <XRiftProvider baseUrl="/">
      {walk ? (
        <DevEnvironment
          moveSpeed={3}
          spawnPosition={[0, 1.6, 15]}
          physicsConfig={{ gravity: 9.81, allowInfiniteJump: false }}
          camera={{ near: 0.05, far: 160, fov: 55 }}
        >
          <World />
        </DevEnvironment>
      ) : (
        <Canvas
          camera={{ position: [11, 7.5, 17], fov: 42, near: 0.05, far: 160 }}
          gl={{ antialias: true, toneMapping: ACESFilmicToneMapping, preserveDrawingBuffer: true }}
          dpr={[1, 1.5]}
        >
          <Suspense fallback={null}>
            <Physics paused>
              <World />
            </Physics>
          </Suspense>
          <OrbitControls target={[0, 1.2, 0]} minDistance={4} maxDistance={40} maxPolarAngle={Math.PI / 2 - 0.025} />
        </Canvas>
      )}
      {!capture && (
        <>
          <header>
            <span>XRIFT WORLD</span>
            <h1>KALEID DOME</h1>
            <p>万華鏡ドーム</p>
          </header>
          <button onClick={() => setWalk(!walk)}>{walk ? '全景へ戻る ↗' : '空間を歩く →'}</button>
          <footer>
            <span>{walk ? 'WASD / マウス · Escで解除' : 'ドラッグで視点を回転 · スクロールでズーム'}</span>
            <span>SHARDS 3500 · GPU INSTANCING · THEMES 120 SEC</span>
          </footer>
        </>
      )}
    </XRiftProvider>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
