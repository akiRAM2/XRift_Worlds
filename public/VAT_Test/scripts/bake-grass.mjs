import { DataUtils } from 'three'
import { writeFileSync, mkdirSync } from 'node:fs'
// Offline blade simulation: one periodic gust (bend, tip lag, rebound, settle) for a single tuft.
// Stores displacement from the rest pose so the runtime can yaw the rest shape per instance
// while every tuft still bends along the wind. The wind is +X in bake space.
const blades = 7, segments = 4, frames = 64, period = 3.2
const bladeVerts = segments * 2 + 1, width = blades * bladeVerts
const substeps = 400, settleCycles = 12, gustLength = .42
let seed = 20261101
const rand = (min, max) => {
  seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return min + ((t ^ t >>> 14) >>> 0) / 4294967296 * (max - min)
}
const gust = t => {
  const x = ((t % 1) + 1) % 1
  return x < gustLength ? Math.sin(Math.PI * x / gustLength) ** 2 : 0
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = v => { const l = Math.hypot(...v); return v.map(c => c / l) }
const rotate = (v, bend, sway) => {
  const x = v[0] * Math.cos(bend) + v[1] * Math.sin(bend), y = -v[0] * Math.sin(bend) + v[1] * Math.cos(bend)
  return [x, y * Math.cos(sway) - v[2] * Math.sin(sway), y * Math.sin(sway) + v[2] * Math.cos(sway)]
}
function makeBlade(index) {
  // Lower indices are the tallest, centred blades; the far LODs draw only those.
  const hero = index < 2
  const spread = hero ? .04 : .15, angle = rand(0, Math.PI * 2), offset = rand(.02, spread)
  const heading = rand(0, Math.PI * 2), length = hero ? rand(.72, .82) : rand(.5, .72)
  const lean = rand(.04, .2), curl = rand(.15, .5), halfWidth = hero ? .03 : rand(.019, .026)
  const stiffness = rand(.88, 1.12)
  return {
    base: [Math.cos(angle) * offset, 0, Math.sin(angle) * offset], heading, length, lean, curl, halfWidth,
    delay: rand(-.05, .05), swayPhase: rand(0, Math.PI * 2), swayAmount: rand(.03, .09),
    freq: [2.2, 1.7, 1.25, .95].map(f => f * stiffness),
    peak: [.18, .3, .45, .62].map(p => p * rand(.9, 1.1)),
    zeta: rand(.28, .4),
  }
}
// Spring joints stiffen toward the root, so the tip arrives late and overshoots on the way back.
function simulate(blade) {
  const dt = period / frames / substeps, angle = new Array(segments).fill(0), speed = new Array(segments).fill(0)
  const out = []
  for (let c = 0; c < settleCycles; c++) for (let f = 0; f < frames; f++) {
    if (c === settleCycles - 1) out.push(angle.slice())
    for (let s = 0; s < substeps; s++) {
      const time = (f + s / substeps) / frames - blade.delay
      let cumulative = 0
      for (let i = 0; i < segments; i++) {
        cumulative += angle[i]
        const w = blade.freq[i] * Math.PI * 2
        const target = blade.peak[i] * gust(time) * Math.max(0, Math.cos(cumulative))
        speed[i] += (w * w * (target - angle[i]) - 2 * blade.zeta * w * speed[i]) * dt
      }
      for (let i = 0; i < segments; i++) angle[i] += speed[i] * dt
    }
  }
  return out
}
function pose(blade, joints, frame) {
  const positions = [], normals = [], sides = [], heights = []
  const segment = blade.length / segments
  const side = [-Math.sin(blade.heading) * blade.halfWidth, 0, Math.cos(blade.heading) * blade.halfWidth]
  const sway = joints ? Math.sin(frame / frames * Math.PI * 2 + blade.swayPhase) * blade.swayAmount : 0
  let center = blade.base, cumulative = 0
  for (let i = 0; i <= segments; i++) {
    const seg = Math.min(i, segments - 1)
    if (joints && i < segments) cumulative += joints[i]
    const pitch = blade.lean + blade.curl * seg / segments
    const rest = [Math.sin(pitch) * Math.cos(blade.heading), Math.cos(pitch), Math.sin(pitch) * Math.sin(blade.heading)]
    const swayHere = sway * (seg + 1) / segments
    const direction = rotate(rest, cumulative, swayHere), widthAxis = rotate(side, cumulative, swayHere)
    const normal = unit(cross(widthAxis, direction))
    const taper = 1 - (i / segments) ** 1.8
    if (i < segments) for (const sign of [-1, 1]) {
      const offset = widthAxis.map(c => c * sign * taper)
      positions.push(center.map((c, k) => c + offset[k]))
      normals.push(normal); sides.push(offset); heights.push(i / segments)
    } else {
      positions.push(center); normals.push(normal); sides.push([0, 0, 0]); heights.push(1)
    }
    center = center.map((c, k) => c + direction[k] * segment)
  }
  return { positions, normals, sides, heights }
}
const delta = new Uint16Array(width * frames * 4), normalDelta = new Uint16Array(delta.length)
const mesh = new Float32Array(width * 10)
let minY = Infinity, maxBend = 0, lengthError = 0, seamError = 0, maxDelta = 0
for (let b = 0; b < blades; b++) {
  const blade = makeBlade(b), joints = simulate(blade), rest = pose(blade, null, 0)
  rest.positions.forEach((p, v) => mesh.set([...p, ...rest.normals[v], ...rest.sides[v], rest.heights[v]], (b * bladeVerts + v) * 10))
  for (let f = 0; f < frames; f++) {
    const shape = pose(blade, joints[f], f)
    const tip = shape.positions.at(-1), rootToTip = rest.positions.at(-1)
    maxBend = Math.max(maxBend, Math.hypot(tip[0] - rootToTip[0], tip[1] - rootToTip[1], tip[2] - rootToTip[2]))
    let polyline = 0
    for (let i = 0; i + 2 < bladeVerts - 1; i += 2) polyline += Math.hypot(...shape.positions[i + 2].map((c, k) => c - shape.positions[i][k]))
    polyline += Math.hypot(...tip.map((c, k) => c - shape.positions[bladeVerts - 3][k]))
    lengthError = Math.max(lengthError, Math.abs(polyline - blade.length) / blade.length)
    shape.positions.forEach((p, v) => {
      minY = Math.min(minY, p[1])
      const offset = (f * width + b * bladeVerts + v) * 4
      for (let c = 0; c < 3; c++) {
        delta[offset + c] = DataUtils.toHalfFloat(p[c] - rest.positions[v][c])
        normalDelta[offset + c] = DataUtils.toHalfFloat(shape.normals[v][c] - rest.normals[v][c])
        maxDelta = Math.max(maxDelta, Math.abs(p[c] - rest.positions[v][c]))
      }
      delta[offset + 3] = normalDelta[offset + 3] = DataUtils.toHalfFloat(1)
    })
  }
  const first = pose(blade, joints[0], 0).positions.at(-1), last = pose(blade, joints[frames - 1], frames - 1).positions.at(-1), next = pose(blade, joints[1], 1).positions.at(-1)
  seamError = Math.max(seamError, Math.hypot(...first.map((c, k) => c - last[k])) - Math.hypot(...first.map((c, k) => c - next[k])))
}
mkdirSync(new URL('../public/', import.meta.url), { recursive: true })
for (const [name, data] of [['position', delta], ['normal', normalDelta], ['mesh', mesh]])
  writeFileSync(new URL(`../public/vat-grass-${name}.bin`, import.meta.url), Buffer.from(data.buffer))
const metadata = { frames, period, width, height: frames, blades, segments, bladeVerts, vertices: width, format: 'RGBA16F' }
writeFileSync(new URL('../public/vat-grass-metadata.json', import.meta.url), JSON.stringify(metadata, null, 2))
console.log(metadata, { totalBytes: delta.byteLength + normalDelta.byteLength + mesh.byteLength, minY, maxBend, maxDelta, lengthError, seamExcess: seamError })
