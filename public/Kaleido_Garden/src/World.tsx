import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import { SpawnPoint, useServerClock, useUsers } from '@xrift/world-components'
import {
  BackSide,
  Color,
  DoubleSide,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicMaterial,
  HalfFloatType,
  LinearFilter,
  OrthographicCamera,
  RGBAFormat,
  Scene,
  Vector4,
  WebGLRenderTarget,
  MeshStandardMaterial,
  AdditiveBlending,
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
const THEME_SECONDS = 120
// シェーダーへ渡す時刻はこの周期で折り返す（float精度対策。VAT_TestのMEADOWと同じ方針）
const TIME_WRAP = 600
// 波シムの解像度と、シム空間（55m四方＝庭の直径）に対するテクセル
const WAVE_SIZE = 256
const THEME_FADE = 24

interface Palette {
  base: string
  glowA: string
  glowB: string
  petalA: string
  petalB: string
}

// サイバーなカラーテーマ4種。2分ごとに次のテーマへ24秒かけて移る。
const PALETTES: Palette[] = [
  // NEON CYAN × MAGENTA
  { base: '#04060e', glowA: '#00e5ff', glowB: '#ff2ea6', petalA: '#d9fbff', petalB: '#00c8ff' },
  // VIOLET PULSE
  { base: '#07040f', glowA: '#a855f7', glowB: '#ff4d8d', petalA: '#f3e8ff', petalB: '#c084fc' },
  // ACID MINT
  { base: '#030a08', glowA: '#34ffb0', glowB: '#00b3ff', petalA: '#e2fff4', petalB: '#4dffc3' },
  // AMBER ALERT
  { base: '#0d0503', glowA: '#ffb020', glowB: '#ff3b30', petalA: '#fff3d6', petalB: '#ff8a3c' },
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


const WAVE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main(){
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// 簡単な流体シミュレーション: 波動方程式をピンポンで解く。
// r = 現在の波高, g = 1ステップ前の波高。波同士が干渉し、縁では静まる。
const WAVE_FRAG = /* glsl */ `
  uniform sampler2D uPrev;
  uniform float uTexel;
  uniform vec4 uImpulses[14];
  varying vec2 vUv;
  void main(){
    float h = texture2D(uPrev, vUv).r;
    float hp = texture2D(uPrev, vUv).g;
    float avg = (
      texture2D(uPrev, vUv + vec2(uTexel, 0.0)).r +
      texture2D(uPrev, vUv - vec2(uTexel, 0.0)).r +
      texture2D(uPrev, vUv + vec2(0.0, uTexel)).r +
      texture2D(uPrev, vUv - vec2(0.0, uTexel)).r) * 0.25;
    float nh = (avg * 2.0 - hp) * 0.995;
    for(int i = 0; i < 14; i++){
      vec4 imp = uImpulses[i];
      if(imp.w == 0.0) continue;
      float d = distance(vUv, imp.xy);
      nh += imp.w * exp(-(d * d) / (imp.z * imp.z));
    }
    float outside = smoothstep(0.485, 0.5, distance(vUv, vec2(0.5)));
    nh = mix(nh, 0.0, outside);
    gl_FragColor = vec4(nh, h, 0.0, 1.0);
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
  uniform sampler2D uWaveTex;
  uniform float uWaveTexel;
  varying vec3 vWorld;
  ${GLSL_NOISE}
  void main(){
    vec2 p = vWorld.xz;
    float r = length(p);
    float mask = smoothstep(27.1, 26.0, r);

    // 流体シムの波高と勾配
    vec2 wuv = p / 55.0 + 0.5;
    float h = texture2D(uWaveTex, wuv).r;
    float hx = texture2D(uWaveTex, wuv + vec2(uWaveTexel, 0.0)).r;
    float hz = texture2D(uWaveTex, wuv + vec2(0.0, uWaveTexel)).r;

    // 万華鏡対称に折った流れ模様。波高が模様を歪ませ、干渉縞を作る。
    vec2 kp = kaleido(p, uSegments);
    vec2 flow = 1.2 * vec2(cos(uTime * 0.0524), sin(uTime * 0.0419));
    float v = fbm(kp * 0.32 + flow + fbm3(kp * 0.12 - flow) * 0.9);
    v += h * 0.85;
    float contour = 1.0 - smoothstep(0.0, 0.07, abs(fract(v * 2.6 + uTime * 0.015) - 0.5));
    contour = pow(contour, 3.0);

    // ホログラム格子（同心円と放射）とスキャンラインのきらめき
    float gridR = pow(1.0 - smoothstep(0.0, 0.05, abs(fract(r * 0.8) - 0.5)), 2.0);
    float spoke = atan(p.y, p.x) / 6.2831853 * uSegments * 6.0;
    float gridA = pow(1.0 - smoothstep(0.0, 0.05, abs(fract(spoke) - 0.5)), 2.0);

    // 熊手で引いた砂紋
    float rake = sin(r * 7.0 - fbm3(p * 0.22) * 5.0) * 0.5 + 0.5;

    // ゆっくり移動しながら花開いては消える光の中心
    vec2 bloomPos = 13.0 * vec2(cos(uTime * 0.0419), sin(uTime * 0.0314));
    float bloom = exp(-dot(p - bloomPos, p - bloomPos) / 10.0) * (0.5 + 0.5 * sin(uTime * 0.4503));

    vec3 col = uBase * (0.9 + rake * 0.06);
    col += uGlowB * (gridR + gridA) * 0.10 * mask;
    col += uGlowA * contour * (0.6 + 0.9 * smoothstep(0.2, 0.9, v)) * mask;
    col *= 1.0 + 0.05 * sin(r * 40.0 - uTime * 2.1991);
    // 波の山は明るく、谷は淡く、斜面の縁が光る
    col += uGlowB * max(h, 0.0) * 1.4 * mask;
    col += uGlowA * max(-h, 0.0) * 0.45 * mask;
    col += uGlowA * length(vec2(hx - h, hz - h)) * 2.2 * mask;
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
    float lat = pow(1.0 - smoothstep(0.0, 0.03, abs(fract(dir.y * 6.0) - 0.5)), 2.0);
    float lon = pow(1.0 - smoothstep(0.0, 0.03, abs(fract(a / sector * 6.0) - 0.5)), 2.0);
    vec3 col = uBase * 0.85;
    col += uGlowB * (lat + lon) * 0.07 * smoothstep(-0.1, 0.3, dir.y);
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
  ${GLSL_NOISE}
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
    float phase = aSeed.w * 6.2831853;
    // 全体の渦に、角度と半径のゆらぎを重ねて密度の波を作る
    float ang = phase + uTime * (6.2831853 * aSeed.y / 600.0)
      + sin(uTime * 0.1152 + phase * 3.0) * 0.55;
    float radius = aSeed.x + sin(uTime * 0.0733 + phase * 5.0) * 1.6;
    vec2 orbit = vec2(cos(ang), sin(ang)) * radius;
    // 大きな流れ場で漂う（渦に乗りながら寄せては離れる）
    vec2 fq = orbit * 0.055 + aSeed.w * 37.0;
    vec2 drift = vec2(
      vnoise(fq + vec2(uTime * 0.0524, 0.0)) - 0.5,
      vnoise(fq + vec2(0.0, -uTime * 0.0419) + 31.7) - 0.5) * 5.2;
    vec2 xz = orbit + drift;
    float y = aSeed.z
      + sin(uTime * 0.2513 + aSeed.w * 43.0) * 0.7
      + (vnoise(xz * 0.08 + uTime * 0.0314) - 0.5) * 2.4;
    vec3 center = vec3(xz.x, y, xz.y);
    float fl = uTime * 0.9006 + aSeed.w * 81.0 + vnoise(xz * 0.2 - uTime * 0.0524) * 3.0;
    vec3 p = position * (0.75 + fract(aSeed.w * 7.31) * 0.9);
    p = rotX(sin(fl) * 0.9) * p;
    p = rotZ(cos(fl * 0.83) * 0.7) * p;
    p = rotY(-ang + sin(fl * 0.5) * 0.6) * p;
    vShade = 0.9 + 0.5 * sin(fl * 1.7);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(center + p, 1.0);
  }
`

const PETAL_FRAG = /* glsl */ `
  uniform vec3 uPetalA;
  uniform vec3 uPetalB;
  varying vec2 vUv;
  varying float vShade;
  void main(){
    vec2 q = vUv - 0.5;
    float d = abs(q.x) * 2.4 + abs(q.y) * 1.05;
    float alpha = smoothstep(1.0, 0.5, d) * 0.95;
    if(alpha < 0.01) discard;
    vec3 col = mix(uPetalB, uPetalA, vUv.y) * vShade * 1.5;
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
  const users = useUsers()

  const shared = useMemo(
    () => ({
      uTime: { value: 0 },
      uSegments: { value: 9 },
      uBase: { value: new Color(PALETTES[0].base) },
      uGlowA: { value: new Color(PALETTES[0].glowA) },
      uGlowB: { value: new Color(PALETTES[0].glowB) },
      uPetalA: { value: new Color(PALETTES[0].petalA) },
      uPetalB: { value: new Color(PALETTES[0].petalB) },
    }),
    [],
  )

  // 波動方程式シム（ピンポン2枚のRenderTargetを60Hzで回す）
  const sim = useMemo(() => {
    const makeTarget = () =>
      new WebGLRenderTarget(WAVE_SIZE, WAVE_SIZE, {
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        format: RGBAFormat,
        type: HalfFloatType,
        depthBuffer: false,
        stencilBuffer: false,
      })
    const mat = new ShaderMaterial({
      vertexShader: WAVE_VERT,
      fragmentShader: WAVE_FRAG,
      uniforms: {
        uPrev: { value: null },
        uTexel: { value: 1 / WAVE_SIZE },
        uImpulses: { value: Array.from({ length: 14 }, () => new Vector4(0, 0, 0.01, 0)) },
      },
      depthTest: false,
      depthWrite: false,
    })
    const scene = new Scene()
    const quad = new Mesh(new PlaneGeometry(2, 2), mat)
    quad.frustumCulled = false
    scene.add(quad)
    return {
      read: makeTarget(),
      write: makeTarget(),
      mat,
      scene,
      cam: new OrthographicCamera(-1, 1, 1, -1, 0, 1),
    }
  }, [])

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
          uWaveTex: { value: null },
          uWaveTexel: { value: 1 / WAVE_SIZE },
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

  const rockMat = useMemo(
    () =>
      new MeshStandardMaterial({
        color: '#151824',
        roughness: 0.9,
        flatShading: true,
        emissive: '#000000',
      }),
    [],
  )
  const rimMat = useMemo(() => new MeshBasicMaterial({ color: PALETTES[0].glowA }), [])

  const petalMesh = useMemo(() => {
    const plane = new PlaneGeometry(0.065, 0.105)
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
      blending: AdditiveBlending,
    })
    const mesh = new Mesh(geo, mat)
    mesh.frustumCulled = false
    return mesh
  }, [shared])

  const rockGeos = useMemo(() => ROCKS.map((rock, i) => jitteredRock(rock.r, i + 1)), [])
  const scratch = useRef({
    a: new Color(),
    b: new Color(),
    avatars: Array.from({ length: 8 }, () => ({ x: 0, z: 0, s: 0 })),
    acc: 0,
    simTime: 0,
    lastPulse: -1,
    lastDrip: ROCKS.map(() => -1),
    stepPos: Array.from({ length: 8 }, () => ({ x: 0, z: 0, ok: false })),
  })

  useFrame((state) => {
    const t = now() / 1000
    shared.uTime.value = t % TIME_WRAP
    shared.uSegments.value = 9 + Math.sin(t * 0.017) * 2.5

    // テーマパレットの補間
    const cycle = t % (THEME_SECONDS * PALETTES.length)
    const idx = Math.floor(cycle / THEME_SECONDS)
    const local = cycle - idx * THEME_SECONDS
    const fadeStart = THEME_SECONDS - THEME_FADE
    const f = local > fadeStart ? (local - fadeStart) / THEME_FADE : 0
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

    // アバター位置の収集。slot0は自分（カメラ≒アバター位置）、slot1以降はリモート
    // （useUsersのgetMovement、毎フレーム呼んでも再描画しない）。庭の外では強さがフェード。
    const sc = scratch.current
    const avatars = sc.avatars
    const setAvatar = (i: number, x: number, z: number) => {
      const inside = Math.hypot(x, z) < GARDEN_RADIUS ? 1 : 0
      const av = avatars[i]
      av.s += (inside - av.s) * 0.06
      av.x = x
      av.z = z
    }
    setAvatar(0, state.camera.position.x, state.camera.position.z)
    for (let i = 0; i < 7; i++) {
      const remote = users.remoteUsers[i]
      const movement = remote ? users.getMovement(remote.id) : undefined
      if (movement) {
        setAvatar(i + 1, movement.position.x, movement.position.z)
      } else {
        avatars[i + 1].s += (0 - avatars[i + 1].s) * 0.06
      }
    }

    // 流体シムを60Hz固定ステップで進める（波同士が干渉する）
    sc.acc += Math.min(state.clock.getDelta(), 0.1)
    let steps = 0
    while (sc.acc >= 1 / 60 && steps < 3) {
      sc.acc -= 1 / 60
      sc.simTime += 1 / 60
      steps++
      const impulses = sim.mat.uniforms.uImpulses.value as Vector4[]
      for (const imp of impulses) imp.w = 0
      let n = 0
      const push = (x: number, z: number, radius: number, strength: number) => {
        if (n >= impulses.length) return
        impulses[n].set(x / 55 + 0.5, z / 55 + 0.5, radius, strength)
        n++
      }
      // 2.5秒ごとのパルス（全アバター同時。サーバ時計基準なので全員に同期）
      const pulseSlot = Math.floor(t / 2.5)
      if (pulseSlot !== sc.lastPulse) {
        sc.lastPulse = pulseSlot
        for (const av of avatars) {
          if (av.s > 0.3) push(av.x, av.z, 0.02, 0.5)
        }
      }
      // 石からの滴り（4秒ごと、石ごとに位相をずらす）
      ROCKS.forEach((rock, i) => {
        const slot = Math.floor((t + i * 1.37) / 4)
        if (slot !== sc.lastDrip[i]) {
          sc.lastDrip[i] = slot
          push(rock.pos[0], rock.pos[1], 0.014, 0.3)
        }
      })
      // 足跡: 0.9m動くごとに小さな波紋
      avatars.forEach((av, i) => {
        if (av.s <= 0.3) return
        const last = sc.stepPos[i]
        if (!last.ok || Math.hypot(av.x - last.x, av.z - last.z) > 0.9) {
          push(av.x, av.z, 0.01, 0.22)
          last.x = av.x
          last.z = av.z
          last.ok = true
        }
      })
      sim.mat.uniforms.uPrev.value = sim.read.texture
      const gl = state.gl
      gl.setRenderTarget(sim.write)
      gl.render(sim.scene, sim.cam)
      gl.setRenderTarget(null)
      const tmp = sim.read
      sim.read = sim.write
      sim.write = tmp
    }
    floorMat.uniforms.uWaveTex.value = sim.read.texture

    // 縁のネオンリングと石の縁発光をテーマ色に同期
    const pulse = 0.5 + 0.5 * Math.sin(t * 0.4503)
    rimMat.color.copy(shared.uGlowA.value).multiplyScalar(0.8 + 0.35 * pulse)
    rockMat.emissive.copy(shared.uGlowB.value).multiplyScalar(0.06 + 0.05 * pulse)
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
      <mesh material={rimMat} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <torusGeometry args={[GARDEN_RADIUS + 0.4, 0.28, 10, 108]} />
      </mesh>

      {/* 石 */}
      {ROCKS.map((rock, i) => (
        <mesh
          key={i}
          material={rockMat}
          geometry={rockGeos[i]}
          position={[rock.pos[0], rock.h * 0.30, rock.pos[1]]}
          rotation={[0, rock.rot, 0]}
          scale={[1, rock.h / rock.r, 1]}
        />
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
