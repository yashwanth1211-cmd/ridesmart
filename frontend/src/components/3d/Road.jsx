import { useMemo } from 'react'
import { ROAD, BUS } from '@/config/constants'
import { createRoadTexture } from '@/lib/textures'

/**
 * The road the bus drives along, plus the kerb, sidewalk and shelter on the
 * passenger side. The texture tiles every TILE_LENGTH metres so the speckle
 * does not stretch into smears down the length of the slab.
 */

const TILE_LENGTH = 16

function RoadSlab() {
  const map = useMemo(() => {
    const texture = createRoadTexture({ road: ROAD })
    texture.repeat.set(1, ROAD.length / TILE_LENGTH)
    return texture
  }, [])

  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0, -ROAD.length / 2 + TILE_LENGTH]}
        receiveShadow
      >
        <planeGeometry args={[ROAD.width, ROAD.length]} />
        <meshStandardMaterial map={map} roughness={0.94} metalness={0.02} />
      </mesh>

      {/* Kerb + sidewalk on the passenger (+X) side. */}
      <mesh
        position={[ROAD.width / 2 + ROAD.kerb.width / 2, ROAD.kerb.height / 2, -ROAD.length / 4]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[ROAD.kerb.width, ROAD.kerb.height, ROAD.length / 2]} />
        <meshStandardMaterial color={ROAD.kerb.color} roughness={0.9} />
      </mesh>

      {/* Matching far sidewalk so the road is not a slab in a void. */}
      <mesh
        position={[-ROAD.width / 2 - ROAD.kerb.width / 2, ROAD.kerb.height / 2, -ROAD.length / 4]}
        receiveShadow
      >
        <boxGeometry args={[ROAD.kerb.width, ROAD.kerb.height, ROAD.length / 2]} />
        <meshStandardMaterial color={ROAD.kerb.color} roughness={0.9} />
      </mesh>
    </group>
  )
}

function StopShelter() {
  // Sits just past the door so the camera has something to read at ground level.
  const x = BUS.halfWidth + 1.5

  return (
    <group position={[x, 0, BUS.DOOR.centerZ + 3.4]}>
      {/* Canopy */}
      <mesh position={[0, 2.5, 0]} castShadow>
        <boxGeometry args={[2.6, 0.12, 4.2]} />
        <meshStandardMaterial color="#3b4a5a" roughness={0.7} metalness={0.2} />
      </mesh>
      {/* Rear glass panel */}
      <mesh position={[1.1, 1.35, 0]}>
        <boxGeometry args={[0.05, 2.2, 4]} />
        <meshPhysicalMaterial
          color="#cfe4f2"
          transparent
          opacity={0.22}
          roughness={0.05}
          metalness={0}
          transmission={0.6}
        />
      </mesh>
      {/* Bench */}
      <mesh position={[0.5, 0.5, 0]} castShadow>
        <boxGeometry args={[0.5, 0.08, 3]} />
        <meshStandardMaterial color="#6b5b4a" roughness={0.85} />
      </mesh>
      {/* Two posts */}
      {[-1.8, 1.8].map((z) => (
        <mesh key={z} position={[-1.1, 1.25, z]} castShadow>
          <boxGeometry args={[0.09, 2.5, 0.09]} />
          <meshStandardMaterial color="#3b4a5a" roughness={0.6} metalness={0.3} />
        </mesh>
      ))}
      {/* Stop flag */}
      <mesh position={[-1.2, 3.2, -2.1]} castShadow>
        <boxGeometry args={[0.06, 1.4, 0.5]} />
        <meshStandardMaterial color="#dc2626" roughness={0.6} />
      </mesh>
    </group>
  )
}

function StopLine() {
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0.004, BUS.DOOR.centerZ + 2.1]}
      renderOrder={1}
    >
      <planeGeometry args={[ROAD.width * 0.9, 0.28]} />
      <meshBasicMaterial color={ROAD.lanes.color} transparent opacity={0.75} />
    </mesh>
  )
}

export default function Road() {
  return (
    <group>
      <RoadSlab />
      <StopShelter />
      <StopLine />
    </group>
  )
}