import { useMemo } from 'react'
import * as THREE from 'three'
import { useTexture } from '@react-three/drei'
import { BACKDROP } from '@/config/constants'
import { createSkyGradient } from '@/lib/textures'

/**
 * Distant 2D backdrop.
 *
 * The reference photo is wrapped around the inside of a large open-ended
 * cylinder so that when the camera swings around to enter the bus the
 * background still has real perspective on it, rather than reading as a flat
 * billboard. Everything is driven by BACKDROP in src/config/constants.js.
 */

function BackdropPhoto({ repeat, offset, color, tint }) {
  const texture = useTexture(BACKDROP.texture)

  const map = useMemo(() => {
    const next = texture.clone()
    next.wrapS = THREE.RepeatWrapping
    next.wrapT = THREE.ClampToEdgeWrapping
    next.colorSpace = THREE.SRGBColorSpace
    next.repeat.set(repeat[0], repeat[1])
    next.offset.set(offset[0], offset[1])
    next.anisotropy = 8
    next.needsUpdate = true
    return next
  }, [texture, repeat, offset])

  return (
    <mesh position={BACKDROP.position} rotation={[0, Math.PI, 0]} renderOrder={-10}>
      <cylinderGeometry
        args={[BACKDROP.radius, BACKDROP.radius, BACKDROP.height, 64, 1, true, 0, BACKDROP.thetaLength]}
      />
      <meshBasicMaterial
        map={map}
        color={color}
        side={THREE.BackSide}
        fog={false}
        toneMapped={false}
      />
      {/* Warm veil that pulls the 2D backdrop toward the 3D golden-hour key. */}
      <mesh position={[0, 0, 0.02]}>
        <cylinderGeometry
          args={[
            BACKDROP.radius - 0.05,
            BACKDROP.radius - 0.05,
            BACKDROP.height,
            64,
            1,
            true,
            0,
            BACKDROP.thetaLength,
          ]}
        />
        <meshBasicMaterial
          color="#ffb067"
          transparent
          opacity={tint}
          side={THREE.BackSide}
          depthWrite={false}
          fog={false}
          toneMapped={false}
        />
      </mesh>
    </mesh>
  )
}

function BackdropFallback({ color }) {
  const gradient = useMemo(() => createSkyGradient(), [])

  return (
    <mesh position={BACKDROP.position} rotation={[0, Math.PI, 0]} renderOrder={-10}>
      <cylinderGeometry
        args={[BACKDROP.radius, BACKDROP.radius, BACKDROP.height, 64, 1, true, 0, BACKDROP.thetaLength]}
      />
      <meshBasicMaterial map={gradient} color={color} side={THREE.BackSide} fog={false} toneMapped={false} />
    </mesh>
  )
}

export default function Backdrop({ hasTexture }) {
  if (!hasTexture) return <BackdropFallback color={BACKDROP.color} />
  return (
    <BackdropPhoto
      repeat={BACKDROP.repeat}
      offset={BACKDROP.offset}
      color={BACKDROP.color}
      tint={BACKDROP.tint}
    />
  )
}