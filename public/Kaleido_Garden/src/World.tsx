import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import { SpawnPoint, useServerClock } from '@xrift/world-components'
import {
  BackSide,
  Color,
  DoubleSide,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three'

export type WorldProps = Record<string, never>

/*
 * 枯山水万華鏡 — Karesansui Kaleidoscope
 *
 * 構成はスマホでも軽いことを優先している:
 * - 庭の床: シェーダー1枚。万華鏡対称に折ったFBMの等高線が花のように開いて消える。
 *   石と訪問者の足元からは波紋が広がる。
 * - 空のドーム: シェーダー1枚。床と同じ模様関数とパレットを共有し、空にも模様が映る。
 * - 花びらの渦: GPUインスタンシング1ドローコール。全個体の軌道計算は頂点シェーダー内で
 *   完結し、CPUは時刻uniformを渡すだけ。
 * - 石と縁石: 固定コライダー付きの低ポリゴン。
 * ポストプロセス、テクスチャ、影は使わない。時刻は useServerClock 由来で全員同期する。
 */

const PETAL_COUNT = 3500
const GARDEN_RADIUS = 26
const SEASON_SECONDS = 120
// シェーダーへ渡す時刻はこの周期で折り返す（float精度対策。VAT_TestのMEADOWと同じ方針）
const TIME_WRAP = 600
const SEASON_FADE = 24

interface Palette {
  base: string
  glowA: string
  glowB: string
  petalA: string
  petalB: string
}

// 春・夏・秋・冬。2分ごとに次の季節へ24秒かけて移る。
const PALETTES: Palette[] = [
  { base: '#171021', glowA: '#ff9ecb', glowB: '#ffd98a', petalA: '#ffe3ef', petalB: '#ff9ec4' },
  { base: '#0a1620', glowA: '#4fe3d2', glowB: '#9be7ff', petalA: '#eafffb', petalB: '#8fe8ff' },
  { base: '#170f08', glowA: '#ff9a3c', glowB: '#ff5d47', petalA: '#ffd9a0', petalB: '#ff7a4d' },
  { base: '#0a0d14', glowA: '#aecbf5', glowB: '#e8f1ff', petalA: '#ffffff', petalB: '#cfe0ff' },
]

const ROCKS = [
  { pos: [3.4, -1.6], r: 0.85, h: 1.05, rot: 0.7 },
  { pos: [-4.6, 2.2], r: 1.25, h: 1.55, rot: 2.1 },
  { pos: [1.6, 5.6], r: 0.6, h: 0.75, rot: 4.0 },
  { pos: [-2.2, -5.2], r: 0.95, h: 1.25, rot: 1.2 },
  { pos: [6.6, 3.6], r: 0.55, h: 0.65, rot: 5.3 },
] as const

const GLSL_NOISE = /* glsl */ `
  float hash21(vec2 p){
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float vnoise(vec2 p){
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
      u.y);
  }
  float fbm(vec2 p){
    float s = 0.0;
    float a = 0.5;
    for(int i = 0; i < 4; i++){
      s += a * vnoise(p);
      p = p * 2.03 + vec2(17.3, 9.1);
      a *= 0.5;
    }
    return s;
  }
  float fbm3(vec2 p){
    float s = 0.0;
    float a = 0.5;
    for(int i = 0; i < 3; i++){
      s += a * vnoise(p);
      p = p * 2.03 + vec2(17.3, 9.1);
      a *= 0.5;
    }
    return s;
  }
  vec2 kaleido(vec2 p, float segments){
    float r = length(p);
    float a = atan(p.y, p.x);
    float sector = 6.2831853 / segments;
    a = mod(a, sector);
    a = abs(a - sector * 0.5);
    return vec2(cos(a), sin(a)) * r;
  }
`

const FLOOR_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main(){
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const FLOOR_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uSegments;
  uniform vec3 uBase;
  uniform vec3 uGlowA;
  uniform vec3 uGlowB;
  uniform vec3 uPetalA;
  uniform vec3 uVisitor; // xy = 訪問者のXZ, z = 波紋の強さ
  varying vec3 vWorld;
  ${GLSL_NOISE}
  float ripple(vec2 p, vec2 src, float phase){
    float d = length(p - src);
    float gate = 0.5 + 0.5 * sin(uTime * 0.20944 + phase);
    return (sin(d * 4.5 - uTime * 1.4977 + phase) * 0.5 + 0.5) * exp(-d * 0.40) * gate;
  }
  void main(){
    vec2 p = vWorld.xz;
    float r = length(p);
    float mask = smoothstep(${(GARDEN_RADIUS + 0.6).toFixed(1)}, ${GARDEN_RADIUS.toFixed(1)}, r);

    // 万華鏡対称に折った流れ模様。その等高線が花の開花のように広がる。
    vec2 kp = kaleido(p, uSegments);
    vec2 flow = 1.2 * vec2(cos(uTime * 0.0524), sin(uTime * 0.0419));
    float v = fbm(kp * 0.32 + flow + fbm3(kp * 0.12 - flow) * 0.9);
    float contour = 1.0 - smoothstep(0.0, 0.16, abs(fract(v * 2.6 + uTime * 0.015) - 0.5));
    contour = pow(contour, 2.0);

    // 熊手で引いた砂紋
    float rake = sin(r * 7.0 - fbm3(p * 0.22) * 5.0) * 0.5 + 0.5;

    // 石からの波紋
    float rip = 0.0;
    rip += ripple(p, vec2(3.4, -1.6), 0.0);
    rip += ripple(p, vec2(-4.6, 2.2), 1.7);
    rip += ripple(p, vec2(1.6, 5.6), 3.1);
    rip += ripple(p, vec2(-2.2, -5.2), 4.4);
    rip += ripple(p, vec2(6.6, 3.6), 5.6);
    // 訪問者の足元の波紋
    float vd = length(p - uVisitor.xy);
    rip += (sin(vd * 5.0 - uTime * 2.1991) * 0.5 + 0.5) * exp(-vd * 0.55) * uVisitor.z * 0.9;

    // ゆっくり移動しながら花開いては消える光の中心
    vec2 bloomPos = 13.0 * vec2(cos(uTime * 0.0419), sin(uTime * 0.0314));
    float bloom = exp(-dot(p - bloomPos, p - bloomPos) / 10.0) * (0.5 + 0.5 * sin(uTime * 0.4503));

    vec3 col = uBase * (0.82 + rake * 0.10);
    col += uGlowA * contour * (0.35 + 0.65 * smoothstep(0.2, 0.9, v)) * mask;
    col += uGlowB * rip * 0.75 * mask;
    col += uPetalA * bloom * 0.35 * mask;
    col *= 0.75 + 0.25 * smoothstep(27.0, 6.0, r);
    col *= 1.5;
    gl_FragColor = vec4(col, 1.0);
  }
`

const DOME_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uSegments;
  uniform vec3 uBase;
  uniform vec3 uGlowA;
  uniform vec3 uGlowB;
  varying vec3 vWorld;
  ${GLSL_NOISE}
  void main(){
    vec3 dir = normalize(vWorld);
    float a = atan(dir.x, dir.z);
    float sector = 6.2831853 / uSegments;
    a = mod(a, sector);
    a = abs(a - sector * 0.5);
    vec2 sp = vec2(a * 4.0, dir.y * 2.2);
    float v = fbm(sp * 1.4 + 0.6 * vec2(cos(uTime * 0.0314), sin(uTime * 0.0524)) + fbm3(sp * 0.8) * 0.7);
    float contour = pow(1.0 - smoothstep(0.0, 0.18, abs(fract(v * 2.2) - 0.5)), 2.0);
    vec3 col = uBase * 0.85;
    col += uGlowA * contour * 1.15 * smoothstep(-0.15, 0.45, dir.y);
    col += uGlowB * pow(max(dir.y, 0.0), 3.0) * 0.12;
    float sparkle = pow(max(0.0, fbm(dir.xy * 30.0 + dir.zx * 17.0)), 18.0);
    col += vec3(0.9, 0.95, 1.0) * sparkle * 0.6 * smoothstep(0.05, 0.5, dir.y);
    col *= smoothstep(-0.35, 0.02, dir.y) * 0.85 + 0.15;
    gl_FragColor = vec4(col, 1.0);
  }
`

const PETAL_VERT = /* glsl */ `
  attribute vec4 aSeed; // x: 軌道半径, y: TIME_WRAPあたりの周回数, z: 基準高さ, w: 位相[0,1)
  uniform float uTime;
  varying vec2 vUv;
  varying float vShade;
  mat3 rotX(float a){
    float c = cos(a), s = sin(a);
    return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
  }
  mat3 rotY(float a){
    float c = cos(a), s = sin(a);
    return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
  }
  mat3 rotZ(float a){
    float c = cos(a), s = sin(a);
    return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
  }
  void main(){
    vUv = uv;
    float radius = aSeed.x;
    float ang = aSeed.w * 6.2831853 + uTime * (6.2831853 * aSeed.y / 600.0);
    float y = aSeed.z
      + sin(uTime * 0.2513 + aSeed.w * 43.0) * 0.7
      + sin(uTime * 0.0524 + aSeed.w * 6.2831853) * 0.5;
    vec3 center = vec3(cos(ang) * radius, y, sin(ang) * radius);
    float fl = uTime * 0.9006 + aSeed.w * 81.0;
    vec3 p = position;
    p = rotX(sin(fl) * 0.9) * p;
    p = rotZ(cos(fl * 0.83) * 0.7) * p;
    p = rotY(-ang + sin(fl * 0.5) * 0.6) * p;
    vShade = 0.9 + 0.5 * sin(fl * 1.7);
    vec4 wp = vec4(center + p, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * wp;
  }
`

const PETAL_FRAG = /* glsl */ `
  uniform vec3 uPetalA;
  uniform vec3 uPetalB;
  varying vec2 vUv;
  varying float vShade;
  void main(){
    vec2 q = vUv - vec2(0.5, 0.42);
    q.x *= 1.3;
    float d = length(q) + (vUv.y - 0.42) * 0.16;
    float alpha = smoothstep(0.55, 0.10, d) * 0.95;
    if(alpha < 0.01) discard;
    vec3 col = mix(uPetalB, uPetalA, vUv.y) * vShade;
    gl_FragColor = vec4(col, alpha);
  }
`

// 位置ハッシュで頂点をずらす。重複頂点も同じ変位になるため面が裂けない。
function jitteredRock(radius: number, seed: number) {
  const geo = new IcosahedronGeometry(radius, 1)
  const pos = geo.attributes.position
  const v = new Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const h =
      Math.sin(v.x * 127.1 + v.y * 311.7 + v.z * 74.7 + seed * 19.19) * 43758.5453
    const jitter = (h - Math.floor(h) - 0.5) * 0.30 * radius
    v.addScaledVector(v.clone().normalize(), jitter)
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  geo.computeVertexNormals()
  return geo
}

export function World() {
  const { now } = useServerClock()

  const shared = useMemo(
    () => ({
      uTime: { value: 0 },
      uSegments: { value: 9 },
      uBase: { value: new Color(PALETTES[0].base) },
      uGlowA: { value: new Color(PALETTES[0].glowA) },
      uGlowB: { value: new Color(PALETTES[0].glowB) },
      uPetalA: { value: new Color(PALETTES[0].petalA) },
      uPetalB: { value: new Color(PALETTES[0].petalB) },
      uVisitor: { value: new Vector3(0, 0, 0) },
    }),
    [],
  )

  const floorMat = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: FLOOR_VERT,
        fragmentShader: FLOOR_FRAG,
        uniforms: {
          uTime: shared.uTime,
          uSegments: shared.uSegments,
          uBase: shared.uBase,
          uGlowA: shared.uGlowA,
          uGlowB: shared.uGlowB,
          uPetalA: shared.uPetalA,
          uVisitor: shared.uVisitor,
        },
      }),
    [shared],
  )

  const domeMat = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: FLOOR_VERT,
        fragmentShader: DOME_FRAG,
        uniforms: {
          uTime: shared.uTime,
          uSegments: shared.uSegments,
          uBase: shared.uBase,
          uGlowA: shared.uGlowA,
          uGlowB: shared.uGlowB,
        },
        side: BackSide,
        depthWrite: false,
      }),
    [shared],
  )

  const petalMesh = useMemo(() => {
    const plane = new PlaneGeometry(0.13, 0.21)
    const geo = new InstancedBufferGeometry()
    geo.index = plane.index
    geo.setAttribute('position', plane.attributes.position)
    geo.setAttribute('uv', plane.attributes.uv)
    const seeds = new Float32Array(PETAL_COUNT * 4)
    // 決定的な疑似乱数にしておくと、再現チェックがしやすい。
    // インデックスのハッシュで生成し、項目間の相関で帯状に偏らないようにする。
    let seed = 0
    const rand = () => {
      seed += 1
      const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453
      return x - Math.floor(x)
    }
    for (let i = 0; i < PETAL_COUNT; i++) {
      const radius = 2.5 + Math.pow(rand(), 0.7) * 15.5
      const period = 110 + radius * 7 + rand() * 60 // 1周およそ130〜300秒のゆっくりした回遊
      const laps = Math.min(5, Math.max(2, Math.round(TIME_WRAP / period)))
      seeds[i * 4 + 0] = radius
      seeds[i * 4 + 1] = laps
      seeds[i * 4 + 2] = 0.4 + Math.pow(rand(), 1.3) * 7.4
      seeds[i * 4 + 3] = rand()
    }
    geo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4))
    geo.instanceCount = PETAL_COUNT
    const mat = new ShaderMaterial({
      vertexShader: PETAL_VERT,
      fragmentShader: PETAL_FRAG,
      uniforms: {
        uTime: shared.uTime,
        uPetalA: shared.uPetalA,
        uPetalB: shared.uPetalB,
      },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: NormalBlending,
    })
    const mesh = new Mesh(geo, mat)
    mesh.frustumCulled = false
    return mesh
  }, [shared])

  const rockGeos = useMemo(() => ROCKS.map((rock, i) => jitteredRock(rock.r, i + 1)), [])
  const scratch = useRef({ a: new Color(), b: new Color(), visitor: 0 })

  useFrame((state) => {
    const t = now() / 1000
    shared.uTime.value = t % TIME_WRAP
    shared.uSegments.value = 9 + Math.sin(t * 0.017) * 2.5

    // 季節パレットの補間
    const cycle = t % (SEASON_SECONDS * PALETTES.length)
    const idx = Math.floor(cycle / SEASON_SECONDS)
    const local = cycle - idx * SEASON_SECONDS
    const fadeStart = SEASON_SECONDS - SEASON_FADE
    const f = local > fadeStart ? (local - fadeStart) / SEASON_FADE : 0
    const smooth = f * f * (3 - 2 * f)
    const cur = PALETTES[idx]
    const nxt = PALETTES[(idx + 1) % PALETTES.length]
    const { a, b } = scratch.current
    const mixInto = (target: Color, from: string, to: string) => {
      a.set(from)
      b.set(to)
      target.copy(a).lerp(b, smooth)
    }
    mixInto(shared.uBase.value, cur.base, nxt.base)
    mixInto(shared.uGlowA.value, cur.glowA, nxt.glowA)
    mixInto(shared.uGlowB.value, cur.glowB, nxt.glowB)
    mixInto(shared.uPetalA.value, cur.petalA, nxt.petalA)
    mixInto(shared.uPetalB.value, cur.petalB, nxt.petalB)

    // 訪問者（カメラ）の足元の波紋。庭の外では弱まる。
    const cam = state.camera.position
    const dist = Math.hypot(cam.x, cam.z)
    const target = dist < GARDEN_RADIUS ? 1 : 0
    scratch.current.visitor += (target - scratch.current.visitor) * 0.06
    shared.uVisitor.value.set(cam.x, cam.z, scratch.current.visitor)
  })

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 10, 4]} intensity={1.1} />

      {/* 空のドーム（内側から見る） */}
      <mesh material={domeMat} renderOrder={-1}>
        <sphereGeometry args={[70, 48, 32]} />
      </mesh>

      {/* 庭の床（万華鏡シェーダー） */}
      <mesh material={floorMat} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[GARDEN_RADIUS + 1.5, 72]} />
      </mesh>

      {/* 庭の外側の地面 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, 0]}>
        <circleGeometry args={[80, 48]} />
        <meshStandardMaterial color="#06060a" roughness={1} />
      </mesh>

      {/* 縁石 */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <torusGeometry args={[GARDEN_RADIUS + 0.4, 0.28, 10, 108]} />
        <meshStandardMaterial color="#1d1d24" roughness={0.95} />
      </mesh>

      {/* 石 */}
      {ROCKS.map((rock, i) => (
        <mesh
          key={i}
          geometry={rockGeos[i]}
          position={[rock.pos[0], rock.h * 0.30, rock.pos[1]]}
          rotation={[0, rock.rot, 0]}
          scale={[1, rock.h / rock.r, 1]}
        >
          <meshStandardMaterial color="#363b47" roughness={0.95} flatShading />
        </mesh>
      ))}

      {/* 花びらの渦（GPUインスタンシング） */}
      <primitive object={petalMesh} />

      {/* 物理: 床と石 */}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[40, 0.15, 40]} position={[0, -0.15, 0]} />
        {ROCKS.map((rock, i) => (
          <CuboidCollider
            key={i}
            args={[rock.r * 0.8, rock.h * 0.5, rock.r * 0.8]}
            position={[rock.pos[0], rock.h * 0.4, rock.pos[1]]}
          />
        ))}
      </RigidBody>

      <SpawnPoint position={[0, 0, 15]} />
    </>
  )
}
