import { Bus, SkipForward } from '@phosphor-icons/react'
import { APP_STATE } from '@/config/constants'
import { useAppStore } from '@/store/appStore'

/**
 * Loading screen with a Skip Intro escape hatch.
 *
 * The progress figure is mirrored out of drei's useProgress by the AssetGate
 * inside <Canvas>, so it can be read here in the DOM. When the scene is using
 * the procedural bus and the texture is served from /public, useProgress has
 * nothing to report and the bar switches to an indeterminate shimmer.
 */

function SkipButton({ className = '' }) {
  const skipIntro = useAppStore((s) => s.skipIntro)

  return (
    <button
      type="button"
      onClick={skipIntro}
      className={`inline-flex h-10 items-center gap-2 rounded-xl bg-black/40 px-4 text-[13px] font-medium text-white backdrop-blur-xl border border-white/10 shadow-2xl transition-colors hover:bg-black/60 glow-blue ${className}`}
    >
      <SkipForward size={15} weight="fill" />
      Skip intro
    </button>
  )
}

function ProgressBar() {
  const progress = useAppStore((s) => s.progress)

  // drei reports 0..100. Anything else means nothing is queued yet.
  const determinate = progress.total > 0 && progress.loaded > 0
  const pct = determinate ? Math.min(100, Math.round(progress.loaded)) : 0

  return (
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-white/10"
      role="progressbar"
      aria-label="Loading 3D scene"
      aria-valuenow={determinate ? pct : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full bg-brand-blue glow-blue transition-[width] duration-300 ${
          determinate ? '' : 'w-1/3 animate-[shimmer_1.4s_linear_infinite]'
        }`}
        style={determinate ? { width: `${pct}%` } : undefined}
      />
    </div>
  )
}

export function OverlayLoader() {
  const progress = useAppStore((s) => s.progress)

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-8 bg-black/70 backdrop-blur-2xl">
      <div className="flex flex-col items-center gap-4 px-8">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-blue text-white glow-blue">
          <Bus size={24} weight="fill" />
        </span>
        <div className="flex flex-col items-center gap-1">
          <h1 className="text-xl font-medium tracking-tight text-white">RideSmart</h1>
          <p className="text-[13px] text-gray-300">
            {progress.item ? 'Loading bus model' : 'Preparing the boarding sequence'}
          </p>
        </div>
      </div>

      <div className="w-64 px-8">
        <ProgressBar />
      </div>

      <div className="pointer-events-auto">
        <SkipButton />
      </div>
    </div>
  )
}

const PHASE_COPY = {
  [APP_STATE.ARRIVING]: { label: 'Approaching', hint: 'Bus inbound to your stop' },
  [APP_STATE.STOPPED]: { label: 'At the kerb', hint: 'Doors opening' },
  [APP_STATE.ENTERING]: { label: 'Boarding', hint: 'Mind the step' },
}

/**
 * Non-interactive caption shown while the camera is still moving. Pairs with
 * the loader - both are pointer-events-none except for the Skip button, so the
 * canvas stays live underneath.
 */
export function SequenceHud() {
  const state = useAppStore((s) => s.state)
  const journeyProgress = useAppStore((s) => s.journeyProgress)
  const doorOpen = useAppStore((s) => s.doorOpen)
  const copy = PHASE_COPY[state] ?? PHASE_COPY[APP_STATE.ARRIVING]

  // Fade out the hint once we are inside, so it does not sit over the dashboard.
  const visible = state !== APP_STATE.DASHBOARD

  return (
    <div
      className={`absolute inset-0 z-20 transition-opacity duration-700 ${
        visible ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    >
      <div className="pointer-events-auto absolute top-6 right-6">
        <SkipButton />
      </div>

      <div className="pointer-events-none absolute bottom-8 left-8 flex flex-col gap-3">
        <div className="glass-panel flex items-center gap-3 px-4 py-3">
          <span className="flex h-2 w-2 items-center">
            <span className="h-2 w-2 animate-ping rounded-full bg-brand-blue" />
            <span className="h-2 w-2 rounded-full bg-brand-blue" />
          </span>
          <div className="flex flex-col">
            <span className="text-[13px] font-medium text-white">{copy.label}</span>
            <span className="text-[11px] text-gray-300">
              {doorOpen ? 'Doors open' : copy.hint}
            </span>
          </div>
        </div>

        {state === APP_STATE.ENTERING && (
          <div className="h-0.5 w-40 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-brand-blue glow-blue"
              style={{ width: `${journeyProgress * 100}%` }}
            />
          </div>
        )}
      </div>
    </div>
  )
}