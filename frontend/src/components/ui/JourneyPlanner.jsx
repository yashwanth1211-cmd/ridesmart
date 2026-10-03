import { useMemo, useState } from 'react'
import {
  ArrowsLeftRight,
  Wheelchair,
  Sliders,
  Sparkle,
  WarningCircle,
  CheckCircle,
} from '@phosphor-icons/react'
import CrowdIndicator from './CrowdIndicator'
import DelayBadge from './DelayBadge'
import OptionCard from './OptionCard'
import PredictionBadge from './PredictionBadge'
import SourceBadge from './SourceBadge'
import StopTimeline from './StopTimeline'
import { useTripEtas } from '@/lib/useTripEtas'

/**
 * The passenger journey planner: pick two stops, get every ranked option.
 *
 * Presentational on purpose. The journey state is owned by the Dashboard shell
 * so the live map can draw the same selected route without a second useJourney
 * instance polling the API independently.
 *
 * Two rules from the contract are treated as non-negotiable:
 *
 *  1. "The UI must render every entry - showing one option defeats the purpose
 *     of the feature." The list never collapses to a single winner; the fastest
 *     is preselected but every alternative stays visible and one click away.
 *  2. The seed's whole point is that V1 is faster-but-packed and V2 is
 *     slower-but-empty. Neither dominates, so ranking on ETA alone and hiding
 *     the empty one would delete the decision the product exists to present.
 */

function StopSelect({ label, value, stops, onChange, id }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1.5" htmlFor={id}>
      <span className="text-[11px] tracking-wide text-gray-400 uppercase">{label}</span>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-lg border border-white/10 bg-black/40 px-3 text-[13px] text-white focus:border-brand-blue focus:outline-none"
      >
        {stops.length === 0 && <option value={value}>{value}</option>}
        {stops.map((stop) => (
          <option key={stop.code} value={stop.code} className="bg-gray-900">
            {/* A campus anchor is a real place but not a surveyed bus bay, so
                say so in the picker rather than implying we mapped one. */}
            {stop.name}
            {stop.kind === 'campus' ? ' (campus stop)' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}

export default function JourneyPlanner({
  journey,
  stops = [],
  buses = [],
  from,
  to,
  onFromChange,
  onToChange,
  accessibilityOnly,
  onAccessibilityOnlyChange,
}) {
  const [notice, setNotice] = useState(null)

  const { plan, options, selected, selectOption, source, isLive, error, loading, overriding, overrideCrowd } =
    journey

  /** The live trip serving the selected route, needed for the crowd override. */
  const activeTrip = useMemo(() => {
    if (!selected?.code) return null
    return buses.find((b) => b.routeCode === selected.code && b.tripId) ?? null
  }, [buses, selected])

  /*
    Per-stop delay for that trip. Returns {} when there is no active trip, in
    which case StopTimeline falls back to the planner's own eta_min values and
    simply shows no delay markers.
  */
  const tripEtas = useTripEtas(activeTrip?.tripId)

  const runOverride = async (load) => {
    setNotice(null)
    const result = await overrideCrowd(activeTrip.tripId, load)
    setNotice(
      result.ok
        ? {
            ok: true,
            text: `${selected.code} set to ${load} passengers. Options re-planned.`,
          }
        : { ok: false, text: result.message },
    )
  }

  const sameStop = from === to

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* ---- search bar ---- */}
      <section className="glass-panel flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <StopSelect id="planner-from" label="From" value={from} stops={stops} onChange={onFromChange} />

          <button
            type="button"
            onClick={() => {
              onFromChange(to)
              onToChange(from)
            }}
            aria-label="Swap origin and destination"
            className="mb-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ArrowsLeftRight size={15} />
          </button>

          <StopSelect id="planner-to" label="To" value={to} stops={stops} onChange={onToChange} />

          <label className="mb-0.5 inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-white/10 px-3 text-[12px] text-gray-300 transition-colors hover:bg-white/10">
            <input
              type="checkbox"
              checked={accessibilityOnly}
              onChange={(event) => onAccessibilityOnlyChange(event.target.checked)}
              className="accent-brand-blue"
            />
            <Wheelchair size={14} />
            Accessible only
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
          <SourceBadge source={source} error={error} />
          {isLive && (
            <span>
              {options.length} option{options.length === 1 ? '' : 's'} · sorted by ETA
            </span>
          )}
          {plan.generatedAt && <span>updated {new Date(plan.generatedAt).toLocaleTimeString()}</span>}
        </div>

        {error && source === 'api' && (
          <p
            className="flex items-center gap-1.5 rounded-lg bg-brand-red/10 px-3 py-2 text-[12px] text-busy"
            role="alert"
          >
            <WarningCircle size={13} />
            {error}
          </p>
        )}

        {sameStop && (
          <p className="rounded-lg bg-white/5 px-3 py-2 text-[12px] text-gray-300">
            Pick two different stops to plan a journey.
          </p>
        )}
      </section>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ---- ranked options ---- */}
        <section className="glass-panel flex min-h-0 flex-col gap-3 p-4">
          <header className="flex items-center justify-between gap-3">
            <h2 className="text-[13px] font-medium text-white">Journey options</h2>
            <span className="text-[11px] text-gray-400">
              {loading ? 'Planning…' : `${options.length} found`}
            </span>
          </header>

          <p className="text-[11px] leading-relaxed text-gray-500">
            Every option is shown, not just the fastest. Pick the trade-off that suits you right now.
          </p>

          <ul className="scroll-slim -mr-2 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-2">
            {options.map((option, index) => (
              <li key={option.id}>
                <OptionCard
                  option={option}
                  rank={index + 1}
                  selected={option.id === selected?.id}
                  onSelect={() => selectOption(option.id)}
                />
              </li>
            ))}

            {options.length === 0 && !loading && (
              <li className="rounded-lg border border-dashed border-white/10 px-4 py-8 text-center">
                <p className="text-[13px] text-gray-300">
                  No route connects these two stops in that direction.
                </p>
                <p className="mt-1 text-[11px] text-gray-500">
                  Buses do not run backwards — try swapping them.
                </p>
              </li>
            )}
          </ul>
        </section>

        {/* ---- selected option detail ---- */}
        <section className="glass-panel flex min-h-0 flex-col gap-4 overflow-y-auto p-4 scroll-slim">
          {selected ? (
            <>
              <header className="flex flex-col gap-1">
                <span className="text-[11px] tracking-wide text-gray-400 uppercase">Selected</span>
                <h2 className="text-[18px] font-medium text-white">
                  {selected.code}
                  {selected.name ? (
                    <span className="ml-2 text-[13px] font-normal text-gray-300">{selected.name}</span>
                  ) : null}
                </h2>
              </header>

              <div className="glass-inset flex items-end justify-between gap-3 p-3">
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] tracking-wide text-gray-400 uppercase">Arriving in</span>
                  <span className="text-3xl leading-none font-medium tracking-tight text-white">
                    {selected.etaMin ?? '—'}
                    <span className="ml-1 text-[15px] font-normal text-gray-400">min</span>
                  </span>
                </div>
                <DelayBadge
                  minutes={selected.delayMin}
                  scheduledMin={selected.etaScheduledMin}
                  predictedMin={selected.etaMin}
                  size="md"
                />
              </div>

              {/*
                Prediction provenance sits directly under the authoritative ETA
                and never replaces it. The headline number above always comes
                from the contract field eta_min, so even an unvalidated model
                result is only ever additional context.
              */}
              {selected.prediction && (
                <div className="glass-inset flex flex-col gap-1.5 px-3 py-2.5">
                  <span className="text-[10px] tracking-wide text-gray-500 uppercase">
                    How this was predicted
                  </span>
                  <PredictionBadge prediction={selected.prediction} />
                  {selected.prediction.trusted === false && (
                    <p className="text-[11px] leading-relaxed text-warn/90">
                      The ETA above is the live figure. This is an experimental model estimate and is
                      not validated against real arrival times.
                    </p>
                  )}
                </div>
              )}

              <CrowdIndicator
                level={selected.crowd}
                load={selected.load}
                capacity={selected.capacity}
                ratio={selected.ratio}
              />

              <div>
                <h3 className="mb-2 text-[11px] tracking-wide text-gray-400 uppercase">
                  Stops on the way
                </h3>
                <StopTimeline stops={selected.stops} etas={tripEtas} />
              </div>

              {/*
                The documented demo trigger: empty the bus, re-plan, and the
                ranking changes. That is what proves the app is live rather than
                a static mock.
              */}
              <div className="glass-inset flex flex-col gap-2 p-3">
                <h3 className="flex items-center gap-1.5 text-[11px] tracking-wide text-gray-400 uppercase">
                  <Sparkle size={12} />
                  Demo · change the crowd
                </h3>

                {activeTrip ? (
                  <>
                    <p className="text-[11px] text-gray-500">
                      Trip {activeTrip.tripId} · {activeTrip.reg ?? 'bus'} currently reports{' '}
                      {activeTrip.load ?? '—'}/{activeTrip.capacity ?? '—'}.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={overriding || !isLive}
                        onClick={() => runOverride(0)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-[12px] text-gray-200 transition-colors hover:bg-white/10 disabled:opacity-40"
                      >
                        <Sliders size={12} />
                        Empty it
                      </button>
                      <button
                        type="button"
                        disabled={overriding || !isLive}
                        onClick={() => runOverride(Math.round((activeTrip.capacity ?? 50) * 0.85))}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-[12px] text-gray-200 transition-colors hover:bg-white/10 disabled:opacity-40"
                      >
                        <Sliders size={12} />
                        Pack it
                      </button>
                    </div>
                    {!isLive && (
                      <p className="text-[11px] text-busy">
                        Needs the live API — the demo fallback is read-only.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-[11px] text-gray-500">
                    No active trip on {selected.code}, so there is nothing to override. Start the
                    simulator with <code className="text-gray-400">python -m simulation_ml.simulate</code>.
                  </p>
                )}

                {notice && (
                  <p className={`text-[11px] ${notice.ok ? 'text-ok' : 'text-busy'}`} role="status">
                    {notice.text}
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
              {loading ? (
                <p className="text-[13px] text-gray-400">Planning your journey…</p>
              ) : (
                <>
                  <CheckCircle size={22} className="text-gray-600" />
                  <p className="text-[13px] text-gray-400">No option selected.</p>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
