import { useMemo } from 'react'
import * as THREE from 'three'
import { BUS } from '@/config/constants'

/**
 * Procedural bus built from primitives.
 *
 * This is the fallback that runs when /models/bus.glb is missing. It is also
 * the reference for how a real model should be proportioned: every dimension
 * comes from BUS in src/config/constants.js, so re-measuring your .glb is a
 * one-file change.
 *
 * IMPORTANT: the shell is built from separate panels (floor, roof, segmented
 * walls with real window openings, a genuine gap for the doorway) rather than
 * a solid box. A solid box would swallow the camera the moment it crosses the
 * threshold. Keep that property when you swap in the real model - if your .glb
 * has no interior, cut one with `clippingPlanes` on a local material.
 */

const LIVERIES = {
  lower: '#1d4ed8',
  accent: '#dc2626',
  body: '#eef1f5',
  roof: '#f7f9fb',
  trim: '#12203f',
  glass: '#0e1a2b',
  seat: '#22304d',
  seatTrim: '#0f1830',
  floor: '#39404b',
  aisle: '#2b313a',
  metal: '#9aa3ad',
  chrome: '#c8ced6',
}

const HW = BUS.halfWidth
const HL = BUS.halfLength
const FLOOR = BUS.floorY
const ROOF = BUS.roofY
const SIDE_T = 0.08
const WIN_BOTTOM = 1.8
const WIN_TOP = 2.62

const DOOR_SIDE = BUS.DOOR.side
const DOOR_Z0 = BUS.DOOR.centerZ - BUS.DOOR.width / 2
const DOOR_Z1 = BUS.DOOR.centerZ + BUS.DOOR.width / 2

/** Panel colour used for a given height band. */
function bandColor(y) {
  if (y < 0.72) return LIVERIES.trim
  if (y < 1.74) return LIVERIES.lower
  return LIVERIES.body
}

/**
 * Z spans of wall on one side. The door side is split into two runs so the
 * doorway is a genuine hole rather than a texture.
 */
function sideSpans(side) {
  if (side !== DOOR_SIDE) return [[-HL, HL]]
  return [
    [-HL, DOOR_Z0],
    [DOOR_Z1, HL],
  ]
}

/** Window mullions, evenly spaced, skipped across the doorway. */
function pillarZs(side) {
  const zs = []
  const step = 1.92
  for (let z = -HL + 0.5; z <= HL - 0.4; z += step) {
    if (side === DOOR_SIDE && z > DOOR_Z0 - 0.35 && z < DOOR_Z1 + 0.35) continue
    zs.push(z)
  }
  return zs
}

function Panel({ position, args, color, ...rest }) {
  return (
    <mesh position={position} castShadow receiveShadow {...rest}>
      <boxGeometry args={args} />
      <meshStandardMaterial color={color} roughness={0.62} metalness={0.12} />
    </mesh>
  )
}

function SideWall({ side }) {
  const spans = sideSpans(side)
  const x = side * HW

  return (
    <group>
      {spans.map(([z0, z1]) => {
        const len = z1 - z0
        const cz = (z0 + z1) / 2
        return (
          <group key={`${z0}-${z1}`}>
            {/* Skirt / lower body */}
            <Panel
              position={[x, (0.28 + WIN_BOTTOM) / 2, cz]}
              args={[SIDE_T, WIN_BOTTOM - 0.28, len]}
              color={LIVERIES.lower}
            />
            {/* Red accent stripe riding the shoulder line */}
            <Panel
              position={[x + side * 0.02, 1.66, cz]}
              args={[SIDE_T * 0.7, 0.16, len]}
              color={LIVERIES.accent}
            />
            {/* Glazing band */}
            <mesh position={[x, (WIN_BOTTOM + WIN_TOP) / 2, cz]}>
              <boxGeometry args={[0.05, WIN_TOP - WIN_BOTTOM, len - 0.08]} />
              <meshPhysicalMaterial
                color={LIVERIES.glass}
                roughness={0.12}
                metalness={0.1}
                transparent
                opacity={0.42}
                transmission={0.25}
                side={THREE.DoubleSide}
              />
            </mesh>
            {/* Cant rail above the windows */}
            <Panel
              position={[x, (WIN_TOP + ROOF) / 2, cz]}
              args={[SIDE_T, ROOF - WIN_TOP, len]}
              color={LIVERIES.body}
            />
          </group>
        )
      })}

      {/* Window mullions */}
      {pillarZs(side).map((z) => (
        <Panel
          key={`p-${z}`}
          position={[x, (WIN_BOTTOM + WIN_TOP) / 2, z]}
          args={[SIDE_T * 1.25, WIN_TOP - WIN_BOTTOM + 0.04, 0.11]}
          color={bandColor(2.2)}
        />
      ))}
    </group>
  )
}

function EndWall({ front }) {
  const z = front ? HL - 0.06 : -HL + 0.06
  const winTop = 2.6
  const winBottom = front ? 1.42 : 1.66

  return (
    <group>
      {/* Body below the glazing */}
      <Panel position={[0, (0.3 + winBottom) / 2, z]} args={[HW * 2, winBottom - 0.3, 0.12]} color={LIVERIES.lower} />
      {/* Glazing */}
      <mesh position={[0, (winBottom + winTop) / 2, z]}>
        <boxGeometry args={[HW * 1.92, winTop - winBottom, 0.06]} />
        <meshPhysicalMaterial
          color={LIVERIES.glass}
          roughness={0.1}
          metalness={0.1}
          transparent
          opacity={0.34}
          transmission={0.3}
        />
      </mesh>
      {/* Header */}
      <Panel position={[0, (winTop + ROOF) / 2, z]} args={[HW * 2, ROOF - winTop, 0.12]} color={LIVERIES.body} />
      {/* Centre pillar */}
      <Panel position={[0, (winBottom + winTop) / 2, z]} args={[0.1, winTop - winBottom, 0.14]} color={LIVERIES.body} />
    </group>
  )
}

function Wheel({ position }) {
  return (
    // Outer group lays the axle along world X; the inner mesh spins about its
    // local Y, which is the same axis.
    <group position={position} rotation={[0, 0, Math.PI / 2]} userData={{ wheel: true }}>
      <mesh castShadow rotation={[0, 0, 0]}>
        <cylinderGeometry args={[BUS.wheelRadius, BUS.wheelRadius, 0.3, 28]} />
        <meshStandardMaterial color="#17181b" roughness={0.92} />
      </mesh>
      {/* Hubcap reads the rotation at a glance */}
      <mesh position={[0, 0.16, 0]}>
        <cylinderGeometry args={[BUS.wheelRadius * 0.52, BUS.wheelRadius * 0.52, 0.03, 20]} />
        <meshStandardMaterial color={LIVERIES.chrome} roughness={0.35} metalness={0.7} />
      </mesh>
      <mesh position={[0, -0.16, 0]}>
        <cylinderGeometry args={[BUS.wheelRadius * 0.52, BUS.wheelRadius * 0.52, 0.03, 20]} />
        <meshStandardMaterial color={LIVERIES.chrome} roughness={0.35} metalness={0.7} />
      </mesh>
      {/* Spokes, purely so rotation is legible */}
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[0, 0.17, 0]} rotation={[0, (i * Math.PI) / 3, 0]}>
          <boxGeometry args={[0.06, 0.02, BUS.wheelRadius * 0.86]} />
          <meshStandardMaterial color="#2b2d31" roughness={0.6} metalness={0.3} />
        </mesh>
      ))}
    </group>
  )
}

/**
 * Two-leaf bi-fold door. Each leaf is hinged on an outer edge of the opening
 * and swings outward, so a single `open` value drives both.
 */
function Door({ leaf, side }) {
  const isFrontLeaf = leaf === 'front'
  const hingeZ = isFrontLeaf ? DOOR_Z1 : DOOR_Z0
  const direction = isFrontLeaf ? -1 : 1
  const leafWidth = BUS.DOOR.width / 2
  const angle = isFrontLeaf ? BUS.DOOR.openAngle : -BUS.DOOR.openAngle

  return (
    // Grouped on the hinge edge, so rotating the group swings the leaf outward.
    <group
      position={[side * (HW + 0.03), FLOOR + BUS.DOOR.height / 2, hingeZ]}
      userData={{ door: true, openAngle: angle, axis: 'y' }}
      name={`door_${leaf}`}
    >
      <mesh castShadow position={[0, 0, direction * (leafWidth / 2)]}>
        <boxGeometry args={[0.07, BUS.DOOR.height, leafWidth]} />
        <meshStandardMaterial color={LIVERIES.body} roughness={0.5} metalness={0.15} />
      </mesh>
      {/* Door glass */}
      <mesh position={[0, 0.24, direction * (leafWidth / 2)]}>
        <boxGeometry args={[0.05, BUS.DOOR.height * 0.62, leafWidth - 0.14]} />
        <meshPhysicalMaterial
          color={LIVERIES.glass}
          roughness={0.14}
          transparent
          opacity={0.4}
          transmission={0.3}
        />
      </mesh>
      {/* Red kick panel */}
      <mesh position={[side * 0.015, -BUS.DOOR.height / 2 + 0.24, direction * (leafWidth / 2)]}>
        <boxGeometry args={[0.05, 0.42, leafWidth - 0.06]} />
        <meshStandardMaterial color={LIVERIES.accent} roughness={0.55} />
      </mesh>
    </group>
  )
}

function Interior() {
  const seatRows = useMemo(() => {
    const rows = []
    for (let z = -4.6; z <= 3.4; z += 0.94) {
      rows.push(z)
    }
    return rows
  }, [])

  const seat = (x, z) => {
    // Keep the doorway and the front step clear.
    const nearDoor = x * DOOR_SIDE > 0.4 && z > 0.4 && z < 3.5
    const inDriverZone = z > 3.2 && x < 0
    if (nearDoor || inDriverZone) return null
    return (
      <group key={`${x}-${z}`} position={[x, FLOOR, z]}>
        <mesh position={[0, 0.44, 0]} castShadow>
          <boxGeometry args={[0.44, 0.1, 0.86]} />
          <meshStandardMaterial color={LIVERIES.seatTrim} roughness={0.8} />
        </mesh>
        <mesh position={[x * 0.12, 0.72, -0.36]} castShadow>
          <boxGeometry args={[0.42, 0.62, 0.09]} />
          <meshStandardMaterial color={LIVERIES.seat} roughness={0.85} />
        </mesh>
      </group>
    )
  }

  return (
    <group>
      {/* Saloon floor + aisle runner */}
      <Panel position={[0, FLOOR - 0.05, 0]} args={[HW * 1.94, 0.1, HL * 1.97]} color={LIVERIES.floor} />
      <mesh position={[0, FLOOR + 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.94, HL * 1.9]} />
        <meshStandardMaterial color={LIVERIES.aisle} roughness={0.95} />
      </mesh>

      {/* Ceiling - emissive so the interior reads through the glass and gives
          the overlaid dashboard something to sit against. */}
      <Panel position={[0, ROOF + 0.06, 0]} args={[HW * 2, 0.12, HL * 2]} color={LIVERIES.roof} />
      <mesh position={[0, ROOF - 0.02, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[HW * 1.9, HL * 1.95]} />
        <meshStandardMaterial
          color="#fff6e6"
          emissive="#ffe9c9"
          emissiveIntensity={0.55}
          roughness={0.95}
          toneMapped={false}
        />
      </mesh>

      {/* Longitudinal grab poles flanking the aisle */}
      {[-0.62, 0.62].map((x) => (
        <mesh key={x} position={[x, FLOOR + (ROOF - FLOOR) / 2, 0.4]} castShadow>
          <cylinderGeometry args={[0.035, 0.035, ROOF - FLOOR - 0.1, 12]} />
          <meshStandardMaterial color={LIVERIES.metal} roughness={0.32} metalness={0.75} />
        </mesh>
      ))}

      {/* Seats, both sides, skipping the door well */}
      {[-0.82, 0.82].map((x) => seatRows.map((z) => seat(x, z)))}

      {/* Door well grab poles - these frame the camera's entry shot */}
      {[DOOR_Z0 + 0.12, DOOR_Z1 - 0.12].map((z) => (
        <mesh key={z} position={[DOOR_SIDE * (HW - 0.16), FLOOR + (ROOF - FLOOR) / 2, z]} castShadow>
          <cylinderGeometry args={[0.04, 0.04, ROOF - FLOOR - 0.1, 12]} />
          <meshStandardMaterial color={LIVERIES.metal} roughness={0.32} metalness={0.75} />
        </mesh>
      ))}

      {/* Step well below the doorway */}
      {[0, 1].map((i) => (
        <Panel
          key={i}
          position={[DOOR_SIDE * (HW - 0.24), FLOOR - 0.16 - i * 0.17, BUS.DOOR.centerZ]}
          args={[0.48, 0.16, BUS.DOOR.width - 0.1]}
          color={LIVERIES.aisle}
        />
      ))}
    </group>
  )
}

function Cockpit() {
  const dashZ = HL - 1.05
  return (
    <group>
      {/* Bulkhead behind the driver + desk */}
      <Panel position={[0, FLOOR + 0.45, dashZ]} args={[HW * 1.9, 0.9, 0.55]} color={LIVERIES.trim} />
      <Panel position={[0, FLOOR + 0.93, dashZ - 0.05]} args={[HW * 1.9, 0.08, 0.62]} color="#0b1220" />

      {/* Fare/ticketing console on the left of the desk */}
      <Panel position={[0.62, FLOOR + 1.06, dashZ - 0.16]} args={[0.36, 0.22, 0.3]} color="#111827" />

      {/* The lit destination/payment panel the final camera move frames. */}
      <mesh position={[-0.34, FLOOR + 1.22, dashZ - 0.16]} rotation={[-0.22, 0, 0]}>
        <planeGeometry args={[1.05, 0.44]} />
        <meshBasicMaterial color="#7f9bfb" toneMapped={false} />
      </mesh>
      <mesh position={[-0.34, FLOOR + 1.225, dashZ - 0.152]} rotation={[-0.22, 0, 0]}>
        <planeGeometry args={[0.94, 0.3]} />
        <meshBasicMaterial color="#0b1220" toneMapped={false} />
      </mesh>

      {/* Driver seat + wheel, on the right hand side (left-hand traffic). */}
      <group position={[BUS.driverX, FLOOR, dashZ + 0.75]}>
        <mesh position={[0, 0.44, 0]} castShadow>
          <boxGeometry args={[0.46, 0.1, 0.46]} />
          <meshStandardMaterial color={LIVERIES.seatTrim} roughness={0.8} />
        </mesh>
        <mesh position={[0, 0.74, -0.2]} castShadow>
          <boxGeometry args={[0.44, 0.6, 0.09]} />
          <meshStandardMaterial color={LIVERIES.seat} roughness={0.85} />
        </mesh>
        <mesh position={[0, 0.98, 0.22]} rotation={[Math.PI / 2.4, 0, 0]}>
          <torusGeometry args={[0.21, 0.032, 10, 24]} />
          <meshStandardMaterial color="#1c1f24" roughness={0.6} />
        </mesh>
      </group>

      {/* Dash glow spill onto the windscreen */}
      <pointLight position={[0, FLOOR + 1.4, dashZ - 0.5]} intensity={1.4} distance={4.5} color="#9db6ff" />
    </group>
  )
}

function Lights() {
  const headY = 0.72
  const front = HL + 0.02
  const rear = -HL - 0.02
  return (
    <group>
      {[-0.92, 0.92].map((x) => (
        <mesh key={`h${x}`} position={[x, headY, front]}>
          <boxGeometry args={[0.44, 0.2, 0.06]} />
          <meshStandardMaterial color="#fff4dd" emissive="#ffe9bf" emissiveIntensity={1.4} toneMapped={false} />
        </mesh>
      ))}
      {[-0.92, 0.92].map((x) => (
        <mesh key={`t${x}`} position={[x, headY + 0.5, rear]}>
          <boxGeometry args={[0.26, 0.5, 0.05]} />
          <meshStandardMaterial color={LIVERIES.accent} emissive="#ff3b30" emissiveIntensity={0.9} toneMapped={false} />
        </mesh>
      ))}
      {/* Roof marker strip, visible in the exterior three-quarter shot */}
      <mesh position={[0, ROOF + 0.14, HL - 0.4]}>
        <boxGeometry args={[1.5, 0.1, 0.16]} />
        <meshStandardMaterial color="#fff4dd" emissive="#ffe9bf" emissiveIntensity={0.8} toneMapped={false} />
      </mesh>
    </group>
  )
}

export default function ProceduralBus() {
  return (
    <group name="procedural_bus">
      {/* Kerb-side skirt below the floor */}
      <Panel position={[0, 0.42, 0]} args={[HW * 1.98, 0.26, HL * 1.98]} color={LIVERIES.trim} />

      <SideWall side={1} />
      <SideWall side={-1} />
      <EndWall front />
      <EndWall front={false} />

      <Door leaf="front" side={DOOR_SIDE} />
      <Door leaf="rear" side={DOOR_SIDE} />

      <Interior />
      <Cockpit />
      <Lights />

      {/* Wheels */}
      {BUS.axles.map((z) =>
        [-1, 1].map((s) => (
          <Wheel key={`${z}-${s}`} position={[s * BUS.wheelTrack, BUS.wheelRadius, z]} />
        )),
      )}
    </group>
  )
}