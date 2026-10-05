import { useMemo, useState } from 'react'
import {
  ArrowsLeftRight,
  Wheelchair,
  Sliders,
  Sparkle,
  WarningCircle,
  CheckCircle,
  Clock,
  Lightning,
} from '@phosphor-icons/react'
import CrowdIndicator from './CrowdIndicator'
import DelayBadge from './DelayBadge'
import OptionCard, { TransferCard } from './OptionCard'
import PredictionBadge from './PredictionBadge'
import SourceBadge from './SourceBadge'
import StopTimeline from './StopTimeline'
import { useTripEtas } from '@/lib/useTripEtas'

/**
 * The passenger journey planner: pick two stops, get every ranked bus.
 *
 * Presentational on purpose. The journey state is owned by the Dashboard shell
 * so the live map can draw the same selected route without a second useJourney
 * instance polling the API independently.
 *
 * Three rules are treated as non-negotiable:
 *
 *  1. "The UI must render every entry - showing one option defeats the purpose
 *     of the feature." The list never collapses to a single winner; the best
 *     ranked bus is preselected but every alternative stays visible and one
 *     click away.
 *  2. The seed's whole point is that one bus is faster-but-packed and another is
 *     slower-but-empty. Neither dominates, so ranking on arrival alone and hiding
 *     the empty one would delete the decision the product exists to present.
 *     Hence the explicit ETA / least-crowded toggle rather than one hidden score.
 *  3. An empty result is an ANSWER and is worded as one. The backend knows
 *     whether it is "same stop", "nothing connects these" or "you need one
 *     transfer", and each deserves different words - suggesting a swap is
 *     helpful for one and nonsense for another.
 *
 * Options are BUSES, not routes (GET /api/journey). That is what lets the panel
 * name a registration, say how long that vehicle will take to arrive, and drop
 * the ones that have already passed the boarding stop.
 */

/**
 * The two rankings, as a real control rather than a hidden score.
 *
 * "Least crowded" is not a sort key nobody can see - it is the answer to "I would
 * rather wait or travel longer than stand in a packed bus", which is a decision
 * only the passenger can make. The backend's score is arrival time plus a
 * crowding penalty; this makes both terms visible.
 */
function SortToggle({ sort, onSortChange, disabled = false }) {
  const options = [
    { id: 'eta', label: 'Soonest', icon: Lightning, hint: 'Rank by arrival time' },
    {
      id: 'crowd',
      label: 'Least crowded',
      icon: Clock,
      hint: 'Rank by arrival time plus a crowding penalty',
    },
  ]

  return (
    <div
      role="group"
      aria-label="Rank journey options"
      className="inline-flex items-center gap-0.5 rounded-lg border border-white/10 bg-black/40 p-0.5"
    >
      {options.map(({ id, label, icon: Icon, hint }) => {
        const active = sort === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSortChange(id)}
            aria-pressed={active}
            title={hint}
            disabled={disabled}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] transition-colors disabled:opacity-40 ${
              active
                ? 'bg-amber-400/20 font-medium text-amber-200 ring-1 ring-amber-400/50'
                : 'text-gray-400 hover:bg-white/10 hover:text-white'
            }`}
          >
            <Icon size={12} />
            {label}
          </button>
        )
      })}
    </div>
  )
}

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
  sort = 'eta',
  onSortChange = () => {},
}) {
  const [notice, setNotice] = useState(null)

  const {
    plan,
    options,
    transfers,
    message,
    selected,
    selectOption,
    source,
    isLive,
    error,
    loading,
    overriding,
    overrideCrowd,
  } = journey

  /**
   * The live trip serving the selected bus, needed for the crowd override.
   *
   * Matched on the BUS, not the route. The planner now returns individual
   * vehicles, so two buses on one corridor are two options and the demo trigger
   * has to act on the one whose card is open. Matching on route code picked an
   * arbitrary bus off the corridor - and with a hundred buses on the network,
   * almost always the wrong one.
   */
  const activeTrip = useMemo(() => {
    if (selected?.busId == null) return null
    return buses.find((b) => b.busId === selected.busId && b.tripId) ?? null
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
            text: `${selected.busReg ?? selected.code} set to ${load} passengers. Options re-planned.`,
          }
        : { ok: false, text: result.message },
    )
  }

  const sameStop = from === to

  /**
   * What to say when the list is empty.
   *
   * The backend's own wording wins when it sent one: it distinguishes "these are
   * the same stop" from "nothing runs between these, try swapping" from "you
   * need one transfer", and only the middle one is helped by a swap suggestion.
   * `message` is only about the direct list being empty, so the presence of
   * transfers is worth mentioning - otherwise a passenger who just changed the
   * From/To pickers would read "no buses found" while a viable option is
   * sitting right below.
   */
  const emptyState = (() => {
    if (message) {
      return {
        headline: message,
        hint: transfers.length
          ? `There ${transfers.length === 1 ? 'is' : 'are'} ${transfers.length} one-transfer option${
              transfers.length === 1 ? '' : 's'
            } below.`
          : null,
      }
    }
    if (loading) return null
    return {
      headline: 'No buses found for this journey.',
      hint: 'Try swapping the stops — a bus only runs one direction between two points.',
    }
  })()

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

        <div className="flex flex-wrap items-center justify-between gap-3">
          <SortToggle sort={sort} onSortChange={onSortChange} disabled={loading && !isLive} />

          <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
            <SourceBadge source={source} error={error} />
            {isLive && (
              <span>
                {options.length} bus{options.length === 1 ? '' : 'es'}
                {options.length === 0 ? '' : sort === 'crowd' ? ' · least crowded first' : ' · soonest first'}
              </span>
            )}
            {plan.generatedAt && (
              <span>updated {new Date(plan.generatedAt).toLocaleTimeString()}</span>
            )}
          </div>
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
            <h2 className="text-[13px] font-medium text-white">Buses you can catch</h2>
            <span className="text-[11px] text-gray-400">
              {loading ? 'Planning…' : `${options.length} found`}
            </span>
          </header>

          <p className="text-[11px] leading-relaxed text-gray-500">
            Only buses going <em>this way</em> between these stops, and only ones still ahead of you.
            Every one is listed — pick the trade-off that suits you.
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

            {/*

              One-transfer options, shown only when there is no direct bus. Not
              offered alongside a direct option: suggesting a change to someone
              who can simply take one bus is noise, and it buries the answer.
            */}
            {options.length === 0 &&
              transfers.map((option) => (
                <li key={option.id}>
                  <TransferCard option={option} />
                </li>
              ))}

            {options.length === 0 && emptyState && (
              <li className="rounded-lg border border-dashed border-white/10 px-4 py-8 text-center">
                <p className="text-[13px] text-gray-300">{emptyState.headline}</p>
                {emptyState.hint && <p className="mt-1 text-[11px] text-gray-500">{emptyState.hint}</p>}
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
                {selected.busReg && (
                  <p className="text-[12px] text-gray-400">
                    Bus {selected.busReg}
                    {selected.busType ? ` · ${selected.busType}` : ''}
                    {selected.direction
                      ? ` · ${selected.direction === 'up' ? 'up' : 'down'} direction`
                      : ''}
                  </p>
                )}
              </header>

              {/*
                TWO CLOCKS, because they answer two different questions and
                conflating them is the bug this panel used to have. "Arriving in
                0 min" was the wait for the bus to reach the stop where the
                passenger was already standing, while the actual journey was an
                hour away.

                Both labels say what they measure, so neither number can be
                misread as the other.
              */}
              <div className="glass-inset flex items-end justify-between gap-3 p-3">
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] tracking-wide text-gray-400 uppercase">
                    Arrives at {plan.destination?.name ?? 'destination'}
                  </span>
                  <span className="text-3xl leading-none font-medium tracking-tight text-white">
                    {selected.etaMin ?? '—'}
                    <span className="ml-1 text-[15px] font-normal text-gray-400">min</span>
                  </span>
                </div>
                {Number.isFinite(selected.delayMin) ? (
                  <DelayBadge minutes={selected.delayMin} size="md" />
                ) : (
                  <span className="text-[11px] text-gray-500">scheduled</span>
                )}
              </div>

              <dl className="grid grid-cols-2 gap-2">
                <div className="glass-inset px-3 py-2">
                  <dt className="text-[10px] tracking-wide text-gray-500 uppercase">
                    Reaches you in
                  </dt>
                  <dd className="font-mono text-[16px] text-white">
                    {selected.arrivesInMin === 0
                      ? 'now'
                      : `${selected.arrivesInMin} min`}
                  </dd>
                </div>
                <div className="glass-inset px-3 py-2">
                  <dt className="text-[10px] tracking-wide text-gray-500 uppercase">Ride time</dt>
                  <dd className="font-mono text-[16px] text-white">
                    {selected.journeyMin ?? '—'}
                    {Number.isFinite(selected.journeyMin) ? ' min' : ''}
                  </dd>
                </div>
              </dl>

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
                      The time above is the live figure. This is an experimental model estimate and is
                      not validated against real arrival times.
                    </p>
                  )}
                </div>
              )}

              {/*
                Crowding is only meaningful for a real vehicle. A timetable entry
                has no passengers yet, and drawing an "empty" bar for a bus that
                has not departed would invent the one reading the passenger is
                most likely to act on.
              */}
              {selected.kind === 'live' ? (
                <CrowdIndicator
                  level={selected.crowd}
                  load={selected.load}
                  capacity={selected.capacity}
                  ratio={selected.ratio}
                />
              ) : (
                <div className="glass-inset px-3 py-2.5 text-[11px] text-gray-400">
                  Not running yet — crowding is not known until it departs.
                </div>
              )}

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
                      {selected.busReg ?? selected.code} (trip {activeTrip.tripId}) currently
                      reports {activeTrip.load ?? '—'}/{activeTrip.capacity ?? '—'}.
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
