import { Users, Wheelchair, Steps, Gauge, MapPin, Bus, Clock } from '@phosphor-icons/react'
import CrowdIndicator from './CrowdIndicator'
import DelayBadge from './DelayBadge'
import PredictionBadge from './PredictionBadge'

/**
 * One candidate BUS from GET /api/journey.
 *
 * The contract is emphatic that options must be shown side by side: "The UI must
 * render every entry - showing one option defeats the purpose of the feature."
 * The seed deliberately produces a fast-but-packed bus and a slow-but-empty one,
 * and the whole product is the passenger choosing between them. So this card
 * never collapses to a single "best" result - the list shows them all and lets
 * the ranking be a suggestion rather than a decision made for them.
 *
 * TWO CLOCKS ON EVERY CARD, WHICH ARE NOT THE SAME NUMBER
 * -----------------------------------------------------
 *   arrivesInMin  how long until the bus gets to WHERE YOU ARE STANDING
 *   etaMin        how long until it gets you WHERE YOU ARE GOING
 *
 * Both are shown because a passenger weighs them differently and collapsing them
 * hides the decision. Waiting 20 minutes for a bus that then takes 5 is a
 * different journey from waiting 2 for one that takes 25, and a card showing
 * only the total would make those look identical. On the route-level plan the
 * single ETA was the whole story, which is why this distinction only became
 * necessary once the options became buses.
 */
export default function OptionCard({ option, selected = false, onSelect = null, rank = null }) {
  const eta = option.etaMin
  const wait = option.arrivesInMin

  // A timetable entry has no vehicle behind it yet, so it says "21A UP at 14:35"
  // rather than inventing a registration. Showing a bus number we have not been
  // given would be the kind of small invention that makes a live board a liar.
  const isLive = option.kind === 'live'

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`glass-inset flex w-full flex-col gap-3 px-4 py-3.5 text-left transition-colors ${
        selected
          ? 'border-brand-blue/70 bg-brand-blue/10'
          : 'hover:border-white/20 hover:bg-white/10'
      }`}
    >
      {/* header: rank, route code, name */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {rank !== null && (
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-medium ${
                rank === 1 ? 'bg-accent/20 text-accent' : 'bg-white/10 text-gray-300'
              }`}
            >
              {rank}
            </span>
          )}
          <div className="flex min-w-0 flex-col">
            <span className="text-[14px] font-medium text-white">{option.code}</span>
            {option.name && (
              <span className="truncate text-[11px] text-gray-400">{option.name}</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end">
          <span className="text-[20px] leading-none font-medium text-white">
            {eta ?? '—'}
            <span className="ml-0.5 text-[12px] font-normal text-gray-400">min</span>
          </span>
          <span className="mt-1 text-[10px] text-gray-500">
            {Number.isFinite(option.journeyMin) && `${option.journeyMin} min ride`}
            {Number.isFinite(option.journeyMin) && Number.isFinite(wait) ? ' · ' : ''}
            {Number.isFinite(wait)
              ? wait === 0
                ? 'at your stop'
                : `waits ${wait} min`
              : ''}
          </span>
        </div>
      </div>

      {/*
        Which physical vehicle this is. Shown as the registration when the bus is
        live, and as a departure time when it is only a timetable entry - a bus
        number is something you can look for as it approaches, so it is more
        useful than a countdown.
      */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-300">
        <span
          className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 ${
            isLive ? 'bg-emerald-400/10 text-emerald-300' : 'bg-white/10 text-gray-300'
          }`}
        >
          {isLive ? <Bus size={12} /> : <Clock size={12} />}
          {isLive
            ? (option.busReg ?? `bus ${option.busId}`)
            : (option.departsAt
                ? `departs ${new Date(option.departsAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}`
                : 'scheduled')}
        </span>

        {option.busType && (
          <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-gray-400">{option.busType}</span>
        )}

        {/* Direction is load-bearing once a corridor runs both ways: the same
            route number serves the pair in one direction only, and the code
            alone ("21A") does not say which. */}
        {option.direction && (
          <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-gray-400">
            {option.direction === 'up' ? 'up' : 'down'}
          </span>
        )}
      </div>

      {/* crowd + delay */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CrowdIndicator
            level={option.crowd}
            load={option.load}
            capacity={option.capacity}
            ratio={option.ratio}
            compact
          />
          {Number.isFinite(option.load) && Number.isFinite(option.capacity) && (
            <span className="text-[11px] text-gray-400">
              {option.load}/{option.capacity}
            </span>
          )}
        </div>

        {Number.isFinite(option.delayMin) ? (
          <DelayBadge minutes={option.delayMin} />
        ) : (
          /* No live vehicle, so there is no delay to report. Saying "on time" for
             a bus that does not exist yet would be a fabricated reassurance. */
          <span className="text-[11px] text-gray-500">scheduled</span>
        )}
      </div>

      {/* accessibility + model metadata */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-400">
        {Array.isArray(option.stops) && option.stops.length > 1 && (
          <span className="inline-flex items-center gap-1">
            <MapPin size={12} />
            {/* Inclusive of both endpoints, so a direct stop-to-stop trip is
                "1 stop" and not "0 stops". */}
            {option.stops.length} {option.stops.length === 1 ? 'stop' : 'stops'} on the way
          </span>
        )}
        {option.wheelchair && (
          <span className="inline-flex items-center gap-1 text-accent">
            <Wheelchair size={12} />
            Wheelchair accessible
          </span>
        )}
        {option.lowFloor && (
          <span className="inline-flex items-center gap-1">
            <Steps size={12} />
            Low floor
          </span>
        )}
        {option.wheelchair && option.lowFloor && <span className="sr-only">Accessible vehicle</span>}
        {/* Always rendered when the backend supplies a score. Under sort=crowd
            the score is what the list is actually ordered by, and hiding it
            would leave the ranking unexplained while it is on screen. */}
        {Number.isFinite(option.score) && (
          <span
            className="inline-flex items-center gap-1"
            title="Ranking score: arrival time plus a crowding penalty. Lower is better."
          >
            <Gauge size={12} />
            score {option.score}
          </span>
        )}

        {/*

          Only rendered when the backend sends real model metadata. No endpoint
          in the contract does today, and the badge renders nothing rather than
          a fabricated confidence figure.
        */}
        <PredictionBadge prediction={option.prediction} />

        {!option.wheelchair && !option.lowFloor && (
          <span className="inline-flex items-center gap-1">
            <Users size={12} />
            Standard vehicle
          </span>
        )}
      </div>
    </button>
  )
}

/**
 * One multi-leg option, for journeys with no direct bus.
 *
 * NOT selectable, and that is the honest choice rather than an omission. The map
 * is scoped to a single route - that invariant is what stops a bus belonging to
 * an unselected route being drawn on it - and a transfer spans two. Making it
 * selectable would mean either showing only one leg while implying both, or
 * breaking the scoping that the whole live map depends on.
 *
 * So the card states the two legs, the interchange and the total, and leaves the
 * choice of which to track to the direct buses.
 */
export function TransferCard({ option }) {
  const [first, second] = option.legs

  return (
    <div className="glass-inset flex w-full flex-col gap-3 px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="inline-flex w-fit items-center gap-1.5 rounded-md bg-amber-400/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
            1 transfer
          </span>
          <span className="truncate text-[13px] text-gray-300">
            {option.via?.name ? `change at ${option.via.name}` : 'change of bus'}
          </span>
        </div>

        <div className="flex shrink-0 flex-col items-end">
          <span className="text-[20px] leading-none font-medium text-white">
            {option.totalMin}
            <span className="ml-0.5 text-[12px] font-normal text-gray-400">min</span>
          </span>
          <span className="mt-1 text-[10px] text-gray-500">
            {option.waitMin} min waiting
          </span>
        </div>
      </div>

      <ol className="flex flex-col gap-1.5 text-[11px] text-gray-400">
        {[first, second].map((leg, i) => (
          <li key={`${leg.routeId}-${i}`} className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-white/10 px-1.5 py-0.5 font-medium text-white">
              {leg.code}
            </span>
            <span className="text-gray-300">{leg.stops?.[0]?.name ?? '—'}</span>
            <span className="text-gray-600">→</span>
            <span className="text-gray-300">{leg.stops?.[leg.stops.length - 1]?.name ?? '—'}</span>
            {leg.busReg && <span className="text-gray-500">{leg.busReg}</span>}
            <span className="text-gray-500">
              ({leg.arrivesInMin === 0 ? 'at the stop' : `${leg.arrivesInMin} min`})
            </span>
          </li>
        ))}
      </ol>

      <p className="text-[10px] text-gray-500">
        Not shown on the map - it spans two routes. Pick a direct bus below to track it live.
      </p>
    </div>
  )
}
