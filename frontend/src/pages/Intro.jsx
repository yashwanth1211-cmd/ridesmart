import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight } from '@phosphor-icons/react'

/**
 * The cinematic intro IS the uploaded video, nothing else. The trimmed
 * public/ui.mp4 (the provided video minus its last two seconds) plays
 * fullscreen on load - no generated title, no staged copy. When it ends it
 * fades straight into the dashboard, which keeps the same video looping behind
 * the panels, so the two read as one continuous shot.
 *
 * There is no 3D anywhere: the intro and the console are both built directly
 * on the video you provided.
 */
const EXIT_MS = 700

export default function Intro() {
  const navigate = useNavigate()
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    document.title = 'RideSmart'
  }, [])

  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => navigate('/app'), EXIT_MS)
    return () => clearTimeout(timer)
  }, [leaving, navigate])

  return (
    <div
      className={`relative h-dvh w-full overflow-hidden bg-black transition-opacity duration-700 ${
        leaving ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <video
        src="/ui.mp4"
        autoPlay
        muted
        playsInline
        poster="/ui-final.png"
        onEnded={() => setLeaving(true)}
        className="absolute inset-0 h-full w-full object-cover"
      />

      {/* Same dark veil the dashboard sits under, so the crossfade has nowhere to jump. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, rgba(8,6,4,0.55), rgba(10,8,6,0.2) 48%, rgba(8,6,4,0.55))',
        }}
      />

      {/* The only control: a quiet handoff into the same video as the dashboard. */}
      <button
        type="button"
        onClick={() => setLeaving(true)}
        className="absolute right-4 bottom-4 inline-flex h-11 items-center gap-2 rounded-xl border border-white/15 bg-black/45 px-5 text-[13px] font-medium text-white backdrop-blur-md transition-colors hover:bg-white/10"
      >
        Open dashboard
        <ArrowRight size={15} className="text-amber-300" />
      </button>
    </div>
  )
}