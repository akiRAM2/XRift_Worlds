import { SphereGeometry, DataUtils, Vector3 } from 'three'
import { writeFileSync, mkdirSync } from 'node:fs'
const frames = 120, duration = 12, width = 1024
const geometry = new SphereGeometry(1, 96, 64)
const base = geometry.attributes.position.array.slice()
const count = geometry.attributes.position.count
const rows = Math.ceil(count / width), height = rows * frames
const positions = new Uint16Array(width * height * 4)
const normals = new Uint16Array(positions.length)
const p = new Vector3(), tangent = new Vector3(), bitangent = new Vector3()
const a = new Vector3(), b = new Vector3(), n = new Vector3()
const radius = 2.5, poleZ = 1.6, poleRadius = .39, softness = .1
const lag = .42
const travelAt = t => 6 * Math.sin(t - lag * Math.sin(2 * t))
function press(out, travel, z) {
  const length = Math.hypot(travel, z), ux = -travel / length, uz = z / length
  const qx = out.x, qz = out.z - z
  const along = qx * ux + qz * uz, side = qz * ux - qx * uz
  // Tight against the pole, softer toward the rim of the groove.
  const groove = -poleRadius + side * side / (2 * poleRadius), soft = softness + .4 * side * side, knee = groove - soft
  if (along <= knee) return
  const shift = knee + soft * Math.tanh((along - knee) / soft) - along
  out.x += shift * ux
  out.z += shift * uz
}
function deform(v, t, out, passage=false) {
  if (passage) {
    const travel = travelAt(t)
    const depth = Math.max(0, radius + poleRadius - Math.hypot(travel, poleZ)) / 1.25
    const swell = depth * depth
    out.set(v.x * radius * (1 + .14 * swell) + travel, v.y * radius * (1 + .17 * swell), v.z * radius)
    press(out, travel, poleZ)
    press(out, travel, -poleZ)
    return out
  }
  const r = 2.5 * (1 + .105 * Math.sin(3*v.x + 2*v.y + t) + .075 * Math.sin(4*v.z - 2*v.y - 2*t) + .045 * Math.cos(5*v.y + v.x + 3*t))
  const stretch = 1 + .09 * Math.sin(t)
  return out.set(v.x*r / Math.sqrt(stretch), v.y*r*stretch, v.z*r / Math.sqrt(stretch))
}
for(const passage of [false,true]) {
let maxRadius = 0
for (let f=0; f<frames; f++) {
  const t = f / frames * Math.PI * 2
  for (let i=0; i<count; i++) {
    p.fromArray(base, i*3).normalize()
    tangent.set(Math.abs(p.y)<.9 ? 0 : 1, Math.abs(p.y)<.9 ? 1 : 0, 0).cross(p).normalize()
    bitangent.crossVectors(p,tangent).normalize()
    const eps=.001
    deform(p.clone().addScaledVector(tangent,eps).normalize(),t,a,passage)
    deform(p.clone().addScaledVector(tangent,-eps).normalize(),t,b,passage)
    tangent.copy(a).sub(b)
    deform(p.clone().addScaledVector(bitangent,eps).normalize(),t,a,passage)
    deform(p.clone().addScaledVector(bitangent,-eps).normalize(),t,b,passage)
    bitangent.copy(a).sub(b)
    n.crossVectors(tangent,bitangent).normalize()
    deform(p,t,a,passage)
    maxRadius=Math.max(maxRadius,a.length())
    const offset=(f*rows*width+i)*4
    for(let c=0;c<3;c++) {
      positions[offset+c]=DataUtils.toHalfFloat(a.getComponent(c))
      normals[offset+c]=DataUtils.toHalfFloat(n.getComponent(c))
    }
    positions[offset+3]=normals[offset+3]=DataUtils.toHalfFloat(1)
  }
}
mkdirSync(new URL('../public/',import.meta.url),{recursive:true})
for(const [name,data] of [['position',positions],['normal',normals]])
  writeFileSync(new URL(`../public/vat-${passage?'pass-':''}${name}.bin`,import.meta.url),Buffer.from(data.buffer))
const metadata={frames,duration,width,height,rows,vertices:count,maxRadius,format:'RGBA16F',segments:[96,64]}
writeFileSync(new URL(`../public/vat-${passage?'pass-':''}metadata.json`,import.meta.url),JSON.stringify(metadata,null,2))
console.log(metadata, 'Total bytes:',positions.byteLength+normals.byteLength)
}
