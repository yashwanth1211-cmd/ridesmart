import { useEffect, useLayoutEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import gsap from 'gsap'
import { APP_STATE, BUS, MODEL, TRAVEL } from '@/config/constants'
import { useAppStore } from '@/store/appStore'
import ProceduralBus from './ProceduralBus'
import GlbBus from './GlbBus'

/**
 * The bus itself: picks the .glb or the procedural proxy, drives the ARRIVING
 * and STOPPED phases, and rolls the wheels from real distance travelled.
 *
 * Note on the state machine ownership:
 *   ARRIVING -> STOPPED   happens here (the vehicle is what stops)
 *   STOPPED -> ENTERING   happens here (the door is what opens)
 *   ENTERING -> DASHBOARD happens in CameraJourney.jsx
 *
 * Keeps inside <Canvas>. That matters: react/rules-of-hooks is an oxlint error
 * in this repo, and useFrame must never be called from the component that
 * renders <Canvas> itself.
 */

const FORWARD = MODEL.facesPositiveZ ? 1 : -1

export default function Bus({ hasModel }) {
  const groupRef = useRef()

  const wheelsRef = useRef([])
  const doorsRef = useRef([])

  const spin = useRef(0)
  const lastZ = useRef(null)
  const bob = useRef(0)

  const state = useAppStore((s) => s.state)
  const skipRequested = useAppStore((s) => s.skipRequested)
  const reducedMotion = useAppStore((s) => s.reducedMotion)

  /**
   * Discover wheels and doors by userData tags. Both the proxy and the .glb
   * loader tag their nodes identically, so there is only one code path.
   */
  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group) return

    const wheels = []
    const doors = []

    group.traverse((node) => {
      if (node.userData?.wheel) wheels.push(node)
      if (node.userData?.door) {
        // Remember the rest pose so Skip can jump straight to "open".
        node.userData.baseRotation = {
          x: node.rotation.x,
          y: node.rotation.y,
          z: node.rotation.z,
        }
        doors.push(node)
      }
    })

    wheelsRef.current = wheels
    doorsRef.current = doors
  }, [hasModel])

  /**
   * ARRIVING: drive down the road. The first 58% is a constant-speed cruise
   * so the bus does not lurch away from the camera, then power2.out brakes it
   * into the stop as specified.
   */
  useEffect(() => {
    if (state !== APP_STATE.ARRIVING) return

    const group = groupRef.current
    if (!group) return

    const start = TRAVEL.startZ * FORWARD
    const stop = TRAVEL.stopZ * FORWARD
    const cruise = start + (stop - start) * 0.62
    const scale = reducedMotion ? 0.15 : 1

    group.position.z = start
    lastZ.current = start
    spin.current = 0
    bob.current = 0

    // Re-arms a replay: the doors are still swung open from the last run.
    doorsRef.current.forEach((door) => {
      const base = door.userData.baseRotation ?? { x: 0, y: 0, z: 0 }
      gsap.killTweensOf(door.rotation)
      door.rotation.set(base.x, base.y, base.z)
    })

    const proxy = { z: start }
    const write = () => {
      group.position.z = proxy.z
    }

    const tl = gsap.timeline({
      onComplete: () => useAppStore.getState().setState(APP_STATE.STOPPED),
    })

    tl.to(proxy, {
      z: cruise,
      duration: TRAVEL.duration * 0.58 * scale,
      ease: 'none',
      onUpdate: write,
    }).to(proxy, {
      z: stop,
      duration: TRAVEL.duration * 0.42 * scale,
      ease: 'power2.out',
      onUpdate: write,
    })

    return () => tl.kill()
    // FORWARD is a module-level constant derived from MODEL.facesPositiveZ, so
    // it is not a valid dependency.
  }, [state, reducedMotion])

  /** STOPPED: suspension settles, then the doors swing open. */
  useEffect(() => {
    if (state !== APP_STATE.STOPPED) return

    const group = groupRef.current
    const doors = doorsRef.current
    const scale = reducedMotion ? 0.15 : 1

    const tl = gsap.timeline({
      onComplete: () => {
        const store = useAppStore.getState()
        store.setDoorOpen(true)
        store.setState(APP_STATE.ENTERING)
      },
    })

    // Brake dive / suspension rebound. Pure flavour, 0.03 m of travel.
    if (group) {
      tl.to(group.position, { y: -0.03, duration: 0.18, ease: 'power2.out' }, 0)
        .to(group.position, { y: 0, duration: 0.55, ease: 'elastic.out(1, 0.35)' }, 0.18)
    }

    if (doors.length === 0) {
      // No door node in the model. Per spec, treat it as already open.
      tl.to({}, { duration: TRAVEL.settleDuration * scale })
    } else {
      doors.forEach((door) => {
        const axis = door.userData.axis ?? 'y'
        const openAngle = door.userData.openAngle ?? 0
        tl.to(
          door.rotation,
          { [axis]: door.rotation[axis] + openAngle, duration: TRAVEL.doorDuration * scale, ease: 'power2.out' },
          TRAVEL.settleDuration * scale,
        )
      })
    }

    return () => tl.kill()
  }, [state, reducedMotion])

  /** Skip: snap the vehicle to the stop and force the doors open. */
  useEffect(() => {
    if (!skipRequested) return

    const group = groupRef.current
    const store = useAppStore.getState()

    if (group) {
      gsap.killTweensOf(group.position)
      group.position.set(0, 0, TRAVEL.stopZ * FORWARD)
    }

    doorsRef.current.forEach((door) => {
      const base = door.userData.baseRotation ?? { x: 0, y: 0, z: 0 }
      const axis = door.userData.axis ?? 'y'
      const openAngle = door.userData.openAngle ?? 0
      door.rotation.set(base.x, base.y, base.z)
      door.rotation[axis] = base[axis] + openAngle
    })

    spin.current = 0
    lastZ.current = TRAVEL.stopZ * FORWARD
    store.setDoorOpen(true)
    store.clearSkip()
    // FORWARD is a module-level constant - see the note in the ARRIVING effect.
  }, [skipRequested])

  /**
   * Per-frame: convert distance into wheel rotation, plus a small amount of
   * suspension bob that scales with speed.
   *
   * The sign: rolling forward along +Z on an axle along X needs angular
   * velocity about +X, and the pivot's local +Y maps to world -X, so the spin
   * is negated.
   */
  useFrame((_, delta) => {
    const group = groupRef.current
    if (!group) return

    const z = group.position.z
    const step = delta > 1e-5 ? delta : 1e-5

    if (lastZ.current !== null) {
      const dz = z - lastZ.current
      spin.current -= dz / BUS.wheelRadius

      const speed = Math.abs(dz) / step
      const target = Math.min(speed / 8, 1)
      bob.current += (target - bob.current) * Math.min(1, delta * 6)

      group.position.y = Math.sin(spin.current * 1.6) * 0.014 * bob.current
    }
    lastZ.current = z

    /*
     * Mutating three.js Object3D transforms is the entire point of R3F's
     * imperative escape hatch, and the React Compiler immutability lint cannot
     * tell that these nodes are engine-owned scene graph handles rather than
     * React state. Hence the disable.
     */
    // eslint-disable-next-line react/immutability
    for (const wheel of wheelsRef.current) {
      // eslint-disable-next-line react/immutability
      if (wheel) wheel.rotation.x = spin.current
    }
  })

  return (
    <group ref={groupRef} name="bus" position={[0, 0, TRAVEL.startZ * FORWARD]}>
      {hasModel ? <GlbBus /> : <ProceduralBus />}
    </group>
  )
}