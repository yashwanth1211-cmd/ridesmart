import { Suspense, useEffect } from 'react'
import * as THREE from 'three'
import { Canvas, useThree } from '@react-three/fiber'
import { useProgress } from '@react-three/drei'
import { APP_STATE, CAMERA, LIGHTING, RENDER } from '@/config/constants'
import { useAppStore } from '@/store/appStore'
import Backdrop from './Backdrop'
import Road from './Road'
import Bus from './Bus'
import CameraJourney from './CameraJourney'

/**
 * Canvas, golden-hour lighting, environment and the frame budget policy.
 *
 * Lighting is tuned to match the reference photo: a low warm key at #ffb067
 * with soft shadows, a warm hemisphere bounce so the shadow side never goes
 * black, and a cool rim from the opposite side to cut the bus silhouette out
 * of the backdrop. All values live in LIGHTING in src/config/constants.js.
 */

function Lights() {
  return (
    <>
      <ambientLight color={LIGHTING.ambient.color} intensity={LIGHTING.ambient.intensity} />

      <hemisphereLight
        args={[LIGHTING.hemisphere.sky, LIGHTING.hemisphere.ground, LIGHTING.hemisphere.intensity]}
      />

      {/* Key. Carries the shadow map - one shadow-casting light only, because
          every extra one doubles the shadow cost for little visual gain. */}
      <directionalLight
        color={LIGHTING.sun.color}
        intensity={LIGHTING.sun.intensity}
        position={LIGHTING.sun.position}
        castShadow
        shadow-mapSize-width={LIGHTING.shadow.mapSize}
        shadow-mapSize-height={LIGHTING.shadow.mapSize}
        shadow-camera-left={LIGHTING.shadow.camera.left}
        shadow-camera-right={LIGHTING.shadow.camera.right}
        shadow-camera-top={LIGHTING.shadow.camera.top}
        shadow-camera-bottom={LIGHTING.shadow.camera.bottom}
        shadow-camera-near={LIGHTING.shadow.camera.near}
        shadow-camera-far={LIGHTING.shadow.camera.far}
        shadow-bias={LIGHTING.shadow.bias}
        shadow-normalBias={LIGHTING.shadow.normalBias}
      />

      {/* Cool fill from the opposite side. No shadow map - this is purely for
          edge separation against the warm backdrop. */}
      <directionalLight
        color={LIGHTING.rim.color}
        intensity={LIGHTING.rim.intensity}
        position={LIGHTING.rim.position}
      />
    </>
  )
}

/**
 * Sits inside <Suspense>, so its effect only runs once the GLTF and texture
 * have actually resolved. That is the correct moment to leave LOADING.
 */
function AssetGate() {
  const { progress, active, item } = useProgress()
  const setState = useAppStore((s) => s.setState)

  useEffect(() => {
    useAppStore.getState().setProgress({ active, loaded: progress, total: 100, item })
  }, [progress, active, item])

  useEffect(() => {
    setState(APP_STATE.ARRIVING)
  }, [setState])

  return null
}

/**
 * Once the camera is parked, the canvas runs on demand. Anything that
 * repaints the 3D layer (the handoff pill's live data ticking over) bumps
 * dataVersion to ask for exactly one more frame.
 */
function DemandInvalidator() {
  const invalidate = useThree((s) => s.invalidate)
  const dataVersion = useAppStore((s) => s.dataVersion)

  useEffect(() => {
    invalidate()
  }, [dataVersion, invalidate])

  return null
}

export default function Scene({ hasModel, hasTexture }) {
  const interactive = useAppStore((s) => s.interactive)

  return (
    <Canvas
      // Explicit type: R3F's boolean `shadows` resolves to PCFSoftShadowMap,
      // which three 0.186 removed. PCFShadowMap is the soft-filtered option
      // that still exists.
      shadows={{ type: THREE.PCFShadowMap }}
      dpr={interactive ? RENDER.dashboardDpr : RENDER.activeDpr}
      frameloop={interactive ? 'demand' : 'always'}
      gl={{
        antialias: RENDER.antialias,
        powerPreference: 'high-performance',
        alpha: false,
      }}
      camera={{
        fov: CAMERA.fov,
        near: CAMERA.near,
        far: CAMERA.far,
        position: CAMERA.WAYPOINTS[0],
      }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = 1.05
      }}
    >
      <color attach="background" args={[LIGHTING.fog.color]} />
      <fog attach="fog" args={[LIGHTING.fog.color, LIGHTING.fog.near, LIGHTING.fog.far]} />

      <Lights />

      <Suspense fallback={null}>
        <Backdrop hasTexture={hasTexture} />
        <Bus hasModel={hasModel} />
        <AssetGate />
      </Suspense>

      <Road />
      <CameraJourney />
      <DemandInvalidator />
    </Canvas>
  )
}