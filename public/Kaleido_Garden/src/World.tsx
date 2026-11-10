import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import { SpawnPoint, useServerClock, useUsers, useXRift } from '@xrift/world-components'
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  FileLoader,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  Vector4,
} from 'three'

export type WorldProps = Record<string, never>

/*
 * KALEID DOME — 万華鏡ドーム
 *
 * - 床: 暗い水面のような床。プレイヤーは一定間隔で、その時点の立ち位置を中心に
 *   「揺らぎをもった細い線の波紋」を放つ（中心は発生位置に固定）。
 * - 天井ドーム: 天頂を中心にした放射状の万華鏡（曼荼羅）に床の波紋を映す。
 *   同心円の層ごとに逆向きに回り、波紋の線は虹色ににじむ。主役は波紋で、ほかは控えめ。
 * - オーラ: 波紋の線から、細い光の糸が不規則にふわふわと立ち上っては消える。
 * - 花びらの群れ: 魚群のように、群れごとに回る道筋を時間差で追い、群れの軸の周りを螺旋状に回る。
 *   花びらは進行方向を向いて1枚ずつひらひら揺れる。
 * ポストプロセス、テクスチャ、影は使わない。時刻は useServerClock 由来で全員同期。
 */

const DISC_RADIUS = 26
// ドームの半径。床の縁にぴったり乗せ、模様が床まで途切れずに続くようにする
const DOME_RADIUS = 28
const THEME_SECONDS = 120
const THEME_FADE = 30
// シェーダーへ渡す時刻はこの周期で折り返す（float精度対策）。周期運動はすべて
// W = 2π/600 または WS = 2π/2400 の整数倍の角速度にそろえ、折り返しで継ぎ目が出ないようにしてある。
const TIME_WRAP = 2400
// 波紋
// 波紋の時間の進み方（1より小さいとゆっくり）。広がり・揺らぎ・オーラの糸のタイミングがすべてこれに従う。
// RIPPLE_LIFE と RIPPLE_SPEED は「波紋の時間」での値なので、実際の寿命は RIPPLE_LIFE / RIPPLE_TIME_SCALE 秒
const RIPPLE_TIME_SCALE = 0.25
const RIPPLE_LIFE = 14
const RIPPLE_INTERVAL = 7
const RIPPLE_SPEED = 2.2
const RIPPLE_SLOTS = 48
const RIPPLE_SYMMETRY = [6, 8, 10, 12]
// 天井の万華鏡（2ミラー方式）: 見える像の数（鏡の角度 = 360° / この数）と、
// 覗き窓の円の半径（床と同じ縮尺、m。床の半径26が地平線に当たるので、それより大きくして床の縁まで続ける）
const KALEIDO_IMAGES = 12
const KALEIDO_RADIUS = 30
// オーラの糸: 波紋1つあたりの本数と、1本の縦の分割数
const WISPS_PER_RIPPLE = 84
const WISP_SEGMENTS = 16
// 花びらの群れ: 群れの数 × 1群れあたりの枚数、群れの長さ（先頭から最後尾までの時間差、秒）
const SCHOOLS = 6
const PER_SCHOOL = 420
const SCHOOL_SPAN = 26

interface Palette {
  base: string
  glowA: string
  glowB: string
  petalA: string
  petalB: string
}

// 幻想寄りのテーマ4種。2分ごとに次のテーマへ30秒かけて移る。
const PALETTES: Palette[] = [
  // MOONLIT AURORA
  { base: '#02030a', glowA: '#6ff3ff', glowB: '#a98bff', petalA: '#f4f9ff', petalB: '#8fd6ff' },
  // ROSE NEBULA
  { base: '#060208', glowA: '#ff9ad8', glowB: '#7d7bff', petalA: '#fff0fa', petalB: '#ffb0e3' },
  // GOLDEN DUSK
  { base: '#060306', glowA: '#ffd58a', glowB: '#ff7ab0', petalA: '#fff9ea', petalB: '#ffc070' },
  // DEEP SEA
  { base: '#010607', glowA: '#62ffd8', glowB: '#4f86ff', petalA: '#ecfffb', petalB: '#7cefff' },
]

const GLSL_COMMON = /* glsl */ `
  #define W 0.010471976
  // ゆっくりした動き用（2400秒で一周）。W = WS * 4
  #define WS 0.0026179939
  #define TAU 6.2831853
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
  vec2 kaleido(vec2 p, float segments){
    float r = length(p);
    float a = atan(p.y, p.x);
    float sector = TAU / segments;
    a = mod(a, sector);
    a = abs(a - sector * 0.5);
    return vec2(cos(a), sin(a)) * r;
  }
`

// 波紋。xy: 中心XZ, z: 発生時刻(折り返し済み), w: 万華鏡の対称数（0なら空きスロット）
const GLSL_RIPPLE = /* glsl */ `
  uniform vec4 uRipples[${RIPPLE_SLOTS}];
  float rippleAge(vec4 rp){
    return mod(uTime - rp.z + ${TIME_WRAP.toFixed(1)}, ${TIME_WRAP.toFixed(1)}) * ${RIPPLE_TIME_SCALE.toFixed(3)};
  }
  // 輪郭の揺らぎ。広がるほど大きくうねる（オーラの根元も同じ式で輪に乗せる）
  float rippleWob(float ang, float age, float fi){
    float amp = 0.08 + age * 0.13;
    float w = sin(ang * 3.0 + fi * 1.7 + uTime * W * 10.0) * 0.5
            + sin(ang * 5.0 - fi * 2.3 - uTime * W * 16.0) * 0.3
            + sin(ang * 9.0 + fi * 4.1 + uTime * W * 8.0) * 0.2;
    // 楕円へのゆがみ。半径に比例させるので広がっても楕円のまま。
    // つぶれ具合と向きは波紋ごとに違い、ゆっくり呼吸するように変わる
    float R = age * ${RIPPLE_SPEED.toFixed(2)};
    float ecc = (0.14 + 0.16 * fract(fi * 0.618 + 0.3)) * (0.65 + 0.35 * sin(uTime * W * 8.0 + fi * 2.1));
    float axis = fi * 1.9 + uTime * W * 2.0;
    return w * amp - R * ecc * cos(2.0 * (ang - axis));
  }
  // rippleWob の絶対値の上限（揺らぎ＋楕円のゆがみ）。これより外のピクセルは計算を省ける
  float rippleReach(float age, float fi){
    return 0.08 + age * 0.13 + age * ${RIPPLE_SPEED.toFixed(2)} * (0.14 + 0.16 * fract(fi * 0.618 + 0.3));
  }
`

// 線の波紋の色。ピクセルごとに届かない波紋を飛ばすので、fwidth はループの外で求めて px で渡す
const GLSL_RING = /* glsl */ `
  // 天井用: 各波紋の中心を鏡の正面の扇へ折り込んだ位置（毎フレームCPUで計算）
  uniform vec2 uRippleFold[${RIPPLE_SLOTS}];
  // 波紋の線の太さの倍率。ドームの中の人数が多いほど細くする（JSでなめらかに変える）
  uniform float uLineScale;
  vec3 ringColor(vec2 rel, float d, float age, float fi, float px){
    float ang = atan(rel.y, rel.x);
    float x = d + rippleWob(ang, age, fi) - age * ${RIPPLE_SPEED.toFixed(2)};
    float aa = px * 1.3 + 0.002;
    float wl = (0.018 + age * 0.003) * uLineScale;
    float l0 = 1.0 - smoothstep(wl, wl + aa, abs(x));
    float l1 = 1.0 - smoothstep(wl * 0.7, wl * 0.7 + aa, abs(x + 0.55 + 0.18 * sin(ang * 4.0 + fi)));
    float l2 = 1.0 - smoothstep(wl * 0.5, wl * 0.5 + aa, abs(x + 1.35 + 0.35 * sin(ang * 7.0 - fi * 1.3)));
    float halo = exp(-x * x * 2.5);
    float fade = smoothstep(0.0, 0.8, age) * pow(max(1.0 - age / ${RIPPLE_LIFE.toFixed(1)}, 0.0), 1.4);
    float hue = 0.5 + 0.5 * sin(ang * 2.0 + age * 0.5 + fi);
    vec3 c = mix(uGlowA, uGlowB, hue);
    return (c * (l0 * 1.4 + l1 * 0.8 + l2 * 0.5 + halo * 0.22) + uPetalA * l0 * 0.7) * fade;
  }
  // 床の実座標での波紋
  vec3 ripplesRaw(vec2 p){
    float px = length(fwidth(p));
    vec3 acc = vec3(0.0);
    for(int i = 0; i < ${RIPPLE_SLOTS}; i++){
      vec4 rp = uRipples[i];
      if(rp.w < 0.5) continue;
      float age = rippleAge(rp);
      if(age > ${RIPPLE_LIFE.toFixed(1)}) continue;
      vec2 rel = p - rp.xy;
      float d = length(rel);
      // 線（内側 -2.2 まで）とにじみ（|x| < 1.7）が届かないピクセルは省く。寄与は 0.001 未満
      float dr = d - age * ${RIPPLE_SPEED.toFixed(2)};
      float reach = rippleReach(age, float(i));
      if(dr - reach > 1.7 || dr + reach < -2.4) continue;
      acc += ringColor(rel, d, age, float(i), px);
    }
    return acc;
  }
  // ボロノイ（F1, F2, セルの乱数）。万華鏡の中の色ガラスの破片に使う
  vec3 voronoi(vec2 x){
    vec2 n = floor(x);
    vec2 f = fract(x);
    float f1 = 8.0;
    float f2 = 8.0;
    float id = 0.0;
    for(int j = -1; j <= 1; j++){
      for(int i = -1; i <= 1; i++){
        vec2 g = vec2(float(i), float(j));
        float h = hash21(n + g);
        vec2 o = 0.5 + 0.42 * sin(uTime * WS * (20.0 + floor(h * 40.0)) + h * TAU + vec2(0.0, 1.7));
        vec2 r = g + o - f;
        float d = dot(r, r);
        if(d < f1){ f2 = f1; f1 = d; id = h; }
        else if(d < f2){ f2 = d; }
      }
    }
    return vec3(sqrt(f1), sqrt(f2), id);
  }
  // 天井用の波紋の線。RGBで半径を少しずらし、プリズムのような虹色のにじみを出す。
  // glow には線の周りの広いにじみ（結晶やきらめきを灯す範囲）を加算して返す。
  // px は1ピクセルの大きさ（層の境目では分岐の中で呼ぶので、fwidth は外で求めて渡す）
  vec3 ringSpectral(vec2 rel, float d, float age, float fi, float px, inout float glow, inout float trail){
    float ang = atan(rel.y, rel.x);
    float x = d + rippleWob(ang, age, fi) - age * ${RIPPLE_SPEED.toFixed(2)};
    float aa = px * 1.3 + 0.002;
    float wl = (0.035 + age * 0.005) * uLineScale;
    float disp = wl * 0.9 + age * 0.006;
    vec3 xs = vec3(x - disp, x, x + disp);
    vec3 l0 = 1.0 - smoothstep(vec3(wl), vec3(wl + aa), abs(xs));
    vec3 x1 = xs + 0.7 + 0.25 * sin(ang * 4.0 + fi);
    vec3 l1 = 1.0 - smoothstep(vec3(wl * 0.7), vec3(wl * 0.7 + aa), abs(x1));
    vec3 x2 = xs + 1.7 + 0.45 * sin(ang * 7.0 - fi * 1.3);
    vec3 l2 = 1.0 - smoothstep(vec3(wl * 0.5), vec3(wl * 0.5 + aa), abs(x2));
    float halo = exp(-x * x * 1.6);
    float fade = smoothstep(0.0, 0.8, age) * pow(max(1.0 - age / ${RIPPLE_LIFE.toFixed(1)}, 0.0), 1.3);
    float hue = 0.5 + 0.5 * sin(ang * 2.0 + age * 0.5 + fi);
    vec3 c = mix(uGlowA, uGlowB, hue);
    glow += exp(-x * x * 0.5) * fade;
    // 波紋が通り過ぎた内側の帯（色ガラスを灯す範囲）
    trail += smoothstep(-4.5, -1.0, x) * (1.0 - smoothstep(-0.3, 0.2, x)) * fade;
    // 芯は白く、ふちだけ赤と青にずれて虹色になる
    float core = l0.g;
    vec3 spec = l0 * 1.1 + l1 * 0.6 + l2 * 0.35;
    return (spec * mix(vec3(1.0), c, 0.45) + uPetalA * core * 0.4 + c * halo * 0.3) * fade;
  }
  // ---- 2ミラー方式の万華鏡（実物の構造に合わせる） ----
  // 2枚の鏡を ${(360 / KALEIDO_IMAGES).toFixed(0)}° で合わせた筒を、天頂から覗いている。
  // ・正面の扇（像0）にはオブジェクトセルがそのまま見え、残りの ${KALEIDO_IMAGES - 1} 個は鏡に映った像。
  //   鏡像は1回ごとに左右が反転し、反射回数が増えるほど暗く、わずかにぼやける。
  // ・像の円の外は筒の内側なので暗い（2ミラー方式は黒い背景に曼荼羅が浮かぶ）。
  // ・オブジェクトセルには色ガラスの破片とガラスの粉が入っていて、セルがゆっくり回ると中身が流れる。
  // ・セルを裏から照らす光は、プレイヤーの波紋。波紋が通った所だけガラスが透けて色づく。
  // p は床と同じ縮尺の平面座標（天頂からの角距離を床の半径へ対応させたもの）。
  vec3 kaleidoField(vec2 p){
    float px = length(fwidth(p));
    float r = length(p);
    float Rm = ${KALEIDO_RADIUS.toFixed(1)};
    float wedge = TAU / ${KALEIDO_IMAGES.toFixed(1)};
    // 筒ごとゆっくり回る（覗く人が筒を回す動き）
    float tube = uTime * WS * 2.0;
    float ang = mod(atan(p.y, p.x) + tube, TAU);
    float k = floor(ang / wedge);
    float la = ang - k * wedge;
    if(mod(k, 2.0) > 0.5) la = wedge - la; // 鏡像は左右反転
    // 反射回数（どちら回りでも少ない方の回数で目に届く）
    float nref = min(k, ${KALEIDO_IMAGES.toFixed(1)} - k);
    float pxr = px * (1.0 + nref * 0.35); // 反射ごとのわずかなぼやけ
    vec2 q = vec2(cos(la), sin(la)) * r;  // 正面の扇の中の座標

    // セルを照らす光 = 波紋。中心も正面の扇の中へ折り込む（どこで放った波紋も映る）
    vec3 rings = vec3(0.0);
    float glow = 0.0;
    float trail = 0.0;
    for(int i = 0; i < ${RIPPLE_SLOTS}; i++){
      vec4 rp = uRipples[i];
      if(rp.w < 0.5) continue;
      float age = rippleAge(rp);
      if(age > ${RIPPLE_LIFE.toFixed(1)}) continue;
      vec2 rel = q - uRippleFold[i];
      float d = length(rel);
      // 線・にじみ・灯りの帯（-4.6 < x < 3.8）が届かないピクセルは省く。寄与は 0.001 未満
      float dr = d - age * ${RIPPLE_SPEED.toFixed(2)};
      float reach = rippleReach(age, float(i));
      if(dr - reach > 3.8 || dr + reach < -4.6) continue;
      rings += ringSpectral(rel, d, age, float(i), pxr, glow, trail);
    }
    glow = min(glow, 1.5);
    trail = min(trail, 1.2);
    float light = 0.05 + glow * 0.7 + trail * 0.55;

    // オブジェクトセル。セル自体が筒に対してゆっくり回り、中身が扇の中を流れていく
    float cr = uTime * WS * 5.0;
    vec2 c = mat2(cos(cr), sin(cr), -sin(cr), cos(cr)) * q;
    // 色ガラスの破片: すき間を空けて散らばり、7割ほどのセルに破片がある
    vec2 drift = 1.5 * vec2(cos(uTime * WS * 3.0), sin(uTime * WS * 4.0));
    vec3 vo = voronoi(c * 0.26 + drift);
    float id = vo.z;
    float inner = vo.y - vo.x; // 破片の縁からの距離（セル単位）
    float gap = 0.06;
    float piece = step(0.3, fract(id * 13.7)) * smoothstep(gap, gap + pxr * 0.3 + 0.01, inner);
    vec3 glassCol = 0.5 + 0.5 * cos(TAU * (fract(id * 5.3) + vec3(0.0, 0.33, 0.67)));
    glassCol = mix(glassCol, mix(uGlowA, uGlowB, fract(id * 3.1)), 0.45);
    // 厚みのある縁は濃く、中は明るく透ける。縁には細い照り
    float thick = 0.55 + 0.45 * smoothstep(gap, gap + 0.35, inner);
    float edgeHi = (1.0 - smoothstep(0.0, pxr * 0.3 + 0.015, abs(inner - gap - 0.02))) * step(0.3, fract(id * 13.7));
    vec3 glass = glassCol * piece * thick * light * 1.3 + uPetalA * edgeHi * light * 0.5;

    // きらめき（ガラスの粉）。光が当たった所で瞬く
    vec2 gc = c * 1.6;
    vec2 cell = floor(gc);
    float gh = hash21(cell + 7.7);
    vec2 gp = fract(gc) - 0.5;
    float tw = pow(0.5 + 0.5 * sin(uTime * W * (150.0 + floor(gh * 300.0)) + gh * 70.0), 6.0);
    float glitter = step(0.9, gh) * tw * exp(-dot(gp, gp) * 60.0) * (0.03 + glow + trail * 0.5);

    vec3 img = rings * 1.5 + glass + uPetalA * glitter;
    // 反射ごとの光の損失（鏡の反射率 約0.9）と、裏面鏡のごくわずかな色かぶり
    img *= pow(0.9, nref) * pow(vec3(0.985, 1.0, 0.975), vec3(nref));
    // 鏡の合わせ目: ほぼ見えない細い線
    float seamD = min(la, wedge - la) * r;
    float seam = (1.0 - smoothstep(0.0, px * 1.2 + 0.003, seamD)) * smoothstep(0.3, 2.0, r);
    img += uPetalA * seam * 0.04;
    // 覗き窓の円。外は筒の内側で暗い
    float view = 1.0 - smoothstep(Rm - 0.6, Rm, r);
    float tubeRim = exp(-pow((r - Rm) * 1.4, 2.0)) * 0.05;
    return img * view + uGlowB * tubeRim;
  }
`

const WORLD_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main(){
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const SHADE_UNIFORMS = /* glsl */ `
  uniform float uTime;
  uniform vec3 uBase;
  uniform vec3 uGlowA;
  uniform vec3 uGlowB;
  uniform vec3 uPetalA;
  uniform vec3 uPetalB;
`

const FLOOR_FRAG = /* glsl */ `
  ${SHADE_UNIFORMS}
  varying vec3 vWorld;
  ${GLSL_COMMON}
  ${GLSL_RIPPLE}
  ${GLSL_RING}
  void main(){
    vec2 p = vWorld.xz;
    float r = length(p);
    float mask = 1.0 - smoothstep(${(DISC_RADIUS + 0.5).toFixed(1)}, ${(DOME_RADIUS - 0.1).toFixed(1)}, r);

    vec3 col = uBase;
    // 足元に漂う薄い霧
    vec2 o1 = 3.0 * vec2(cos(uTime * W * 2.0), sin(uTime * W * 3.0));
    float mist = fbm(p * 0.07 + o1 + fbm(p * 0.05 - o1) * 1.4);
    col += mix(uGlowB, uGlowA, mist) * pow(mist, 2.6) * 0.1;
    // 淡い万華鏡の等高線（天井の像が床に映り込んでいるような下地）
    vec2 kp = kaleido(p, 8.0);
    float v = fbm(kp * 0.22 + o1 * 0.5);
    float contour = pow(1.0 - smoothstep(0.0, 0.06, abs(fract(v * 3.0 + uTime * W * 3.0) - 0.5)), 3.0);
    col += uGlowA * contour * 0.025 * mask;
    // 瞬く微光
    vec2 cell = floor(p * 2.5);
    float h = hash21(cell);
    vec2 fp = fract(p * 2.5) - 0.2 - 0.6 * vec2(h, fract(h * 17.3));
    float tw = pow(0.5 + 0.5 * sin(uTime * W * (120.0 + floor(h * 300.0)) + h * 60.0), 12.0);
    col += uPetalA * step(0.94, h) * tw * exp(-dot(fp, fp) * 900.0) * 0.5 * mask;

    // 波紋（床では実像）
    col += ripplesRaw(p) * mask;

    col *= 0.55 + 0.45 * (1.0 - smoothstep(4.0, ${(DISC_RADIUS + 1).toFixed(1)}, r));
    gl_FragColor = vec4(col, 1.0);
  }
`

const DOME_FRAG = /* glsl */ `
  ${SHADE_UNIFORMS}
  varying vec3 vWorld;
  ${GLSL_COMMON}
  ${GLSL_RIPPLE}
  ${GLSL_RING}
  void main(){
    vec3 dir = normalize(vWorld);
    float up = smoothstep(-0.05, 0.25, dir.y);
    // 天頂＝床の中心、地平線＝床の縁に対応させ、ゆっくり回す
    float rho = acos(clamp(dir.y, -1.0, 1.0)) / 1.5707963;
    float phi = atan(dir.x, dir.z) + uTime * W;
    vec2 mp = vec2(sin(phi), cos(phi)) * rho * ${DISC_RADIUS.toFixed(1)};

    vec3 col = uBase * 0.8;
    // 星雲
    vec2 sp = dir.xz / (dir.y + 1.15);
    vec2 o1 = 2.0 * vec2(cos(uTime * W * 2.0), sin(uTime * W * 3.0));
    float n = fbm(sp * 2.2 + o1 + fbm(sp * 1.3 - o1) * 1.6);
    float n2 = fbm(sp * 3.1 - o1 * 0.7 + 11.0);
    col += mix(uGlowB, uGlowA, n2) * pow(n, 3.0) * 0.12 * up;
    // 星の瞬き
    vec2 sc = sp * 55.0;
    vec2 cell = floor(sc);
    float h = hash21(cell);
    vec2 fp = fract(sc) - 0.5;
    float tw = 0.4 + 0.6 * pow(0.5 + 0.5 * sin(uTime * W * (90.0 + floor(h * 400.0)) + h * 80.0), 6.0);
    col += uPetalA * step(0.965, h) * tw * exp(-dot(fp, fp) * 40.0) * 0.4 * up;
    // 地平線のにじみ
    col += uGlowB * exp(-abs(dir.y) * 7.0) * 0.06;

    // 床の波紋を、天頂を中心にした放射状の万華鏡として映す
    // 地平線（＝床の縁）まで途切れずに続ける
    col += kaleidoField(mp) * smoothstep(-0.1, 0.0, dir.y);
    col *= smoothstep(-0.4, 0.0, dir.y) * 0.85 + 0.15;
    gl_FragColor = vec4(col, 1.0);
  }
`

// オーラの糸。波紋の輪の上に根元を置き、不規則に揺れながら上へ伸びては消える
const WISP_VERT = /* glsl */ `
  attribute vec4 aWisp; // x: 波紋スロット, y: 輪上の角度, z,w: 個体の乱数
  uniform float uTime;
  uniform float uViewH;
  varying float vV;
  varying float vX;
  varying float vAlpha;
  varying float vHue;
  ${GLSL_COMMON}
  ${GLSL_RIPPLE}
  void main(){
    vec4 rp = uRipples[int(aWisp.x)];
    float age = rippleAge(rp);
    float s1 = aWisp.z;
    float s2 = aWisp.w;
    // 個体ごとの出現窓。生まれて、伸びて、ほどけて消える
    float start = 0.5 + s1 * 6.0;
    float dur = 2.5 + s2 * 5.5;
    float local = (age - start) / dur;
    if(rp.w < 0.5 || age > ${RIPPLE_LIFE.toFixed(1)} || local < 0.0 || local > 1.0){
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }
    float fi = aWisp.x;
    float ang = aWisp.y;
    float R = age * ${RIPPLE_SPEED.toFixed(2)} - rippleWob(ang, age, fi);
    vec2 rd = vec2(cos(ang), sin(ang));
    vec2 tg = vec2(-rd.y, rd.x);
    vec2 base = rp.xy + rd * R;

    float v = position.y;
    float tallness = 0.5 + 3.8 * pow(fract(s1 * 7.31 + s2 * 3.1), 1.4);
    float H = tallness * smoothstep(0.0, 0.75, local);
    // 後半は根元が床から離れ、ふっと浮き上がりながらほどける
    float lift = pow(local, 1.6) * (0.6 + 1.2 * s2);
    // ふわふわ: 高さとともに大きくなる、周期の違う揺れの重ね合わせ
    float sw = sin(v * 3.3 - uTime * W * (90.0 + floor(s2 * 60.0)) + s1 * 20.0)
             + 0.6 * sin(v * 7.1 + uTime * W * (150.0 + floor(s1 * 80.0)) + s2 * 13.0)
             + 0.8 * (vnoise(vec2(v * 2.2 - uTime * W * 70.0, s1 * 40.0 + fi)) - 0.5);
    sw *= 0.34 * pow(v, 1.1) * (0.6 + H * 0.3);
    sw += sin(local * 3.0 + s1 * 17.0) * 0.5 * v * v;
    float rad = sin(v * 2.4 + uTime * W * 75.0 + s1 * 9.0) * 0.3 * v + (s2 - 0.5) * 0.6 * v * v;
    vec3 wp = vec3(base.x + tg.x * sw + rd.x * rad, v * H + lift, base.y + tg.y * sw + rd.y * rad);

    // 鉛直軸まわりにカメラへ向ける細いリボン
    vec3 toCam = cameraPosition - wp;
    vec3 side = cross(vec3(0.0, 1.0, 0.0), toCam);
    float sl = length(side);
    side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
    float width = (0.022 + 0.03 * s2) * (1.0 - v * 0.6);
    // 遠くでも画面上で1.3px以上の幅を保ち、広げた分だけ暗くして明るさを保存する
    float viewZ = max(-(viewMatrix * vec4(wp, 1.0)).z, 0.05);
    float minW = 1.3 * viewZ / (projectionMatrix[1][1] * uViewH * 0.5);
    float thin = width / max(width, minW);
    wp += side * position.x * max(width, minW);

    float env = smoothstep(0.0, 0.22, local) * (1.0 - smoothstep(0.5, 1.0, local));
    float fade = pow(max(1.0 - age / ${RIPPLE_LIFE.toFixed(1)}, 0.0), 0.8);
    float inside = 1.0 - smoothstep(${(DISC_RADIUS - 1.5).toFixed(1)}, ${(DISC_RADIUS + 0.5).toFixed(1)}, length(base));
    float flicker = 0.65 + 0.35 * sin(uTime * W * (250.0 + floor(s1 * 200.0)) + s2 * 50.0);
    float root = mix(1.0, smoothstep(0.0, 0.25, v), smoothstep(0.3, 0.8, local));
    vAlpha = env * fade * inside * flicker * pow(1.0 - v, 1.2) * thin * root;
    vV = v;
    vX = position.x;
    vHue = fract(s1 * 3.7 + ang * 0.3);
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`

const WISP_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uGlowA;
  uniform vec3 uGlowB;
  uniform vec3 uPetalA;
  varying float vV;
  varying float vX;
  varying float vAlpha;
  varying float vHue;
  void main(){
    float across = pow(max(1.0 - abs(vX), 0.0), 1.6);
    // 糸を上へ流れていく光の粒
    float pulse = 0.6 + 0.4 * sin(vV * 26.0 - uTime * 0.010471976 * 400.0 + vHue * 40.0);
    vec3 c = mix(uGlowA, uGlowB, vHue);
    c = mix(c, uPetalA, 0.35 * (1.0 - vV));
    gl_FragColor = vec4(c * across * pulse * vAlpha * 2.2, 1.0);
  }
`

// 花びらの群れ。各群れはドームの中を回る閉じた道筋をたどり、
// 群れの中の花びらは先頭から時間差でその道筋を追う（曲がると群れ全体がしなる）。
// さらに群れの軸の周りを螺旋状に回り、1枚ずつひらひらと揺れる。状態を持たず全員同期。
const PETAL_VERT = /* glsl */ `
  attribute vec4 aSeed; // x: 群れ番号, y: 群れの中の位置[0,1)（0が先頭）, z,w: 個体の乱数
  uniform float uTime;
  varying vec2 vQ;
  varying float vShade;
  varying float vAlpha;
  varying float vHue;
  ${GLSL_COMMON}
  // 群れの道筋。角速度はすべて WS の整数倍なので2400秒で継ぎ目なく一周する
  vec3 schoolPath(float t, float sa, float sb, float dir){
    float laps = (24.0 + 2.0 * floor(sb * 6.0)) * dir;
    float th = sa * TAU + t * WS * laps;
    float R = 9.5 + 5.0 * sin(t * WS * 6.0 + sb * TAU);
    vec2 xz = vec2(cos(th), sin(th)) * R;
    xz += 2.5 * vec2(sin(t * WS * 26.0 + sb * 5.0), cos(t * WS * 22.0 + sa * 7.0));
    float y = 4.2 + 1.9 * sin(t * WS * 10.0 + sa * 9.0) + 0.8 * sin(th * 2.0 + sb * 4.0);
    return vec3(xz.x, y, xz.y);
  }
  void main(){
    float school = aSeed.x;
    float sa = hash21(vec2(school, 1.3));
    float sb = hash21(vec2(school, 7.9));
    float dir = mod(school, 2.0) < 0.5 ? 1.0 : -1.0;
    float u = aSeed.y;
    float tt = uTime - u * ${SCHOOL_SPAN.toFixed(1)};
    vec3 P = schoolPath(tt, sa, sb, dir);
    vec3 T = normalize(schoolPath(tt + 0.15, sa, sb, dir) - P);
    vec3 N = normalize(cross(T, vec3(0.0, 1.0, 0.0)));
    vec3 B = cross(N, T);

    // 群れの太さ: 先頭と最後尾は細く、中ほどがふくらむ。ゆっくり呼吸する
    float bulge = pow(sin(3.14159 * clamp(u * 1.08, 0.0, 1.0)), 0.6);
    // ふくらみが群れの中を波のように伝わる
    float wave = 0.65 + 0.35 * sin(u * 14.0 - uTime * WS * 240.0 + sa * 20.0);
    float rad = (0.2 + 0.85 * bulge) * wave;
    float r0 = sqrt(aSeed.z) * rad;
    // 群れの軸の周りを螺旋状に回る
    float a0 = aSeed.w * TAU + uTime * WS * 80.0 * dir + u * 6.0;
    vec3 center = P + N * cos(a0) * r0 + B * sin(a0) * r0;
    // 個体ごとの揺らぎ
    vec2 wq = vec2(uTime * WS * 140.0 + aSeed.z * 40.0, aSeed.w * 30.0 + school * 11.0);
    center += (vec3(vnoise(wq), vnoise(wq + 17.3), vnoise(wq + 41.1)) - 0.5) * 0.3;

    // 進行方向を向き、ひらひらと回転（ロール）しながら少し上下に傾く
    float flutter = uTime * WS * (520.0 + 2.0 * floor(aSeed.z * 220.0)) + aSeed.w * 40.0;
    float roll = sin(flutter) * 1.1;
    vec3 S = N * cos(roll) + B * sin(roll);
    vec3 F = normalize(T + cross(S, T) * 0.35 * sin(flutter * 0.5 + 1.3));
    float size = 0.09 * (0.7 + 0.6 * fract(aSeed.z * 7.3 + aSeed.w));
    vec2 q = position.xy * 2.0;
    vec3 world = center + S * q.x * size * 0.6 + F * q.y * size;

    vec3 nrm = normalize(cross(S, F));
    vec3 toCam = normalize(cameraPosition - center);
    vShade = 0.35 + 0.65 * pow(abs(dot(nrm, toCam)), 3.0);
    vQ = q;
    vHue = fract(sa * 3.1 + u * 0.6 + aSeed.z * 0.15);
    vAlpha = smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.7, 1.0, u));
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`

const PETAL_FRAG = /* glsl */ `
  uniform vec3 uGlowA;
  uniform vec3 uGlowB;
  uniform vec3 uPetalA;
  uniform vec3 uPetalB;
  varying vec2 vQ;
  varying float vShade;
  varying float vAlpha;
  varying float vHue;
  void main(){
    // しずく形の花びら（先端が細く、付け根が丸い）
    float y = vQ.y;
    float w = 0.62 * (1.0 - 0.38 * y) * sqrt(max(1.0 - y * y, 0.0));
    float d = abs(vQ.x) / max(w, 1e-3);
    float shape = (1.0 - smoothstep(0.7, 1.0, d)) * step(abs(y), 1.0);
    if(shape < 0.01) discard;
    float vein = exp(-vQ.x * vQ.x * 60.0) * 0.35;
    vec3 c = mix(uPetalB, uGlowA, vHue);
    c = mix(c, uPetalA, 0.35 + 0.3 * (0.5 - 0.5 * y));
    gl_FragColor = vec4(c * (vShade + vein) * shape * vAlpha * 0.75, 1.0);
  }
`

const emptyRipple = () => new Vector4(0, 0, -100, 0)

// BGM: public/bgm.m4a（元の ambient.wav から頭の無音を除き、つなぎ目を30msだけ重ねてAAC 128kbpsにしたもの）
// AACは末尾に詰め物が付くので、ループの終点はサンプル数で正確に指定する
const BGM_FILE = 'bgm.m4a'
const BGM_LOOP_SAMPLES = 5640066
const BGM_SAMPLE_RATE = 44100
const BGM_VOLUME = 0.55
const BGM_FADE_IN = 4

// Web Audio でつなぎ目なくループ再生する。ブラウザは操作前の自動再生を止めるので、
// 最初のクリック・タップ・キー操作で鳴り始める（VRに入る操作でも鳴る）
function Bgm() {
  const { baseUrl } = useXRift()
  useEffect(() => {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const gain = ctx.createGain()
    gain.gain.value = 0
    gain.connect(ctx.destination)
    let source: AudioBufferSourceNode | null = null
    let disposed = false

    const start = (buffer: AudioBuffer) => {
      if (disposed || source) return
      source = ctx.createBufferSource()
      source.buffer = buffer
      source.loop = true
      source.loopStart = 0
      source.loopEnd = Math.min(BGM_LOOP_SAMPLES / BGM_SAMPLE_RATE, buffer.duration)
      source.connect(gain)
      source.start()
      gain.gain.setValueAtTime(0, ctx.currentTime)
      gain.gain.linearRampToValueAtTime(BGM_VOLUME, ctx.currentTime + BGM_FADE_IN)
    }

    let loaded: AudioBuffer | null = null
    // ワールド内のファイルは three の FileLoader で読む（XRift のセキュリティチェックに合わせる）
    new FileLoader()
      .setResponseType('arraybuffer')
      .loadAsync(`${baseUrl}${BGM_FILE}`)
      .then((data) => ctx.decodeAudioData(data as ArrayBuffer))
      .then((buffer) => {
        loaded = buffer
        if (ctx.state === 'running') start(buffer)
      })
      .catch(() => {})

    const unlock = () => {
      ctx.resume().then(() => {
        if (loaded) start(loaded)
      }).catch(() => {})
    }
    const events = ['pointerdown', 'touchend', 'keydown'] as const
    events.forEach((e) => window.addEventListener(e, unlock, { passive: true }))
    ctx.addEventListener('statechange', () => {
      if (ctx.state === 'running' && loaded) start(loaded)
    })
    // 自動再生が許可されている環境ではそのまま鳴らす
    ctx.resume().catch(() => {})

    return () => {
      disposed = true
      events.forEach((e) => window.removeEventListener(e, unlock))
      try {
        source?.stop()
      } catch {
        // 既に止まっている
      }
      ctx.close().catch(() => {})
    }
  }, [baseUrl])
  return null
}

export function World() {
  const { now } = useServerClock()
  const users = useUsers()

  const shared = useMemo(
    () => ({
      uTime: { value: 0 },
      uViewH: { value: 1000 },
      uBase: { value: new Color(PALETTES[0].base) },
      uGlowA: { value: new Color(PALETTES[0].glowA) },
      uGlowB: { value: new Color(PALETTES[0].glowB) },
      uPetalA: { value: new Color(PALETTES[0].petalA) },
      uPetalB: { value: new Color(PALETTES[0].petalB) },
      uRipples: { value: Array.from({ length: RIPPLE_SLOTS }, emptyRipple) },
      uRippleFold: { value: Array.from({ length: RIPPLE_SLOTS }, () => new Vector2()) },
      uLineScale: { value: 1 },
    }),
    [],
  )

  const { floorMat, domeMat } = useMemo(() => {
    const uniforms = {
      uTime: shared.uTime,
      uBase: shared.uBase,
      uGlowA: shared.uGlowA,
      uGlowB: shared.uGlowB,
      uPetalA: shared.uPetalA,
      uPetalB: shared.uPetalB,
      uRipples: shared.uRipples,
      uRippleFold: shared.uRippleFold,
      uLineScale: shared.uLineScale,
    }
    return {
      floorMat: new ShaderMaterial({ vertexShader: WORLD_VERT, fragmentShader: FLOOR_FRAG, uniforms }),
      domeMat: new ShaderMaterial({
        vertexShader: WORLD_VERT,
        fragmentShader: DOME_FRAG,
        uniforms,
        side: BackSide,
        depthWrite: false,
      }),
    }
  }, [shared])

  const rimMat = useMemo(
    () => new MeshBasicMaterial({ color: PALETTES[0].glowA, transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false }),
    [],
  )

  // オーラの糸（全スロット分をまとめて1ドローコール）
  const wispMesh = useMemo(() => {
    const strip = new BufferGeometry()
    const pos: number[] = []
    const idx: number[] = []
    for (let k = 0; k <= WISP_SEGMENTS; k++) {
      const v = k / WISP_SEGMENTS
      pos.push(-1, v, 0, 1, v, 0)
      if (k < WISP_SEGMENTS) {
        const a = k * 2
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
    strip.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    strip.setIndex(idx)
    const geo = new InstancedBufferGeometry()
    geo.index = strip.index
    geo.setAttribute('position', strip.attributes.position)
    const count = RIPPLE_SLOTS * WISPS_PER_RIPPLE
    const data = new Float32Array(count * 4)
    const h = (n: number) => {
      const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
      return x - Math.floor(x)
    }
    for (let i = 0; i < count; i++) {
      const slot = Math.floor(i / WISPS_PER_RIPPLE)
      const j = i % WISPS_PER_RIPPLE
      data[i * 4 + 0] = slot
      data[i * 4 + 1] = ((j + h(i * 3.1) * 0.9) / WISPS_PER_RIPPLE) * Math.PI * 2
      data[i * 4 + 2] = h(i * 5.7 + 1)
      data[i * 4 + 3] = h(i * 9.3 + 2)
    }
    geo.setAttribute('aWisp', new InstancedBufferAttribute(data, 4))
    geo.instanceCount = count
    const mat = new ShaderMaterial({
      vertexShader: WISP_VERT,
      fragmentShader: WISP_FRAG,
      uniforms: {
        uTime: shared.uTime,
        uViewH: shared.uViewH,
        uGlowA: shared.uGlowA,
        uGlowB: shared.uGlowB,
        uPetalA: shared.uPetalA,
        uRipples: shared.uRipples,
      },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    })
    const mesh = new Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = 2
    return mesh
  }, [shared])

  // 花びらの群れ（インスタンシング1ドローコール）
  const petals = useMemo(() => {
    const plane = new PlaneGeometry(1, 1)
    const geo = new InstancedBufferGeometry()
    geo.index = plane.index
    geo.setAttribute('position', plane.attributes.position)
    const count = SCHOOLS * PER_SCHOOL
    const seeds = new Float32Array(count * 4)
    const h = (n: number) => {
      const x = Math.sin(n * 91.7 + 47.3) * 43758.5453
      return x - Math.floor(x)
    }
    for (let i = 0; i < count; i++) {
      const school = Math.floor(i / PER_SCHOOL)
      const j = i % PER_SCHOOL
      seeds[i * 4 + 0] = school
      seeds[i * 4 + 1] = (j + h(i * 1.7) * 0.8) / PER_SCHOOL
      seeds[i * 4 + 2] = h(i * 3.7 + 9.1)
      seeds[i * 4 + 3] = h(i * 5.3 + 2.2)
    }
    geo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4))
    geo.instanceCount = count
    const mat = new ShaderMaterial({
      vertexShader: PETAL_VERT,
      fragmentShader: PETAL_FRAG,
      uniforms: {
        uTime: shared.uTime,
        uGlowA: shared.uGlowA,
        uGlowB: shared.uGlowB,
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
    mesh.renderOrder = 1
    return mesh
  }, [shared])

  const scratch = useRef({
    a: new Color(),
    b: new Color(),
    size: new Vector2(),
    avatars: Array.from({ length: 8 }, () => ({ x: 0, z: 0, s: 0 })),
    nextEmit: Array.from({ length: 8 }, () => -1),
    rippleIdx: 0,
    emitCount: 0,
  })

  useFrame((state, delta) => {
    const t = now() / 1000
    const sc = scratch.current
    shared.uTime.value = t % TIME_WRAP
    shared.uViewH.value = state.gl.getDrawingBufferSize(sc.size).y

    // テーマパレットの補間
    const cycle = t % (THEME_SECONDS * PALETTES.length)
    const idx = Math.floor(cycle / THEME_SECONDS)
    const local = cycle - idx * THEME_SECONDS
    const fadeStart = THEME_SECONDS - THEME_FADE
    const f = local > fadeStart ? (local - fadeStart) / THEME_FADE : 0
    const smooth = f * f * (3 - 2 * f)
    const cur = PALETTES[idx]
    const nxt = PALETTES[(idx + 1) % PALETTES.length]
    const mixInto = (target: Color, from: string, to: string) => {
      sc.a.set(from)
      sc.b.set(to)
      target.copy(sc.a).lerp(sc.b, smooth)
    }
    mixInto(shared.uBase.value, cur.base, nxt.base)
    mixInto(shared.uGlowA.value, cur.glowA, nxt.glowA)
    mixInto(shared.uGlowB.value, cur.glowB, nxt.glowB)
    mixInto(shared.uPetalA.value, cur.petalA, nxt.petalA)
    mixInto(shared.uPetalB.value, cur.petalB, nxt.petalB)

    // アバター位置。slot0は自分（getLocalMovement）、slot1以降はリモート（getMovement）
    const avatars = sc.avatars
    const setAvatar = (i: number, x: number, z: number) => {
      const inside = Math.hypot(x, z) < DISC_RADIUS ? 1 : 0
      const av = avatars[i]
      av.s += (inside - av.s) * 0.06
      av.x = x
      av.z = z
    }
    const localMovement = users.getLocalMovement()
    setAvatar(0, localMovement.position.x, localMovement.position.z)
    for (let i = 0; i < 7; i++) {
      const remote = users.remoteUsers[i]
      const movement = remote ? users.getMovement(remote.id) : undefined
      if (movement) setAvatar(i + 1, movement.position.x, movement.position.z)
      else avatars[i + 1].s += (0 - avatars[i + 1].s) * 0.06
    }

    // 波紋の発火。その時点の立ち位置をスナップショットし、中心はその場に固定。
    const ripples = shared.uRipples.value
    avatars.forEach((av, i) => {
      if (sc.nextEmit[i] < 0) sc.nextEmit[i] = t + 0.4 + i * 0.9
      if (t < sc.nextEmit[i]) return
      if (av.s > 0.5) {
        const sym = RIPPLE_SYMMETRY[sc.emitCount % RIPPLE_SYMMETRY.length]
        // 原点ちょうどだと鏡の軸が定まらないので、わずかにずらす
        const x = Math.abs(av.x) + Math.abs(av.z) < 1e-3 ? 0.01 : av.x
        ripples[sc.rippleIdx].set(x, av.z, t % TIME_WRAP, sym)
        sc.rippleIdx = (sc.rippleIdx + 1) % RIPPLE_SLOTS
        sc.emitCount += 1
        sc.nextEmit[i] = t + RIPPLE_INTERVAL
      } else {
        sc.nextEmit[i] = t + 1
      }
    })

    // 天井用: 波紋の中心を鏡の正面の扇へ折り込む（シェーダーの kaleidoField と同じ式）。
    // どのピクセルでも同じ値なので、ピクセルごとではなくここで1回だけ計算する
    const tube = (t % TIME_WRAP) * ((Math.PI * 2) / 2400) * 2
    const wedge = (Math.PI * 2) / KALEIDO_IMAGES
    ripples.forEach((rp, i) => {
      const ca = (((Math.atan2(rp.y, rp.x) + tube) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
      const ck = Math.floor(ca / wedge)
      let cla = ca - ck * wedge
      if (ck % 2 === 1) cla = wedge - cla
      const cr = Math.hypot(rp.x, rp.y)
      shared.uRippleFold.value[i].set(Math.cos(cla) * cr, Math.sin(cla) * cr)
    })

    // 人数が多いほど波紋の線を細くする。1人で1、2人で0.8、4人で約0.57、8人で約0.36。
    // 人の出入りで急に変わらないよう、数秒かけて近づける
    const present = Math.max(1, avatars.filter((av) => av.s > 0.5).length)
    const lineTarget = 1 / (1 + 0.25 * (present - 1))
    shared.uLineScale.value += (lineTarget - shared.uLineScale.value) * Math.min(1, delta * 0.6)

    const pulse = 0.5 + 0.5 * Math.sin(t * 0.4503)
    rimMat.color.copy(shared.uGlowA.value).multiplyScalar(0.35 + 0.25 * pulse)
  })

  return (
    <>
      <ambientLight intensity={0.4} />

      {/* 天井ドーム（内側から見る） */}
      <mesh material={domeMat} renderOrder={-1}>
        <sphereGeometry args={[DOME_RADIUS, 64, 40]} />
      </mesh>

      {/* 床 */}
      <mesh material={floorMat} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[DOME_RADIUS + 0.3, 96]} />
      </mesh>

      {/* ドームの外側の地面 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, 0]}>
        <circleGeometry args={[80, 48]} />
        <meshBasicMaterial color="#020205" />
      </mesh>

      {/* 境界の淡い光の輪 */}
      <mesh material={rimMat} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <torusGeometry args={[DOME_RADIUS - 0.4, 0.06, 8, 160]} />
      </mesh>

      <primitive object={petals} />
      <primitive object={wispMesh} />

      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[40, 0.15, 40]} position={[0, -0.15, 0]} />
      </RigidBody>

      <SpawnPoint position={[0, 0, 15]} />
      <Bgm />
    </>
  )
}
