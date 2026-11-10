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
  // 確認用: ?cam=x,y,z&look=x,y,z で全景プレビューの視点を指定できる
  const cam = (params.get('cam') ?? '11,7.5,17').split(',').map(Number) as [number, number, number]
  const look = (params.get('look') ?? '0,1.2,0').split(',').map(Number) as [number, number, number]
  const [walk, setWalk] = useState(params.has('walk'))
  return (
    <XRiftProvider baseUrl="/">
      {walk ? (
        <DevEnvironment
          moveSpeed={3}
          spawnPosition={[0, 1.6, 15]}
          physicsConfig={{ gravity: 9.81, allowInfiniteJump: true }}
          camera={{ near: 0.05, far: 160, fov: 55 }}
        >
          <World />
        </DevEnvironment>
      ) : (
        <Canvas
          camera={{ position: cam, fov: params.has('cam') ? 70 : 42, near: 0.05, far: 160 }}
          gl={{ antialias: true, toneMapping: ACESFilmicToneMapping, preserveDrawingBuffer: true }}
          dpr={[1, 1.5]}
        >
          <Suspense fallback={null}>
            <Physics paused>
              <World />
            </Physics>
          </Suspense>
          <OrbitControls target={look} minDistance={0.1} maxDistance={40} maxPolarAngle={params.has('cam') ? Math.PI : Math.PI / 2 - 0.025} />
        </Canvas>
      )}
      {!capture && (
        <>
          <header>
            <span>XRIFT WORLD</span>
            <h1>KALEIDOME</h1>
            <p>万華鏡ドーム</p>
          </header>
          <button onClick={() => setWalk(!walk)}>{walk ? '全景へ戻る ↗' : '空間を歩く →'}</button>
          <footer>
            <span>{walk ? 'WASD / マウス · Escで解除' : 'ドラッグで視点を回転 · スクロールでズーム'}</span>
            <span>PETAL SCHOOLS · AURA WISPS · THEMES 120 SEC</span>
          </footer>
        </>
      )}
    </XRiftProvider>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
