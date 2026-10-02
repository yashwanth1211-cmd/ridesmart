import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import gsap from 'gsap'
import { APP_STATE, CAMERA, MODEL } from '@/config/constants'
import { useAppStore } from '@/store/appStore'

/**
 * The camera move from the street, through the doorway, into the aisle.
 *
 * Two Catmull-Rom curves are sampled with a single t, so the camera can dolly
 * and pan independently - a path defined only by positions would force the
 * look-at to swing wildly whenever the dolly direction changes.
 *
 * A single GSAP timeline owns the whole move and tweens one scalar, `t`.
 * useFrame reads that scalar and does the actual camera writes. Tweening the
 * camera's position directly would fight React's reconciler, and would make
 * "Skip" impossible without recreating the state.
 *
 * See CAMERA.WAYPOINTS / CAMERA.LOOKAT in src/config/constants.js - that is
 * the only place to edit when you swap in your real .glb.
 */

const FORWARD = MODEL.facesPositiveZ ? 1 : -1

function toVectors(list) {
  return list.map(([x, y, z]) => new THREE.Vector3(x, y, z * FORWARD))
}

export default function CameraJourney() {
  const camera = useThree((state) => state.camera)
  const invalidate = useThree((state) => state.invalidate)

  const state = useAppStore((s) => s.state)
  const skipRequested = useAppStore((s) => s.skipRequested)
  const reducedMotion = useAppStore((s) => s.reducedMotion)

  const progress = useRef(0)
  const active = useRef(false)
  const lookTarget = useMemo(() => new THREE.Vector3(), [])

  const positionCurve = useMemo(
    () =>
      new THREE.CatmullRomCurve3(
        toVectors(CAMERA.WAYPOINTS),
        false,
        CAMERA.curveType,
        CAMERA.curveTension,
      ),
    // FORWARD is module-constant; excluding it keeps the identity stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const lookCurve = useMemo(
    () =>
      new THREE.CatmullRomCurve3(
        toVectors(CAMERA.LOOKAT),
        false,
        CAMERA.curveType,
        CAMERA.curveTension,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  /** Places the camera at a point on the path. */
  const applyProgress = (t) => {
    positionCurve.getPointAt(THREE.MathUtils.clamp(t, 0, 1), camera.position)
    lookCurve.getPointAt(THREE.MathUtils.clamp(t, 0, 1), lookTarget)
    camera.lookAt(lookTarget)
    camera.updateMatrixWorld()
  }

  // Snap to the opening frame before the first paint, so there is no flash of
  // the default R3F camera position.
  useLayoutEffect(() => {
    progress.current = 0
    applyProgress(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Re-arm the journey when the sequence is replayed from the top. */
  useEffect(() => {
    if (state !== APP_STATE.ARRIVING) return
    progress.current = 0
    active.current = false
    applyProgress(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  /** ENTERING: build and run the master timeline. */
  useEffect(() => {
    if (state !== APP_STATE.ENTERING) return

    const duration = CAMERA.journeyDuration * (reducedMotion ? 0.15 : 1)
    let lastReported = -1

    active.current = true
    progress.current = 0

    const tl = gsap.timeline({
      delay: CAMERA.startDelay * (reducedMotion ? 0.15 : 1),
      onUpdate: () => {
        progress.current = tl.progress()
        // Report to the store at ~1% granularity so the HUD bar updates
        // without re-rendering React on every frame.
        const rounded = Math.round(progress.current * 100)
        if (rounded !== lastReported) {
          lastReported = rounded
          useAppStore.getState().setJourneyProgress(rounded / 100)
        }
      },
      onComplete: () => {
        active.current = false
        progress.current = 1
        const store = useAppStore.getState()
        store.setJourneyProgress(1)
        store.setState(APP_STATE.DASHBOARD)
        // Canvas switches to demand mode at this point, so ask for one more
        // frame to make sure the final camera pose is actually rasterised.
        invalidate()
      },
    })

    // `none` because the curve already carries all the easing character -
    // any GSAP ease on top would fight it and produce a visible lurch.
    tl.to(progress, { current: 1, duration, ease: 'none' })

    return () => {
      active.current = false
      tl.kill()
    }
  }, [state, reducedMotion, invalidate])

  /** Skip: jump straight to the final in-aisle pose. */
  useEffect(() => {
    if (!skipRequested) return
    progress.current = 1
    applyProgress(1)
    useAppStore.getState().clearSkip()
    invalidate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipRequested, invalidate])

  useFrame(() => {
    if (!active.current) return
    applyProgress(progress.current)
  })

  return null
}