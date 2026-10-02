import { Users } from '@phosphor-icons/react'
import { CROWD_LEVELS, CROWD_THRESHOLDS } from '@/config/constants'

/**
 * Occupancy for one bus, banded low / medium / high.
 *
 * `level` arrives already normalised by lib/api.js, which maps the contract's
 * "low" | "med" | "high" (and the "medium"/"MEDIUM" spellings from the earlier
 * backends) onto these keys.
 *
 * `ratio` is preferred over count/capacity when both exist, because the
 * contract's band edges are defined on the ratio and a label computed against a
 * stale capacity will not agree with the occupancy actually on board.
 *
 * The threshold ticks on the bar are the contract's own edges (0.4 and 0.75,
 * mirrored from crowd_level_for()), so the passenger can see how close the bus
 * is to tipping into the next band rather than just being told which band it is
 * in. The pulse is CSS, not WebGL, so it keeps animating when the 3D canvas is
 * on frameloop="demand".
 */
export default function CrowdIndicator({
  level = 'low',
  load = null,
  capacity = null,
  ratio = null,
  compact = false,
}) {
  const config = CROWD_LEVELS[level] ?? CROWD_LEVELS.low

  const derived =
    Number.isFinite(ratio) && ratio !== null
      ? ratio
      : Number.isFinite(load) && Number.isFinite(capacity) && capacity > 0
        ? load / capacity
        : null

  const fill = Math.min(Math.max(derived ?? 0, 0), 1)
  const hasNumbers = Number.isFinite(load) && Number.isFinite(capacity)

  if (compact) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="relative flex h-2 w-2 shrink-0">
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70"
            style={{ backgroundColor: config.color }}
          />
          <span
            className="relative inline-flex h-2 w-2 rounded-full"
            style={{ backgroundColor: config.color, boxShadow: `0 0 8px ${config.color}` }}
          />
        </span>
        <span className="text-[12px] text-gray-300">{config.label}</span>
      </span>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium tracking-wide text-gray-400 uppercase">
          Crowd level
        </span>
        <span className="text-[12px] text-gray-400">
          {hasNumbers ? `${load} / ${capacity} seats` : 'Occupancy unavailable'}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span
          className="h-3.5 w-3.5 shrink-0 rounded-full"
          style={{ backgroundColor: config.color, boxShadow: `0 0 14px ${config.ring}` }}
        />

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[15px] font-medium text-white">{config.label}</span>
            {derived !== null && (
              <span className="text-[12px] text-gray-400">{Math.round(fill * 100)}% full</span>
            )}
          </div>

          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full transition-[width] duration-700 ease-out"
              style={{
                width: `${fill * 100}%`,
                backgroundColor: config.color,
                boxShadow: `0 0 10px ${config.ring}`,
              }}
            />
            {/* contract band edges */}
            {[CROWD_THRESHOLDS.low, CROWD_THRESHOLDS.high].map((edge) => (
              <span
                key={edge}
                className="absolute top-0 h-full w-px bg-black/40"
                style={{ left: `${edge * 100}%` }}
              />
            ))}
          </div>
        </div>
      </div>

      <p className="flex items-center gap-1.5 text-[12px] text-gray-400">
        <Users size={13} />
        {level === 'low'
          ? 'Seats available, board anywhere.'
          : level === 'medium'
            ? 'Standing room filling up.'
            : 'Very crowded. Consider the next service.'}
      </p>
    </div>
  )
}
