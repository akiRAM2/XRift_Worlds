import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import { SpawnPoint, useUsers } from '@xrift/world-components'
import { Mesh, PointLight } from 'three'

export type WorldProps = Record<string, never>

/*
 * LIGHT TEST — アバターを照らす point light の検証用ワールド
 *
 * 問い: ワールドに置いた pointLight は XRift のアバター (VRM / MToon) を照らすか?
 * 文献では決着がつかない (MToon が directional + 環境光のみという説がある一方、
 * three-vrm の MToon 実装が point light を拾う可能性も否定できない) ため、実機で判定する。
 *
 * 設計 (判定を混ぜないための工夫):
 * - pointLight は1個だけ。自分のアバター位置 (getLocalMovement) に追従し、高さ 2.2m 固定。
 *   強さ・色は一定にし、明るさの変化が「位置だけ」に起因するようにする。
 * - 対照物: meshStandardMaterial の床・壁・球5個。これらは point light を確実に受けるので、
 *   「ライト自体が動いているか」の確認になる。
 * - 光源位置マーカー: 発光に見える小球 (meshBasicMaterial = ライトを受けない) をライトと同位置に置く。
 *   これが明るく見えても「照らされている」証拠にはならない。判定は下の2点だけ。
 * - 全体光はわざと暗く (ambient 0.12 / directional 0.25) し、point light の効果が見えやすくした。
 *
 * 判定:
 *  A. 球・床・壁が歩くにつれて明るくなる → ライトはワールド側で機能している
 *  B. 自分 / 他人のアバターの服・肌が、ライトが近づくと明るくなる → MToon も point light を受ける
 *  Aのみ成立 → アバターは point light を受けない。代替案は directional / ambient の動的制御か、
 *  発光マテリアル・グローのビルボードによる「照らされてる風」の演出。
 */

const CONTROL_X = [-4, -2, 0, 2, 4]

export function World() {
  const users = useUsers()
  const light = useRef<PointLight>(null!)
  const bulb = useRef<Mesh>(null!)

  useFrame(() => {
    const p = users.getLocalMovement().position
    light.current.position.set(p.x, 2.2, p.z)
    bulb.current.position.set(p.x, 2.2, p.z)
  })

  return (
    <>
      <ambientLight intensity={0.12} />
      <directionalLight position={[6, 10, 4]} intensity={0.25} />

      {/* 検証対象: アバターに追従する point light (three r155+ の物理単位。decay=2 なら intensity は数十が必要) */}
      <pointLight ref={light} color="#ffd9a0" intensity={40} distance={12} decay={2} />

      {/* 光源位置マーカー (unlit なので判定には使わない) */}
      <mesh ref={bulb}>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshBasicMaterial color="#ffe9b0" />
      </mesh>

      {/* 床: 標準マテリアル (point light を受ける対照物) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[14, 48]} />
        <meshStandardMaterial color="#3a3a40" roughness={0.95} />
      </mesh>

      {/* 奥の壁: 標準マテリアル */}
      <mesh position={[0, 1.5, -6]}>
        <planeGeometry args={[12, 3]} />
        <meshStandardMaterial color="#55555e" roughness={0.95} />
      </mesh>

      {/* 対照物の球5個: 歩いて近づくと明るくなるはず */}
      {CONTROL_X.map((x) => (
        <mesh key={x} position={[x, 0.6, 0]}>
          <sphereGeometry args={[0.6, 32, 32]} />
          <meshStandardMaterial color="#8a8a92" roughness={0.9} />
        </mesh>
      ))}

      {/* 物理: 床 */}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[20, 0.15, 20]} position={[0, -0.15, 0]} />
      </RigidBody>

      <SpawnPoint position={[0, 0, 8]} />
    </>
  )
}
