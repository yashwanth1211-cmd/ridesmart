import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useScroll } from '@react-three/drei'
import { CAMERA, DASHBOARD_SCROLL, MODEL } from '@/config/constants'
import { useAppStore } from '@/store/appStore'

const FORWARD = MODEL.facesPositiveZ ? 1 : -1

/**
 * Scroll-driven camera parallax for the horizontal dashboard horizon.
 *
 * The camera is parked (in-aisle pose, CAMERA.WAYPOINTS[6]) when this mounts,
 * so no journey code is fighting it. useScroll().offset runs 0..1 across the
 * three pages; the camera dollies sideways by -parallaxX..+parallaxX and aims
 * past the dashboard by -parallaxLookX..+parallaxLookX, damped at a slightly
 * higher rate than drei's DOM spring so the pages read as sliding PAST the
 * camera rather than the camera merely following them.
 *
 * Thousands of the y/z are never touched, so the lens cannot clip the roof or
 * dive into the road, and x stays within +/- BUS.halfWidth (see
 * DASHBOARD_SCROLL in constants). In demand-frameloop mode this invalidates
 * once per convergence step and stops the moment the pose settles.
 *
 * It also reports the current page into the store (rounded index over the
 * offset range) so the DOM handoff pill can light the right dot.
 */
export default function ScrollParallax() {
  const scroll = useScroll()
  const camera = useThree((state) => state.camera)
  const invalidate = useThree((state) => state.invalidate)
  const reducedMotion = useAppStore((s) => s.reducedMotion)
  const setDashboardPage = useAppStore((s) => s.setDashboardPage)

  const base = useMemo(
    () => new THREE.Vector3(CAMERA.WAYPOINTS[6][0], CAMERA.WAYPOINTS[6][1], CAMERA.WAYPOINTS[6][2] * FORWARD),
    [],
  )
  const lookBase = useMemo(
    () => new THREE.Vector3(CAMERA.LOOKAT[6][0], CAMERA.LOOKAT[6][1], CAMERA.LOOKAT[6][2] * FORWARD),
    [],
  )
  const lookAt = useRef(new THREE.Vector3())
  const page = useRef(-1)

  useFrame((_, delta) => {
    const scale = reducedMotion ? DASHBOARD_SCROLL.reducedMotionScale : 1
    const drift = (scroll.offset - 0.5) * 2

    const targetX = base.x + drift * DASHBOARD_SCROLL.parallaxX * scale
    const targetLookX = lookBase.x + drift * DASHBOARD_SCROLL.parallaxLookX * scale

    const nextX = THREE.MathUtils.damp(camera.position.x, targetX, DASHBOARD_SCROLL.parallaxDamping, delta)
    const nextLookX = THREE.MathUtils.damp(lookAt.current.x, targetLookX, DASHBOARD_SCROLL.parallaxDamping, delta)

    camera.position.set(nextX, base.y, base.z)
    lookAt.current.set(nextLookX, lookBase.y, lookBase.z)
    camera.lookAt(lookAt.current)

    const nextPage = THREE.MathUtils.clamp(
      Math.round(scroll.offset * (scroll.pages - 1)),
      0,
      scroll.pages - 1,
    )
    if (nextPage !== page.current) {
      page.current = nextPage
      setDashboardPage(nextPage)
    }

    if (Math.abs(nextX - targetX) > 0.0002 || Math.abs(nextLookX - targetLookX) > 0.0002) invalidate()
  })

  return null
}