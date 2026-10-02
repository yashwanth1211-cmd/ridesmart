import { CloudSlash, Broadcast } from '@phosphor-icons/react'

/**
 * Says where the numbers on screen came from.
 *
 * This exists because the planner falls back to demo data when the API is
 * unreachable. Without a visible marker, a failed fetch would leave realistic
 * looking ETAs on screen that came from nowhere - which is the one thing a
 * transit app must never do. Anything that can show invented data shows this
 * badge next to it.
 */
export default function SourceBadge({ source, error = null, className = '' }) {
  if (source === 'api') {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-md bg-ok-soft px-2 py-0.5 text-[11px] font-medium text-ok ${className}`}
      >
        <Broadcast size={11} />
        API live
      </span>
    )
  }

  if (source === 'pending') {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-medium text-gray-300 ${className}`}
      >
        Connecting…
      </span>
    )
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md bg-brand-red/20 px-2 py-0.5 text-[11px] font-medium text-busy ${className}`}
      title={error ?? 'RideSmart API unreachable — showing demo data'}
    >
      <CloudSlash size={11} />
      Offline · demo data
    </span>
  )
}
