import { readFileSync } from 'node:fs'
import { DataUtils, SphereGeometry } from 'three'
const positions=new Uint16Array(readFileSync(new URL('../public/vat-pass-position.bin',import.meta.url)).buffer)
const normals=new Uint16Array(readFileSync(new URL('../public/vat-pass-normal.bin',import.meta.url)).buffer)
const geometry=new SphereGeometry(1,96,64)
const count=geometry.attributes.position.count, stride=1024*7*4
const index=geometry.index.array
let clearance=Infinity, maxStep=0, minNormal=Infinity, maxNormal=0
for(let frame=0;frame<120;frame++) {
  const read=i=>[0,2].map(c=>DataUtils.fromHalfFloat(positions[frame*stride+i*4+c]))
  for(let i=0;i<index.length;i+=3) for(let e=0;e<3;e++) {
    const p=read(index[i+e]), q=read(index[i+(e+1)%3])
    for(let s=.25;s<1;s+=.25) for(const z of [-1.6,1.6])
      clearance=Math.min(clearance,Math.hypot(p[0]+(q[0]-p[0])*s,p[1]+(q[1]-p[1])*s-z)-.35)
  }
  for(let i=0;i<count;i++) {
    const offset=frame*stride+i*4, next=((frame+1)%120)*stride+i*4
    const p=[0,1,2].map(c=>DataUtils.fromHalfFloat(positions[offset+c]))
    const q=[0,1,2].map(c=>DataUtils.fromHalfFloat(positions[next+c]))
    const n=[0,1,2].map(c=>DataUtils.fromHalfFloat(normals[offset+c]))
    if(![...p,...n].every(Number.isFinite)) throw Error('Non-finite VAT')
    const norm=Math.hypot(...n)
    minNormal=Math.min(minNormal,norm);maxNormal=Math.max(maxNormal,norm)
    maxStep=Math.max(maxStep,Math.hypot(...p.map((v,c)=>v-q[c])))
    for(const z of [-1.6,1.6]) clearance=Math.min(clearance,Math.hypot(p[0],p[2]-z)-.35)
  }
}
console.log({minimumPoleClearance:clearance,maxFrameStep:maxStep,minNormal,maxNormal})
if(clearance<.02 || minNormal<.98 || maxNormal>1.02 || maxStep>.8) throw Error('Passage geometry validation failed')
