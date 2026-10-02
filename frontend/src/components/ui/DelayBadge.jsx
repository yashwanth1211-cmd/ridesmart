import { Warning, CheckCircle, ArrowDown, ArrowUp } from '@phosphor-icons/react'

/**
 * Signed delay badge, driven by PlanOption.delay_min.
 *
 * This is a real, contract-backed number: delay_min is eta_min minus
 * eta_scheduled_min, where eta_min accumulates OBSERVED segment travel times
 * from segment_stat and eta_scheduled_min comes from the timetable. So this is
 * a measured comparison, not a guess - which is why it came back after being
 * removed when the older backend had no delay field at all.
 *
 * Negative means running early. That is deliberately shown rather than clamped:
 * "3 min early" is useful information, and hiding it would make the badge lie
 * about the sign of the number it is displaying.
 */
export default function DelayBadge({ minutes, scheduledMin = null, predictedMin = null, size = 'sm' }) {
  const value = Number.isFinite(minutes) ? Math.round(minutes) : 0
  const late = value > 0
  const early = value < 0
  const onTime = value === 0

  const Icon = onTime ? CheckCircle : early ? ArrowDown : late ? Warning : null

  const tone = onTime
    ? 'bg-ok-soft text-ok'
    : late
      ? 'bg-brand-red/20 text-busy'
      : 'bg-brand-blue/20 text-accent'

  const label = onTime ? 'On time' : late ? `+${value} min late` : `${Math.abs(value)} min early`

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium ${tone} ${
        size === 'sm' ? 'text-[11px]' : 'text-[12px]'
      }`}
      title={
        Number.isFinite(scheduledMin) && Number.isFinite(predictedMin)
          ? `Predicted ${predictedMin} min vs ${scheduledMin} min scheduled`
          : undefined
      }
    >
      {Icon ? <Icon size={size === 'sm' ? 12 : 13} /> : <ArrowUp size={12} />}
      {label}
    </span>
  )
}
