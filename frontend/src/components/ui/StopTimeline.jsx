import { Wheelchair } from '@phosphor-icons/react'

/**
 * Per-stop arrival times for the selected option.
 *
 * PlanOption.stops[] is minutes REMAINING from boarding, so it counts down to 0
 * at the destination - which is why the last row is the arrival itself. The
 * numbers come from observed segment travel times accumulated along the path, so
 * a slow segment shows up as a bigger jump between two consecutive stops.
 */
export default function StopTimeline({ stops = [], etas = {} }) {
  if (!stops.length) return null

  return (
    <ol className="flex flex-col">
      {stops.map((stop, index) => {
        const isFirst = index === 0
        const isLast = index === stops.length - 1

        /*
          Merge in the live trip's per-stop figures when they exist.
          PlanOption.stops[] only has eta_min (minutes remaining); the trip
          endpoint adds scheduled vs predicted and a signed delay, so the
          passenger can see the bus is recovering time or falling further behind
          at a specific stop rather than just being told an ETA.
        */
        const live = etas[stop.stopId] ?? null
        const delay = live?.delayMin ?? 0

        return (
          <li key={stop.stopId ?? stop.name} className="flex gap-3">
            {/* rail */}
            <div className="flex flex-col items-center pt-1.5">
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                  isFirst
                    ? 'bg-brand-blue glow-blue'
                    : isLast
                      ? 'bg-brand-red'
                      : 'bg-white/25'
                }`}
              />
              {!isLast && <span className="my-1 w-px flex-1 border-l border-dashed border-white/20" />}
            </div>

            <div className={`flex min-w-0 flex-1 items-baseline justify-between gap-3 ${isLast ? '' : 'pb-3'}`}>
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className={`truncate text-[12px] ${
                    isFirst || isLast ? 'font-medium text-white' : 'text-gray-300'
                  }`}
                >
                  {stop.name}
                </span>
                {stop.accessible && (
                  <Wheelchair size={11} className="shrink-0 text-accent" aria-label="Accessible stop" />
                )}
              </span>

              <span className="flex shrink-0 items-center gap-2 text-[12px] text-gray-400">
                {/*
                  Only show a delay marker where one is non-zero. A column of
                  repeated "on time" chips is noise; the absence of one already
                  means on time.
                */}
                {Number.isFinite(live?.delayMin) && delay !== 0 && !isLast && (
                  <span
                    className={`text-[11px] ${delay > 0 ? 'text-busy' : 'text-ok'}`}
                    title={`Scheduled ${live.scheduledMin} min · predicted ${live.predictedMin} min`}
                  >
                    {delay > 0 ? `+${delay}` : delay} min
                  </span>
                )}

                {isFirst
                  ? `board here${Number.isFinite(live?.predictedMin) ? ` · ${live.predictedMin} min` : Number.isFinite(stop.etaMin) ? ` · ${stop.etaMin} min` : ''}`
                  : isLast
                    ? 'arrive'
                    : Number.isFinite(live?.predictedMin)
                      ? `${live.predictedMin} min`
                      : stop.etaMin === null
                        ? '—'
                        : `${stop.etaMin} min`}
              </span>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
