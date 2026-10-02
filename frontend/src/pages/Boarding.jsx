import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Warning, ArrowRight } from '@phosphor-icons/react'
import Scene from '@/components/3d/Scene'
import { OverlayLoader, SequenceHud } from '@/components/ui/OverlayLoader'
import { APP_STATE, BACKDROP, DASHBOARD_SCROLL, MODEL } from '@/config/constants'
import { useAppStore } from '@/store/appStore'
import { probeAssets } from '@/lib/assets'
import { useDocumentTitle } from '@/lib/useDocumentTitle'

/**
 * Page that owns the whole experience: probes the optional assets, forces dark
 * mode, and mounts the 3D scene plus whichever DOM overlay the current state
 * calls for.
 *
 * The asset probe lives here rather than inside <Canvas> so the bus and
 * backdrop are never mounted with a guessed URL - which also means the loader
 * can cover the gap instead of showing a half-built scene.
 */

function WebGLFallback() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-8 text-center">
      <Warning size={28} className="text-warn" />
      <p className="text-[14px] font-medium text-white">WebGL is unavailable</p>
      <p className="max-w-sm text-[13px] leading-relaxed text-gray-300">
        This browser could not create a WebGL context, so the 3D boarding scene cannot run. Enable
        hardware acceleration or try a different browser.
      </p>
    </div>
  )
}

/**
 * The door opens onto the app.
 *
 * Originally a full-screen modal; now a compact floating bar because the
 * dashboard itself fills the canvas behind it as a horizontal scroll. The bar
 * keeps the E2E-pinned handoff narrative ("Doors open" / "You're on board." /
 * a "Plan a journey" button that walks into /app) while adding page dots that
 * track the 3D scroll parallax, so it reads as the dashboard's header rather
 * than a dead-end overlay.
 */
function SequenceEnd({ modelSource, onContinue }) {
  const dashboardPage = useAppStore((s) => s.dashboardPage)
  const labels = DASHBOARD_SCROLL.pageLabels

  return (
    <div className="pointer-events-none absolute inset-x-0 top-4 z-40 flex justify-center px-4">
      <div className="glass-panel-strong pointer-events-auto flex max-w-full flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-white/10 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-brand-red/80 px-2 py-0.5 text-[10px] font-medium tracking-wide text-white uppercase">
            Doors open
          </span>
          <span className="text-[13px] font-medium whitespace-nowrap text-white">You're on board.</span>
        </div>

        <div className="flex items-center gap-2" aria-label="Dashboard pages">
          <div className="flex items-center gap-1.5">
            {labels.map((label, i) => (
              <span
                key={label}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === dashboardPage ? 'w-4 bg-brand-blue glow-blue' : 'w-1.5 bg-white/25'
                }`}
              />
            ))}
          </div>
          <span className="text-[11px] text-gray-400">{labels[dashboardPage]}</span>
        </div>

        <span className="hidden text-[11px] text-gray-500 xl:inline">
          {modelSource === 'glb' ? 'Live bus model' : 'Procedural bus'} · Bengaluru
        </span>

        <button
          type="button"
          onClick={onContinue}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-blue/80 px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-brand-blue"
        >
          Plan a journey
          <ArrowRight size={14} />
        </button>
      </div>
    </div>
  )
}

export default function Boarding() {
  const [assets, setAssets] = useState(null)
  const navigate = useNavigate()

  const state = useAppStore((s) => s.state)
  const interactive = useAppStore((s) => s.interactive)
  const modelSource = useAppStore((s) => s.modelSource)

  // Bumped only by store.reset(). Changing the key tears the whole Canvas down
  // and rebuilds it, which is the only way to get a genuinely cold scene - a
  // plain state reset would leave the previous GLTF and textures resident.
  const [sceneKey, setSceneKey] = useState(0)

  useDocumentTitle('RideSmart / Boarding')

  // Probe once per scene mount. Sets the GLB-vs-proxy branch and records which
  // one is live so the dashboard can surface it. Re-runs when the Canvas is
  // rebuilt via sceneKey.
  useEffect(() => {
    let cancelled = false

    probeAssets({ model: MODEL.url, texture: BACKDROP.texture }).then((result) => {
      if (cancelled) return
      setAssets(result)
      useAppStore.getState().setModelSource(result.model ? 'glb' : 'proxy')
    })

    return () => {
      cancelled = true
    }
  }, [sceneKey])

  // The scene is strict dark mode regardless of the rest of the app's theme.
  useEffect(() => {
    const root = document.documentElement
    const previous = root.dataset.theme
    root.dataset.theme = 'dark'
    return () => {
      root.dataset.theme = previous
    }
  }, [])

  // prefers-reduced-motion collapses every sequence duration.
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => useAppStore.getState().setReducedMotion(query.matches)

    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])

  // Watch for an explicit cold reset and rebuild the scene around it.
  useEffect(() => useAppStore.subscribe((s, prev) => {
    if (s.state === APP_STATE.LOADING && prev.state !== APP_STATE.LOADING) {
      setAssets(null)
      setSceneKey((k) => k + 1)
    }
  }), [])

  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas">
      {assets && (
        <Scene
          key={sceneKey}
          hasModel={assets.model}
          hasTexture={assets.texture}
          fallback={<WebGLFallback />}
        />
      )}

      {state === APP_STATE.LOADING && <OverlayLoader />}
      {/*
        Unmounted outright once the dashboard is live rather than merely faded
        out. A faded-out overlay keeps its Skip button focusable, which leaves
        an invisible tab stop sitting in front of the dashboard.
      */}
      {state !== APP_STATE.LOADING && state !== APP_STATE.DASHBOARD && <SequenceHud />}
      {interactive && state === APP_STATE.DASHBOARD && (
        <SequenceEnd modelSource={modelSource} onContinue={() => navigate('/app')} />
      )}
    </div>
  )
}