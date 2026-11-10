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



// アバターの立ち位置から10秒かけてじわっと広がる波紋。
// 広がるほど万華鏡折りノイズと角度の揺らぎで輪郭が崩れ、複雑な波形になる。
// 床とドームで共用（ドームでは頭上に写る分）。
const GLSL_RIPPLE = /* glsl */ `
  uniform vec3 uAvatars[8]; // xy: アバターのXZ, z: 強さ
  vec3 rippleGlow(vec2 p){
    vec3 acc = vec3(0.0);
    for(int i = 0; i < 8; i++){
      vec3 av = uAvatars[i];
      if(av.z < 0.02) continue;
      float age = mod(uTime + float(i) * 0.37, 10.0);
      vec2 rel = p - av.xy;
      float d = length(rel);
      vec2 wkp = kaleido(rel, uSegments);
      vec2 wob = vec2(cos(uTime * 0.0628), sin(uTime * 0.0524)) * 0.35;
      float warp = fbm3(wkp * 0.35 + wob) - 0.5;
      float rr = d + warp * 2.6 * smoothstep(0.0, 2.5, age);
      rr += sin(atan(rel.y, rel.x) * 3.0 + uTime * 0.3142 + float(i) * 1.7) * 0.3 * smoothstep(0.0, 3.0, age);
      float ring = exp(-pow((rr - age * 2.4) * 1.4, 2.0));
      float seg = 0.75 + 0.25 * sin(atan(rel.y, rel.x) * uSegments * 2.0);
      float fade = smoothstep(0.0, 1.2, age) * pow(1.0 - age / 10.0, 1.6);
      acc += (uGlowA * 0.8 + uGlowB * 0.45) * ring * seg * fade * av.z;
    }
    return acc;
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
  varying vec3 vWorld;
  ${GLSL_NOISE}
  ${GLSL_RIPPLE}
  void main(){
    vec2 p = vWorld.xz;
    float r = length(p);
    float mask = smoothstep(27.1, 26.0, r);

    // 万華鏡対称に折った流れ模様。波高が模様を歪ませ、干渉縞を作る。
    vec2 kp = kaleido(p, uSegments);
    vec2 flow = 1.2 * vec2(cos(uTime * 0.0524), sin(uTime * 0.0419));
    float v = fbm(kp * 0.32 + flow + fbm3(kp * 0.12 - flow) * 0.9);
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
    col += rippleGlow(p) * mask;
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
  ${GLSL_RIPPLE}
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
    // プレイヤーから広がる波紋を、方位を万華鏡折りして天井に映す。
    // 全セクターに鏡映しされた波紋が頭上で同期して広がり、複雑なパタンになる。
    float rSector = 6.2831853 / uSegments;
    float raz = atan(dir.x, dir.z);
    float rfa = abs(mod(raz, rSector) - rSector * 0.5);
    vec2 rdp = vec2(sin(rfa), cos(rfa)) * length(dir.xz) * 24.0;
    col += rippleGlow(rdp) * 0.9 * smoothstep(-0.05, 0.25, dir.y);
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
  // 渦の軌道＋流れ場ドリフトによる中心位置（速度を差分で取るため関数化）
  vec3 shardCenter(float t, out float ang){
    float phase = aSeed.w * 6.2831853;
    ang = phase + t * (6.2831853 * aSeed.y / 600.0)
      + sin(t * 0.1152 + phase * 3.0) * 0.55;
    float radius = aSeed.x + sin(t * 0.0733 + phase * 5.0) * 1.6;
    vec2 orbit = vec2(cos(ang), sin(ang)) * radius;
    vec2 fq = orbit * 0.055 + aSeed.w * 37.0;
    vec2 drift = vec2(
      vnoise(fq + vec2(t * 0.0524, 0.0)) - 0.5,
      vnoise(fq + vec2(0.0, -t * 0.0419) + 31.7) - 0.5) * 5.2;
    vec2 xz = orbit + drift;
    float y = aSeed.z
      + sin(t * 0.2513 + aSeed.w * 43.0) * 0.7
      + (vnoise(xz * 0.08 + t * 0.0314) - 0.5) * 2.4;
    return vec3(xz.x, y, xz.y);
  }
  void main(){
    vUv = uv;
    float ang;
    vec3 center = shardCenter(uTime, ang);
    float ang2;
    vec3 ahead = shardCenter(uTime + 0.35, ang2);
    vec3 vel = ahead - center;
    float vl = length(vel);
    // 進行方向を向くフレームを作る
    vec3 fwd = vl > 0.001 ? vel / vl : vec3(-sin(ang), 0.0, cos(ang));
    vec3 up0 = abs(fwd.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 right = normalize(cross(up0, fwd));
    vec3 up = cross(fwd, right);

    // そのフレームの中で、破片ごとに違うローカル軸・速さ・向きで回る。
    // 速さはTIME_WRAPで整数周回になるよう量子化（ループの継ぎ目対策）。
    // 正弦波で全員が揃って羽ばたく「わざとらしさ」を消すのが狙い。
    float h1 = fract(aSeed.w * 13.73);
    float h2 = fract(aSeed.w * 29.31);
    float h3 = fract(aSeed.w * 47.17);
    float spin1 = (40.0 + floor(h1 * 110.0)) * (h3 > 0.5 ? 1.0 : -1.0);
    float spin2 = (40.0 + floor(h2 * 110.0)) * (h3 > 0.75 || h3 < 0.25 ? 1.0 : -1.0);
    float a1 = aSeed.w * 43.0 + uTime * (6.2831853 * spin1 / 600.0);
    float a2 = aSeed.w * 91.0 + uTime * (6.2831853 * spin2 / 600.0);
    mat3 local = rotY(a1) * rotX(a2);
    local = local * rotX(aSeed.w * 40.0) * rotY(aSeed.w * 71.0);

    vec3 p = position * (0.75 + fract(aSeed.w * 7.31) * 0.9);
    vec3 lp = local * p;
    vec3 world = center + right * lp.x + up * lp.y + fwd * lp.z;
    vec3 ln = local * vec3(0.0, 0.0, 1.0);
    vec3 wn = right * ln.x + up * ln.y + fwd * ln.z;
    // 陰影は法線と光の向きから（回転に連動して自然にきらめく）
    vShade = 0.7 + 0.55 * abs(dot(wn, normalize(vec3(0.4, 0.8, 0.3))));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
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
      uAvatars: { value: Array.from({ length: 8 }, () => new Vector3(0, 0, 0)) },
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
          uAvatars: shared.uAvatars,
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
                  uAvatars: shared.uAvatars,
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
    const plane = new PlaneGeometry(0.0325, 0.0525)
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
  })

  useFrame(() => {
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

    // アバター位置の収集。slot0は自分（getLocalMovement）、slot1以降はリモート
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
    // 自分はカメラではなくアバター本体の位置（getLocalMovement = PlayerMovement.position）
    const localMovement = users.getLocalMovement()
    setAvatar(0, localMovement.position.x, localMovement.position.z)
    for (let i = 0; i < 7; i++) {
      const remote = users.remoteUsers[i]
      const movement = remote ? users.getMovement(remote.id) : undefined
      if (movement) {
        setAvatar(i + 1, movement.position.x, movement.position.z)
      } else {
        avatars[i + 1].s += (0 - avatars[i + 1].s) * 0.06
      }
    }

    // 波紋の発生源として共有uniformへ書き込む
    const slots = shared.uAvatars.value
    avatars.forEach((av, i) => slots[i].set(av.x, av.z, av.s))

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
