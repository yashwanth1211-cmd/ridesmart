import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight } from '@phosphor-icons/react'

/**
 * The cinematic intro IS the uploaded video, nothing else. public/ui.mp4 plays
 * fullscreen on load - no generated title, no staged copy - and hands off to
 * the dashboard, where the same video keeps looping behind the panels.
 *
 * There is no 3D anywhere: the intro and the console are both built directly
 * on the video you provided.
 */
export default function Intro() {
  const navigate = useNavigate()
  const [videoEnded, setVideoEnded] = useState(false)

  useEffect(() => {
    document.title = 'RideSmart'
  }, [])

  const enter = () => navigate('/app')

  useEffect(() => {
    if (videoEnded) {
      const timer = setTimeout(() => navigate('/app'), 600)
      return () => clearTimeout(timer)
    }
  }, [videoEnded, navigate])

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-black">
      <video
        src="/ui.mp4"
        autoPlay
        muted
        loop
        playsInline
        poster="/ui-final.png"
        onEnded={() => setVideoEnded(true)}
        className="absolute inset-0 h-full w-full object-cover"
      />

      {/* The only control: a quiet handoff into the same video as the dashboard. */}
      <button
        type="button"
        onClick={enter}
        className="absolute right-4 bottom-4 inline-flex h-11 items-center gap-2 rounded-xl border border-white/15 bg-black/45 px-5 text-[13px] font-medium text-white backdrop-blur-md transition-colors hover:bg-white/10"
      >
        Open dashboard
        <ArrowRight size={15} className="text-amber-300" />
      </button>
    </div>
  )
}